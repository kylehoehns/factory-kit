import assert from "node:assert/strict";
import { test } from "node:test";
import { firstWait, isStuck, STUCK_MINUTES } from "./automerge.ts";

const later = (minutes: number) => minutes * 60_000;

test("a wait on the machinery is stuck once it has lasted long enough", () => {
  assert.equal(isStuck("unresolved review threads", 0, later(STUCK_MINUTES - 1)), false);
  assert.equal(isStuck("unresolved review threads", 0, later(STUCK_MINUTES)), true);
  assert.equal(isStuck("the second opinion errored (it posted nothing readable)", 0, later(240)), true);
  assert.equal(isStuck("ci not green", 0, later(STUCK_MINUTES)), true);
});

test("a wait that is the maintainer's, or no wait at all, is never stuck", () => {
  assert.equal(isStuck("not low tier, and no maintainer approval of the head commit", 0, later(600)), false);
  assert.equal(isStuck("labelled decision-needed", 0, later(600)), false);
  assert.equal(isStuck("labelled agent:blocked", 0, later(600)), false);
  assert.equal(isStuck(undefined, 0, later(600)), false);
});

test("a PR blocked for an errored second opinion reads as the maintainer's wait, so it isn't blocked again", () => {
  const blocked = new Set(["risk:low", "agent:blocked"]);
  const why = firstWait(blocked, "error", false);
  assert.equal(why, "labelled agent:blocked");
  assert.equal(isStuck(why, 0, later(600)), false);
  assert.equal(
    firstWait(new Set(["risk:low"]), "error", false),
    "the second opinion errored (it posted nothing readable)",
  );
  assert.equal(firstWait(new Set(["risk:medium"]), "success", false)?.startsWith("not low tier"), true);
  assert.equal(firstWait(new Set(["risk:medium"]), "success", true), undefined);
});
