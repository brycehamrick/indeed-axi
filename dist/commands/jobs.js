import { optionalInt, parseFlags } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { listJobs } from "../indeed/api.js";
export const JOBS_HELP = `indeed-axi jobs list - active employer jobs

flags:
  --limit <n>            max jobs to fetch (default 100)
  --json                 machine-readable JSON instead of TOON

Live read through the authenticated browser session. Rows show the short
job ref (uuid) used by \`candidates list --job <ref>\`, plus the title.

examples:
  indeed-axi jobs list
  indeed-axi jobs list --json`;
const LIST_FLAGS = {
    limit: { type: "string" },
    json: { type: "boolean" },
};
export async function jobsCommand(args, ctx) {
    const sub = args[0];
    if (sub === undefined) {
        return { help_text: JOBS_HELP };
    }
    if (sub !== "list") {
        return { help_text: JOBS_HELP };
    }
    const commandPath = "indeed-axi jobs list";
    const { values, positionals } = parseFlags(args.slice(1), commandPath, LIST_FLAGS);
    const json = values["json"] === true;
    if (positionals.length > 0) {
        return { help_text: JOBS_HELP };
    }
    const limit = optionalInt(values, "limit", { min: 1, max: 500 }) ?? 100;
    const jobs = await ctx.app((api) => listJobs(api, limit));
    return renderResult({
        jobs: { count: jobs.length },
        list: jobs.map((job) => ({ ref: job.ref, title: job.title })),
        help: [
            "Run `indeed-axi candidates list --job <ref>` for the pipeline of a job",
            "Run `indeed-axi candidates sync --job <ref>` to pull candidates into the local store",
        ],
    }, json);
}
