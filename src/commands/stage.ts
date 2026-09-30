import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { parseFlags, requirePositional, requiredString, type FlagDefinition } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { getCandidate, moveStage, normalizeMoveTarget } from "../indeed/api.js";
import type { CommandContext } from "../context.js";

export const STAGE_HELP = `indeed-axi stage move - move a candidate's pipeline stage

usage:
  stage move <legacyId> --to <milestone> [--confirm]

flags:
  --to <milestone>   new|pending|reviewed|phone_screened|interviewed|offer_made|rejected|hired
  --confirm          actually move - without it, prints a preview
  --json             machine-readable JSON instead of TOON

Gated: without --confirm the command resolves the candidate, shows the
current and target milestone, and makes zero mutation calls. With
--confirm it performs the move and verifies the milestone in the mutation's
own response. The Indeed pipeline stays the single source of truth.

examples:
  indeed-axi stage move aaaaaaaa0001 --to reviewed
  indeed-axi stage move aaaaaaaa0001 --to rejected --confirm`;

const MOVE_FLAGS: Record<string, FlagDefinition> = {
  to: { type: "string" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const TARGETS = [
  "new",
  "pending",
  "reviewed",
  "phone_screened",
  "interviewed",
  "offer_made",
  "rejected",
  "hired",
] as const;

export async function stageCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  if (sub !== "move") {
    return { help_text: STAGE_HELP };
  }
  const commandPath = "indeed-axi stage move";
  const { values, positionals } = parseFlags(args.slice(1), commandPath, MOVE_FLAGS);
  const json = values["json"] === true;
  const legacyId = requirePositional(positionals, 0, "legacyId", commandPath);
  if (positionals.length > 1) throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");
  const rawTarget = requiredString(values, "to", commandPath);
  const target = normalizeMoveTarget(rawTarget);
  if (target === undefined) {
    throw new AxiError(
      `${commandPath}: unknown --to "${rawTarget}" (valid: ${TARGETS.join(", ")})`,
      "VALIDATION_ERROR",
    );
  }
  const confirm = values["confirm"] === true;

  const summary = await ctx.app((api) => getCandidate(api, legacyId));
  if (summary === null) {
    throw new AxiError(`no candidate submission found for ${legacyId}`, "NOT_FOUND", [
      "Ids come from `indeed-axi candidates list` - never guess",
    ]);
  }
  if (summary.submissionId.length === 0 || summary.jobId === undefined) {
    throw new AxiError(
      `cannot move ${summary.name}: the submission is missing stage-move keys`,
      "VALIDATION_ERROR",
      ["Use the interactive browser for this candidate"],
    );
  }

  if (summary.milestone === target) {
    return renderResult(
      {
        move: {
          candidate: { id: summary.legacyId, name: summary.name },
          from: summary.milestone,
          to: target,
          note: "already at this milestone - nothing to do",
        },
        help: ["Run `indeed-axi candidate get <id> --refresh` to double-check"],
      },
      json,
    );
  }

  if (!confirm) {
    return renderResult(
      {
        move: {
          candidate: { id: summary.legacyId, name: summary.name },
          from: summary.milestone,
          to: target,
          ...(summary.jobTitle !== undefined ? { job: summary.jobTitle } : {}),
        },
        help: [
          "Preview only - zero mutations were made",
          "Rerun with --confirm to move this candidate",
        ],
      },
      json,
    );
  }

  const result = await ctx.app((api) =>
    moveStage(api, {
      candidateSubmissionId: summary.submissionId,
      jobId: summary.jobId ?? "",
      milestoneId: target,
    }),
  );
  return renderResult(
    {
      moved: {
        candidate: { id: summary.legacyId, name: summary.name },
        to: result.milestoneId,
        verified: result.verified,
      },
      help: result.verified
        ? [
            "Verified: the mutation response reports the new milestone",
            "Run `indeed-axi candidate get <id> --refresh` to see the updated packet",
          ]
        : [
            `Move returned milestone ${result.milestoneId}, expected ${target} - verify with \`candidate get --refresh\` before retrying`,
          ],
    },
    json,
  );
}
