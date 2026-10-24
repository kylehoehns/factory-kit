// Review findings, triaged (rsvp-factory's ADR 0005, "review findings block only when they must"):
//   blocker       fixed before merge: by the factory reviewer itself, or in a review-fix round (at most two)
//   one-way-door  labelled decision-needed for the maintainer
//   follow-up     listed on the PR, filed as a needs-triage ticket when it merges (at most three)
//   nit           never recorded

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api,
  comment,
  gh,
  labels,
  noMentions,
  push,
  requestSecondOpinion,
  reviewThreads,
  settleThread,
} from "./github.ts";
import { runSessions } from "./sandbox.ts";
import { kit, type Repo, RUNS, run } from "./shared.ts";
import { log, note } from "./status.ts";

export type Finding = {
  kind: "fixed" | "blocker" | "one-way-door" | "follow-up";
  title: string;
  path?: string;
  line?: number;
  body: string;
  /** The review thread the factory posted for this finding, when GitHub placed it on its line. */
  thread?: string;
};

export const MAX_FOLLOW_UPS = 3;
export type Resolution = { id: number; status: "fixed" | "declined"; note: string };

const DECLINED_ALL =
  "**Decision for the maintainer:** the factory declined every blocker from the second opinion and changed nothing; " +
  "its reasons are on each thread. Merge if you agree with the factory, or say what to change.";
const FOLLOW_UP_REPLY = "Tracked as a follow-up: it's filed as a `needs-triage` ticket when this PR merges.";

const followUpReply = (f: Finding) => (f.kind === "follow-up" ? FOLLOW_UP_REPLY : undefined);

/**
 * Post findings from the app: a review holding the heading and any finding GitHub won't place on a line, then each
 * placed finding as its own comment on its line. Returns the findings with the ID of the thread each one opened, found
 * by the comment's ID, so the factory answers each thread by ID later.
 */
export async function postFindings(
  repo: Repo,
  token: string,
  pr: number,
  heading: string,
  findings: Finding[],
  signature = "",
): Promise<Finding[]> {
  if (findings.length === 0) return [];
  const text = (f: Finding) => `[${f.kind}] **${f.title}**: ${f.body}${signature}`;
  const commit = gh(repo, token, "pr", "view", String(pr), "--json", "headRefOid", "--jq", ".headRefOid");
  const comments = new Map<Finding, string>();
  for (const f of findings.filter((f) => f.path && f.line)) {
    const posted = await api<{ node_id: string }>(repo, token, `/pulls/${pr}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: noMentions(text(f)), commit_id: commit, path: f.path, line: f.line, side: "RIGHT" }),
    }).catch(() => undefined); // a line outside the diff: the finding goes in the review body
    if (posted) comments.set(f, posted.node_id);
  }
  const threads = comments.size ? await reviewThreads(repo, token, pr) : [];
  const thread = (f: Finding) => threads.find((t) => t.first === comments.get(f))?.id;
  const inBody = findings.filter((f) => !comments.has(f)).map((f) => `- ${text(f)}${where(f)}`);
  await api(repo, token, `/pulls/${pr}/reviews`, {
    method: "POST",
    body: JSON.stringify({ event: "COMMENT", body: noMentions([heading, ...inBody].join("\n\n")) }),
  });
  return findings.map((f) => ({ ...f, thread: thread(f) }));
}

/** Reply to and resolve the threads the factory posted for these findings. One-way doors stay open: they're the
 *  maintainer's call. */
export async function settleFindings<F extends Finding>(
  repo: Repo,
  token: string,
  pr: number,
  findings: F[],
  reply: (f: F) => string | undefined = followUpReply,
  keepOpen = false,
) {
  for (const finding of findings) {
    if (!finding.thread || finding.kind === "one-way-door") continue;
    await settleThread(token, finding.thread, reply(finding), keepOpen).catch((e) =>
      log(`${repo.name} PR #${pr}: could not settle "${finding.title}": ${e}`),
    );
  }
}
const STORE = /\n*<!-- factory-follow-ups\n([\s\S]*?)\n-->\n?/;
const SECTION = /\n*### Follow-ups \(filed as tickets when this PR merges\)\n[\s\S]*?(?=\n<!-- factory-follow-ups|$)/;
const where = (f: Finding) => (f.path ? ` (\`${f.path}${f.line ? `:${f.line}` : ""}\`)` : "");

export function followUpsIn(body: string): Finding[] {
  const match = body.match(STORE);
  return match ? (JSON.parse(match[1]) as Finding[]) : [];
}

