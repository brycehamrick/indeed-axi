import { optionalInt, parseFlags } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { snippet } from "../lib/truncate.js";
import { buildDigest, DEFAULT_CHASE_DAYS, DEFAULT_EXPIRE_DAYS, filterByJob } from "../indeed/digest.js";
import { listPackets } from "../store/store.js";
export const DIGEST_HELP = `indeed-axi digest - the hiring review view over the local store

flags:
  --job <ref>            job-title prefix or employerJobRef filter (default: all jobs)
  --chase-days <n>       days after our last message before a candidate is chase-eligible (default ${DEFAULT_CHASE_DAYS})
  --expire-days <n>      days after our last message before a candidate is expire/reject-eligible (default ${DEFAULT_EXPIRE_DAYS})
  --limit <n>            max rows per list (default 10)
  --json                 machine-readable JSON instead of TOON

Offline: reads only the local packet store (~/.indeed-axi/store/) - zero
browser/API calls. Run \`candidates sync --job <ref> --applications
--threads\` first to refresh the data behind it.

Sections: scored (ranked by latest score), awaiting_reply (we sent the last
message; ages with chase/expire flags), replied (candidate spoke last -
ready for screening evaluation), unscored, no_thread.

The chase/expire defaults are fallbacks - the authoritative windows live in
your platform-agnostic hiring process documents; pass them explicitly when
they differ.

examples:
  indeed-axi digest
  indeed-axi digest --job "executive assistant" --chase-days 4 --expire-days 9`;
const DIGEST_FLAGS = {
    job: { type: "string" },
    "chase-days": { type: "string" },
    "expire-days": { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
};
export async function digestCommand(args, ctx) {
    const commandPath = "indeed-axi digest";
    const { values, positionals } = parseFlags(args, commandPath, DIGEST_FLAGS);
    const json = values["json"] === true;
    if (positionals.length > 0) {
        return { help_text: DIGEST_HELP };
    }
    const job = typeof values["job"] === "string" ? values["job"] : undefined;
    const chaseDays = optionalInt(values, "chase-days", { min: 1, max: 90 }) ?? DEFAULT_CHASE_DAYS;
    const expireDays = optionalInt(values, "expire-days", { min: 1, max: 365 }) ?? DEFAULT_EXPIRE_DAYS;
    const limit = optionalInt(values, "limit", { min: 1, max: 100 }) ?? 10;
    const packets = listPackets(ctx.stateDir);
    const pool = filterByJob(packets, job);
    if (job !== undefined && pool.length === 0) {
        return renderResult({
            digest: { job, candidates: 0 },
            note: "0 packets match - run `candidates sync --job <ref>` first",
            help: ["Run `indeed-axi jobs list` for exact titles", "Run `indeed-axi candidates sync --job <ref> --applications --threads`"],
        }, json);
    }
    const view = buildDigest(pool, { chaseDays, expireDays });
    const counts = { ...view.counts };
    delete counts["by_milestone"];
    if (Object.keys(view.counts.by_milestone).length > 0) {
        counts["milestones"] = view.counts.by_milestone;
    }
    return renderResult({
        digest: {
            ...(job !== undefined ? { job } : {}),
            candidates: view.total,
            windows: { chase_days: chaseDays, expire_days: expireDays },
            counts,
        },
        ...(view.scored.length > 0
            ? {
                top: view.scored.slice(0, limit).map((row) => ({
                    id: row.id,
                    name: snippet(row.name, 40),
                    score: row.score,
                    stage: row.stage,
                    why: snippet(row.rationale, 80),
                })),
            }
            : {}),
        ...(view.awaitingReply.length > 0
            ? {
                awaiting: view.awaitingReply
                    .slice()
                    .sort((a, b) => b.ageDays - a.ageDays)
                    .slice(0, limit)
                    .map((row) => ({
                    id: row.id,
                    name: snippet(row.name, 40),
                    age_days: row.ageDays,
                    ...(row.expire ? { flag: "EXPIRE" } : row.chase ? { flag: "CHASE" } : {}),
                })),
            }
            : {}),
        ...(view.replied.length > 0
            ? {
                replied_list: view.replied.slice(0, limit).map((row) => ({
                    id: row.id,
                    name: snippet(row.name, 40),
                    milestone: row.milestone,
                })),
            }
            : {}),
        help: [
            view.counts.no_thread > 0
                ? `${view.counts.no_thread} packet(s) have no cached thread - run \`candidates sync --threads\` to refresh aging`
                : "Aging is computed from cached threads (`messages read` and `sync --threads` refresh them)",
            "Score candidates with `score record <id> --stage --score --rationale`",
            "Draft chases/rejections from the process docs, send with `messages send ... --confirm`",
        ],
    }, json);
}
