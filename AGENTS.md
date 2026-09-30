# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

`indeed-axi` is an AXI-compliant CLI over the Indeed **employer dashboard**
via a persistent authenticated browser (there is no public employer API).
Phase 0 (this) covers the transport: browser daemon, auth, ref-based
interactive primitives, and discovery capture. Later phases add domain
commands (candidates, messages, pipeline) built from discovery artifacts.
The requirements source is `REQUIREMENTS.md` in this repo. Keep the AXI
principles in mind for every change:

1. TOON output by default, `--json` opt-in
2. Minimal list schemas by default
3. Truncate with size hints, `--full` escape hatch
4. Pre-computed aggregates (counts, summaries)
5. Definitive empty states ("0 matches")
6. Structured errors on stdout; exit 2 usage / 1 runtime; unknown flags fail
   loud; never prompt
7. Ambient context via `setup hooks`, opt-in only
8. No-args home view is live content, not help
9. `help[]` next-step suggestions after output
10. Every command has a concise `--help`

## Hard rules

- **Never commit secrets or candidate PII.** The repo holds code and skill
  docs only. Resumes, applications, threads, and captured documents live
  under `~/.indeed-axi/` (user-level, gitignored). Tests must pass with no
  browser running.
- **Commit `dist/` with every source change.** After editing `src/`, run
  `npm run build` and commit `dist/` in the same change.
- **Network/browser access lives in `src/browser/` only.** Commands receive
  injected daemon connections and runners; tests pass fakes. Do not call
  `fetch`, spawn Chrome, or import playwright outside `src/browser/`.
- **All browsing is headed.** Never headless, never a background daemon
  doing invisible work - the daemon is a *visible* Chrome window the user
  can watch. One browser at a time, enforced by the launch lock.
- **Indeed-only scoping.** Navigation and actions are limited to
  `*.indeed.com`; the authenticated profile is never pointed elsewhere.
- **The Playwright-controlled browser is the only web client for
  indeed.com.** No cookie export, no replaying requests through a separate
  HTTP client.
- **Never log or persist cookies, headers, or credential-shaped keys.**
  Captured artifacts pass through `redactJsonText()`; error paths through
  `redact()`.
- **This is an internal tool** operating on accounts I am authorized to
  manage. Visible, user-invoked Playwright interaction through the normal
  Indeed interface is direct user interaction.
- **Exit codes:** `VALIDATION_ERROR` (and only it) maps to exit 2; everything
  else is 1. The SDK's error mapping owns this - do not hand-roll it.

## Layout

```
bin/indeed-axi.js     entrypoint; fast-path version probe, then dist/
src/lib/              args (strict parseArgs), output, guard, truncate,
                      dotenv (working-dir .env, env wins)
src/browser/session.ts  state dir (~/.indeed-axi), session record, launch
                       lock, Indeed auth classification, login wait
src/browser/daemon.ts   persistent headed Chrome: spawn (detached, CDP
                       port), state file, connect-over-CDP, stop;
                       in-page error collector init script
src/browser/appapi.ts   in-page GraphQL transport: auth-header sniff from
                       live dashboard traffic (memory only), in-page fetch
                       against apis.indeed.com/graphql, settle+retry for
                       SPA context churn
src/browser/snapshot.ts ref-based page outline (in-page script + pure
                       helpers: clipLines, filterLines, parseTarget)
src/browser/capture.ts  discovery network recorder (Indeed hosts only,
                       redacted)
src/browser/artifacts.ts run dirs + sanitized snapshots
src/browser/runners.ts  login / probe / discover orchestration (daemon)
src/indeed/queries.ts   GraphQL documents extracted verbatim from the
                       discovery run (docs/discovery-2026-09-29.md)
src/indeed/model.ts     canonical summarizers (jobs, candidates, threads)
src/indeed/api.ts       operation wrappers + --job reference resolution
src/store/store.ts      candidate packet store (~/.indeed-axi/store/)
src/commands/           one file per command family
src/index.ts            runAxiCli registration
test/                   vitest, fully mocked daemon + pages
skills/indeed-axi/      installable agent skill
```

## Snapshot ref rules

- Refs (`[ref=eN]`) are assigned per snapshot via a `data-ia-ref` attribute;
  click/fill/select resolve them to locators. Public Playwright API only.
- Refs reset on every snapshot and navigation. Stale refs fail as
  `STALE_REF` with re-snapshot guidance - never retry blindly.
- Only viewport-intersecting interactive elements get refs. Hidden/off-canvas
  elements render as `(offscreen)` without a ref; below-fold content becomes
  actionable after scrolling + re-snapshot.

## Domain commands (reads)

The GraphQL transport (`src/browser/appapi.ts`) works like this: ensure the
daemon, land on the dashboard, sniff the exact headers the app itself sends
to `apis.indeed.com/graphql` from live traffic (reloading the page to
trigger its burst when idle; headers live in memory for one command and are
never persisted), let the SPA settle, then run in-page same-origin fetches
with those headers. 401/403 surfaces as `AUTH_ERROR` with a login hint;
GraphQL `errors[]` surfaces as `APP_API_ERROR` suggesting a re-discovery.

Queries in `src/indeed/queries.ts` are extracted verbatim from the
discovery run. If a schema drift breaks one, re-run `discover`, re-extract,
and keep the discovery doc updated. Never hand-write queries.

Candidate packets (submissions, application answers, thread refs) are PII:
they persist only under `~/.indeed-axi/store/` and never in the repo.
Syncs pace per-candidate fetches (~300 ms) - keep it human-pace.

## Gated writes

Mutations (`messages send`, `stage move`, `candidates note`) are plan-preview
by default: live resolution + full preview output + **zero mutation calls**;
each gate has a test proving the mutation document is never sent without
`--confirm`. With `--confirm`: one write per invocation, verify-by-reread
(send -> thread re-read; stage -> mutation's own milestone response), and
never any bulk operations. Sends are candidate-facing - the human approves
every one. Notes are employer-internal (the score-sync channel).

Mutation documents live in `src/indeed/queries.ts` beside the reads,
extracted verbatim from discovery.

## Commands

```
npm run build       # tsc -> dist/ (committed to the repo; rebuild on change)
npm test            # vitest run
npm run typecheck
```

Run the CLI locally with `node bin/indeed-axi.js` (after `npm run build`).
It works with no browser running: the home view, `auth status`, and
`browser status` read state files and never launch anything.

Live Indeed testing is an explicit local operation. Prefer read-only
commands (`browser open`, `snapshot`, `find`, `goto`) when verifying against
production. Anything that mutates state (clicks on buttons that submit,
sends) happens under the user's eye in the visible window - narrate what you
are about to do first.
