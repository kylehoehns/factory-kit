// Fix rounds on open factory PRs, each capped (Stripe: at most two CI rounds, then a human):
//   ci      the `ci` check failed on the PR's head commit: a session gets the failed steps' log
//   update  the PR conflicts with main (another PR merged first): a session merges main in and resolves it

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appToken,
  ciResult,
  comment,
  type FactoryPr,
  failedLog,
  openFactoryPrs,
  push,
  requestSecondOpinion,
  roundMarker,
  roundsTried,
} from "./github.ts";
import { pruneWorktrees, runSessions, type Session } from "./sandbox.ts";
import { BRANCH_PREFIX, forbiddenChanges, kit, type Repo, RUNS, run } from "./shared.ts";

export type Hooks = {
  writeTask: (issue: number, token: string) => Promise<void>;
  block: (token: string, target: number, reason: string) => void;
};
type Round = { kind: "ci" | "update"; name: string; session: Session; max: number; inputs: string[] };

async function fixRound(repo: Repo, pr: FactoryPr, round: Round, claudeToken: string, hooks: Hooks, token: string) {
  const tried = roundsTried(repo, token, pr.number, round.kind);
  if (tried.includes(pr.headRefOid)) return; // this commit already had its round
  if (tried.length >= round.max) {
    hooks.block(token, pr.number, `${round.name} is still needed after ${tried.length} rounds.`);
    return;
  }
  const n = tried.length + 1;
  const issue = Number(pr.headRefName.slice(BRANCH_PREFIX.length));
  const branch = pr.headRefName;
  console.log(`${repo.name} PR #${pr.number}: ${round.name}, round ${n} of ${round.max}`);
  await hooks.writeTask(issue, token);
  run(repo, "git", ["fetch", "--quiet", "origin", "main", branch]);
  pruneWorktrees(repo);
  run(repo, "git", ["branch", "--force", branch, `origin/${branch}`]);

  const { outcome } = await runSessions(repo, issue, branch, [round.session], round.inputs, claudeToken);
  const fresh = await appToken(repo);
  const commits = run(repo, "git", ["rev-list", `origin/${branch}..${branch}`]);
  const forbidden = forbiddenChanges(repo, branch);
  const label = `${round.name}, round ${n} of ${round.max}`;
  if (outcome.outcome !== "success" || !commits || forbidden.length) {
    const why = forbidden.length
      ? `the session touched the factory's own controls: ${forbidden.join(", ")}`
      : !commits
        ? `the session made no commits (${outcome.summary})`
        : outcome.summary;
    comment(repo, fresh, pr.number, `${label}: ${why}\n\n${roundMarker(round.kind, pr.headRefOid)}`);
    hooks.block(fresh, pr.number, why);
    return;
  }
  push(repo, fresh, branch); // fast-forward only
  comment(repo, fresh, pr.number, `${label}: ${outcome.summary}\n\n${roundMarker(round.kind, pr.headRefOid)}`);
  requestSecondOpinion(repo, fresh, pr.number); // the new commits haven't been read by anyone independent
  console.log(`${repo.name} PR #${pr.number}: pushed ${label}`);
}

export async function fixPrs(repo: Repo, claudeToken: string, hooks: Hooks) {
  const task = join(repo.root, RUNS, "task.md");
  const ciLog = join(repo.root, RUNS, "ci-failure.log");
  const token = await appToken(repo);
  for (const pr of openFactoryPrs(repo, token, BRANCH_PREFIX)) {
    if (pr.labels.some((l) => l.name === "agent:blocked")) continue;
    if (pr.mergeable === "CONFLICTING") {
      await fixRound(
        repo,
        pr,
        {
          kind: "update",
          name: "Updating with main",
          max: kit().rounds.update,
          inputs: [task],
          session: { role: "updateBranch", prompt: "update-branch.md" },
        },
        claudeToken,
        hooks,
        token,
      );
      continue; // CI on a conflicting branch says nothing useful; look again after the update
    }
    const ci = await ciResult(repo, token, pr.headRefOid);
    if (!ci?.failed) continue;
    if (roundsTried(repo, token, pr.number, "ci").includes(pr.headRefOid)) continue;
    writeFileSync(ciLog, failedLog(repo, ci.runId));
    await fixRound(
      repo,
      pr,
      {
        kind: "ci",
        name: "CI fix",
        max: kit().rounds.ci,
        inputs: [task, ciLog],
        session: { role: "fixCi", prompt: "fix-ci.md" },
      },
      claudeToken,
      {
        ...hooks,
        block: (t, target, reason) =>
          hooks.block(t, target, `${reason} Latest failure: https://github.com/${repo.slug}/actions/runs/${ci.runId}`),
      },
      token,
    );
  }
}
