// The risk gate as a GitHub Actions step: labels the PR risk:low|medium|high and posts the `risk-gate` status.
// Run by .github/workflows/risk-gate.yml, which checks out the caller's BASE branch for the policy and never runs PR
// code: the PR is read as data through the API.
//
// Shadow mode (the default) labels the tier and always passes, so the maintainer can compare the gate's call with
// their own before it blocks anything.

import { appendFileSync, readFileSync } from "node:fs";
import { parseRepoConfig } from "./config.ts";
import { type ChangedFile, floorTier } from "./gate.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

async function api<T>(method: string, path: string, body?: object): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${env("GITHUB_REPOSITORY")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

type ApiFile = { filename: string; status: string; changes: number; deletions: number; previous_filename?: string };

async function changedFiles(pr: number): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (let page = 1; ; page++) {
    const batch = await api<ApiFile[]>("GET", `/pulls/${pr}/files?per_page=100&page=${page}`);
    files.push(
      ...batch.map((f) => ({
        path: f.filename,
        status: f.status,
        changes: f.changes,
        deletions: f.deletions,
        ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
      })),
    );
    if (batch.length < 100) return files;
  }
}

/** The second-review workflow passed this exact commit. Its status is pinned to the commit it read, and only a workflow
 *  run (github-actions[bot]) can have posted it. */
async function secondOpinionPassed(sha: string): Promise<boolean> {
  const statuses = await api<{ context: string; state: string; creator: { login: string } }[]>(
    "GET",
    `/commits/${sha}/statuses?per_page=100`,
  );
  const latest = statuses.find((s) => s.context === "second-opinion");
  return latest?.state === "success" && latest.creator.login === "github-actions[bot]";
}

const prNumber = Number(env("PR_NUMBER"));
const mode = process.env.RISK_GATE_MODE || "shadow";
const config = parseRepoConfig(readFileSync(process.env.POLICY ?? ".factory/config.yml", "utf8"));

type Pull = { user: { login: string }; head: { sha: string }; body: string | null; labels: { name: string }[] };
const pr = await api<Pull>("GET", `/pulls/${prNumber}`);
const author = pr.user.login;
const trusted = config.maintainers.includes(author) || author === config.factoryBot;
const reviewed = await secondOpinionPassed(pr.head.sha);
const decision = floorTier(await changedFiles(prNumber), config.risk, author, trusted, pr.body ?? "", reviewed);

for (const { name } of pr.labels) {
  if (name.startsWith("risk:") && name !== `risk:${decision.tier}`)
    await api("DELETE", `/issues/${prNumber}/labels/${encodeURIComponent(name)}`);
}
if (!pr.labels.some((l) => l.name === `risk:${decision.tier}`)) {
  await api("POST", `/issues/${prNumber}/labels`, { labels: [`risk:${decision.tier}`] });
}

const summary = decision.reasons.map((r) => `- ${r}`).join("\n");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Risk tier: ${decision.tier} (${mode} mode)\n\n${summary}\n`);
console.log(`tier=${decision.tier}\n${summary}`);

if (mode === "shadow") {
  await api("POST", `/statuses/${pr.head.sha}`, {
    state: "success",
    context: "risk-gate",
    description: `shadow: would be ${decision.tier}`.slice(0, 140),
  });
}
