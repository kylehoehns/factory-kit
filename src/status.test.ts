import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FACTORY_CACHE_DIR = mkdtempSync(join(tmpdir(), "factory-cache-"));
const { acquireLock, initStatus, note, paths, releaseLock, writeStatus } = await import("./status.ts");

/** Fake `pgrep` and `ps` first on the PATH: pgrep prints `pgrepOut` (nothing: exit 1), ps prints `psOut`. */
function fakeProcessTools(pgrepOut: string, psOut: string) {
  const dir = mkdtempSync(join(tmpdir(), "factory-ps-"));
  const script = (out: string) => (out ? `#!/bin/sh\necho "${out}"\n` : "#!/bin/sh\nexit 1\n");
  writeFileSync(join(dir, "pgrep"), script(pgrepOut));
  writeFileSync(join(dir, "ps"), script(psOut));
  chmodSync(join(dir, "pgrep"), 0o755);
  chmodSync(join(dir, "ps"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  return () => {
    process.env.PATH = before;
  };
}

test("the lock refuses while a live factory holds the pidfile", async () => {
  const other = spawn("sleep", ["30"]);
  const restore = fakeProcessTools("", "node src/factory.ts");
  try {
    writeFileSync(paths().pid, `${other.pid}\n`);
    const lock = acquireLock();
    assert.equal(lock.ok, false);
    assert.match(lock.ok ? "" : lock.message, new RegExp(`already running: pid ${other.pid}`));
    assert.equal(readFileSync(paths().pid, "utf8").trim(), String(other.pid));
  } finally {
    restore();
    other.kill();
  }
});

test("the lock replaces a stale pidfile, and takes it for this process", () => {
  const restore = fakeProcessTools("", "");
  try {
    writeFileSync(paths().pid, "999999\n");
    assert.deepEqual(acquireLock(), { ok: true });
    assert.equal(readFileSync(paths().pid, "utf8").trim(), String(process.pid));
    releaseLock();
    assert.equal(existsSync(paths().pid), false);
  } finally {
    restore();
  }
});

test("the lock refuses when pgrep finds another factory, even with no pidfile (a hand-started one)", () => {
  const restore = fakeProcessTools(`${process.pid}\n86002`, "");
  try {
    const lock = acquireLock();
    assert.equal(lock.ok, false);
    assert.equal(lock.ok ? 0 : lock.pid, 86002);
  } finally {
    restore();
  }
});

test("writeStatus replaces status.json whole: no .tmp left, it parses, and carries the controls marker", () => {
  initStatus({
    kit: { sha: "abc1234", subject: "x", dirty: false },
    node: process.version,
    once: false,
    pollSeconds: 60,
    wipLimit: 3,
    rounds: { ci: 2, review: 2, update: 2 },
    sessions: {},
    repos: [],
    phase: "pass",
  });
  writeStatus({ phase: "sleeping", nextPassAt: "2026-10-24T00:00:00.000Z" });
  writeStatus({ nextPassAt: undefined });
  assert.deepEqual(
    readdirSync(paths().dir).filter((f) => f.endsWith(".tmp")),
    [],
  );
  const status = JSON.parse(readFileSync(paths().status, "utf8"));
  assert.equal(status.phase, "sleeping");
  assert.equal(status.controls, 1);
  assert.equal(status.pid, process.pid);
  assert.equal(status.launchedFrom, "terminal");
  assert.equal("nextPassAt" in status, false);
});

test("note() appends an event, and rotates events.jsonl past 512 KB to its last 1,000 lines", (t) => {
  t.mock.method(console, "log", () => {});
  note("merged", "me/repo", "repo PR #3: auto-merged", { pr: 3, issue: 2, tier: "low" });
  const first = JSON.parse(readFileSync(paths().events, "utf8").split("\n")[0] ?? "");
  assert.equal(first.kind, "merged");
  assert.equal(first.tier, "low");
  const filler = "x".repeat(600);
  for (let i = 0; i < 1500; i++) note("factory", "", `idle: nothing ready ${filler}`);
  const lines = readFileSync(paths().events, "utf8").trim().split("\n");
  assert.ok(lines.length <= 1000, `${lines.length} lines kept`);
  assert.equal(
    lines.some((line) => JSON.parse(line).kind === "merged"),
    false,
  ); // the oldest rotated out
  assert.ok(lines.every((line) => JSON.parse(line).kind));
});
