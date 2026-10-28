import assert from "node:assert/strict";
import { test } from "node:test";
import { answerTo, context, earlierFindings, lastReviewed, onlyFiles, ticketIn, ticketText } from "./opinion.ts";

test("the ticket is the one the PR body closes", () => {
  assert.equal(ticketIn("## Summary\n\nDid it.\n\nCloses #82\n"), 82);
  assert.equal(ticketIn("fixes #3 and closes #4"), 3);
  assert.equal(ticketIn("Resolved: #7"), 7);
  assert.equal(ticketIn("See #82 for background"), undefined);
  assert.equal(ticketIn("enclosed #5"), undefined);
});

const opinion = (findings: unknown) =>
  `Second opinion\n\nStuff.\n\n\`\`\`findings\n${JSON.stringify(findings)}\n\`\`\``;
const blocker = (title: string, body = "why") => ({ kind: "blocker", title, path: "src/a.ts", line: 3, body });

test("the ticket text has its body and every comment, in order", () => {
  const text = ticketText({
    number: 82,
    title: "Organizers see attendance",
    body: "Signed-out visitors get not-an-organizer.",
    comments: [
      { author: { login: "kylehoehns" }, body: "Correction: signed-out visitors get 401." },
      { author: { login: "kh-factory-bot" }, body: "## Agent Brief\n\nBuild it." },
    ],
  });
  assert.match(text, /^# #82: Organizers see attendance\n\nSigned-out visitors get not-an-organizer\.\n\n/);
  assert.ok(text.indexOf("Correction") < text.indexOf("Agent Brief"));
  assert.match(text, /## Comment by kylehoehns\n\nCorrection/);
});

test("the last reviewed commit is the newest one before the head whose opinion passed or failed", () => {
  const states = new Map([
    ["a", "failure"],
    ["b", "success"],
    ["c", "error"],
    ["d", "success"],
  ]);
  assert.equal(lastReviewed(["a", "b", "c", "d"], states, "d"), "b");
  assert.equal(lastReviewed(["a", "b", "c"], states, "c"), "b");
  assert.equal(lastReviewed(["c", "d"], states, "d"), undefined);
});

test("earlier findings keep the latest copy of each title and skip unreadable opinions", () => {
  const findings = earlierFindings([
    opinion([blocker("Missing check", "first"), blocker("Leaks email")]),
    "Second opinion\n\n```findings\nnot json\n```",
    opinion([blocker("Missing check", "second")]),
  ]);
  assert.deepEqual(
    findings.map((f) => [f.title, f.body]),
    [
      ["Missing check", "second"],
      ["Leaks email", "why"],
    ],
  );
});

test("the answer is every reply on the thread the factory posted for the second opinion's finding", () => {
  const comments = [
    { id: 1, body: "[blocker] **Missing check**: why\n\n_From the second opinion._" },
    { id: 2, body: "[blocker] **Missing check**: why" }, // the factory's own reviewer, not the second opinion
    { id: 3, body: "**Not changed:** it is checked upstream", in_reply_to_id: 2 },
    { id: 4, body: "**Not changed:** it is checked upstream", in_reply_to_id: 1 },
    { id: 5, body: "Settled by the maintainer's decision.", in_reply_to_id: 1 },
    { id: 6, body: "[blocker] **Leaks email**\n\nwhy" }, // posted before the factory signed its threads
    { id: 7, body: "**Fixed in `abc1234`:** dropped it", in_reply_to_id: 6 },
  ];
  assert.equal(
    answerTo(blocker("Missing check"), comments),
    "**Not changed:** it is checked upstream / Settled by the maintainer's decision.",
  );
  assert.equal(answerTo(blocker("Leaks email"), comments), "**Fixed in `abc1234`:** dropped it");
  assert.equal(answerTo(blocker("Unanswered"), comments), undefined);
});

test("only the parts of a diff that touch the PR's own files are kept", () => {
  const part = (path: string) =>
    `diff --git a/${path} b/${path}\nindex 1..2\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\n`;
  const diff = part("src/a.ts") + part("src/from-main.ts") + part("src/b.ts");
  assert.equal(onlyFiles(diff, ["src/a.ts", "src/b.ts"]), part("src/a.ts") + part("src/b.ts"));
});

test("the context says it's the first round, or lists what was found before with the factory's answers", () => {
  assert.match(context(undefined, [], []), /first second opinion/);
  const text = context(
    "abc1234",
    [blocker("Missing check"), blocker("Leaks email")],
    ["**Fixed:** added it", undefined],
  );
  assert.match(text, /read this PR at `abc1234`/);
  assert.match(
    text,
    /- \[blocker\] \*\*Missing check\*\* \(`src\/a.ts:3`\): why\n {2}Factory's answer: \*\*Fixed:\*\* added it/,
  );
  assert.match(text, /- \[blocker\] \*\*Leaks email\*\* \(`src\/a.ts:3`\): why$/m);
});
