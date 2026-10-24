// Running agents: a Sandcastle Docker sandbox on a branch of one repo, built from that repo's .factory/Dockerfile.
// If the repo asks for it (sandbox.docker), a private Docker-in-Docker on its own network as well, so Testcontainers
// works inside the sandbox without the agent ever reaching the host's Docker.

import { claudeCode, createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Role } from "./config.ts";
import { KIT, kit, type Outcome, type Repo, run, RUNS } from "./shared.ts";

const DIND_IMAGE = "docker:29.9.2-dind";

export const imageName = (repo: Repo) => `factory-sandbox-${repo.name}`;

/** Total tokens across every assistant message in the captured session transcripts. */
function sessionTokens(files: (string | undefined)[]) {
  const total = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 };
  for (const file of files) {
    if (!file || !existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const usage = line ? JSON.parse(line)?.message?.usage : undefined;
      if (!usage) continue;
      total.turns++;
      total.input += usage.input_tokens ?? 0;
      total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      total.cacheRead += usage.cache_read_input_tokens ?? 0;
      total.output += usage.output_tokens ?? 0;
    }
  }
  return total;
}

type PrivateDocker = { network: string; host: string; stop: () => void };

function startPrivateDocker(repo: Repo, issue: number): PrivateDocker {
  const network = `factory-${repo.name}-${issue}`;
  const host = `factory-dind-${repo.name}-${issue}`;
  const stop = () => {
    for (const args of [["rm", "-f", host], ["network", "rm", network]]) {
      try {
        execFileSync("docker", args, { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  };
  stop();
  run(repo, "docker", ["network", "create", network]);
  // Plain TCP is fine here: the daemon is only reachable on this run's private network.
  run(repo, "docker", ["run", "-d", "--privileged", "--name", host, "--network", network, "-e", "DOCKER_TLS_CERTDIR=",
    DIND_IMAGE, "--tls=false"]);
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync("docker", ["exec", host, "docker", "info"], { stdio: "ignore" });
      return { network, host, stop };
    } catch (error) {
      if (attempt > 60) throw error;
      execFileSync("sleep", ["1"]);
    }
  }
}

/** Drop worktrees Sandcastle left behind (e.g. after an interrupted run), so a branch can be reset. */
export function pruneWorktrees(repo: Repo) {
  for (const line of run(repo, "git", ["worktree", "list", "--porcelain"]).split("\n")) {
    const path = line.startsWith("worktree ") ? line.slice(9) : "";
    if (path.includes("/.sandcastle/")) run(repo, "git", ["worktree", "remove", "--force", path]);
  }
  run(repo, "git", ["worktree", "prune"]);
}

export type Session = { role: Role; prompt: string };
export type SessionsResult = { outcome: Outcome; read: (file: string) => string | undefined };

/**
 * Runs each session in turn in one sandbox on `branch`, stopping at the first that doesn't succeed.
 * `inputs` are host files copied into the worktree's .factory/runs/ for the agents to read.
 */
export async function runSessions(repo: Repo, issue: number, branch: string, sessions: Session[], inputs: string[],
  claudeToken: string): Promise<SessionsResult> {
  const privateDocker = repo.config.sandbox.docker ? startPrivateDocker(repo, issue) : undefined;
  const mounts = repo.config.sandbox.caches.map((cache) => {
    const hostPath = join(homedir(), ".cache/factory", repo.name, cache.name);
    mkdirSync(hostPath, { recursive: true });
    return { hostPath, sandboxPath: cache.path };
  });
  const { slug, userId } = kit().app;
  const bot = `${slug}[bot]`;
  const botEmail = `${userId}+${bot}@users.noreply.github.com`; // GitHub links this to the app's bot user
  try {
    await using sandbox = await createSandbox({
      branch,
      cwd: repo.root,
      sandbox: docker({
        imageName: imageName(repo),
        ...(privateDocker ? { network: privateDocker.network } : {}),
        mounts,
        env: {
          // Sandcastle 0.12.0's createSandbox() ignores claudeCode({ env }) (it starts the container with an empty
          // agent env and sandbox.run() never adds it), so the token goes in the sandbox env.
          CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
          // Repos' hooks check this to hold an agent to stricter rules than a person at the keyboard.
          FACTORY_RUN: "1",
          // Agents commit as the factory app, not as whoever's git identity the host repo has.
          GIT_AUTHOR_NAME: bot,
          GIT_AUTHOR_EMAIL: botEmail,
          GIT_COMMITTER_NAME: bot,
          GIT_COMMITTER_EMAIL: botEmail,
          ...(privateDocker ? { DOCKER_HOST: `tcp://${privateDocker.host}:2375`, TESTCONTAINERS_HOST_OVERRIDE: privateDocker.host } : {}),
        },
      }),
    });

    // .factory/runs/ is gitignored, so a fresh worktree doesn't have it; the worktree is bind-mounted, so writing here
    // on the host is what the agent sees.
    const runsInWorktree = join(sandbox.worktreePath, RUNS);
    mkdirSync(runsInWorktree, { recursive: true });
    for (const input of inputs) copyFileSync(input, join(runsInWorktree, basename(input)));
    const read = (file: string) => {
      const path = join(runsInWorktree, file);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    };

    const promptArgs = {
      TASK_FILE: join(RUNS, "task.md"),
      CI_LOG_FILE: join(RUNS, "ci-failure.log"),
      FINDINGS_FILE: join(RUNS, "findings.json"),
      RESOLUTIONS_FILE: join(RUNS, "resolutions.json"),
      OUTCOME_FILE: join(RUNS, "outcome.json"),
      PR_BODY_FILE: join(RUNS, "pr-body.md"),
      REVIEW_FILE: join(RUNS, "review.json"),
      ISSUE: String(issue),
      CHECK: repo.config.check,
    };
    let last: Outcome = { outcome: "success", summary: "" };
    for (const session of sessions) {
      console.log(`${repo.name}#${issue}: ${session.role}…`);
      const started = Date.now();
      const { model, timeoutMinutes } = kit().sessions[session.role];
      const result = await sandbox.run({
        agent: claudeCode(model),
        promptFile: join(KIT, "prompts", session.prompt),
        promptArgs,
        name: `${session.role} ${repo.name}#${issue}`,
        logging: { type: "file", path: join(repo.root, RUNS, "logs", `${session.role}-${issue}.log`) },
        signal: AbortSignal.timeout(timeoutMinutes * 60_000),
      });
      const outcomeText = read("outcome.json");
      rmSync(join(runsInWorktree, "outcome.json"), { force: true });
      const outcome: Outcome = outcomeText
        ? JSON.parse(outcomeText)
        : { outcome: "blocked", summary: `The ${session.role} session ended without writing an outcome.` };
      appendFileSync(join(repo.root, RUNS, "metrics.jsonl"), JSON.stringify({
        at: new Date().toISOString(), issue, role: session.role, outcome: outcome.outcome, minutes: (Date.now() - started) / 60_000,
        commits: result.commits.length, tokens: sessionTokens(result.iterations.map((i) => i.sessionFilePath)),
      }) + "\n");
      if (outcome.outcome !== "success") return { outcome, read };
      last = outcome; // keep the agent's own summary: it's what the PR comment for a fix round says
    }
    // Read the results before the sandbox (and its worktree) is disposed.
    const snapshot = Object.fromEntries(["pr-body.md", "review.json", "resolutions.json"].map((f) => [f, read(f)]));
    return { outcome: last, read: (file) => snapshot[file] };
  } finally {
    privateDocker?.stop();
  }
}