/** The PR body with its follow-up list replaced: a readable section plus the machine-readable copy. */
export function withFollowUps(body: string, followUps: Finding[]): string {
  const base = body.replace(STORE, "").replace(SECTION, "").trimEnd();
  if (followUps.length === 0) return `${base}\n`;
  const list = followUps.map((f) => `- **${f.title}**${where(f)}: ${f.body}`).join("\n");
  return (
    `${base}\n\n### Follow-ups (filed as tickets when this PR merges)\n\n${list}\n\n` +
    `<!-- factory-follow-ups\n${JSON.stringify(followUps)}\n-->\n`
  );
}

/** Adds follow-ups to a PR, deduplicated by title and capped; returns how many were dropped by the cap. */
export function addFollowUps(repo: Repo, token: string, pr: number, more: Finding[]): number {
  const body = gh(repo, token, "pr", "view", String(pr), "--json", "body", "--jq", ".body");
  const all = followUpsIn(body);
  for (const f of more) if (!all.some((g) => g.title === f.title)) all.push(f);
  gh(repo, token, "pr", "edit", String(pr), "--body", withFollowUps(body, all.slice(0, MAX_FOLLOW_UPS)));
  return Math.max(0, all.length - MAX_FOLLOW_UPS);
}

export function flagDecisions(repo: Repo, token: string, pr: number, doors: Finding[]) {
  if (doors.length === 0) return;
  labels(repo, token, pr, { add: ["decision-needed"] });
  const list = doors.map((f) => `- **${f.title}**${where(f)}: ${f.body}`).join("\n");
  comment(repo, token, pr, `**Decisions for the maintainer** (one-way doors the ticket didn't settle):\n\n${list}`);
}

// --- The second opinion's findings ---

type Comment = { id: string; author: { login: string }; body: string; createdAt: string };
const ROUND = /<!-- factory-review-round source=(\S+) blockers=(\d+) -->/g;

export function secondOpinion(
  comments: Pick<Comment, "id" | "body">[],
): { id: string; findings: Finding[] } | undefined {
  const latest = comments.filter((c) => c.body.startsWith("Second opinion")).at(-1);
  const json = latest?.body.match(/```findings\s*\n([\s\S]*?)```/)?.[1];
  if (!latest || !json) return undefined;
  try {
    return { id: latest.id, findings: JSON.parse(json) as Finding[] };
  } catch {
    return undefined; // unreadable: the maintainer reads it on the PR as usual
  }
}

/**
 * For one open factory PR: act on a second opinion the factory hasn't handled yet. Blockers get a fix round
 * (then the second opinion runs again on the new code); one-way doors and follow-ups go on the PR.
 */
