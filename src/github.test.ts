import assert from "node:assert/strict";
import { test } from "node:test";
import { noMentions } from "./github.ts";

test("@words outside code are backticked so they mention nobody", () => {
  assert.equal(noMentions("Moved @Test back onto its method."), "Moved `@Test` back onto its method.");
  assert.equal(noMentions("@Transactional first"), "`@Transactional` first");
});

test("code, emails and issue refs are left alone", () => {
  const body = "Already `@Test` here.\n```java\n@Test void x() {}\n```\nMail a@b.com about #86.";
  assert.equal(noMentions(body), body);
});
