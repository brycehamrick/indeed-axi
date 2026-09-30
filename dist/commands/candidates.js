import { AxiError } from "axi-sdk-js";
import { optionalInt, parseFlags, requirePositional, requiredString, } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { snippet } from "../lib/truncate.js";
import { listCandidates, getCandidate, normalizeMilestone, resolveJobRef, sleep, currentEmployer, conversationsForCandidate, conversationEvents } from "../indeed/api.js";
import { attachApplication, attachThread, diffAgainstStore, packetFromSummary, readPacket, writePacket, } from "../store/store.js";
import { getApplication } from "../indeed/api.js";
/** Look up and read one candidate's thread (used by sync --threads). */
async function fetchThread(api, legacyId) {
    const employer = await currentEmployer(api);
    if (employer === null)
        return null;
    const conversations = await conversationsForCandidate(api, employer.advertiserKey, legacyId);
    if (conversations.length === 0)
        return null;
    return conversationEvents(api, conversations[0].id);
}
export const CANDIDATES_HELP = `indeed-axi candidates - pipeline reads, local store sync, notes

subcommands:
  candidates list --job <ref> [--stage <s>] [--limit <n>]
                         live pipeline rows (legacyId, name)
  candidates sync --job <ref> [--stage <s>] [--applications]
                         pull new/changed candidates into the local store
  candidates note <legacyId> --text "..." [--confirm]
                         add a note to the candidate in Indeed (preview without --confirm)
  candidate get <legacyId> [--refresh] [--full]
                         one candidate packet from the store (or live with --refresh)

flags:
  --job <ref>            job ref from \`jobs list\` (uuid, key, or unique title prefix)
  --stage <milestone>    new|pending|reviewed|phone_screened|interviewed|offer_made
  --limit <n>            max rows for list (default 100)
  --applications         (sync) also fetch each candidate's application data
  --threads              (sync) also fetch and cache the message thread state
  --force                (sync) refetch every row, even unchanged ones
  --text <text>          (note) the note text
  --confirm              (note) actually create - without it, prints a preview
  --refresh              (get) fetch live instead of reading the store
  --full                 (get) complete application html and raw submission
  --json                 machine-readable JSON instead of TOON

The store lives at ~/.indeed-axi/store/candidates/<legacyId>.json - local
PII state, never committed. Sync fetches one submission per candidate at a
human pace (~300ms between calls).

examples:
  indeed-axi candidates list --job "executive assistant"
  indeed-axi candidates sync --job "executive assistant" --applications
  indeed-axi candidates note aaaaaaaa0001 --text "AI screen 8/10 - strong calendar systems"
  indeed-axi candidate get aaaaaaaa0001 --refresh`;
