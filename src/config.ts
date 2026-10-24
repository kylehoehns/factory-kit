// The two kinds of config, and nothing else:
//   factory.yml           on the maintainer's machine: the factory's identity, limits, and which repos it watches
//   .factory/config.yml   in each repo, read from its main branch: how the factory treats that repo
// The repo file is read from main (never a PR branch), so a PR can't loosen the rules that judge it.

import { parse } from "yaml";

export type Tier = "low" | "medium" | "high";

export type RiskPolicy = {
  low: {
    paths: string[];
    exclude: string[];
    maxChangedLines: number;
    testPaths: string[];
    reviewedProductionPaths: string[];
    reviewedMaxProductionLines: number;
  };
  medium: { existingPaths: string[] };
  high: { paths: string[] };
};

export type RepoConfig = {
  /** The command that means "done": the agents run it, and CI should run it too. */
  check: string;
  autoMerge: "off" | "shadow" | "on";
  maintainers: string[];
  /** The factory app's bot login, e.g. "my-factory[bot]". Its PRs are trusted like a maintainer's. */
  factoryBot: string;
  /** Path prefixes that are the factory's own controls: agents may never change them. */
  protected: string[];
  sandbox: { docker: boolean; caches: { name: string; path: string }[] };
  risk: RiskPolicy;
};

type Session = { model: string; timeoutMinutes: number };
export type Role = "implement" | "review" | "fixCi" | "fixReview" | "updateBranch";

export type KitConfig = {
  app: { id: number; slug: string; userId: number };
  keychain: { appKey: string; claudeToken: string };
  wipLimit: number;
  pollSeconds: number;
  rounds: { ci: number; review: number; update: number };
  sessions: Record<Role, Session>;
  repos: { slug: string; path: string }[];
};

type RawRepoConfig = {
  check?: string;
  autoMerge?: string;
  maintainers?: unknown;
  factoryBot?: string;
  protected?: unknown;
  sandbox?: { docker?: unknown; caches?: { name: string; path: string }[] };
  risk?: {
    low?: Partial<Record<keyof RiskPolicy["low"], unknown>>;
    medium?: { existingPaths?: unknown };
    high?: { paths?: unknown };
  };
};

const fail = (message: string): never => {
  throw new Error(`.factory/config.yml: ${message}`);
};

const required = <T>(value: T | undefined, where: string): T => value ?? fail(`${where} is required`);

function strings(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) fail(`${where} must be a list of strings`);
  return value as string[];
}

function number(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  return typeof value === "number" ? value : fail(`${where} must be a number`);
}

const STAGES = ["off", "shadow", "on"] as const;

export function parseRepoConfig(text: string): RepoConfig {
  const raw = (parse(text) ?? {}) as RawRepoConfig;
  const { low = {}, medium = {}, high = {} } = raw.risk ?? {};
  const stage = raw.autoMerge ?? "off";
  const autoMerge = STAGES.find((s) => s === stage) ?? fail("autoMerge must be off, shadow or on");
  return {
    check: required(raw.check, "check"),
    autoMerge,
    maintainers: strings(required(raw.maintainers, "maintainers"), "maintainers"),
    factoryBot: required(raw.factoryBot, "factoryBot"),
    protected: strings(raw.protected ?? [".github/", ".factory/"], "protected"),
    sandbox: { docker: raw.sandbox?.docker === true, caches: raw.sandbox?.caches ?? [] },
    risk: {
      low: {
        paths: strings(low.paths, "risk.low.paths"),
        exclude: strings(low.exclude, "risk.low.exclude"),
        maxChangedLines: number(low.maxChangedLines, 100, "risk.low.maxChangedLines"),
        testPaths: strings(low.testPaths, "risk.low.testPaths"),
        reviewedProductionPaths: strings(low.reviewedProductionPaths, "risk.low.reviewedProductionPaths"),
        reviewedMaxProductionLines: number(low.reviewedMaxProductionLines, 0, "risk.low.reviewedMaxProductionLines"),
      },
      medium: { existingPaths: strings(medium.existingPaths, "risk.medium.existingPaths") },
      high: { paths: strings(high.paths, "risk.high.paths") },
    },
  };
}

export function parseKitConfig(text: string): KitConfig {
  const raw = (parse(text) ?? {}) as KitConfig;
  for (const key of ["app", "keychain", "wipLimit", "pollSeconds", "rounds", "sessions", "repos"] as const) {
    if (raw[key] === undefined) throw new Error(`factory.yml: ${key} is required (see factory.example.yml)`);
  }
  return raw;
}
