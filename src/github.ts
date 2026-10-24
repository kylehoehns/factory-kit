// GitHub, as the factory's app. Only this file holds a GitHub credential; agents never do.

import { createSign } from "node:crypto";
import { keychain, kit, type Repo, run } from "./shared.ts";

export async function appToken(repo: Repo): Promise<string> {
  const privateKey = Buffer.from(keychain(kit().keychain.appKey), "base64").toString("utf8");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: kit().app.id })}`;
  const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;

  const headers = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" };
  const found = await fetch(`https://api.github.com/repos/${repo.slug}/installation`, { headers });
  if (!found.ok) throw new Error(`The factory app isn't installed on ${repo.slug}: ${found.status}`);
  const installation = (await found.json()) as { id: number };
  const response = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    headers,
  });
  if (!response.ok) throw new Error(`Could not mint a factory app token: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { token: string }).token;
}

export function gh(repo: Repo, token: string, ...args: string[]): string {
  const safe = args.map((a, i) => (args[i - 1] === "--body" ? noMentions(a) : a));
  return run(repo, "gh", [...safe, "--repo", repo.slug], { GH_TOKEN: token });
}

/** Backticks `@word` outside code, so an agent writing `@Test` doesn't notify a GitHub user named "test". */
export function noMentions(body: string): string {
  return body
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|[^\w`])@([A-Za-z][\w-]*)/g, "$1`@$2`")))
    .join("");
}

/** A REST call on the repo. `optional` turns a 404 into undefined instead of an error. */
export async function api<T>(repo: Repo, token: string, path: string, init: RequestInit & { optional?: boolean } = {}): Promise<T> {
  const url = path.startsWith("https://") ? path : `https://api.github.com/repos/${repo.slug}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (init.optional && response.status === 404) return undefined as T;
  if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const result = (await response.json()) as { data: T; errors?: { message: string }[] };
  if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors.map((e) => e.message).join("; ")}`);
  return result.data;
}

export type Thread = { id: string; isResolved: boolean; path: string; line: number | null; body: string };

/** The PR's review threads, with the first comment of each. */
export async function reviewThreads(repo: Repo, token: string, pr: number): Promise<Thread[]> {
  const [owner, name] = repo.slug.split("/");
  const data = await graphql<{ repository: { pullRequest: { reviewThreads: { nodes: {
    id: string; isResolved: boolean; path: string; line: number | null; comments: { nodes: { body: string }[] };
  }[] } } } }>(token, `query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes {
      id isResolved path line comments(first: 1) { nodes { body } } } } } } }`, { owner, name, pr });
  return data.repository.pullRequest.reviewThreads.nodes.map((t) => ({ ...t, body: t.comments.nodes[0]?.body ?? "" }));
}

/** Reply on a review thread and, unless `keepOpen`, resolve it. */
export async function settleThread(token: string, threadId: string, reply: string | undefined, keepOpen = false) {
  if (reply) {
    await graphql(token, `mutation($id: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }`,
      { id: threadId, body: noMentions(reply) });
  }
  if (!keepOpen) {
    await graphql(token, `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id: threadId });
  }
}

/** Push a local branch as the app. Fast-forward only unless `force`, so a human's commits are never lost. */
export function push(repo: Repo, token: string, branch: string, force = false) {
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  run(repo, "git", ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, "push",
    ...(force ? ["--force"] : []), `https://github.com/${repo.slug}.git`, `${branch}:${branch}`]);
}

/** Ask for the second opinion on the PR's current head commit: adding the label starts the repo's second-review
 *  workflow, whose pass counts toward the low tier. */
export function requestSecondOpinion(repo: Repo, token: string, pr: number) {
  try {
    gh(repo, token, "pr", "edit", String(pr), "--remove-label", "claude-review");
  } catch {
    // not labelled yet
  }
  gh(repo, token, "pr", "edit", String(pr), "--add-label", "claude-review");
}

// --- CI on factory PRs ---

export type FactoryPr = {
  number: number; headRefName: string; headRefOid: string; labels: { name: string }[]; mergeable: string;
};

export function openFactoryPrs(repo: Repo, token: string, prefix: string): FactoryPr[] {
  const prs = JSON.parse(gh(repo, token, "pr", "list", "--state", "open", "--json", "number,headRefName,headRefOid,labels,mergeable")) as FactoryPr[];
  return prs.filter((pr) => pr.headRefName.startsWith(prefix));
}

/** The `ci` check on a commit: undefined while it hasn't finished. */
export async function ciResult(repo: Repo, token: string, sha: string): Promise<{ failed: boolean; runId: string } | undefined> {
  const { check_runs } = await api<{ check_runs: { status: string; conclusion: string; details_url: string }[] }>(
    repo, token, `/commits/${sha}/check-runs?check_name=ci`);
  const check = check_runs[0];
  if (!check || check.status !== "completed") return undefined;
  const runId = check.details_url.match(/runs\/(\d+)/)?.[1] ?? "";
  return { failed: check.conclusion === "failure", runId };
}

/** The failed steps' log, trimmed to its end, where build tools print the cause. Read with the maintainer's gh login:
 *  the factory app has no Actions permission, and this is read-only. */
export function failedLog(repo: Repo, runId: string): string {
  const log = run(repo, "gh", ["run", "view", runId, "--log-failed", "--repo", repo.slug]);
  const lines = log.split("\n").map((line) => line.replace(/^[^\t]*\t[^\t]*\t\S+Z /, ""));
  return lines.slice(-300).join("\n").slice(-40_000);
}

/** Commits the factory has already run a fix round of this kind on, from markers in its own PR comments. */
export function roundsTried(repo: Repo, token: string, pr: number, kind: "ci" | "update"): string[] {
  const marker = new RegExp(`<!-- factory-${kind}-round sha=([0-9a-f]+) -->`, "g");
  const bodies = JSON.parse(gh(repo, token, "pr", "view", String(pr), "--json", "comments")).comments as { body: string }[];
  return bodies.flatMap((c) => [...c.body.matchAll(marker)].map((m) => m[1]));
}

export function roundMarker(kind: "ci" | "update", sha: string): string {
  return `<!-- factory-${kind}-round sha=${sha} -->`;
}
