import assert from "node:assert/strict";
import { test } from "node:test";
import { pick, type Ticket } from "./dispatch.ts";

const MAINTAINERS = ["kylehoehns"];

const ticket = (number: number, labels: string[] = [], o: Partial<Ticket> = {}): Ticket => ({
  number, labels: ["ready-for-agent", ...labels], openBlockers: 0, subIssues: 0, labelledBy: "kylehoehns", hasOpenPr: false, ...o,
});
const chosen = (tickets: Ticket[], wip = 0, limit = 1) => pick(tickets, wip, limit, MAINTAINERS)?.number;

test("the lowest-numbered ready ticket wins", () => {
  assert.equal(chosen([ticket(5), ticket(3), ticket(4)]), 3);
});

test("blocked tickets wait", () => {
  assert.equal(chosen([ticket(3, [], { openBlockers: 1 }), ticket(5)]), 5);
});

test("specs and parents are never dispatched", () => {
  assert.equal(chosen([ticket(1, ["spec"]), ticket(2, [], { subIssues: 3 })]), undefined);
});

test("claimed and blocked tickets are skipped", () => {
  assert.equal(chosen([ticket(3, ["agent:in-progress"]), ticket(4, ["agent:blocked"]), ticket(6)]), 6);
});

test("only a maintainer's label counts", () => {
  assert.equal(chosen([ticket(3, [], { labelledBy: "drive-by" }), ticket(4, [], { labelledBy: undefined })]), undefined);
});

test("a ticket whose PR is waiting for review is not built again", () => {
  // Regression from rsvp-factory: with wipLimit 3, #4 was dispatched again right after its PR opened.
  assert.equal(chosen([ticket(4, [], { hasOpenPr: true }), ticket(5)], 1, 3), 5);
});

test("nothing starts at the work-in-progress limit", () => {
  assert.equal(chosen([ticket(3)], 1, 1), undefined);
  assert.equal(chosen([ticket(3)], 1, 2), 3);
});
