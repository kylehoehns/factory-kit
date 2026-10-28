// The second opinion's inputs, as files: the PR, its ticket, and what earlier rounds already said, so a later round
// reads only what changed and doesn't report the same thing again. Files rather than `gh` calls, so the eval harness
// can replay the same prompt offline. Pure, so the tests cover it; opinion-cli.ts is the GitHub plumbing around it.
// An agent author and an agent reviewer can cycle forever when every round re-reads everything: each pass turns up
// one more old problem.

/** The ticket a PR body closes, by GitHub's closing keywords ("Closes #12", "fixes #3"). */
export function ticketIn(body: string): number | undefined {
  const n = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/i)?.[1];
  return n ? Number(n) : undefined;
}

export type Issue = {
  number: number;
  title: string;
  body: string;
  comments: { author: { login: string }; body: string }[];
};

/** The ticket as markdown: body, then each comment. Built from JSON because `gh issue view --comments` prints only the
 *  comments when its output isn't a terminal, as in CI. */
export function ticketText(issue: Issue): string {
  const comments = issue.comments.map((c) => `## Comment by ${c.author.login}\n\n${c.body}`);
  return `${[`# #${issue.number}: ${issue.title}`, issue.body, ...comments].join("\n\n")}\n`;
}

export type EarlierFinding = { kind: string; title: string; path?: string; line?: number; body: string };
export type ReviewComment = { id: number; body: string; in_reply_to_id?: number };

/** The signature the factory puts on the threads it posts for the second opinion's findings (see findings.ts). */
const SIGNATURE = "_From the second opinion._";

/** The newest commit before `head` that a second opinion finished reading: its status passed or failed, not errored. */
export function lastReviewed(commits: string[], states: Map<string, string | undefined>, head: string) {
  return commits
    .filter((sha) => sha !== head)
    .findLast((sha) => states.get(sha) === "success" || states.get(sha) === "failure");
}

/** Every finding from earlier second opinions, the latest copy of each title. */
export function earlierFindings(opinions: string[]): EarlierFinding[] {
  const byTitle = new Map<string, EarlierFinding>();
  for (const opinion of opinions) {
    const json = opinion.match(/```findings\s*\n([\s\S]*?)```/)?.[1];
    if (!json) continue;
    try {
      for (const f of JSON.parse(json) as EarlierFinding[]) byTitle.set(f.title, f);
    } catch {
      // unreadable: that round had no findings the factory could act on either
    }
  }
  return [...byTitle.values()];
}

/** The replies on the thread the factory posted for this finding: what it fixed or why it didn't, and how it was
 *  settled. Threads from before the factory signed them still count. */
export function answerTo(finding: EarlierFinding, comments: ReviewComment[]): string | undefined {
  const threads = comments.filter((c) => c.body.startsWith(`[${finding.kind}] **${finding.title}**`));
  const thread = threads.find((c) => c.body.includes(SIGNATURE)) ?? threads[0];
  const replies = comments.filter((c) => thread && c.in_reply_to_id === thread.id).map((c) => c.body);
  return replies.length ? replies.join(" / ") : undefined;
}

/** The parts of a unified diff that touch these files. A merge from main brings in other people's changes; those
 *  aren't this PR's to review. */
export function onlyFiles(diff: string, files: string[]): string {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((part) => {
      const paths = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      return paths && (files.includes(paths[1]) || files.includes(paths[2]));
    })
    .join("");
}

/** What the second opinion is told about earlier rounds, as markdown. */
export function context(reviewed: string | undefined, findings: EarlierFinding[], answers: (string | undefined)[]) {
  if (!reviewed) return "This is the first second opinion on this PR: review the whole diff.\n";
  const list = findings.map((f, i) => {
    const where = f.path ? ` (\`${f.path}${f.line ? `:${f.line}` : ""}\`)` : "";
    const answer = answers[i] ? `\n  Factory's answer: ${answers[i]?.replace(/\s+/g, " ")}` : "";
    return `- [${f.kind}] **${f.title}**${where}: ${f.body.replace(/\s+/g, " ")}${answer}`;
  });
  return [
    `An earlier second opinion read this PR at \`${reviewed}\`. The changes since then, in the files this PR changes,`,
    "are in `.second-opinion/changes.diff`.",
    "",
    "## Earlier findings",
    "",
    ...(list.length ? list : ["None."]),
    "",
  ].join("\n");
}
