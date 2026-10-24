// Picking the next ticket, deterministically. No agent decides what to work on.
//
// A ticket is ready when it is open, labelled ready-for-agent by a maintainer, is a leaf (no sub-issues, not a spec),
// isn't already claimed or blocked, has no open factory PR, and every issue blocking it is closed. Lowest number
// wins, which is dependency order because /to-tickets publishes blockers first.

import { writeFileSync } from "node:fs";
import { api } from "./github.ts";
import { BRANCH_PREFIX, type Repo } from "./shared.ts";

export const CLAIMED = "agent:in-progress";
export const BLOCKED = "agent:blocked";
const TRIGGER = "ready-for-agent";

export type Ticket = {
  number: number;
  labels: string[];
  openBlockers: number;
  subIssues: number;
  labelledBy: string | undefined;
  hasOpenPr: boolean;
};

export function pick(
  tickets: Ticket[],
  workInProgress: number,
  wipLimit: number,
  maintainers: string[],
): Ticket | undefined {
  if (workInProgress >= wipLimit) return undefined;
  return ready(tickets, maintainers).sort((a, b) => a.number - b.number)[0];
}

/** The tickets the factory would build, the work-in-progress limit aside. */
export function ready(tickets: Ticket[], maintainers: string[]): Ticket[] {
  return tickets.filter(
    (t) =>
      t.labels.includes(TRIGGER) &&
      ![CLAIMED, BLOCKED, "spec"].some((l) => t.labels.includes(l)) &&
      t.subIssues === 0 &&
      !t.hasOpenPr && // its PR is waiting for review; building it again would overwrite it
      t.openBlockers === 0 &&
      t.labelledBy !== undefined &&
      maintainers.includes(t.labelledBy),
  );
}

type Issue = {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  pull_request?: object;
  issue_dependencies_summary?: { blocked_by: number };
  sub_issues_summary?: { total: number };
};
type Pull = { head: { ref: string }; merged_at: string | null };

async function labelledBy(repo: Repo, token: string, issue: number): Promise<string | undefined> {
  const events = await api<{ event: string; label?: { name: string }; actor: { login: string } }[]>(
    repo,
    token,
    `/issues/${issue}/events?per_page=100`,
  );
  return events.filter((e) => e.event === "labeled" && e.label?.name === TRIGGER).at(-1)?.actor.login;
}

/** Tickets with an open factory PR, or a merged one: GitHub closes a ticket a few seconds after its PR merges, and in
 *  that window it still looks ready (rsvp-factory#28 was nearly built twice). */
async function ticketsWithPrs(repo: Repo, token: string): Promise<Set<number>> {
  const open = await api<Pull[]>(repo, token, "/pulls?state=open&per_page=100");
  const closed = await api<Pull[]>(repo, token, "/pulls?state=closed&sort=updated&direction=desc&per_page=30");
  return new Set(
    [...open, ...closed.filter((p) => p.merged_at)]
      .filter((p) => p.head.ref.startsWith(BRANCH_PREFIX))
      .map((p) => Number(p.head.ref.slice(BRANCH_PREFIX.length))),
  );
}

export async function loadTickets(repo: Repo, token: string): Promise<Ticket[]> {
  const issues = (await api<Issue[]>(repo, token, `/issues?state=open&labels=${TRIGGER}&per_page=100`)).filter(
    (i) => !i.pull_request,
  );
  const withPrs = await ticketsWithPrs(repo, token);
  return Promise.all(
    issues.map(async (i) => ({
      number: i.number,
      labels: i.labels.map((l) => l.name),
      openBlockers: i.issue_dependencies_summary?.blocked_by ?? 0,
      subIssues: i.sub_issues_summary?.total ?? 0,
      labelledBy: await labelledBy(repo, token, i.number),
      hasOpenPr: withPrs.has(i.number),
    })),
  );
}

/** Claimed tickets still being built, plus factory PRs not yet merged or closed. */
export async function workInProgress(repo: Repo, token: string): Promise<number> {
  const claimed = await api<Issue[]>(repo, token, `/issues?state=open&labels=${CLAIMED}&per_page=100`);
  const pulls = await api<Pull[]>(repo, token, "/pulls?state=open&per_page=100");
  return claimed.length + pulls.filter((p) => p.head.ref.startsWith(BRANCH_PREFIX)).length;
}

export async function claim(repo: Repo, token: string, issue: number) {
  await api(repo, token, `/issues/${issue}/labels`, { method: "POST", body: JSON.stringify({ labels: [CLAIMED] }) });
}

/** The ticket, its comments and its parent spec, written as data for the agents to read. */
export async function writeTask(repo: Repo, token: string, issue: number, path: string) {
  const ticket = await api<Issue>(repo, token, `/issues/${issue}`);
  const comments = await api<{ user: { login: string }; body: string }[]>(
    repo,
    token,
    `/issues/${issue}/comments?per_page=100`,
  );
  const parent = await api<Issue | undefined>(repo, token, `/issues/${issue}/parent`, { optional: true });
  const parts = [
    `# Ticket #${issue}: ${ticket.title}\n\n${ticket.body ?? ""}`,
    ...comments.map((c) => `## Comment by ${c.user.login}\n\n${c.body}`),
  ];
  if (parent) parts.push(`# Parent spec #${parent.number}: ${parent.title}\n\n${parent.body ?? ""}`);
  writeFileSync(path, `${parts.join("\n\n---\n\n")}\n`);
}
