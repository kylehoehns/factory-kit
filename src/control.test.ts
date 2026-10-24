import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Repo } from "./shared.ts";

process.env.FACTORY_CACHE_DIR = mkdtempSync(join(tmpdir(), "factory-cache-"));
const {
  buildUntilDrained,
  clearControlFiles,
  finishDrain,
  releaseOrphans,
  sessionSignal,
  signalHandler,
  sleepUntilNextPass,
  stopNow,
} = await import("./control.ts");
const { initStatus, paths, writeStatus } = await import("./status.ts");

test("the drain file stops claims after the build that is running, then the factory writes phase 'stopped'", async () => {
  initStatus({
    kit: { sha: "", subject: "", dirty: false },
    node: process.version,
    once: false,
    pollSeconds: 60,
    wipLimit: 3,
    rounds: { ci: 2, review: 2, update: 2 },
    sessions: {},
    repos: [],
    phase: "pass",
  });
  writeFileSync(paths().pid, `${process.pid}\n`);
  const claimed: number[] = [];
  const built: number[] = [];
  const result = await buildUntilDrained(
    async () => {
      const next = [5, 6, 7][claimed.length];
      if (next) claimed.push(next);
      return next;
    },
    async (ticket) => {
      writeFileSync(paths().drain, ""); // `factoryctl stop` while #5 builds
      built.push(ticket);
    },
  );
  assert.equal(result, "drained");
  assert.deepEqual(claimed, [5]);
  assert.deepEqual(built, [5]);
  let released = false;
  finishDrain(
    () => writeStatus({ phase: "stopped" }),
    () => {
      released = true;
    },
  );
  assert.equal(JSON.parse(readFileSync(paths().status, "utf8")).phase, "stopped");
  assert.equal(existsSync(paths().drain), false);
  assert.equal(released, true);
});

test("the wake file ends the sleep between passes early, and is removed", async () => {
  rmSync(paths().drain, { force: true });
  setTimeout(() => writeFileSync(paths().wake, ""), 30);
  const started = Date.now();
  const result = await sleepUntilNextPass(60, { sliceMs: 10 });
  assert.equal(result, "wake");
  assert.ok(Date.now() - started < 2000);
  assert.equal(existsSync(paths().wake), false);
});

test("one Ctrl+C delivered twice within 2s (npm forwards it, the terminal signals the group) only drains", () => {
  let clock = 1_000_000;
  let drained = 0;
  let stopped = 0;
  const handle = signalHandler(
    () => drained++,
    () => {
      stopped++;
    },
    () => clock,
  );
  handle();
  clock += 50;
  handle();
  clock += 1900;
  handle();
  assert.equal(drained, 1);
  assert.equal(stopped, 0);
});

test("the first signal drains; the second aborts every session's signal", () => {
  let clock = 1_000_000;
  const signal = sessionSignal(60_000);
  let drained = 0;
  let stopped = 0;
  const handle = signalHandler(
    () => drained++,
    () => {
      stopped++;
    },
    () => clock,
  );
  handle();
  assert.equal(drained, 1);
  assert.equal(signal.aborted, false);
  assert.equal(existsSync(paths().drain), false); // a signal drains in memory; the file is factoryctl's
  clock += 2500;
  handle();
  assert.equal(stopped, 1);
  assert.equal(stopNow.signal.aborted, true);
  assert.equal(signal.aborted, true);
});

test("a drain or wake file left by a stop now or a crash is cleared, so the next start does not drain at once", () => {
  writeFileSync(paths().drain, "");
  writeFileSync(paths().wake, "");
  clearControlFiles();
  assert.equal(existsSync(paths().drain), false);
  assert.equal(existsSync(paths().wake), false);
  clearControlFiles(); // nothing there: still fine
});

test("startup and stop now both clear the control files; factoryctl spaces its two TERMs past the repeat window", () => {
  const factory = readFileSync(join(import.meta.dirname, "factory.ts"), "utf8");
  assert.ok(factory.indexOf("clearControlFiles();") > factory.indexOf("acquireLock()"));
  assert.match(factory, /clearControlFiles\(\);\n\s*releaseLock\(\);\n\s*process\.exit\(130\)/);
  assert.match(
    readFileSync(join(import.meta.dirname, "..", "bin", "factoryctl"), "utf8"),
    /kill -TERM \$pid[^\n]*\n\s*sleep 3/,
  );
});

test("no SIGUSR1 handler anywhere in the kit", () => {
  for (const file of ["factory.ts", "control.ts", "status.ts", "sandbox.ts"]) {
    assert.doesNotMatch(readFileSync(join(import.meta.dirname, file), "utf8"), /USR1/);
  }
});

test("startup releases agent:in-progress only from tickets with no open agent/issue-N PR", (t) => {
  t.mock.method(console, "log", () => {});
  const dir = mkdtempSync(join(tmpdir(), "factory-gh-"));
  const log = join(dir, "calls");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "issue list") echo '[{"number":4},{"number":5},{"number":9}]' ;;
  "pr list") echo '[{"headRefName":"agent/issue-5"},{"headRefName":"feature/x"}]' ;;
esac
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const repo = { slug: "me/repo", name: "repo", root: dir } as Repo;
  assert.deepEqual(releaseOrphans(repo, "t"), [4, 9]);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(
    calls.filter((c) => c.startsWith("issue edit")),
    [
      "issue edit 4 --remove-label agent:in-progress --repo me/repo",
      "issue edit 9 --remove-label agent:in-progress --repo me/repo",
    ],
  );
  const events = readFileSync(paths().events, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((e) => e.text),
    ["released stale claim on #4", "released stale claim on #9"],
  );
});
