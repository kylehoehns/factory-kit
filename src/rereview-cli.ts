// Run before the second opinion in second-opinion.yml: writes .second-opinion/context.md (what earlier rounds found and
// how the factory answered) and .second-opinion/changes.diff (what changed since the last commit it read).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { answerTo, context, earlierFindings, lastReviewed, onlyFiles, type ReviewComment } from "./rereview.ts";

const { PR, SHA, GITHUB_REPOSITORY } = process.env as Record<string, string>;
const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const api = <T>(path: string): T => JSON.parse(gh("api", "--paginate", "--slurp", path)).flat();

const opinions = (JSON.parse(gh("pr", "view", PR, "--json", "comments")).comments as { body: string }[])
  .map((c) => c.body)
  .filter((body) => body.startsWith("Second opinion"));
const commits = api<{ sha: string }[]>(`repos/${GITHUB_REPOSITORY}/pulls/${PR}/commits`).map((c) => c.sha);
const states = new Map(
  commits.map((sha) => [
    sha,
    gh(
      "api",
      `repos/${GITHUB_REPOSITORY}/commits/${sha}/status`,
      "--jq",
      '.statuses[] | select(.context == "second-opinion") | .state',
    ).trim() || undefined,
  ]),
);
const reviewed = opinions.length ? lastReviewed(commits, states, SHA) : undefined;

mkdirSync(".second-opinion", { recursive: true });
if (reviewed) {
  const files = gh("pr", "view", PR, "--json", "files", "--jq", ".files[].path").split("\n").filter(Boolean);
  const diff = gh(
    "api",
    `repos/${GITHUB_REPOSITORY}/compare/${reviewed}...${SHA}`,
    "-H",
    "Accept: application/vnd.github.diff",
  );
  writeFileSync(".second-opinion/changes.diff", onlyFiles(diff, files));
}
const findings = earlierFindings(opinions);
const comments = reviewed ? api<ReviewComment[]>(`repos/${GITHUB_REPOSITORY}/pulls/${PR}/comments`) : [];
writeFileSync(
  ".second-opinion/context.md",
  context(
    reviewed?.slice(0, 7),
    findings,
    findings.map((f) => answerTo(f, comments)),
  ),
);
console.log(reviewed ? `earlier round read ${reviewed}; ${findings.length} earlier finding(s)` : "first round");
