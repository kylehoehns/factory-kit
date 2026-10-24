// The factory, run on the maintainer's machine: `npm run factory`. It keeps running and, every `pollSeconds`, does
// this for each repo in factory.yml (`npm run factory -- --once` does it once and exits):
//
//   1. fix      a factory PR that conflicts with main gets a session that merges main in; one whose `ci` check
//               failed gets a session with the failure log; each capped, then labelled agent:blocked (rounds.ts)
//   2. review   a factory PR's second opinion is triaged: blockers get a fix round, one-way doors are labelled
//               decision-needed, follow-ups are listed on the PR (findings.ts)
//   +  merge    low-risk PRs with everything green and resolved, and PRs a maintainer approved (automerge.ts)
//   3. follow-ups  when a factory PR merges, its follow-ups are filed as needs-triage tickets
//   4. tickets  ready tickets, up to the work-in-progress limit across all repos, are implemented and reviewed in a
//               sandbox, then published as a PR by the factory app
//
// Agents never hold a GitHub credential: github.ts does, with the app key from the macOS keychain.
//
// One factory per machine (a pidfile, and a check for any other `node src/factory.ts`). It says what it is doing in
// ~/.cache/factory/status.json and events.jsonl, and bin/factoryctl stops (drains), wakes and restarts it (control.ts).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { autoMerge } from "./automerge.ts";
import {
  buildUntilDrained,
  draining,
  finishDrain,
  releaseOrphans,
  signalHandler,
  sleepUntilNextPass,
  stopNow,
} from "./control.ts";
import { claim, loadTickets, pick, ready, workInProgress, writeTask } from "./dispatch.ts";
import {
  addFollowUps,
  type Finding,
  fileFollowUps,
  flagDecisions,
  settleFindings,
  triageSecondOpinion,
} from "./findings.ts";
import { floorTier, localFiles } from "./gate.ts";
import { api, appToken, comment, gh, labels, openFactoryPrs, push, requestSecondOpinion } from "./github.ts";
import { interruptLeftovers } from "./live.ts";
import { fixPrs } from "./rounds.ts";
import { pruneWorktrees, runSessions } from "./sandbox.ts";
import {
  BRANCH_PREFIX,
  forbiddenChanges,
  KIT,
  keychain,
  kit,
  type Outcome,
  openRepo,
  type Repo,
  RUNS,
  run,
} from "./shared.ts";
import {
  acquireLock,
  currentStatus,
  initStatus,
  kitVersion,
  log,
  note,
  releaseLock,
  type Step,
  writeStatus,
} from "./status.ts";

type Review = { summary: string; findings: Finding[] };

const taskFile = (repo: Repo) => join(repo.root, RUNS, "task.md");

function block(repo: Repo, token: string, target: number, reason: string) {
  labels(repo, token, target, { add: ["agent:blocked"] });
  try {
    labels(repo, token, target, { remove: ["agent:in-progress"] });
  } catch {
    // PRs never carry it
  }
  const retry = "A human needs to look. Remove `agent:blocked` to let the factory try again.";
  comment(repo, token, target, `The factory stopped: ${reason}\n\n${retry}`);
  note("blocked", repo.slug, `${repo.name}#${target}: blocked: ${reason}`);
}

