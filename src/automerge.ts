// Merging factory PRs. Each repo sets its stage with `autoMerge` in .factory/config.yml.
// Low tier, no human, in stages:
//   off     nothing happens (approved PRs aren't merged either: `off` stops all factory merges)
//   shadow  the factory comments "would auto-merge" once per head commit; the maintainer still merges
//   on      the factory merges, unless the stop rule has tripped
// Medium and high tier: once a maintainer has approved the head commit and everything is green, the factory merges
// it in `shadow` and `on` alike. The decision was the maintainer's; the factory only clicks the button.

import { api, ciResult, comment, type FactoryPr, gh, reviewThreads, settleThread, type Thread } from "./github.ts";
import { BRANCH_PREFIX, type Repo, run } from "./shared.ts";
import { log, note } from "./status.ts";

const MARK = (sha: string) => `<!-- factory-auto-merge sha=${sha} -->`;
const AUTO_MERGED = "Auto-merged by the factory";
const short = (pr: FactoryPr) => pr.headRefOid.slice(0, 7);
const tierOf = (pr: FactoryPr) => pr.labels.find((l) => l.name.startsWith("risk:"))?.name.slice(5);
const facts = (pr: FactoryPr) => ({
  pr: pr.number,
  issue: Number(pr.headRefName.slice(BRANCH_PREFIX.length)),
  tier: tierOf(pr),
});

/** Says why on the PR, then squash-merges exactly the commit that was checked. */
async function merge(repo: Repo, token: string, pr: FactoryPr, why: string) {
  comment(repo, token, pr.number, `${why}\n\n${MARK(pr.headRefOid)}`);
  const body = JSON.stringify({ merge_method: "squash", sha: pr.headRefOid });
  await api(repo, token, `/pulls/${pr.number}/merge`, { method: "PUT", body });
}

