// How the factory is stopped and nudged, without ever cutting off a session by surprise:
//
//   drain         a drain file (bin/factoryctl stop), or the first Ctrl+C / SIGTERM: no new claims; the running
//                 session finishes and publishes as usual, then the factory stops
//   stop now      a second Ctrl+C / SIGTERM, at least 2s after the first: the running session is aborted and its
//                 ticket goes back in the queue. One Ctrl+C under `npm run` arrives twice (npm forwards it, and the
//                 terminal signals the whole group), so a repeat within 2s counts as the same press.
//   wake          a wake file (bin/factoryctl poll): the sleep between passes ends and a pass starts now
//
// Only SIGINT and SIGTERM are handled, on purpose: no other signal stops a session, and nothing here sends one.

import { existsSync, unlinkSync } from "node:fs";
import { gh, labels } from "./github.ts";
import { BRANCH_PREFIX, type Repo } from "./shared.ts";
import { note, paths } from "./status.ts";

const CLAIMED = "agent:in-progress";

let drainRequested = false;

/** True once a drain was asked for: by a signal, or the drain file. */
export function draining(): boolean {
  return drainRequested || existsSync(paths().drain);
}

export function requestDrain() {
  drainRequested = true;
}

/** Aborted by the second signal: every running session's signal follows it. */
export const stopNow = new AbortController();

/** A session's abort signal: its own timeout, or stop now. */
export const sessionSignal = (timeoutMs: number) => AbortSignal.any([AbortSignal.timeout(timeoutMs), stopNow.signal]);

/** Removes a file if it is there; true when it was. */
function take(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wait between passes, in slices: it ends early when the wake file appears (which it removes) or a drain starts.
 * `onSleep` is told when the next pass is due, for the status file.
 */
export async function sleepUntilNextPass(
  seconds: number,
  options: { sliceMs?: number; onSleep?: (nextPassAt: Date) => void } = {},
): Promise<"timeout" | "wake" | "drain"> {
  const sliceMs = options.sliceMs ?? 1000;
  const slices = Math.max(1, Math.round((seconds * 1000) / sliceMs));
  options.onSleep?.(new Date(Date.now() + slices * sliceMs));
  for (let i = 0; i < slices; i++) {
    if (take(paths().wake)) return "wake";
    if (draining()) return "drain";
    await new Promise((resolve) => setTimeout(resolve, sliceMs));
  }
  return "timeout";
}

/**
 * Builds tickets one at a time until there is nothing to build or a drain starts. The drain is checked before each
 * claim, so a ticket is never claimed and then dropped; a build already running always finishes.
 */
export async function buildUntilDrained<T>(
  claimNext: () => Promise<T | undefined>,
  build: (ticket: T) => Promise<void>,
): Promise<"idle" | "drained"> {
  for (;;) {
    if (draining()) return "drained";
    const ticket = await claimNext();
    if (ticket === undefined) return "idle";
    await build(ticket);
  }
}

/**
 * Removes a leftover drain or wake file. Called at startup (after the lock) and on stop now, so a stop never leaves
 * a drain file behind that would make the next start drain and exit at once.
 */
export function clearControlFiles() {
  take(paths().drain);
  take(paths().wake);
}

/** Once draining and nothing runs: the drain file and pidfile go, and the caller exits 0. */
export function finishDrain(writeStopped: () => void, releaseLock: () => void) {
  writeStopped();
  take(paths().drain);
  releaseLock();
}

/** A repeat signal this soon after the first is the same Ctrl+C delivered twice, not a second press. */
export const REPEAT_MS = 2000;

/**
 * SIGINT and SIGTERM. The first drains; the second stops now: `onStopNow` cleans up and exits. A signal within
 * REPEAT_MS of the first is ignored (see the top of this file). Returns the handler, which the caller installs with
 * process.on.
 */
export function signalHandler(
  onDrain: () => void,
  onStopNow: () => void | Promise<void>,
  now: () => number = Date.now,
) {
  let signals = 0;
  let firstAt = 0;
  return () => {
    if (signals === 1 && now() - firstAt < REPEAT_MS) return;
    signals++;
    if (signals === 1) {
      firstAt = now();
      requestDrain();
      onDrain();
      return;
    }
    if (signals === 2) {
      stopNow.abort(new Error("stopped now by the maintainer"));
      void onStopNow();
    }
  };
}

// --- Claims a stopped factory left behind ---

/**
 * Tickets labelled agent:in-progress with no open agent/issue-N PR were claimed by a factory that stopped mid-build.
 * Run at startup, after the lock (so nothing else is building): the label comes off and the ticket is pickable again.
 * Returns the tickets released.
 */
export function releaseOrphans(repo: Repo, token: string): number[] {
  const claimed = JSON.parse(
    gh(repo, token, "issue", "list", "--state", "open", "--label", CLAIMED, "--json", "number"),
  ) as { number: number }[];
  if (claimed.length === 0) return [];
  const prs = JSON.parse(gh(repo, token, "pr", "list", "--state", "open", "--json", "headRefName")) as {
    headRefName: string;
  }[];
  const withPr = new Set(
    prs
      .filter((p) => p.headRefName.startsWith(BRANCH_PREFIX))
      .map((p) => Number(p.headRefName.slice(BRANCH_PREFIX.length))),
  );
  const orphans = claimed.map((c) => c.number).filter((n) => !withPr.has(n));
  for (const issue of orphans) {
    labels(repo, token, issue, { remove: [CLAIMED] });
    note("factory", repo.slug, `released stale claim on #${issue}`, { issue });
  }
  return orphans;
}
