// What the factory says about itself, for the maintainer's pane and bin/factoryctl to read. Everything lives in
// ~/.cache/factory/ (FACTORY_CACHE_DIR in tests):
//
//   status.json   the process: pid, phase, the session running now, the last pass, the next one, the last error
//   factory.pid   the lock: one factory per machine
//   drain         touched by `factoryctl stop`: finish the running session, then stop
//   wake          touched by `factoryctl poll`: end the sleep and start a pass now
//   events.jsonl  one line per thing worth telling the maintainer (a PR opened, a merge, a block)
//
// status.json is written whole to a .tmp file and renamed, so a reader never sees half of it.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function paths() {
  const dir = process.env.FACTORY_CACHE_DIR ?? join(homedir(), ".cache/factory");
  return {
    dir,
    status: join(dir, "status.json"),
    pid: join(dir, "factory.pid"),
    drain: join(dir, "drain"),
    wake: join(dir, "wake"),
    events: join(dir, "events.jsonl"),
  };
}

export type Phase = "pass" | "build" | "sleeping" | "draining" | "stopped";
export type Step = "fixFactoryPrs" | "reviewFindings" | "merges" | "followUps" | "buildTickets";

export type Status = {
  v: 1;
  pid: number;
  startedAt: string;
  kit: { sha: string; subject: string; dirty: boolean };
  node: string;
  once: boolean;
  pollSeconds: number;
  wipLimit: number;
  rounds: { ci: number; review: number; update: number };
  sessions: Record<string, { model: string; timeoutMinutes: number }>;
  repos: { slug: string; path: string }[];
  phase: Phase;
  step?: Step;
  current?: { repo: string; issue: number; role: string; startedAt: string };
  beatAt: string;
  lastPassAt?: string;
  nextPassAt?: string;
  wip?: number;
  ready?: number;
  lastError?: { at: string; step: string; message: string };
  controls: 1;
  launchedFrom: "factoryctl" | "terminal";
};

let status: Status | undefined;

/** The kit's own commit, read once: a factory running old code shows it, and the pane says a restart picks it up. */
export function kitVersion(kitDir: string): Status["kit"] {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", kitDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  return {
    sha: git("rev-parse", "--short", "HEAD").trim(),
    subject: git("log", "-1", "--format=%s").trim(),
    dirty: git("status", "--porcelain", "--untracked-files=no").trim() !== "",
  };
}

/** Starts the status file for this process. Until this runs, writeStatus does nothing (tests, the CLIs). */
export function initStatus(base: Omit<Status, "v" | "pid" | "startedAt" | "beatAt" | "controls" | "launchedFrom">) {
  const now = new Date().toISOString();
  status = {
    v: 1,
    pid: process.pid,
    startedAt: now,
    beatAt: now,
    controls: 1,
    launchedFrom: process.env.FACTORYCTL ? "factoryctl" : "terminal",
    ...base,
  };
  writeStatus({});
}

/** Merges the patch in and writes status.json whole (tmp, then rename). Keys set to undefined are dropped. */
export function writeStatus(patch: Partial<Status>) {
  if (!status) return;
  status = { ...status, ...patch, beatAt: new Date().toISOString() };
  const { status: file, dir } = paths();
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(status)}\n`);
  renameSync(`${file}.tmp`, file);
}

export const currentStatus = () => status;

// --- The lock ---

const FACTORY = /node .*src\/factory\.ts/;

function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks the pid exists; nothing is sent
    return true;
  } catch {
    return false;
  }
}

/** Another factory's pid: any `node src/factory.ts` but this one, the hand-started kind with no pidfile included. */
function otherFactory(): number | undefined {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-f", "node .*src/factory.ts"], { encoding: "utf8" });
  } catch {
    return undefined; // pgrep exits 1 when nothing matches
  }
  return out
    .split("\n")
    .map(Number)
    .find((pid) => pid > 0 && pid !== process.pid);
}

export type Lock = { ok: true } | { ok: false; pid: number; message: string };

/** One factory per machine. Refuses when another runs (by pgrep, or a live pidfile); replaces a stale pidfile. */
export function acquireLock(): Lock {
  const refuse = (pid: number): Lock => ({
    ok: false,
    pid,
    message: `Factory already running: pid ${pid}. Not starting a second one.`,
  });
  const other = otherFactory();
  if (other) return refuse(other);
  const { pid: file, dir } = paths();
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      process.on("exit", releaseLock);
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(readFileSync(file, "utf8").trim());
      if (holder > 0 && holder !== process.pid && isAlive(holder) && FACTORY.test(commandOf(holder))) {
        return refuse(holder);
      }
      unlinkSync(file); // stale: its process is gone, or the pid now belongs to something else
    }
  }
  return refuse(0);
}

/** Removes the pidfile, only while it is still ours. */
export function releaseLock() {
  const { pid: file } = paths();
  try {
    if (Number(readFileSync(file, "utf8").trim()) === process.pid) unlinkSync(file);
  } catch {
    // already gone
  }
}

// --- What the maintainer is told ---

const MAX_EVENTS_BYTES = 512 * 1024;
const KEEP_EVENTS = 1000;

const clock = (at = new Date()) => at.toTimeString().slice(0, 8);

/** A console line with the time in front. */
export function log(text: string) {
  console.log(`${clock()} ${text}`);
}

export type EventKind = "pr" | "merged" | "blocked" | "needsinfo" | "followups" | "error" | "factory";

/** Something worth telling the maintainer: a line in events.jsonl for the pane, and on the console. */
export function note(
  kind: EventKind,
  repo: string,
  text: string,
  extra: { issue?: number; pr?: number; tier?: string } = {},
) {
  log(text);
  const { events, dir } = paths();
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(events, `${JSON.stringify({ at: new Date().toISOString(), repo, kind, ...extra, text })}\n`);
    if (statSync(events).size > MAX_EVENTS_BYTES) {
      const lines = readFileSync(events, "utf8").split("\n").filter(Boolean);
      writeFileSync(`${events}.tmp`, `${lines.slice(-KEEP_EVENTS).join("\n")}\n`);
      renameSync(`${events}.tmp`, events);
    }
  } catch {
    // the console line is enough; never stop the factory over its own diary
  }
}
