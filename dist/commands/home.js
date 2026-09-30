import { parseFlags } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { profileExists, readSessionRecord } from "../browser/session.js";
const HOME_FLAGS = {
    json: { type: "boolean" },
};
/**
 * AXI principle 8: bare invocation is live content - session state, daemon
 * state, and next steps. It reads files and (cheaply) probes the daemon's
 * DevTools endpoint; it never launches a browser.
 */
export async function homeCommand(args, ctx) {
    const { values } = parseFlags(args, "indeed-axi", HOME_FLAGS);
    const json = values["json"] === true;
    const record = readSessionRecord(ctx.stateDir);
    const daemon = await ctx.daemon.probe().catch(() => ({ running: false }));
    return renderResult({
        auth: {
            browser_session: {
                profile: profileExists(ctx.stateDir) ? "present" : "missing",
                last_login: record?.lastLogin ?? null,
                ...(record ? { last_url: record.url } : {}),
            },
        },
        browser: daemon.running
            ? {
                running: true,
                port: daemon.port,
                pid: daemon.pid,
                ...(daemon.browserVersion ? { version: daemon.browserVersion } : {}),
            }
            : { running: false },
        help: [
            "Run `indeed-axi auth login` to establish the employer session (visible Chrome, manual login)",
            "Run `indeed-axi browser open` to start browsing the employer dashboard",
            "Run `indeed-axi discover` to record dashboard traffic for domain commands",
            "Run `indeed-axi setup hooks` for ambient session context",
        ],
    }, json);
}