/** The stop rule: a revert of any auto-merged PR pauses auto-merge until the maintainer turns it back on. */
function stopRuleTripped(repo: Repo, token: string): string | undefined {
  const reverts = run(repo, "git", ["log", "origin/main", "--since=30 days ago", "--grep=^Revert", "--format=%s%n%b"]);
  for (const pr of new Set([...reverts.matchAll(/#(\d+)/g)].map((m) => m[1]))) {
    const comments = gh(
      repo,
      token,
      "pr",
      "view",
      pr,
      "--json",
      "comments",
      "--jq",
      '[.comments[].body] | join("\\n")',
    );
    if (comments.includes(AUTO_MERGED)) return `#${pr} was auto-merged and later reverted`;
  }
  return undefined;
}

type Review = { user: { login: string }; state: string; commit_id: string };

/** The maintainer who approved this exact commit, if one did and hasn't since asked for changes. A push after the
 *  approval moves the head, so it needs approving again. */
async function approvedBy(repo: Repo, token: string, pr: FactoryPr): Promise<string | undefined> {
  // Maintainers come from .factory/config.yml on main: a PR can't add itself to the list.
  const people = repo.config.maintainers;
  const reviews = (await api<Review[]>(repo, token, `/pulls/${pr.number}/reviews?per_page=100`)).filter(
    (r) => people.includes(r.user.login) && r.state !== "COMMENTED",
  );
  const latest = reviews.at(-1);
  return latest?.state === "APPROVED" && latest.commit_id === pr.headRefOid ? latest.user.login : undefined;
}

/** A thread opened by a reviewer bot for a finding ("[one-way-door] **title**", "[blocker] **title**"). Left open, it
 *  waits for the maintainer; once they approve the head commit with no decision-needed label, it is settled. */
const isFinding = (t: Thread) => /^\[(one-way-door|blocker)\] \*\*/.test(t.body);

/** Why this PR can't merge yet, or undefined if it can. `approver` is set for a medium or high PR a maintainer approved. */
async function qualifies(
  repo: Repo,
  token: string,
  pr: FactoryPr,
  approver: string | undefined,
): Promise<string | undefined> {
  const labels = new Set(pr.labels.map((l) => l.name));
  const { statuses } = await api<{ statuses: { context: string; state: string }[] }>(
    repo,
    token,
    `/commits/${pr.headRefOid}/status`,
  );
  const opinion = statuses.find((s) => s.context === "second-opinion")?.state;
  // Said first, because an errored opinion is also why a small PR isn't low tier yet.
  if (opinion === "error") return "the second opinion errored (it posted nothing readable)";
  if (!labels.has("risk:low") && !approver) return "not low tier, and no maintainer approval of the head commit";
  for (const label of ["decision-needed", "agent:blocked"]) if (labels.has(label)) return `labelled ${label}`;
  const ci = await ciResult(repo, token, pr.headRefOid);
  if (!ci || ci.failed) return "ci not green";
  if (statuses.find((s) => s.context === "risk-gate")?.state !== "success") return "risk-gate not green";
  // High tier also needs the independent second opinion to have read this commit (rsvp-factory's ADR 0003). A pass or a fail both
  // count: a fail leaves blockers (fix rounds) or a decision-needed label, and both wait for the maintainer anyway.
  if (labels.has("risk:high") && opinion !== "success" && opinion !== "failure") {
    return "the second opinion hasn't read the head commit";
  }
  const open = (await reviewThreads(repo, token, pr.number)).filter((t) => !t.isResolved);
  // An approval settles open finding threads; any other open thread (a person's comment) still waits.
  if (open.some((t) => !(approver && isFinding(t)))) return "unresolved review threads";
  return undefined;
}

/** The last reason given for each PR waiting, so it is noted when it changes, not every pass. */
const waiting = new Map<string, string | undefined>();

export async function autoMerge(repo: Repo, token: string, prs: FactoryPr[]) {
  const mode = repo.config.autoMerge;
  if (mode === "off") return;
  const stopped = mode === "on" ? stopRuleTripped(repo, token) : undefined;
  for (const pr of prs) {
    const approver = pr.labels.some((l) => l.name === "risk:low") ? undefined : await approvedBy(repo, token, pr);
    const why = await qualifies(repo, token, pr, approver);
    const key = `${repo.slug}#${pr.number}`;
    // Say once why a PR is waiting, so a green PR that never merges isn't silent.
    if (why !== waiting.get(key)) {
      waiting.set(key, why);
      if (why) note("pr", repo.slug, `${repo.name} PR #${pr.number}: waiting: ${why}`, facts(pr));
    }
    if (why !== undefined) continue;
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
    if (comments.includes(MARK(pr.headRefOid))) continue;
    if (approver) {
      const settled = (await reviewThreads(repo, token, pr.number)).filter((t) => !t.isResolved && isFinding(t));
      for (const t of settled) await settleThread(token, t.id, `Settled by ${approver}'s approval of ${short(pr)}.`);
      // Not an auto-merge: a revert of this PR doesn't trip the stop rule, because a person approved it.
      await merge(
        repo,
        token,
        pr,
        `Merged by the factory: ${approver} approved ${short(pr)} and all checks are green.`,
      );
      note("merged", repo.slug, `${repo.name} PR #${pr.number}: merged after ${approver}'s approval`, facts(pr));
      continue;
    }
    if (mode === "shadow" || stopped) {
      const why = stopped
        ? `Auto-merge is paused by the stop rule: ${stopped}.`
        : "Shadow mode: the maintainer merges.";
      const note = `Would auto-merge: low tier, all checks green, nothing left open. ${why}`;
      comment(repo, token, pr.number, `${note}\n\n${MARK(pr.headRefOid)}`);
      log(`${repo.name} PR #${pr.number}: would auto-merge (${stopped ? "paused" : "shadow"})`);
      continue;
    }
    await merge(repo, token, pr, `${AUTO_MERGED}: low tier, all checks green, nothing left open.`);
    note("merged", repo.slug, `${repo.name} PR #${pr.number}: auto-merged`, facts(pr));
  }
}
