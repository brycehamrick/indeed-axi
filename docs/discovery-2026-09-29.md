# Discovery 2026-09-29 — Indeed Employer Dashboard API Map

Source: `~/.indeed-axi/runs/discover-20260929-085938-e88b/` (375 exchanges,
88 documents, live employer session). Names and message bodies below appear
only as schema illustrations; candidate data lives in the run directory and
nowhere else.

## Transport summary

- The dashboard is a GraphQL SPA. **Every domain call is a POST to
  `https://apis.indeed.com/graphql`** with `{operationName, variables,
  query}` — full query text is sent, not persisted hashes, so captured
  request bodies contain complete, replayable query documents.
- Resume PDFs come from a REST endpoint on the dashboard origin:
  `https://employers.indeed.com/api/catws/resume/v2/download?id=<legacyID>&indeedcsrftoken=<token>`
  → `application/pdf`.
- The resume download carries an `indeedcsrftoken` query param. GraphQL
  mutation auth headers were not recorded (by design). Phase 1 writers must
  run as in-page same-origin fetches (cookies ride automatically); if a CSRF
  header is required, capture it from live traffic at runtime via the
  recorder before the first mutation.
- Telemetry noise (ignore): `s.indeed.com` snowplow, `one-host-datadog-rum`,
  `t.indeed.com/signals`. `encserv.indeed.com` SSE streams returned 403
  during capture.

## Identifier kinds

| Kind | Example | Where it comes from |
| --- | --- | --- |
| `candidateSubmissionId` | base64 of `iri://apis.indeed.com/CandidateSubmission/V1__CALLY__<legacyID>` | candidate list rows |
| `legacyID` / `candidateKey` | `aaaaaaaa0001` (hex) | candidate rows; also the resume-download `id` and the messaging `candidateKey` |
| `jobId` | `bbbbbbbbbbbbbbbbbbbb0001` | candidate rows, jobs list |
| `advertiserKey`, `aggJobKey` | hex | candidate rows / messaging context |
| conversation `id` | base64-ish opaque | `GetConversations` / `FindConversations` |

Never guess identifiers — list first.

## Read operations (GraphQL)

### Jobs
- `FindEmployerJobs` — jobs list. Variables: `{input: {limit, filter}}`.
  The captured call used `limit: 0` (count only) with a status filter
  (`hostedJobStatus` not in `CLOSED`/`PAUSED`). Response:
  `data.findEmployerJobs.estimatedTotalResultsCount` + jobs when
  `limit > 0`.
- `GetEstimatedJobResultCount`, `Sponsor_EmployerAlertsModule_*` —
  ancillary.

### Candidates (pipeline)
- `CandidateListIds` → `data.findCandidateSubmissions` — the applicant list
  for a job/pipeline view.
- `CRP_CandidateSubmissions` — submissions by `legacyIds` (candidate-reveal
  page). Row shape below.
- `GetCandidateSubmission` — one candidate's full submission (same row
  shape).
- `CandidateDetailsIQP` — candidate detail page data.
- `FindUnifiedPipelineCandidateFilterOptions`,
  `FindGroupedCandidateSubmissionFilterOptions` — pipeline stage/filter
  metadata.
- `OriginalApplicationData` — the application itself:
  `data.originalApplicationData.applicationPreview.html` (rendered
  application incl. screener answers), `.attachments[]`, `.postBody`
  (`downloadUrl`, `fileName`, `mimeType`). Largest captured doc (92 KB).
- `QualificationQuestionSetByEntity` — screener question sets.

**Candidate submission row** (`data.candidateSubmissions.results[].data`):

```text
profile.name.displayName        candidate name
profile.location / contact      location, contact info
milestone.milestone.milestoneId current stage (NEW | REVIEWED | PHONE_SCREENED | REJECTED | …)
milestone.startTime / created   epoch ms
legacyID                        hex id (resume download + messaging key)
aggJob / job                    job refs (title, keys)
resume / supportingFiles        resume refs
sources / activity / feedback / sentiment / sentiments
submissionUuid / metadata / candidateIdentity
talentRepresentation            full profile: experience, education, skills,
                                languages, summary, headline, …
```

