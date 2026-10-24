# factory-kit

## Commands
- Run `nvm use` first: the kit needs Node 26 (`.nvmrc`), and Node runs the TypeScript directly.
- Done means `npm run check` passes: Biome lint and format, `tsc`, and every test. CI runs exactly that.
- One test file: `node --test src/gate.test.ts`. Fix formatting: `npm run format`.

## Rules
- Nothing here may assume a stack or a repo. No Gradle, Java, Python, folder names or repo slugs in `src/` or `prompts/`.
  What differs per repo belongs in that repo's `.factory/config.yml` (add a field in `src/config.ts`) or its own
  `AGENTS.md`, which the prompts point agents to.
- Read a repo's config from `origin/main` (`openRepo`), never from a working tree or PR branch: a PR must not be able
  to loosen the rules that judge it.
- Never give an agent a GitHub credential. The sandbox env in `src/sandbox.ts` carries only the Claude token; every
  GitHub call goes through `src/github.ts` as the app.
- `.github/workflows/risk-gate.yml` runs under the caller's `pull_request_target` with a write token. It must never
  check out or run PR code: only the caller's base branch and this kit.
- Plain Node type stripping only: no `enum`, `namespace` or constructor parameter properties, `.ts` in every relative
  import, and `type` on type-only imports. Don't add a build step, `tsx` or a bundler.
- Post to GitHub with `comment()` and `labels()` from `src/github.ts`, not raw `gh` calls, so `@mentions` get escaped.
  Write those messages for the maintainer in plain words.
- Tests sit next to the code (`src/x.test.ts`) and use `node:test`. Put decisions in pure functions (as `gate.ts`,
  `dispatch.ts` and `findings.ts` do) and test those; keep GitHub plumbing thin.

## Releasing
- Repos call the workflows at `@v1` and run the loop from a clone. After a change merges, tag `v1.x.y` and move `v1`
  to it. A change that breaks an existing `.factory/config.yml` or a workflow's inputs needs `v2`.
- `src/fixtures/rsvp-factory.yml` is a copy of rsvp-factory's real config. When that file changes, update this copy too.
