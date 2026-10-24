import assert from "node:assert/strict";
import { test } from "node:test";
import { type Finding, followUpsIn, secondOpinion, withFollowUps } from "./findings.ts";

const f = (title: string): Finding => ({ kind: "follow-up", title, path: "app/X.java", line: 3, body: "why" });

test("follow-ups survive a round trip through the PR body", () => {
  const body = withFollowUps("## Summary\n\nDid things.\n\nCloses #3\n", [f("Widen column"), f("Rate limit")]);
  assert.match(body, /### Follow-ups \(filed as tickets when this PR merges\)/);
  assert.deepEqual(followUpsIn(body).map((x) => x.title), ["Widen column", "Rate limit"]);
  assert.match(body, /Closes #3/);
});

test("rewriting the list replaces it instead of appending a second one", () => {
  const once = withFollowUps("Body\n", [f("A")]);
  const twice = withFollowUps(once, [f("A"), f("B")]);
  assert.equal(twice.match(/### Follow-ups/g)?.length, 1);
  assert.equal(twice.match(/factory-follow-ups\n/g)?.length, 1);
  assert.deepEqual(followUpsIn(twice).map((x) => x.title), ["A", "B"]);
});

test("an empty list removes the section", () => {
  assert.equal(withFollowUps(withFollowUps("Body\n", [f("A")]), []), "Body\n");
});

test("the latest second opinion's findings block is read", () => {
  const opinion = (n: string, json: string) => ({ id: n, body: `Second opinion (security)\n\nStuff.\n\n\`\`\`findings\n${json}\n\`\`\`` });
  const read = secondOpinion([opinion("old", "[]"), { id: "x", body: "unrelated" }, opinion("new", '[{"kind":"blocker","title":"T","body":"B"}]')]);
  assert.equal(read?.id, "new");
  assert.equal(read?.findings[0].kind, "blocker");
});

test("a second opinion without a readable findings block is left to the maintainer", () => {
  assert.equal(secondOpinion([{ id: "1", body: "Second opinion (security)\n\nNo block here." }]), undefined);
  assert.equal(secondOpinion([{ id: "2", body: "Second opinion (security)\n```findings\nnot json\n```" }]), undefined);
});
