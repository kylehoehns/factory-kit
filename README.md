# factory-kit

A software factory for GitHub repos. Agents pick up tickets labelled `ready-for-agent`, build them in Docker sandboxes on your machine, and open PRs as a GitHub App. A second, independent AI reviews every PR, and a risk gate decides how much human review each one needs.

It came out of [rsvp-factory](https://github.com/kylehoehns/rsvp-factory), where it ran on its own for a while. Its decisions are written up as ADRs there.

## What's in it

| Part | What it does |
|---|---|
| `src/factory.ts` | The loop. Run it with `npm run factory`. Every minute, for each repo it watches, it fixes red CI and merge conflicts on its PRs, acts on second-opinion findings, merges what's allowed, files follow-ups, and builds the next ready ticket. |
| `prompts/` | What each agent session is told: implement, review, fix CI, fix review findings, update a branch. |
| `.github/workflows/risk-gate.yml` | A reusable workflow. It labels each PR `risk:low`, `risk:medium` or `risk:high` from the repo's policy. |
| `.github/workflows/second-opinion.yml` | A reusable workflow. An independent Claude review posts findings and a `second-opinion` status on the commit it read. |
| `template/` | The files a repo adds to use the factory. |

The factory never gives an agent a GitHub credential. Agents work in a sandbox with no `gh` and no token, and the factory pushes for them.

## How a PR gets merged

- **Low risk** (small docs changes, tests-only PRs, small PRs the second opinion passed): the factory merges it once everything is green, if the repo's `autoMerge` is `on`.
- **Medium**: a maintainer approves the head commit, then the factory merges it.
- **High**: as medium, and the second opinion must have read the head commit.

A tier only goes up. Each repo's `.factory/config.yml` says which paths are high risk. The factory and the gate read that file from `main`, so a PR can't loosen its own rules.

## Using it on a repo

1. **Create a GitHub App** for your factory. It needs repository permissions for contents, issues and pull requests (read and write). Install it on the repo.
2. **Copy `template/`** into the repo. Then edit `.factory/config.yml` (the check command, maintainers, the bot name, risk paths) and add your stack's tools to `.factory/Dockerfile`.
3. **Add the `CLAUDE_CODE_OAUTH_TOKEN` secret** to the repo, for the second opinion.
4. **Gitignore** `.factory/runs/` and `.sandcastle/`.
5. **Write `AGENTS.md`.** The prompts point agents at it for which commands to run, where each kind of test lives, and which files must stay numbered in order.

## Running the factory

You need Node 26, Docker and the `gh` CLI, signed in. The keychain storage is macOS only for now.

```sh
npm ci
cp factory.example.yml factory.yml     # your app, keychain item names and repos
bin/setup-keychain.sh                  # stores the Claude token and the app key in the keychain
npm run build-images                   # each repo's sandbox image, from its .factory/Dockerfile
npm run factory                        # keeps watching; add -- --once for a single pass
```

`factory.yml` is gitignored. The work-in-progress limit in it is shared across all your repos.

## Working on the kit

`npm run typecheck && npm test`. Node runs the TypeScript directly, so there's no build step. The factory doesn't work on this repo: changes are made by hand and merged by the maintainer. A repo picks up a change when the `v1` tag moves.