### Messaging
- `GetConversations` — `data.findConversations.conversations[]`
  (`{id, eventsConnection}`).
- `GetConversationAndEvents` — the full thread;
  `data.conversation` + events whose nodes carry `messageBody`, sender,
  timestamps. **This is the AI-scoring payload**: outbound screening
  questions and candidate answers in one document.
- `FindConversations`, `FindConversationsByCandidateKey` — thread lookup by
  candidate.
- `UnreadConversationCount` — badge count.

### Sourcing / AI features (Indeed's own)
- `FindRCPMatches` — recommended candidate matches (sourcing).
- `Nex_SmartScreeningSummary_Applicant` — Indeed's own AI screening summary
  per applicant (useful cross-check for our scoring; do not depend on it).
- `RiskAssessment`, `VerificationMethods` — trust signals.

## Write operations (GraphQL mutations)

### Send a message
`SendConversationEvent` — variables:

```json
{
  "messageBody": "<text>",
  "context": {
    "context": "HQM_DRADIS",
    "scope": { "preOrPostApply": {
      "advertiserKey": "<hex>", "aggJobKey": "<hex>", "candidateKey": "<legacyID>"
    }}
  },
  "eventId": "<uuid4>",           // client-generated
  "correlationKey": "<uuid4>",    // client-generated
  "clientName": "messaging-react",
  "includeRequireResponse": false,
  "attachments": [], "payload": []
}
```

Response: `data.sendConversationEvent` (confirmation).

### Move pipeline stage
`UpdateCandidateStatus` → mutation `updateCandidateSubmissionMilestone`:

```json
{ "statusInput": { "move": {
    "milestoneId": "REVIEWED",
    "candidateSubmissionEmployerJobIdPairs": [
      { "candidateSubmissionId": "<base64 iri>", "jobId": "<hex>" }
    ]
}}}
```

Known milestone ids observed: `NEW`, `REVIEWED`, `PHONE_SCREENED`,
`REJECTED` (full set from the filter-options op during Phase 1).

### Others
- `MarkCandidateSubmissionViewed` — marks a candidate seen.
- `UpdateConversationReadCursor` — marks a thread read.
- `UpdateCandidateSubmissionMilestone` — direct milestone variant.
- `TemplatesMarkAsUsed` — message template bookkeeping.
- `ScheduledMessageV2_EmployerAutomation` — scheduled messages (their
  native delayed-send; possibly useful for chase timing).
- `Nex_AutoRejectionAutomation` — Indeed's auto-reject feature. **We do not
  use this** — rejections are human decisions in our doctrine.

## Resume download (REST)

```text
GET https://employers.indeed.com/api/catws/resume/v2/download?id=<legacyID>&indeedcsrftoken=<token>
→ application/pdf (binary)
```

The CSRF token is page-provided; Phase 1 fetches it in-page (same-origin)
rather than storing it anywhere.

## Phase 1 command mapping

| Command | Operations |
| --- | --- |
| `jobs list` | `FindEmployerJobs` (limit > 0) |
| `candidates list --job` | `CandidateListIds` / `CRP_CandidateSubmissions` |
| `candidates sync` | list + `GetCandidateSubmission` + `OriginalApplicationData` per new row |
| `candidate get` | `GetCandidateSubmission` + `GetConversationAndEvents` + resume fetch |
| `messages read` | `GetConversationAndEvents` / `FindConversationsByCandidateKey` |
| `message send --confirm` | `SendConversationEvent` (in-page fetch, gated) |
| `stage move --confirm` | `UpdateCandidateStatus` (gated) |

All GraphQL traffic goes through in-page same-origin fetch against
`apis.indeed.com` from the authenticated session (appfetch pattern);
cookies never leave the browser. Mutations stay `--confirm`-gated with
plan previews that make zero calls.
