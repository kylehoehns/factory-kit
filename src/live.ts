// What the factory is doing right now, for a viewer to read: ~/.cache/factory/live.json, the running and the most
// recent agent sessions across every repo. Written by this one process only, so a plain read-modify-write is safe;
// each write goes to a .tmp file that is then renamed over it, so a reader never sees half a file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LIVE = process.env.FACTORY_LIVE ?? join(homedir(), ".cache/factory/live.json");
const KEEP = 20;

export type LiveSession = {
  repo: string;
  issue: number;
  role: string;
  log: string;
  /** The session's .factory/runs/ in its worktree: where `ask` leaves a live question and finds the answer. */
  runs?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  summary?: string;
};

function load(): LiveSession[] {
  try {
    return JSON.parse(readFileSync(LIVE, "utf8")) as LiveSession[];
  } catch {
    return [];
  }
}

function save(sessions: LiveSession[]) {
  mkdirSync(dirname(LIVE), { recursive: true });
  writeFileSync(`${LIVE}.tmp`, `${JSON.stringify(sessions.slice(-KEEP), null, 2)}\n`);
  renameSync(`${LIVE}.tmp`, LIVE);
}

/** Records a session as running; returns how to mark it finished, carrying the session's startedAt. */
export function recordStart(
  session: Omit<LiveSession, "startedAt">,
): ((outcome: string, summary: string) => void) & { startedAt: string } {
  const entry: LiveSession = { ...session, startedAt: new Date().toISOString() };
  save([...load(), entry]);
  const finish = (outcome: string, summary: string) =>
    save(
      load().map((s) =>
        s.startedAt === entry.startedAt && s.log === entry.log
          ? { ...s, endedAt: new Date().toISOString(), outcome, summary: summary.slice(0, 500) }
          : s,
      ),
    );
  return Object.assign(finish, { startedAt: entry.startedAt });
}

/** Sessions left "running" by a factory that stopped mid-run are marked interrupted at startup. */
export function interruptLeftovers() {
  save(load().map((s) => (s.endedAt ? s : { ...s, endedAt: new Date().toISOString(), outcome: "interrupted" })));
}
