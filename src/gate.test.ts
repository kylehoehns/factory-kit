import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseRepoConfig } from "./config.ts";
import { type ChangedFile, floorTier, globToRegExp } from "./gate.ts";

// rsvp-factory's real policy: the cases below are the ones that came up there.
const POLICY = parseRepoConfig(readFileSync(new URL("./fixtures/rsvp-factory.yml", import.meta.url), "utf8")).risk;

type Opts = { author?: string; trusted?: boolean; body?: string; reviewed?: boolean };
const decide = (files: ChangedFile[], o: Opts = {}) =>
  floorTier(files, POLICY, o.author ?? "kylehoehns", o.trusted ?? true, o.body ?? "", o.reviewed ?? false);
const tier = (files: ChangedFile[], o: Opts = {}) => decide(files, o).tier;
const added = (path: string, changes = 10): ChangedFile => ({ path, status: "added", changes });
const modified = (path: string, changes = 10): ChangedFile => ({ path, status: "modified", changes });

test("a small docs change is low", () => {
  assert.equal(tier([modified("docs/journal/README.md"), modified("README.md")]), "low");
});

test("a large docs change is medium", () => {
  assert.equal(tier([modified("docs/journal/README.md", 101)]), "medium");
});

test("agent instructions and decisions are not low", () => {
  assert.equal(tier([modified("AGENTS.md")]), "medium");
  assert.equal(tier([added("docs/adr/0009-something.md")]), "medium");
  assert.equal(tier([modified("GLOSSARY.md")]), "medium");
});

test("ordinary app code is medium", () => {
  assert.equal(tier([added("app/src/main/java/dev/rsvpfactory/rsvp/Seating.java")]), "medium");
});

test("the identity module is high", () => {
  assert.equal(tier([modified("app/src/main/java/dev/rsvpfactory/identity/SignIn.java", 1)]), "high");
});

test("migrations and the factory's own controls are high", () => {
  for (const path of [
    "app/src/main/resources/db/migration/V2__rsvps.sql", ".github/workflows/ci.yml", ".factory/config.yml",
    ".claude/hooks/guard-paths.sh", ".githooks/pre-commit", "scripts/check_file_tokens.py", ".agents/skills/tdd/SKILL.md",
    "app/build.gradle.kts", "gradle/libs.versions.toml",
  ]) assert.equal(tier([modified(path, 1)]), "high", path);
});

test("moving a file out of a high-risk path is still high", () => {
  assert.equal(tier([{ path: "app/src/main/java/dev/rsvpfactory/groups/SignIn.java", status: "renamed", changes: 0,
    previousPath: "app/src/main/java/dev/rsvpfactory/identity/SignIn.java" }]), "high");
});

test("adding acceptance scenarios is ordinary work", () => {
  const decision = decide([added("acceptance/src/test/java/dev/rsvpfactory/acceptance/RsvpScenarios.java")]);
  assert.ok(!decision.reasons.some((r) => r.includes("already exists")));
});

test("a PR that only adds tests is low at any size", () => {
  assert.equal(tier([added("acceptance/src/test/java/dev/rsvpfactory/acceptance/RsvpLimitScenarios.java", 400),
    modified("app/src/test/java/dev/rsvpfactory/rsvp/RsvpApiTests.java", 9)]), "low");
});

test("editing or deleting a test line is not only adding tests", () => {
  const path = "app/src/test/java/dev/rsvpfactory/rsvp/RsvpApiTests.java";
  assert.equal(tier([{ path, status: "modified", changes: 2, deletions: 1 }]), "medium");
  assert.equal(tier([{ path, status: "removed", changes: 30, deletions: 30 }]), "medium");
});

test("tests with production code are not only tests", () => {
  assert.equal(tier([added("app/src/test/java/dev/rsvpfactory/rsvp/RsvpApiTests.java"),
    modified("app/src/main/java/dev/rsvpfactory/rsvp/RsvpService.java", 1)]), "medium");
});

test("changing or deleting an existing scenario is flagged", () => {
  for (const status of ["modified", "removed"]) {
    const decision = decide([{ path: "acceptance/src/test/java/dev/rsvpfactory/acceptance/RsvpScenarios.java", status, changes: 3 }]);
    assert.ok(decision.reasons.some((r) => r.includes("already exists in acceptance/*")), status);
  }
});

test("a reviewed feature with little production code is low", () => {
  const feature = [
    added("app/src/main/java/dev/rsvpfactory/rsvp/GuestChange.java", 120),
    modified("app/src/main/java/dev/rsvpfactory/rsvp/RsvpService.java", 80),
    added("app/src/test/java/dev/rsvpfactory/rsvp/GuestChangeTests.java", 540),
    added("acceptance/src/test/java/dev/rsvpfactory/acceptance/GuestChangeScenarios.java", 60),
  ];
  assert.equal(tier(feature, { reviewed: true }), "low");
  assert.equal(tier(feature, { reviewed: false }), "medium");
});

test("a reviewed feature with too much production code is medium", () => {
  assert.equal(tier([added("app/src/main/java/dev/rsvpfactory/rsvp/Big.java", 201)], { reviewed: true }), "medium");
});

test("a review never lowers a floor", () => {
  assert.equal(tier([added("app/src/main/resources/db/migration/V7__rsvp.sql", 5)], { reviewed: true }), "high");
  const scenario = { path: "acceptance/src/test/java/dev/rsvpfactory/acceptance/RsvpScenarios.java", status: "modified", changes: 3, deletions: 1 };
  assert.equal(tier([scenario], { reviewed: true }), "medium");
  const code = added("app/src/main/java/dev/rsvpfactory/rsvp/A.java");
  assert.equal(tier([code], { reviewed: true, trusted: false }), "medium");
  assert.equal(tier([code], { reviewed: true, body: "**Door:** one-way" }), "medium");
});

test("outside contributors are never low", () => {
  assert.equal(tier([modified("README.md")], { author: "someone", trusted: false }), "medium");
});

test("a one-way door is never low", () => {
  assert.equal(tier([modified("README.md")], { body: "## Merge Danger\n\n**Door:** one-way\n" }), "medium");
});

test("a tier never goes down", () => {
  assert.equal(tier([modified(".github/workflows/ci.yml"), modified("README.md")], { body: "**Door:** two-way" }), "high");
});

test("globs behave like Python's fnmatch", () => {
  assert.ok(globToRegExp("docs/*").test("docs/journal/README.md"));
  assert.ok(globToRegExp("*.md").test("docs/a.md"));
  assert.ok(!globToRegExp("*.md").test("README.mdx"));
  assert.ok(globToRegExp("gradlew").test("gradlew") && !globToRegExp("gradlew").test("gradlew.bat"));
  assert.ok(globToRegExp("V[0-9]*.sql").test("V2__x.sql") && !globToRegExp("V[!0-9]*").test("V2"));
  assert.ok(globToRegExp("a.b").test("a.b") && !globToRegExp("a.b").test("axb"));
});

test("a config without a check command is rejected", () => {
  assert.throws(() => parseRepoConfig("maintainers: [me]\nfactoryBot: x[bot]\n"), /check is required/);
});