export async function triageSecondOpinion(
  repo: Repo,
  token: string,
  pr: number,
  branch: string,
  issue: number,
  claudeToken: string,
  freshToken: () => Promise<string>,
  block: (target: number, reason: string) => void,
  prepareTask: () => Promise<void>,
): Promise<void> {
  const comments = JSON.parse(gh(repo, token, "pr", "view", String(pr), "--json", "comments")).comments as Comment[];
  const opinion = secondOpinion(comments);
  const rounds = comments.flatMap((c) =>
    [...c.body.matchAll(ROUND)].map((m) => ({ source: m[1], blockers: Number(m[2]) })),
  );
  if (!opinion || rounds.some((r) => r.source === opinion.id)) return;

  // The second opinion only comments; the factory posts its findings as threads, so it holds every thread's ID.
  const findings = await postFindings(
    repo,
    token,
    pr,
    "**Second opinion**: its findings, one thread each so the factory can answer them. The full opinion is in its comment.",
    opinion.findings,
    "\n\n_From the second opinion._",
  );
  const dropped = addFollowUps(
    repo,
    token,
    pr,
    findings.filter((f) => f.kind === "follow-up"),
  );
  flagDecisions(
    repo,
    token,
    pr,
    findings.filter((f) => f.kind === "one-way-door"),
  );
  await settleFindings(
    repo,
    token,
    pr,
    findings.filter((f) => f.kind === "follow-up"),
  );
  // Numbered for the fixer, which answers each by its id.
  const blockers = findings.filter((f) => f.kind === "blocker").map((f, i) => ({ ...f, id: i + 1 }));
  const marker = `<!-- factory-review-round source=${opinion.id} blockers=${blockers.length} -->`;
  const note = dropped ? ` (${dropped} follow-up(s) over the cap of ${MAX_FOLLOW_UPS} were not recorded)` : "";
  if (blockers.length === 0) {
    comment(repo, token, pr, `Second opinion triaged: no blockers${note}.\n\n${marker}`);
    return;
  }
  const round = rounds.filter((r) => r.blockers > 0).length + 1;
  if (round > kit().rounds.review) {
    comment(repo, token, pr, `Second opinion still has blockers after ${kit().rounds.review} rounds.\n\n${marker}`);
    block(
      pr,
      `the second opinion still reports ${blockers.length} blocker(s) after ${kit().rounds.review} fix rounds.`,
    );
    return;
  }

  log(
    `${repo.name} PR #${pr}: ${blockers.length} blocker(s) from the second opinion, review round ${round} of ${kit().rounds.review}`,
  );
  await prepareTask();
  const findingsFile = join(repo.root, RUNS, "findings.json");
  writeFileSync(
    findingsFile,
    JSON.stringify(
      blockers.map(({ thread: _, ...f }) => f),
      null,
      2,
    ),
  );
  run(repo, "git", ["fetch", "--quiet", "origin", "main", branch]);
  run(repo, "git", ["branch", "--force", branch, `origin/${branch}`]);
  const { outcome, read } = await runSessions(
    repo,
    issue,
    branch,
    [{ role: "fixReview", prompt: "fix-review.md" }],
    [join(repo.root, RUNS, "task.md"), findingsFile],
    claudeToken,
    pr,
  );
  const fresh = await freshToken();
  const commits = run(repo, "git", ["rev-list", `origin/${branch}..${branch}`]);
  comment(repo, fresh, pr, `Review round ${round} of ${kit().rounds.review}: ${outcome.summary}${note}\n\n${marker}`);
  const resolutions = JSON.parse(read("resolutions.json") ?? "[]") as Resolution[];
  const resolution = (b: { id: number }) => resolutions.find((r) => r.id === b.id);
  const declined = (b: { id: number }) => resolution(b)?.status === "declined";
  if (outcome.outcome === "success" && !commits && blockers.every(declined)) {
    // Two reviewers disagree and nothing changed: that's a decision for the maintainer, not a failure. Answer each
    // thread with the fixer's reason and leave it open for the maintainer to settle.
    await settleFindings(repo, fresh, pr, blockers, (b) => `**Not changed:** ${resolution(b)?.note}`, true);
    labels(repo, fresh, pr, { add: ["decision-needed"] });
    comment(repo, fresh, pr, DECLINED_ALL);
    log(`${repo.name} PR #${pr}: the factory declined every second-opinion blocker; waiting for the maintainer`);
    return;
  }
  if (outcome.outcome !== "success" || !commits) {
    block(pr, outcome.outcome !== "success" ? outcome.summary : "the review-fix session made no commits.");
    return;
  }
  push(repo, fresh, branch); // fast-forward only
  // Answer each blocker's thread with what was done about it, then resolve it.
  const head = run(repo, "git", ["rev-parse", "--short", branch]);
  const reply = (r: Resolution) =>
    r.status === "fixed" ? `**Fixed in \`${head}\`:** ${r.note}` : `**Not changed:** ${r.note}`;
  for (const b of blockers) {
    const r = resolution(b);
    if (r) await settleFindings(repo, fresh, pr, [b], () => reply(r));
  }
  // Ask for a fresh second opinion on the fixed code.
  requestSecondOpinion(repo, fresh, pr);
  log(`${repo.name} PR #${pr}: pushed review fix round ${round}`);
}

// --- Filing follow-ups once a PR merges ---

const FILED = "<!-- factory-follow-ups-filed -->";

export function fileFollowUps(repo: Repo, token: string, prefix: string) {
  const merged = JSON.parse(
    gh(repo, token, "pr", "list", "--state", "merged", "--limit", "20", "--json", "number,headRefName,body"),
  ) as { number: number; headRefName: string; body: string }[];
  for (const pr of merged.filter((p) => p.headRefName.startsWith(prefix))) {
    const followUps = followUpsIn(pr.body);
    if (followUps.length === 0) continue;
    const comments = gh(
      repo,
      token,
      "pr",
      "view",
      String(pr.number),
      "--json",
      "comments",
      "--jq",
      '[.comments[].body] | join("\\n")',
    );
    if (comments.includes(FILED)) continue;
    const filed = followUps.map((f) => {
      const existing = gh(
        repo,
        token,
        "issue",
        "list",
        "--state",
        "all",
        "--search",
        `"${f.title}" in:title`,
        "--json",
        "number,title",
        "--jq",
        `[.[] | select(.title == ${JSON.stringify(f.title)}) | .number] | first // empty`,
      );
      if (existing) return `#${existing} (already filed)`;
      const url = gh(
        repo,
        token,
        "issue",
        "create",
        "--title",
        f.title,
        "--label",
        "needs-triage",
        "--body",
        `Follow-up from #${pr.number}, found in review${where(f)}.\n\n${f.body}`,
      );
      return `#${url.split("/").pop()}`;
    });
    comment(repo, token, pr.number, `Filed follow-ups: ${filed.join(", ")}.\n\n${FILED}`);
    note("followups", repo.slug, `${repo.name} PR #${pr.number}: filed follow-ups ${filed.join(", ")}`, {
      pr: pr.number,
      issue: Number(pr.headRefName.slice(prefix.length)),
    });
  }
}
