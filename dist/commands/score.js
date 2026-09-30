import { AxiError } from "axi-sdk-js";
import { oneOf, optionalInt, parseFlags, requirePositional, requiredString, } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { snippet } from "../lib/truncate.js";
import { readPacket, appendScore, writePacket } from "../store/store.js";
import { addNote } from "../indeed/api.js";
export const SCORE_HELP = `indeed-axi score record - record an AI/human screening score

usage:
  score record <legacyId> --stage <s> --score <n> --rationale "..." [--rubric <name>] [--note --confirm]

flags:
  --stage <s>            application | screening | test
  --score <n>            1-10
  --rationale "<text>"   why this score (referenced by the rubric)
  --rubric <name>        which rubric/criterion set was used
  --note                 also sync the score into Indeed as a candidate note
                         (employer-internal; requires --confirm like every mutation)
  --confirm              with --note: create the note
  --json                 machine-readable JSON instead of TOON

The score itself is a local write to the packet store (no gate needed -
nothing leaves the machine). Adding --note turns it into a preview of the
Indeed note; --note --confirm creates the note. The rationale should cite
the rubric so rejects and rankings stay auditable.

examples:
  indeed-axi score record aaaaaaaa0001 --stage application --score 8 --rationale "Strong calendar systems, CDMX-based, relevant EA exposure" --rubric ea-v1
  indeed-axi score record aaaaaaaa0001 --stage screening --score 9 --rationale "Clear written answers, proactive" --rubric ea-v1 --note --confirm`;
const STAGES = ["application", "screening", "test"];
const RECORD_FLAGS = {
    stage: { type: "string" },
    score: { type: "string" },
    rationale: { type: "string" },
    rubric: { type: "string" },
    note: { type: "boolean" },
    confirm: { type: "boolean" },
    json: { type: "boolean" },
};
export async function scoreCommand(args, ctx) {
    const sub = args[0];
    if (sub !== "record") {
        return { help_text: SCORE_HELP };
    }
    const commandPath = "indeed-axi score record";
    const { values, positionals } = parseFlags(args.slice(1), commandPath, RECORD_FLAGS);
    const json = values["json"] === true;
    const legacyId = requirePositional(positionals, 0, "legacyId", commandPath);
    if (positionals.length > 1)
        throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");
    const stage = oneOf(values, "stage", STAGES);
    if (stage === undefined) {
        throw new AxiError(`${commandPath}: --stage must be one of ${STAGES.join(", ")}`, "VALIDATION_ERROR");
    }
    const score = optionalInt(values, "score", { min: 1, max: 10 });
    if (score === undefined) {
        throw new AxiError(`${commandPath}: --score is required (1-10)`, "VALIDATION_ERROR");
    }
    const rationale = requiredString(values, "rationale", commandPath);
    const rubric = typeof values["rubric"] === "string" ? values["rubric"] : undefined;
    const wantNote = values["note"] === true;
    const confirm = values["confirm"] === true;
    const packet = readPacket(ctx.stateDir, legacyId);
    if (packet === null) {
        throw new AxiError(`no local packet for ${legacyId} - score after syncing`, "VALIDATION_ERROR", [
            "Run `indeed-axi candidates sync --job <ref> --applications` first",
            "Scores attach to local packets; the packet is the audit trail",
        ]);
    }
    if (packet.submission["id"] === undefined && wantNote) {
        throw new AxiError(`cannot sync a note for ${packet.name}: no submission id`, "VALIDATION_ERROR");
    }
    // With --note in play, nothing is written until --confirm - the preview
    // rerun would otherwise record the same score twice.
    if (wantNote && !confirm) {
        return renderResult({
            preview: {
                candidate: { id: legacyId, name: packet.name },
                stage,
                score,
                ...(rubric !== undefined ? { rubric } : {}),
                scores_total: packet.scores.length,
            },
            note_preview: `${stage} score ${score}/10${rubric !== undefined ? ` [${rubric}]` : ""} - ${rationale}`,
            help: [
                "Preview only - nothing was recorded",
                "Rerun with --note --confirm to record the score and add the note",
            ],
        }, json);
    }
    const updated = appendScore(packet, {
        stage,
        score,
        rationale,
        ...(rubric !== undefined ? { rubric } : {}),
    });
    writePacket(ctx.stateDir, updated);
    if (wantNote && confirm) {
        const noteText = `${stage} score ${score}/10${rubric !== undefined ? ` [${rubric}]` : ""} - ${rationale}`;
        const result = await ctx.app((api) => addNote(api, {
            candidateSubmissionId: String(packet.submission["id"] ?? ""),
            comment: noteText,
        }));
        return renderResult({
            recorded: {
                candidate: { id: legacyId, name: updated.name },
                stage,
                score,
                ...(rubric !== undefined ? { rubric } : {}),
                scores_total: updated.scores.length,
            },
            noted: { id: snippet(result.id, 24), ...(result.created !== undefined ? { at: result.created } : {}) },
            help: [
                "Score recorded locally and synced to Indeed as a note",
                "Run `indeed-axi digest` for the ranked review",
            ],
        }, json);
    }
    return renderResult({
        recorded: {
            candidate: { id: legacyId, name: updated.name },
            stage,
            score,
            ...(rubric !== undefined ? { rubric } : {}),
            scores_total: updated.scores.length,
        },
        help: [
            "Run `indeed-axi digest` for the ranked review",
            "Add --note --confirm to sync this score into the Indeed pipeline",
        ],
    }, json);
}
