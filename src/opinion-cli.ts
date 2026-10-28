// Run before the second opinion in second-opinion.yml. Writes its inputs to .second-opinion/:
//   pr.md         the PR's title and description
//   diff.patch    the PR's diff
//   ticket.md     the ticket it closes, with comments
//   context.md    what earlier rounds found and how the factory answered
//   changes.diff  what changed since the last commit an earlier round read (later rounds only)
// prompts/second-opinion.md reads only these and the checkout, so the eval harness can replay it offline.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerTo,
  context,
  earlierFindings,
  type Issue,
  lastReviewed,
  onlyFiles,
  type ReviewComment,
  ticketIn,
  ticketText,
} from "./opinion.ts";

const { PR, SHA, GITHUB_REPOSITORY } = process.env as Record<string, string>;
const DIR = ".second-opinion";
const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const api = <T>(path: string): T => JSON.parse(gh("api", "--paginate", "--slurp", path)).flat();
const write = (file: string, text: string) => writeFileSync(join(DIR, file), text);

mkdirSync(DIR, { recursive: true });
const pr = JSON.parse(gh("pr", "view", PR, "--json", "title,body,comments")) as {
  title: string;
  body: string;
  comments: { body: string }[];
};
write("pr.md", `# ${pr.title}\n\n${pr.body}\n`);
write("diff.patch", gh("pr", "diff", PR));
const ticket = ticketIn(pr.body);
write(
  "ticket.md",
  ticket
    ? ticketText(JSON.parse(gh("issue", "view", String(ticket), "--json", "number,title,body,comments")) as Issue)
    : "This PR names no ticket (no `Closes #N`): check it against its description instead.\n",
);

// Earlier rounds. If they can't be read, this round reviews the whole diff, as a first round would.
try {
  const opinions = pr.comments.map((c) => c.body).filter((body) => body.startsWith("Second opinion"));
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
  if (reviewed) {
    const files = gh("pr", "view", PR, "--json", "files", "--jq", ".files[].path").split("\n").filter(Boolean);
    const diff = gh(
      "api",
      `repos/${GITHUB_REPOSITORY}/compare/${reviewed}...${SHA}`,
      "-H",
      "Accept: application/vnd.github.diff",
    );
    write("changes.diff", onlyFiles(diff, files));
  }
  const findings = earlierFindings(opinions);
  const comments = reviewed ? api<ReviewComment[]>(`repos/${GITHUB_REPOSITORY}/pulls/${PR}/comments`) : [];
  write(
    "context.md",
    context(
      reviewed?.slice(0, 7),
      findings,
      findings.map((f) => answerTo(f, comments)),
    ),
  );
  console.log(reviewed ? `earlier round read ${reviewed}; ${findings.length} earlier finding(s)` : "first round");
} catch (e) {
  write("context.md", context(undefined, [], []));
  console.log(`could not read earlier rounds, so this one reviews the whole diff: ${e}`);
}
console.log(`ticket: ${ticket ? `#${ticket}` : "none"}`);
