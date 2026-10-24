import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { comment, labels, noMentions } from "./github.ts";
import type { Repo } from "./shared.ts";

test("@words outside code are backticked so they mention nobody", () => {
  assert.equal(noMentions("Moved @Test back onto its method."), "Moved `@Test` back onto its method.");
  assert.equal(noMentions("@Transactional first"), "`@Transactional` first");
});

test("code, emails and issue refs are left alone", () => {
  const body = "Already `@Test` here.\n```java\n@Test void x() {}\n```\nMail a@b.com about #86.";
  assert.equal(noMentions(body), body);
});

/** A fake `gh` on the PATH that records its arguments, one call per line. */
function fakeGh(): { repo: Repo; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "factory-gh-"));
  const log = join(dir, "calls");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const repo = { slug: "me/repo", name: "repo", root: dir } as Repo;
  return { repo, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

test("comment and labels each make one gh call", () => {
  // Regression: comment() once called itself, and every factory comment overflowed the stack.
  const { repo, calls } = fakeGh();
  comment(repo, "t", 7, "Hello @Test");
  labels(repo, "t", 7, { add: ["needs-info"], remove: ["ready-for-agent", "agent:in-progress"] });
  assert.deepEqual(calls(), [
    "issue comment 7 --body Hello `@Test` --repo me/repo",
    "issue edit 7 --add-label needs-info --remove-label ready-for-agent --remove-label agent:in-progress --repo me/repo",
  ]);
});
