// The second opinion's verdict, pinned to the commit it read: run after the review in second-opinion.yml.
// Pass means no blocker and no one-way door. Anything unreadable is an error, never a pass.

import { execFileSync } from "node:child_process";

const { PR, SHA, STARTED, GITHUB_REPOSITORY } = process.env as Record<string, string>;
const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8" });

const comments = (
  JSON.parse(gh("pr", "view", PR, "--json", "comments")).comments as { body: string; createdAt: string }[]
).filter((c) => c.body.startsWith("Second opinion") && c.createdAt >= STARTED);
const block = comments.at(-1)?.body.match(/```findings\s*\n([\s\S]*?)```/)?.[1];

let state = "error";
let why = "no readable second opinion";
try {
  const open =
    block === undefined
      ? undefined
      : (JSON.parse(block) as { kind: string }[]).filter((f) => f.kind === "blocker" || f.kind === "one-way-door");
  if (open?.length === 0) [state, why] = ["success", "matches the ticket and standards; no blockers or one-way doors"];
  else if (open) [state, why] = ["failure", `${open.length} blocker(s) or one-way door(s)`];
} catch {
  // unreadable findings: stays an error
}
gh(
  "api",
  `repos/${GITHUB_REPOSITORY}/statuses/${SHA}`,
  "-f",
  `state=${state}`,
  "-f",
  "context=second-opinion",
  "-f",
  `description=${why}`,
);
console.log(state, why);
