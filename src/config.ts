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

const strings = (value: unknown, where: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`${where} must be a list of strings`);
  return value as string[];
};

function required<T>(value: T | undefined, where: string): T {
  if (value === undefined || value === null) throw new Error(`.factory/config.yml: ${where} is required`);
  return value;
}

export function parseRepoConfig(text: string): RepoConfig {
  const raw = (parse(text) ?? {}) as any;
  const risk = raw.risk ?? {};
  const autoMerge = raw.autoMerge ?? "off";
  if (!["off", "shadow", "on"].includes(autoMerge)) throw new Error(".factory/config.yml: autoMerge must be off, shadow or on");
  return {
    check: required(raw.check, "check"),
    autoMerge,
    maintainers: strings(required(raw.maintainers, "maintainers"), "maintainers"),
    factoryBot: required(raw.factoryBot, "factoryBot"),
    protected: strings(raw.protected ?? [".github/", ".factory/"], "protected"),
    sandbox: {
      docker: raw.sandbox?.docker === true,
      caches: (raw.sandbox?.caches ?? []) as { name: string; path: string }[],
    },
    risk: {
      low: {
        paths: strings(risk.low?.paths, "risk.low.paths"),
        exclude: strings(risk.low?.exclude, "risk.low.exclude"),
        maxChangedLines: risk.low?.maxChangedLines ?? 100,
        testPaths: strings(risk.low?.testPaths, "risk.low.testPaths"),
        reviewedProductionPaths: strings(risk.low?.reviewedProductionPaths, "risk.low.reviewedProductionPaths"),
        reviewedMaxProductionLines: risk.low?.reviewedMaxProductionLines ?? 0,
      },
      medium: { existingPaths: strings(risk.medium?.existingPaths, "risk.medium.existingPaths") },
      high: { paths: strings(risk.high?.paths, "risk.high.paths") },
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
