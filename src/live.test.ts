import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.FACTORY_LIVE = join(mkdtempSync(join(tmpdir(), "factory-live-")), "live.json");
const { interruptLeftovers, LIVE, recordStart } = await import("./live.ts");
const sessions = () => JSON.parse(readFileSync(LIVE, "utf8"));

test("a session is listed as running, then with its outcome", () => {
  const finished = recordStart({ repo: "me/repo", issue: 3, role: "implement", log: "/tmp/implement-3.log" });
  assert.equal(sessions()[0].outcome, undefined);
  finished("question", "Which rounding?");
  assert.equal(sessions()[0].outcome, "question");
  assert.equal(sessions()[0].summary, "Which rounding?");
});

test("sessions a stopped factory left running are marked interrupted", () => {
  recordStart({ repo: "me/repo", issue: 4, role: "review", log: "/tmp/review-4.log" });
  interruptLeftovers();
  assert.equal(sessions().at(-1).outcome, "interrupted");
});

test("each save replaces live.json whole: no .tmp file is left, and it parses", () => {
  const finished = recordStart({ repo: "me/repo", issue: 5, role: "implement", log: "/tmp/implement-5.log" });
  finished("success", "Done.");
  assert.deepEqual(
    readdirSync(dirname(LIVE)).filter((f) => f.endsWith(".tmp")),
    [],
  );
  assert.equal(sessions().at(-1).outcome, "success");
  assert.match(finished.startedAt, /^\d{4}-\d\d-\d\dT/);
});
