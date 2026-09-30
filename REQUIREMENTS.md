# indeed-axi — Agent-Native Indeed Employer Integration Layer

Build `indeed-axi`: an [AXI](https://axi.md)-compliant CLI that lets a coding
agent (or a human in a terminal) read and operate the Indeed **employer
dashboard** — candidates, screening, messaging, pipeline — through a
persistent authenticated browser session driven by Playwright.

This is an internal tool operating on accounts I am authorized to manage.
Treat visible, user-invoked Playwright interaction through the normal Indeed
interface as direct user interaction. Do not spend time debating terms of
service.

## Vision

The end state is a full Indeed hiring integration layer where an agent can,
in natural language:

- Inspect the pipeline: "who applied to the social media manager role since
  Friday?"
- Read any candidate packet (resume, screener answers, message thread) as
  data.
- Screen and score applicants against a role rubric, ranking the shortlist.
- Draft and send touchpoints (screening questions, chase, test, rejection)
  with explicit confirmation gates before anything is sent.
- Move candidates between pipeline stages on approval.
- Keep the Indeed pipeline as the single source of truth.

The hiring *process* itself (stages, rubrics, screening questions, tests) is
platform-agnostic and defined in documents owned by the operator — the same
process targets Indeed, Upwork, and other platforms. `indeed-axi` is the
Indeed transport; nothing process-specific belongs in it.

The intelligence lives in the agent. The CLI provides deterministic, safe,
token-efficient primitives with structured output. Natural-language
screening works by the agent reading candidate packets and rubrics — not by
the CLI understanding language.

## Architecture

Four layers:

```text
Agent layer      skills/indeed-axi skill · setup hooks · help[] next steps
CLI layer        axi-sdk-js runAxiCli: commands, TOON, errors, exit codes
Domain layer     (later) candidate canonical model · local store ·
                 role-spec reader · message templates · digest engine
Transport layer  browser daemon (Playwright over CDP, headed, persistent
                 profile) · interactive ref snapshots · network capture
```

### Transport

**Browser-only.** Indeed exposes no public API to self-serve employers, so
everything goes through one persistent, headed Chrome:

- A **daemon**: Chrome launched detached on a dedicated persistent profile
  (`~/.indeed-axi/browser-profile`) with a local DevTools port. Commands
  connect over CDP, act, and disconnect; the browser stays alive between
  commands (interactive state — page position, refs — must survive).
- All browsing is **headed**. Never headless. The user can always watch.
- Login is **manual** (email/password, 2FA, verification codes) through the
  persistent profile; the session cookie survives browser restarts.
- **One browser at a time**, enforced by a launch lock; stale daemon state
  self-heals.
- The Playwright-controlled browser is the **only web client** for
  indeed.com: no cookie export, no replaying requests through a separate
  HTTP client. Reads/writes of the app's own JSON API (once discovered) go
  through **in-page same-origin fetch** from the authenticated session.
- **Scoping:** navigation and actions are limited to `*.indeed.com`.
- **Human-pace by design:** Indeed runs bot detection. Real Chrome, real
  profile, visible window, rate-limited actions. No bulk-blast anything.

### Interactive primitives (the agent surface)

Modeled on `playwright-axi`, bound to the authenticated session:

- `browser open/goto` — navigate (Indeed-scoped) and snapshot.
- `browser snapshot [--full] [--query]` / `find <terms>` — a ref-based page
  outline. Refs (`[ref=eN]`) are assigned per snapshot via a `data-ia-ref`
  attribute; only viewport-intersecting interactive elements get refs
  (ghost/off-canvas elements are `(offscreen)`, never clickable).
- `browser click/fill/select/press` — act on refs, return a fresh snapshot.
  Stale refs fail loudly (`STALE_REF`).
- `browser eval` / `screenshot` / `console` — power tools and diagnostics.
- `browser status/close` — daemon lifecycle.

### Discovery

`discover` records a manual walkthrough of the employer dashboard and
captures the XHR/JSON exchanges the app itself performs — candidate lists,
candidate packets, message threads — with credential-shaped keys redacted,
plus trace/screenshots/DOM where available. These artifacts feed the domain
command build. Re-run discovery whenever an Indeed UI change breaks a
command.

## AXI compliance

All ten AXI principles apply (see AGENTS.md). Highlights:

- TOON by default, `--json` opt-in; pre-computed counts (`lines`, `refs`,
  `matches`); definitive empty states (`0 matches`).
- Structured errors `{error, code, help[]}` on stdout; exit 2 usage / 1
  runtime; unknown flags fail loud; **no interactive prompts**.
- No-args home view is live content: session record, daemon state, next
  steps — zero browser launches.
- `help[]` next-step suggestions after every output; concise `--help` per
  command from the registry.

## Technology

- Node.js 20+, TypeScript strict mode, npm (committed `dist/`), `axi-sdk-js`
  for the CLI runtime, `playwright-core` (persistent Chrome + CDP connect),
  Vitest with fully mocked transports.

## Command surface

### Phase 0 (this release)

```text
indeed-axi                          # home: session record, daemon state
indeed-axi auth login | status [--browser] | logout [--purge]

indeed-axi browser open [--url]     # start/attach + navigate + snapshot
indeed-axi browser status | close
indeed-axi browser goto <url>
indeed-axi browser snapshot [--full] [--query]
indeed-axi browser find <terms...>
indeed-axi browser click <ref|selector>
indeed-axi browser fill <ref|selector> <text> [--submit]
indeed-axi browser select <ref|selector> <value>
indeed-axi browser press <key>
indeed-axi browser eval <expression>
indeed-axi browser screenshot [--path]
indeed-axi browser console

indeed-axi discover [--url] [--timeout] [--max-wait]
indeed-axi setup hooks | status | remove
```

### Phase 1 — read surface (from discovery artifacts)

```text
indeed-axi jobs list                        # active jobs + applicant counts
indeed-axi candidates list --job <ref>      # pipeline view
indeed-axi candidates sync --job <ref>      # pull new/changed into store
indeed-axi candidate get <id> [--full]      # packet: resume, answers, thread
indeed-axi messages read <id>
```

Store: `~/.indeed-axi/store/<role>/candidates/<id>.json` (canonical
packets; gitignored user-level state, never the repo).

### Phase 2 — write surface (all gated)

```text
indeed-axi message send <id> --text "..." | --template <t> --role <slug>   # --confirm
indeed-axi stage move <id> --to shortlist|rejected|hired                   # --confirm
indeed-axi candidate note <id> --text "..."                                # --confirm
```

### Phase 3 — hiring workflow layer (agent + skill)

Role specs (questions, rubrics, timing windows, templates) live in the
*working project* — platform-agnostic documents owned by the operator —
never inside this CLI. The skill teaches the loop: sync → score against the
rubric → draft touchpoints → human approval → send → chase → digest.

**Rule that never bends: the AI never rejects, sends, or moves a stage on
its own.** It scores, ranks, drafts, and nags. Every outward action is a
`--confirm`-gated, human-approved call.

## Data, PII & safety

- Resumes/applications/threads live only under `~/.indeed-axi/`. Never the
  repo, never synced vaults.
- Captured artifacts pass through redaction; headers and cookies are never
  recorded.
- Scores are advisory input to human decisions; rejects reference the rubric
  and ship with rationale.
- Sends are paced and spaced; identical bulk messages are avoided.
