// The risk gate's decision: how much review a PR needs. Pure, so the tests cover all of it; gate-cli.ts is the
// GitHub plumbing around it. Tiers only ever go up: no rule can lower a floor another rule set.

import { execFileSync } from "node:child_process";
import type { RiskPolicy, Tier } from "./config.ts";

const TIERS: Tier[] = ["low", "medium", "high"];

export type ChangedFile = {
  path: string;
  status: string; // added, modified, removed, renamed, copied, changed
  changes: number;
  previousPath?: string;
  deletions?: number;
};

export type Decision = { tier: Tier; reasons: string[] };

/** Python's fnmatch: "*" matches anything, "/" included; "?" one character; "[...]" a class, "[!...]" its negation. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) out += "\\[";
      else {
        const body = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "s");
}

export const matches = (path: string, patterns: string[]) => patterns.some((p) => globToRegExp(p).test(path));

export function floorTier(files: ChangedFile[], policy: RiskPolicy, author: string, authorIsTrusted: boolean, body: string,
  reviewed = false): Decision {
  const decision: Decision = { tier: "low", reasons: [] };
  const raise = (tier: Tier, reason: string) => {
    if (TIERS.indexOf(tier) > TIERS.indexOf(decision.tier)) decision.tier = tier;
    decision.reasons.push(`${tier}: ${reason}`);
  };
  const low = policy.low;
  const paths = files.flatMap((f) => [f.path, f.previousPath].filter((p): p is string => Boolean(p)));

  for (const path of paths) if (matches(path, policy.high.paths)) raise("high", `${path} is a high-risk path`);

  for (const f of files) {
    if (f.status !== "added" && matches(f.previousPath ?? f.path, policy.medium.existingPaths)) {
      raise("medium", `${f.path} changes something that already exists in ${policy.medium.existingPaths.join(", ")}`);
    }
  }

  const onlyAddsTests = low.testPaths.length > 0 && files.every((f) =>
    matches(f.path, low.testPaths) && !f.previousPath && f.status !== "removed" && (f.deletions ?? 0) === 0);
  const productionLines = files.filter((f) => matches(f.path, low.reviewedProductionPaths)).reduce((n, f) => n + f.changes, 0);
  const reviewedAndSmall = reviewed && low.reviewedProductionPaths.length > 0 && productionLines <= low.reviewedMaxProductionLines;
  if (!(onlyAddsTests || reviewedAndSmall)) {
    const outsideLow = paths.filter((p) => !matches(p, low.paths) || matches(p, low.exclude));
    if (outsideLow.length) raise("medium", `${outsideLow.length} file(s) outside the low-risk paths, e.g. ${outsideLow[0]}`);
    const changedLines = files.reduce((n, f) => n + f.changes, 0);
    if (changedLines > low.maxChangedLines) raise("medium", `${changedLines} changed lines (low allows ${low.maxChangedLines})`);
  }

  if (!authorIsTrusted) raise("medium", `author ${author} is not a maintainer or the factory`);
  if (/\*\*Door:\*\*\s*one-way/i.test(body)) raise("medium", "the PR's Merge Danger says one-way door");

  if (decision.reasons.length === 0) {
    decision.reasons.push(onlyAddsTests ? "low: only adds tests"
      : reviewedAndSmall ? `low: the second opinion passed it and it changes ${productionLines} production lines`
      : "low: small change to low-risk paths only");
  }
  return decision;
}

/** The same file list the API gives, from a local git diff. Renames count as delete + add, so a file moved out of a
 *  high-risk path still raises the tier. */
export function localFiles(cwd: string, range: string): ChangedFile[] {
  const git = (...args: string[]) =>
    execFileSync("git", ["diff", "--no-renames", ...args, range], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
  const statuses = new Map(git("--name-status").map((line) => {
    const [code, path] = line.split("\t", 2);
    return [path, code === "A" ? "added" : code === "D" ? "removed" : "modified"];
  }));
  return git("--numstat").map((line) => {
    const [added, deleted, path] = line.split("\t", 3);
    const binary = added === "-";
    return { path, status: statuses.get(path) ?? "modified", changes: binary ? 0 : Number(added) + Number(deleted),
      deletions: deleted === "-" ? 0 : Number(deleted) };
  });
}