const LIST_FLAGS = {
    job: { type: "string" },
    stage: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
};
const SYNC_FLAGS = {
    job: { type: "string" },
    stage: { type: "string" },
    limit: { type: "string" },
    applications: { type: "boolean" },
    threads: { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
};
const GET_FLAGS = {
    refresh: { type: "boolean" },
    full: { type: "boolean" },
    json: { type: "boolean" },
};
const NOTE_FLAGS = {
    text: { type: "string" },
    confirm: { type: "boolean" },
    json: { type: "boolean" },
};
const STAGES = ["new", "pending", "reviewed", "phone_screened", "interviewed", "offer_made"];
/** Readable excerpt from Indeed's application HTML: drop styles, tags, entities. */
function applicationExcerpt(html) {
    const text = html
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    return snippet(text, 400) ?? "";
}
export async function candidatesCommand(args, ctx) {
    const sub = args[0];
    if (sub === undefined) {
        return { help_text: CANDIDATES_HELP };
    }
    if (sub === "list")
        return list(args.slice(1), ctx);
    if (sub === "sync")
        return sync(args.slice(1), ctx);
    if (sub === "note")
        return note(args.slice(1), ctx);
    throw new AxiError(`candidates: unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Implemented: `candidates list`, `candidates sync`, `candidates note` (plus `candidate get`)",
        "Run `indeed-axi candidates --help` for the reference",
    ]);
}
async function note(args, ctx) {
    const commandPath = "indeed-axi candidates note";
    const { values, positionals } = parseFlags(args, commandPath, NOTE_FLAGS);
    const json = values["json"] === true;
    const legacyId = requirePositional(positionals, 0, "legacyId", commandPath);
    if (positionals.length > 1)
        throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");
    const comment = requiredString(values, "text", commandPath);
    const confirm = values["confirm"] === true;
    const { addNote } = await import("../indeed/api.js");
    const summary = await ctx.app((api) => getCandidate(api, legacyId));
    if (summary === null) {
        throw new AxiError(`no candidate submission found for ${legacyId}`, "NOT_FOUND", [
            "Ids come from `indeed-axi candidates list` - never guess",
        ]);
    }
    if (summary.submissionId.length === 0) {
        throw new AxiError(`cannot note ${summary.name}: the submission id is unavailable`, "VALIDATION_ERROR", ["Use the interactive browser for this candidate"]);
    }
    if (!confirm) {
        return renderResult({
            note: {
                candidate: { id: summary.legacyId, name: summary.name, milestone: summary.milestone },
                comment,
            },
            help: [
                "Preview only - zero notes were created",
                "Rerun with --confirm to add this note",
                "Notes are how AI scores sync into the Indeed pipeline",
            ],
        }, json);
    }
    const result = await ctx.app((api) => addNote(api, { candidateSubmissionId: summary.submissionId, comment }));
    return renderResult({
        noted: {
            candidate: { id: summary.legacyId, name: summary.name },
            id: result.id,
            ...(result.created !== undefined ? { at: result.created } : {}),
        },
        help: [
            "The note is visible on the candidate profile in Indeed",
            "Run `indeed-axi candidate get <id> --refresh` to refresh the local packet",
        ],
    }, json);
}
function parseStage(values, commandPath) {
    const raw = values["stage"];
    if (typeof raw !== "string")
        return undefined;
    const milestone = normalizeMilestone(raw);
    if (milestone === undefined) {
        throw new AxiError(`${commandPath}: unknown --stage "${raw}" (valid: ${STAGES.join(", ")})`, "VALIDATION_ERROR");
    }
    return milestone;
}
async function list(args, ctx) {
    const commandPath = "indeed-axi candidates list";
    const { values, positionals } = parseFlags(args, commandPath, LIST_FLAGS);
    const json = values["json"] === true;
    if (positionals.length > 0)
        throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");
    const jobRef = typeof values["job"] === "string" ? values["job"] : undefined;
    if (jobRef === undefined) {
        throw new AxiError(`${commandPath} requires --job <ref>`, "VALIDATION_ERROR", [
            "Run `indeed-axi jobs list` for job refs",
        ]);
    }
    const stage = parseStage(values, commandPath);
    const limit = optionalInt(values, "limit", { min: 1, max: 500 }) ?? 100;
    const rows = await ctx.app(async (api) => {
        const job = await resolveJobRef(api, jobRef);
        return listCandidates(api, job.row.key, stage !== undefined ? [stage] : undefined, limit);
    });
    return renderResult({
        candidates: { count: rows.length, ...(stage !== undefined ? { stage } : {}) },
        list: rows.map((row) => ({ id: row.legacyId, name: row.name })),
        help: [
            "Run `indeed-axi candidates sync --job <ref>` to pull full packets into the store",
            "Run `indeed-axi candidate get <id>` for one candidate's details",
        ],
    }, json);
}
async function sync(args, ctx) {
    const commandPath = "indeed-axi candidates sync";
    const { values, positionals } = parseFlags(args, commandPath, SYNC_FLAGS);
    const json = values["json"] === true;
    if (positionals.length > 0)
        throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");
    const jobRef = typeof values["job"] === "string" ? values["job"] : undefined;
    if (jobRef === undefined) {
        throw new AxiError(`${commandPath} requires --job <ref>`, "VALIDATION_ERROR", [
            "Run `indeed-axi jobs list` for job refs",
        ]);
    }
    const stage = parseStage(values, commandPath);
    const limit = optionalInt(values, "limit", { min: 1, max: 500 }) ?? 100;
    const withApplications = values["applications"] === true;
    const withThreads = values["threads"] === true;
    const force = values["force"] === true;
    const result = await ctx.app(async (api) => {
        const job = await resolveJobRef(api, jobRef);
        const rows = await listCandidates(api, job.row.key, stage !== undefined ? [stage] : undefined, limit);
        const liveMilestones = new Map();
        const diff = force
            ? {
                fresh: rows.map((row) => row.legacyId),
                changed: [],
                unchanged: [],
            }
            : diffAgainstStore(ctx.stateDir, rows, liveMilestones);
        const fetched = [];
        const failed = [];
        const targets = [...diff.fresh, ...diff.changed];
        for (const legacyId of targets) {
            const row = rows.find((candidate) => candidate.legacyId === legacyId);
            if (row === undefined)
                continue;
            try {
                const summary = await getCandidate(api, legacyId);
                if (summary === null) {
                    failed.push({ id: legacyId, error: "no submission returned" });
                    continue;
                }
                let packet = packetFromSummary(summary, job.row.title);
                if (withApplications && summary.submissionUuid !== undefined) {
                    const application = await getApplication(api, summary.submissionUuid);
                    if (application !== null)
                        packet = attachApplication(packet, application);
                    await sleep(250);
                }
                if (withThreads) {
                    const thread = await fetchThread(api, legacyId);
                    if (thread !== null)
                        packet = attachThread(packet, thread);
                    await sleep(250);
                }
                writePacket(ctx.stateDir, packet);
                fetched.push({ id: legacyId, name: summary.name, milestone: summary.milestone });
            }
            catch (error) {
                failed.push({ id: legacyId, error: error instanceof Error ? error.message : String(error) });
            }
            await sleep(300);
        }
        return { job: job.row, rows, diff, fetched, failed };
    });
    return renderResult({
        sync: {
            job: result.job.title,
            stage: stage ?? "all",
            found: result.rows.length,
            fresh: result.diff.fresh.length,
            changed: result.diff.changed.length,
            unchanged: result.diff.unchanged.length,
            fetched: result.fetched.length,
            ...(result.failed.length > 0 ? { failed: result.failed.length } : {}),
        },
        ...(result.fetched.length > 0
            ? {
                list: result.fetched.map((row) => ({
                    id: row.id,
                    name: snippet(row.name, 40),
                    milestone: row.milestone,
                })),
            }
            : {}),
        help: [
            "Run `indeed-axi candidate get <id>` for one candidate's packet",
            result.failed.length > 0 ? "Some fetches failed - rerun sync to retry them" : "Re-run sync anytime; unchanged candidates are skipped",
        ].filter((line) => line !== undefined),
    }, json);
}
export async function candidateGetCommand(args, ctx) {
    const commandPath = "indeed-axi candidate get";
    // Accept both `candidate get <id>` and `candidate <id>` (the dispatcher
    // passes "get" through as the first argument in the former).
    const rest = args[0] === "get" ? args.slice(1) : args;
    const { values, positionals } = parseFlags(rest, commandPath, GET_FLAGS);
    const json = values["json"] === true;
    const legacyId = requirePositional(positionals, 0, "legacyId", commandPath);
    if (positionals.length > 1)
        throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");
    const full = values["full"] === true;
    let packet = readPacket(ctx.stateDir, legacyId);
    if (values["refresh"] === true || packet === null) {
        const summary = await ctx.app((api) => getCandidate(api, legacyId));
        if (summary === null) {
            throw new AxiError(`no candidate submission found for ${legacyId}`, "NOT_FOUND", [
                "Ids come from `indeed-axi candidates list` - never guess",
            ]);
        }
        packet = packetFromSummary(summary);
        writePacket(ctx.stateDir, packet);
    }
    const application = packet.application;
    return renderResult({
        candidate: {
            id: packet.legacyId,
            name: packet.name,
            milestone: packet.milestone,
            ...(packet.jobTitle !== undefined ? { job: packet.jobTitle } : {}),
            ...(packet.summary.location !== undefined ? { location: packet.summary.location } : {}),
            ...(packet.summary.headline !== undefined ? { headline: snippet(packet.summary.headline, 120) } : {}),
            fetchedAt: packet.fetchedAt,
        },
        ...(packet.scores.length > 0
            ? {
                scores: packet.scores.map((score) => ({
                    stage: score.stage,
                    score: score.score,
                    ...(score.rubric !== undefined ? { rubric: score.rubric } : {}),
                    why: snippet(score.rationale, 100),
                    at: score.scoredAt,
                })),
            }
            : {}),
        ...(packet.thread !== undefined
            ? {
                thread: {
                    messages: packet.thread.messageCount,
                    ...(packet.thread.lastMessageRole !== undefined
                        ? { last_from: packet.thread.lastMessageRole === "employer" ? "us" : "candidate" }
                        : {}),
                    ...(packet.thread.lastMessageAt !== undefined ? { last_at: packet.thread.lastMessageAt } : {}),
                },
            }
            : {}),
        ...(application !== undefined
            ? {
                application: {
                    chars: application.html?.length ?? 0,
                    ...(application.fileName !== undefined ? { file: application.fileName } : {}),
                    attachments: application.attachments,
                    ...(application.html !== undefined && !full
                        ? { excerpt: applicationExcerpt(application.html) }
                        : {}),
                    ...(full && application.html !== undefined ? { html: application.html } : {}),
                },
            }
            : {}),
        ...(full ? { submission: packet.submission } : {}),
        help: [
            "Run `indeed-axi messages read <id>` for the message thread",
            "Rerun with --refresh to update, --full for the complete packet",
            ...(packet === null ? [] : []),
        ],
    }, json);
}