/** Pocock's needs-info: leave the questions on the ticket and move on; answers arrive as comments. */
function ask(repo: Repo, token: string, issue: number, outcome: Outcome) {
  const questions = (outcome.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n");
  const answer =
    "Answer in a comment, then re-apply `ready-for-agent`. The next run reads every comment on this ticket.";
  comment(
    repo,
    token,
    issue,
    `The factory has questions before it can build this ticket.\n\n${questions || outcome.summary}\n\n${answer}`,
  );
  labels(repo, token, issue, { add: ["needs-info"], remove: ["ready-for-agent", "agent:in-progress"] });
  note("needsinfo", repo.slug, `${repo.name}#${issue}: needs-info (${outcome.questions?.length ?? 0} question(s))`, {
    issue,
  });
}

// --- 1. Fix rounds: red CI, and conflicts with main (rounds.ts) ---

async function fixFactoryPrs(repo: Repo, claudeToken: string) {
  await fixPrs(repo, claudeToken, {
    writeTask: (issue, token) => writeTask(repo, token, issue, taskFile(repo)),
    block: (token, target, reason) => block(repo, token, target, reason),
  });
}

// --- 2. Second opinions on factory PRs ---

async function reviewFindings(repo: Repo, claudeToken: string) {
  const token = await appToken(repo);
  for (const pr of openFactoryPrs(repo, token, BRANCH_PREFIX)) {
    if (pr.labels.some((l) => l.name === "agent:blocked")) continue;
    const issue = Number(pr.headRefName.slice(BRANCH_PREFIX.length));
    await triageSecondOpinion(
      repo,
      token,
      pr.number,
      pr.headRefName,
      issue,
      claudeToken,
      () => appToken(repo),
      (target, reason) => block(repo, token, target, reason),
      () => writeTask(repo, token, issue, taskFile(repo)),
    );
  }
}

// --- Merging: low-risk PRs by stage, approved PRs always ---

async function merges(repo: Repo) {
  const token = await appToken(repo);
  await autoMerge(repo, token, openFactoryPrs(repo, token, BRANCH_PREFIX));
}

// --- 3. Follow-ups from merged PRs ---

async function followUps(repo: Repo) {
  fileFollowUps(repo, await appToken(repo), BRANCH_PREFIX);
}

// --- 4. Building tickets ---

/** The factory reviewer's findings as a GitHub review from the app, inline where GitHub accepts the line. */
async function postReview(repo: Repo, token: string, pr: number, review: Review) {
  const text = (f: Finding) => `[${f.kind}] **${f.title}**: ${f.body}`;
  const asLine = (f: Finding) => `- ${f.path ? `\`${f.path}${f.line ? `:${f.line}` : ""}\`: ` : ""}${text(f)}`;
  const post = (inline: Finding[], inBody: Finding[]) =>
    api(repo, token, `/pulls/${pr}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        event: "COMMENT",
        body: ["**Factory review** (fresh session, `code-review` skill)", review.summary, ...inBody.map(asLine)].join(
          "\n\n",
        ),
        comments: inline.map((f) => ({ path: f.path, line: f.line, side: "RIGHT", body: text(f) })),
      }),
    });
  const inline = review.findings.filter((f) => f.path && f.line);
  try {
    await post(
      inline,
      review.findings.filter((f) => !inline.includes(f)),
    );
  } catch {
    // A line outside the diff makes GitHub reject the whole review; keep every finding in the body instead.
    await post([], review.findings).catch((e) =>
      log(`${repo.name} PR #${pr}: could not post the factory review: ${e}`),
    );
  }
  addFollowUps(
    repo,
    token,
    pr,
    review.findings.filter((f) => f.kind === "follow-up"),
  );
  flagDecisions(
    repo,
    token,
    pr,
    review.findings.filter((f) => f.kind === "one-way-door"),
  );
  // What the reviewer already fixed, or deferred to a ticket, needs no one's attention: resolve those threads.
  await settleFindings(
    repo,
    token,
    pr,
    review.findings.filter((f) => f.kind === "fixed" || f.kind === "follow-up"),
  );
}

