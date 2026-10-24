// Things every part of the factory needs: the kit's config, the repos it watches, and running a command.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKitConfig, parseRepoConfig, type RepoConfig } from "./config.ts";

export const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
export const RUNS = ".factory/runs"; // in each repo, gitignored; shared with the sandbox through the worktree
export const BRANCH_PREFIX = "agent/issue-";

export type Outcome = { outcome: "success" | "question" | "blocked"; summary: string; questions?: string[] };

let kitConfig: ReturnType<typeof parseKitConfig> | undefined;
/** factory.yml, next to package.json. Gitignored: it names the maintainer's own repos and app. */
export function kit() {
  kitConfig ??= parseKitConfig(readFileSync(join(KIT, "factory.yml"), "utf8"));
  return kitConfig;
}

export function exec(cwd: string, command: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

export function keychain(service: string): string {
  try {
    return exec(KIT, "security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", service, "-w"]);
  } catch {
    throw new Error(`Missing keychain item '${service}'. Run bin/setup-keychain.sh first.`);
  }
}

/** One repo the factory watches, with its config as it is on main right now. */
export type Repo = { slug: string; name: string; root: string; config: RepoConfig };

export function run(repo: Repo, command: string, args: string[], env: Record<string, string> = {}): string {
  return exec(repo.root, command, args, env);
}

/** Fetches main and reads `.factory/config.yml` from it: never from a branch, so a PR can't change its own rules. */
export function openRepo(slug: string, path: string): Repo {
  const root = path.replace(/^~(?=\/)/, homedir());
  exec(root, "git", ["fetch", "--quiet", "origin", "main"]);
  const config = parseRepoConfig(exec(root, "git", ["show", "origin/main:.factory/config.yml"]));
  return { slug, name: basename(slug), root, config };
}

/** Files changed on a branch since it left main that touch the repo's protected paths (the factory's own controls). */
export function forbiddenChanges(repo: Repo, branch: string): string[] {
  return run(repo, "git", ["diff", "--name-only", `origin/main...${branch}`])
    .split("\n")
    .filter((path) => path && repo.config.protected.some((prefix) => path.startsWith(prefix)));
}
