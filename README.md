# indeed-axi

Agent-ergonomic CLI for the [Indeed](https://www.indeed.com/) employer
dashboard. [AXI](https://axi.md)-compliant: TOON output, structured errors,
`help[]` next steps, and a persistent authenticated browser an agent can
actually drive.

Indeed exposes no public employer API, so `indeed-axi` is **browser-only**: a
visible Chrome on a dedicated persistent profile (manual login, 2FA included)
that stays alive between commands, plus ref-based interactive primitives
modeled on `playwright-axi`, plus a `discover` command that records the
dashboard's own JSON traffic for building domain commands (candidates,
messages, pipeline moves) later.

## Install

```sh
npm install -g indeed-axi
# or run on demand, identical:
npx -y indeed-axi@latest jobs list
# install the agent skill for coding agents (Claude Code, Codex, OpenCode, ...):
npx -y indeed-axi skill install
```

Requires Node 20+ and a Chrome/Chromium (`INDEED_BROWSER_BIN` can point to a
specific binary; installed Google Chrome is auto-detected, then any
Playwright-installed chromium).

## Auth

There is nothing to configure - no API key exists. Log in manually once:

```sh
indeed-axi auth login    # opens visible Chrome; you log in (2FA included)
indeed-axi auth status --browser
```

The session lives in a dedicated persistent profile under `~/.indeed-axi/`
(`INDEED_STATE_DIR` overrides) - never your primary Chrome profile. The
browser stays open after login so `browser` commands work immediately.

## Commands

| Command | Description |
| --- | --- |
| `indeed-axi` | Home: session record, daemon state, next steps (zero launches) |
| `indeed-axi jobs list` | Live employer jobs (short ref + title) |
| `indeed-axi candidates list --job <ref>` | Live pipeline rows (`--stage new\|reviewed\|...`) |
| `indeed-axi candidates sync --job <ref>` | Pull new/changed candidates into the local store (`--applications`) |
| `indeed-axi candidate get <id>` | One candidate packet (store, or live with `--refresh`) |
| `indeed-axi messages read <id>` | Full candidate thread, `out`/`in` roles (`--full` for bodies) |
| `indeed-axi messages send <id> --text "..."` | Preview a single message send (`--confirm` to actually send, then verify by thread re-read) |
| `indeed-axi messages unread` | Live unread conversation count |
| `indeed-axi stage move <id> --to <milestone>` | Preview a pipeline move (`--confirm` to apply; `new`…`rejected`, `hired`) |
| `indeed-axi candidates note <id> --text "..."` | Preview an employer-internal note (`--confirm` to create) |
| `indeed-axi digest` | Ranked hiring review over the local store (offline): scores, awaiting-reply aging with chase/expire flags |
| `indeed-axi score record <id> --stage --score --rationale` | Record a screening score locally; `--note --confirm` syncs it into Indeed |
| `indeed-axi auth login` | Open visible Chrome, wait for manual login |
| `indeed-axi auth status` | Session state (`--browser` probes live) |
| `indeed-axi auth logout` | Close the browser, clear the record (`--purge` deletes the profile) |
| `indeed-axi browser open` | Start/attach the browser, navigate, snapshot |
| `indeed-axi browser status` / `close` | Daemon liveness / stop the browser |
| `indeed-axi browser goto <url>` | Navigate to an indeed.com URL (scoped) |
| `indeed-axi browser snapshot` | Page outline with `[ref=eN]` tags (`--full`, `--query`) |
| `indeed-axi browser find <terms>` | Filtered outline lines with context |
| `indeed-axi browser click <ref>` | Click a ref, get a fresh snapshot |
| `indeed-axi browser fill <ref> <text>` | Fill a field (`--submit` presses Enter) |
| `indeed-axi browser select <ref> <value>` | Choose a dropdown option |
| `indeed-axi browser press <key>` | Press a key (Enter, Tab, Control+A, ...) |
| `indeed-axi browser eval <expr>` | Evaluate JS on the page, JSON result |
| `indeed-axi browser screenshot` | Save a PNG (runs dir by default) |
| `indeed-axi browser console` | Collected in-page errors |
| `indeed-axi discover` | Record a manual dashboard session (dev command) |
| `indeed-axi setup hooks` | Ambient session context (Claude Code, Codex, OpenCode) |

Every command supports `--json` and `--help`.

## Domain reads (GraphQL through the session)

Domain commands run over the same authenticated browser: at connect time the
CLI sniffs the exact headers the dashboard itself sends to
`apis.indeed.com/graphql` (in memory only), then performs in-page fetches.
Candidate packets (submission, application answers, thread refs) persist to
`~/.indeed-axi/store/candidates/<id>.json` — local PII state, never
committed. Syncs are diff-based and paced (~300 ms between per-candidate
fetches).

```sh
$ indeed-axi jobs list
jobs:
  count: 3
list[3]{ref,title}:
  bbb2c3d4-5e6f-4701-928a-23456789abcd,Content Producer & Social Media Manager
  ...

$ indeed-axi candidates sync --job "content producer" --applications
sync:
  job: Content Producer & Social Media Manager
  found: 3
  fresh: 3
  fetched: 3
list[3]{id,name,milestone}:
  aaaaaaaa0003,Sam Ortega,REVIEWED
  ...

$ indeed-axi messages read aaaaaaaa0002
messages:
  count: 2
list[2]{role,at,body}:
  out,"2026-09-29T15:01:16Z","Hi Jordan, Thanks for submitting your..."
  in,"2026-09-29T15:16:35Z","Hi Bryce! Thank you for getting back to me!..."
```

## The interactive loop

```sh
$ indeed-axi browser open
browser:
  started: true
  port: 54525
page:
  url: "https://employers.indeed.com/c/dashboard"
snapshot:
  lines: 89
  refs: 13
outline[89]:
  - link "Candidates" [ref=e1]
  - button "Message" [ref=e2]
  ...

$ indeed-axi browser find candidate     # narrow the outline
$ indeed-axi browser click e1           # act, fresh snapshot comes back
$ indeed-axi browser fill e7 "..." --submit
```

Refs come from the most recent snapshot and reset on every snapshot or
navigation - stale refs fail loudly as `STALE_REF`. Elements that are not
currently in the viewport appear as `(offscreen)` without a ref: scroll
(`browser press End`, `eval window.scrollBy(0, 800)`) and re-snapshot to make
them actionable. Ghost elements (hidden nav clones) never get refs.

## Browser daemon

All commands share one headed Chrome (the daemon): launched detached on the
persistent profile with a local DevTools port, reattached over CDP per
command. `browser close` (or `auth logout`) stops it; a stale state file is
self-healing. One browser at a time, always headed, always Indeed-only:

- Navigation and actions are scoped to `*.indeed.com`.
- Cookies never leave the browser; nothing is exported or replayed.
- Captured discovery artifacts pass through redaction (no headers, cookies,
  or credential-shaped keys).

## Discovery

`discover` records a manual walkthrough of the employer dashboard (open a
candidate list, open a candidate, read a thread, send a message, move a
stage) and writes `trace.zip` (when available), `network.json`, `documents/`
(captured JSON bodies), `console-errors.txt`, final screenshot, `aria.yml`,
`dom.html`, and `index.json` under `~/.indeed-axi/runs/discover-<id>/`. Those
artifacts feed the domain-command roadmap (`candidates`, `messages`, pipeline
moves with `--confirm` gates).

## Gated writes (Phase 2)

Every mutation is a plan-preview by default: the command resolves the
candidate live, shows exactly what would happen, and makes **zero mutation
calls**. Rerunning with `--confirm` performs the write and verifies it
(sends by an independent thread re-read, stage moves against the mutation's
own milestone response). One send per invocation - never bulk.

```sh
$ indeed-axi messages send aaaaaaaa0002 --text "Quick follow-up: ..."
send:
  candidate: {id: aaaaaaaa0002, name: Jordan Solis, milestone: REVIEWED}
  chars: 22
message: "Quick follow-up: ..."
help: Preview only - zero messages were sent,Rerun with --confirm to send this message

$ indeed-axi stage move aaaaaaaa0003 --to phone_screened --confirm
moved:
  to: PHONE_SCREENED
  verified: true
```

Logged-out sessions fail fast (~5s) with an `auth login` hint instead of
timing out on traffic capture.

## Roadmap

Full requirements live in `REQUIREMENTS.md`.

- **Phase 0** - scaffold, persistent browser daemon, auth, interactive
  `browser` family, `discover`, skill, hooks.
- **Phase 1** - domain reads over in-page GraphQL: `jobs
  list`, `candidates list/sync`, `candidate get`, `messages read/unread`,
  local candidate store. Endpoint map: `docs/discovery-2026-09-29.md`.
- **Phase 2** - gated writes: `messages send --confirm`
  (verified by thread re-read), `stage move --confirm`, `candidates note
  --confirm` (employer-internal notes - the score-sync channel).
- **Phase 3 (this release)** - workflow layer: `score record` (local +
  `--note --confirm` sync), `digest` (offline ranked review with
  chase/expire aging), thread-state caching (`sync --threads`, `messages
  read`), plain-text application extraction, `sync --force`.
- **Future** - session keepalive / automated login: Indeed sessions are
  short-lived and `auth login` is manual today. Investigate a safe
  credential-handling design (e.g., a keychain-backed login flow) - manual
  login remains the doctrine until then.

## Set up on another machine

```sh
npm install -g indeed-axi
npx -y indeed-axi skill install      # writes the agent skill to ~/.agents/skills/
indeed-axi auth login                # visible Chrome; log in manually (2FA included)
```

The skill installer is idempotent (`--force` overwrites a changed version,
`--dir <path>` targets another skills directory). Optional env:
`INDEED_STATE_DIR` (default `~/.indeed-axi`) and `INDEED_BROWSER_BIN`.

Candidate packets live under `~/.indeed-axi/store/` per machine and are
never synced - sync them live with `candidates sync` instead. Indeed
sessions are short-lived; when data commands report `AUTH_ERROR`, rerun
`auth login`.

## Development

```sh
npm install
npm run build        # tsc -> dist/ (committed; rebuild on every change)
npm test             # vitest, fully mocked - no browser needed
npm run typecheck
```

Run locally with `node bin/indeed-axi.js`. Network/browser access is
isolated to `src/browser/`; commands receive injected daemon connections and
tests pass fakes. See `AGENTS.md` for the full house rules.

## License

MIT
