---
name: indeed-axi
description: Use indeed-axi for Indeed employer-dashboard tasks - listing jobs, browsing candidates, syncing applications, reading message threads, sending messages, moving pipeline stages, and recording dashboard traffic for automation - instead of driving a raw browser. Covers domain reads over the authenticated GraphQL session plus the full interactive browser loop (open, snapshot, find, click, fill). First choice whenever a task touches the Indeed employer account.
---

# indeed-axi

Agent-ergonomic CLI over the Indeed employer dashboard via a persistent
authenticated browser. TOON output, structured errors, `help[]` next steps.
There is no Indeed employer API - everything goes through the visible Chrome
session this tool manages.

## Session model

One visible Chrome (headed, dedicated profile at `~/.indeed-axi/`) stays
alive between commands (the daemon). Login is manual once: `indeed-axi
auth login` (waits for you to complete 2FA), then the session persists.
Domain commands (jobs/candidates/messages) start the browser automatically
when needed, land on the dashboard, and reuse the authenticated session -
a Chrome window may appear; that is expected and it is the audit trail.

## Domain commands (the hiring surface)

```sh
indeed-axi jobs list                                # ref + title per job
indeed-axi candidates list --job <ref> [--stage s]  # live pipeline rows
indeed-axi candidates sync --job <ref> [--applications]   # pull packets
indeed-axi candidate get <id> [--refresh] [--full]  # one candidate packet
indeed-axi messages read <id> [--full]              # thread, out/in roles
indeed-axi messages unread                          # live unread count
```

- `--job <ref>`: uuid from `jobs list`, full key, or unique title prefix.
  Ambiguous refs fail with both options listed - pick one.
- Stages: `new`, `pending`, `reviewed`, `phone_screened`, `interviewed`,
  `offer_made`.
- Sync writes packets to `~/.indeed-axi/store/candidates/<id>.json`
  (local PII, never committed) and skips unchanged candidates.
- `--applications` also fetches each candidate's full application
  (screener answers as HTML). Heavier; use it when screening.
- `candidate get --full` returns the complete packet including application
  html and raw submission - the substrate for AI scoring.

### The screening loop (how to run a pipeline)

1. `indeed-axi candidates sync --job <ref> --applications --threads` →
   packets with application text + thread state. Add `--force` to refetch
   unchanged rows.
2. `indeed-axi digest [--job <ref>]` → the ranked review (offline): top
   scores, awaiting-reply aging (CHASE/EXPIRE flags), replied, unscored.
   Pass `--chase-days/--expire-days` when your process docs differ from
   the 5/10 defaults.
3. For each candidate the digest surfaces: `indeed-axi candidate get <id>`
   (packet, scores, thread direction) and `indeed-axi messages read <id>`
   (Q&A thread; also refreshes the cached thread state).
4. Score against the operator's process/rubric documents (they live outside
   this tool - platform-agnostic by design):
   `indeed-axi score record <id> --stage application|screening|test --score
   N --rationale "..." [--rubric <name>]`. Local write; add `--note
   --confirm` to also sync the score into the Indeed pipeline.
5. Draft the next touchpoint from the process docs, show the user, send
   with the gate: `messages send <id> --text "<draft>"` → approval →
   `--confirm`. Move stages with `stage move <id> --to <m>` → `--confirm`.
   Notes for anything employer-internal: `candidates note`.

## Writes (gated - the human approves every candidate-facing action)

- Without `--confirm` the command resolves the candidate live, prints the
  exact preview (message body, from/to milestones, note text), and makes
  zero mutation calls. Always show this preview to the user and get
  approval before rerunning with `--confirm`.
- `messages send <id> --text "..."` - one message per invocation, verified
  by an independent thread re-read after sending.
- `stage move <id> --to <milestone>` - milestones: new, pending, reviewed,
  phone_screened, interviewed, offer_made, rejected, hired. No-op (no
  mutation) if the candidate is already at the target.
- `candidates note <id> --text "..."` - employer-internal notes; the way AI
  scores and screening rationale sync into the Indeed pipeline.
- Never bulk-send or bulk-move. Pace everything; the browser is visible.

## Interactive browser (fallback for anything without a command)

1. `indeed-axi browser open` (or `browser goto <indeed-url>`) - navigate and
   get the page outline with `[ref=eN]` tags.
2. Narrow with `browser find <terms>`; act with `browser click eN`,
   `fill eN "text" --submit`, `select eN "value"`, `press Enter`. Every
   action returns a fresh snapshot - read it before the next action.
3. Refs reset on every snapshot/navigation; stale refs fail loudly
   (`STALE_REF`). `(offscreen)` elements have no ref: scroll
   (`eval window.scrollBy(0, 800)`), re-snapshot.
4. Diagnostics: `browser console`, `browser screenshot`, `browser eval`.

## Safety

- Anything that submits, sends, or changes state happens in the visible
   window under the user's eye. Narrate before acting on buttons that
   submit/send/reject.
- If a session drops to a login page, stop and tell the user to run
  `indeed-axi auth login` - never enter credentials yourself.
- Human-pace: no rapid-fire bulk actions; Indeed runs bot detection.
- Candidate data is PII: quote only what the task needs from packets; the
  store stays local.

## Discovery (when building/fixing domain commands)

`indeed-axi discover` records a manual dashboard walkthrough and writes
redacted network/documents artifacts under `~/.indeed-axi/runs/<id>/`.
The current endpoint map lives in the repo at
`docs/discovery-2026-09-29.md` (GraphQL at apis.indeed.com/graphql; full
query text is captured). If a domain command fails with APP_API_ERROR,
the schema drifted: re-run discover, re-extract the query, update the doc.

## Auth commands

- `indeed-axi auth status [--browser]` - record, or live probe with `--browser`
- `indeed-axi auth login [--timeout <ms>]` - visible Chrome, manual login wait
- `indeed-axi auth logout [--purge]` - close browser, clear record, optional
  profile delete

## Invocation

Installed globally: `indeed-axi <command>`. Otherwise:
`npx -y indeed-axi@latest <command>`. Default output is TOON; pass `--json`
for machine-readable JSON. Exit codes: 0 success, 2 usage/validation, 1
runtime. Errors carry `error`/`code`/`help[]`.

## Conventions

- Empty results are explicit (`count: 0`), never blank.
- Identifier discipline: job refs come from `jobs list`, candidate ids from
  `candidates list`/store - never guess.
- The no-args home view (`indeed-axi`) shows session + daemon state and next
  steps with zero launches.

## Roadmap context

The transport and workflow primitives are complete. The hiring *process*
itself (stages, rubrics, screening questions, timing windows) lives in the
operator's platform-agnostic documents outside this tool - read them
directly and apply them through these commands. Future: session keepalive /
automated login (sessions are short-lived; manual `auth login` is the
doctrine for now).