async function publish(
  repo: Repo,
  token: string,
  issue: number,
  prBody: string | undefined,
  review: Review | undefined,
) {
  const branch = `${BRANCH_PREFIX}${issue}`;
  if (!run(repo, "git", ["rev-list", `origin/main..${branch}`])) {
    return block(repo, token, issue, "the agents reported success but made no commits.");
  }
  const forbidden = forbiddenChanges(repo, branch);
  if (forbidden.length)
    return block(repo, token, issue, `the branch changes the factory's own controls: ${forbidden.join(", ")}.`);

  push(repo, token, branch, true); // a fresh branch from main; replaces any earlier attempt
  const title = gh(repo, token, "issue", "view", String(issue), "--json", "title", "--jq", ".title");
  const body = prBody?.includes(`Closes #${issue}`) ? prBody : `${prBody ?? ""}\n\nCloses #${issue}\n`;
  const url = gh(repo, token, "pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body);
  const pr = Number(url.split("/").pop());
  labels(repo, token, issue, { remove: ["agent:in-progress"] });
  if (review) await postReview(repo, token, pr, review);

  // Every factory PR gets the independent second opinion; its pass can make a small PR low.
  requestSecondOpinion(repo, token, pr);
  const { tier } = floorTier(localFiles(repo.root, `origin/main...${branch}`), repo.config.risk, "factory", true, "");
  note("pr", repo.slug, `${repo.name}#${issue}: opened PR #${pr} (${tier} risk before the second opinion)`, {
    issue,
    pr,
    tier,
  });
}

async function build(repo: Repo, issue: number, claudeToken: string) {
  const branch = `${BRANCH_PREFIX}${issue}`;
  try {
    run(repo, "git", ["fetch", "--quiet", "origin", "main"]);
    pruneWorktrees(repo);
    run(repo, "git", ["branch", "--force", branch, "origin/main"]);
    const { outcome, read } = await runSessions(
      repo,
      issue,
      branch,
      [
        { role: "implement", prompt: "implement.md" },
        { role: "review", prompt: "review.md" },
      ],
      [taskFile(repo)],
      claudeToken,
    );
    const token = await appToken(repo);
    if (outcome.outcome === "success") {
      const review = read("review.json");
      await publish(repo, token, issue, read("pr-body.md"), review ? (JSON.parse(review) as Review) : undefined);
    } else if (outcome.outcome === "question") ask(repo, token, issue, outcome);
    else block(repo, token, issue, outcome.summary);
  } catch (error) {
    if (stopNow.signal.aborted) return; // stopped now: the signal handler puts the ticket back in the queue
    block(repo, await appToken(repo), issue, `the run failed: ${(error as Error).message}`);
  }
}

/** One ticket at a time, across every repo, while the shared work-in-progress limit allows and no drain started. */
async function buildTickets(repos: Repo[], claudeToken: string) {
  const claimNext = async () => {
    let wip = 0;
    for (const repo of repos) wip += await workInProgress(repo, await appToken(repo));
    let readyCount = 0;
    let next: { repo: Repo; issue: number } | undefined;
    for (const repo of repos) {
      const token = await appToken(repo);
      const tickets = await loadTickets(repo, token);
      readyCount += ready(tickets, repo.config.maintainers).length;
      const ticket = next ? undefined : pick(tickets, wip, kit().wipLimit, repo.config.maintainers);
      if (ticket) {
        next = { repo, issue: ticket.number };
        await claim(repo, token, ticket.number);
        await writeTask(repo, token, ticket.number, taskFile(repo));
      }
    }
    writeStatus({ wip: next ? wip + 1 : wip, ready: next ? readyCount - 1 : readyCount });
    if (!next) {
      const full = wip >= kit().wipLimit;
      note("factory", "", full ? `idle: WIP ${wip}/${kit().wipLimit} full` : "idle: nothing ready");
    }
    return next;
  };
  await buildUntilDrained(claimNext, (next) => build(next.repo, next.issue, claudeToken));
}

// --- The loop ---

// A closed pipe (the `tee` in front of the console log went away) must not crash a factory mid-session.
process.stdout.on("error", () => {});
const once = process.argv.includes("--once");
const lock = acquireLock(); // before anything else: a second factory must not even mark the first one's sessions
if (!lock.ok) {
  console.log(lock.message);
  process.exit(3);
}
const claudeToken = keychain(kit().keychain.claudeToken);
// Fail before touching GitHub: a wrong keychain item otherwise surfaces as "Not logged in" inside the sandbox.
if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(claudeToken)) {
  throw new Error(
    `The keychain item '${kit().keychain.claudeToken}' doesn't look like a Claude token (sk-ant-...). ` +
      "Re-run bin/setup-keychain.sh --token with the output of 'claude setup-token'.",
  );
}
initStatus({
  kit: kitVersion(KIT),
  node: process.version,
  once,
  pollSeconds: kit().pollSeconds,
  wipLimit: kit().wipLimit,
  rounds: kit().rounds,
  sessions: kit().sessions,
  repos: kit().repos,
  phase: "pass",
});
setInterval(() => writeStatus({}), 15_000).unref(); // the heartbeat: a stale beatAt means a stuck factory
interruptLeftovers();

let opened: Repo[] = [];
for (const { slug, path } of kit().repos) {
  try {
    const repo = openRepo(slug, path);
    opened.push(repo);
    releaseOrphans(repo, await appToken(repo));
  } catch (error) {
    log(`${slug}: could not check for stale claims: ${(error as Error).message}`);
  }
}

const stopSignal = signalHandler(
  () => {
    writeStatus({ phase: "draining" });
    const current = currentStatus()?.current;
    log(
      current
        ? `Draining: finishing ${current.repo}#${current.issue}, then stopping. Ctrl+C / SIGTERM again to stop now.`
        : "Draining: nothing is running, so stopping after this step. Ctrl+C / SIGTERM again to stop now.",
    );
  },
  async () => {
    const current = currentStatus()?.current;
    log(current ? `Stopping now: cutting off ${current.repo}#${current.issue}.` : "Stopping now.");
    interruptLeftovers();
    const repo = current && opened.find((r) => r.slug === current.repo);
    if (repo && current) {
      try {
        labels(repo, await appToken(repo), current.issue, { remove: ["agent:in-progress"] });
        note("factory", repo.slug, `stopped now: #${current.issue} is back in the queue`, { issue: current.issue });
      } catch (error) {
        log(`Could not put #${current.issue} back in the queue: ${(error as Error).message}`);
      }
    }
    writeStatus({ phase: "stopped", current: undefined, step: undefined });
    releaseLock();
    process.exit(130);
  },
);
process.on("SIGINT", stopSignal);
process.on("SIGTERM", stopSignal);

const names = kit()
  .repos.map((r) => r.slug)
  .join(", ");
log(
  once
    ? `Factory: one pass over ${names}.`
    : `Factory: watching ${names} every ${kit().pollSeconds}s. bin/factoryctl stop (or Ctrl+C) drains it.`,
);
for (;;) {
  writeStatus({ phase: draining() ? "draining" : "pass", step: undefined, current: undefined, nextPassAt: undefined });
  const repos: Repo[] = [];
  for (const { slug, path } of kit().repos) {
    try {
      const repo = openRepo(slug, path);
      mkdirSync(join(repo.root, RUNS), { recursive: true });
      repos.push(repo);
    } catch (error) {
      log(`${slug}: skipped this pass: ${(error as Error).message}`); // a bad config.yml stops only its repo
    }
  }
  opened = repos;
  for (const repo of repos) {
    for (const step of [fixFactoryPrs, reviewFindings, merges, followUps]) {
      if (draining()) break;
      writeStatus({ step: step.name as Step });
      try {
        await step(repo, claudeToken);
      } catch (error) {
        const message = (error as Error).message;
        writeStatus({ lastError: { at: new Date().toISOString(), step: `${step.name} (${repo.name})`, message } });
        note("error", repo.slug, `${repo.name} ${step.name}: ${message}`); // keep watching; the next pass retries
      }
    }
  }
  if (!draining()) {
    writeStatus({ step: "buildTickets" });
    try {
      await buildTickets(repos, claudeToken);
    } catch (error) {
      const message = (error as Error).message;
      writeStatus({ lastError: { at: new Date().toISOString(), step: "buildTickets", message } });
      note("error", "", `buildTickets: ${message}`);
    }
  }
  writeStatus({ lastPassAt: new Date().toISOString(), step: undefined });
  if (draining()) {
    finishDrain(() => writeStatus({ phase: "stopped", current: undefined, step: undefined }), releaseLock);
    log("Drained: nothing is running. Stopped.");
    process.exit(0);
  }
  if (once) break;
  const woke = await sleepUntilNextPass(kit().pollSeconds, {
    onSleep: (at) => writeStatus({ phase: "sleeping", nextPassAt: at.toISOString() }),
  });
  if (woke === "wake") log("Woken by factoryctl poll: starting a pass now.");
}
writeStatus({ phase: "stopped", current: undefined });
