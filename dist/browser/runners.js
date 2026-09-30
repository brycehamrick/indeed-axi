import { createInterface } from "node:readline";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { classifyUrl, looksLikeLoginPage, waitForLogin, writeSessionRecord } from "./session.js";
import { ensureDaemon, withDaemonPage } from "./daemon.js";
import { createRecorder } from "./capture.js";
import { createRunDir, sanitizeHtml, writeText } from "./artifacts.js";
/**
 * Browser runners. These contain the only live-Playwright orchestration in
 * the CLI; commands delegate here and shape output. Unit tests inject
 * fakes. All runners operate on the persistent daemon browser.
 */
export const EMPLOYER_URL = "https://employers.indeed.com/";
export async function runLogin(opts) {
    const deps = opts.deps ?? {};
    const notice = deps.notice ?? ((line) => console.error(line));
    const { started } = await ensureQuiet(opts.stateDir, deps);
    return withDaemonPage(opts.stateDir, async (conn) => {
        notice("[indeed-axi] opened Indeed employers in a visible Chrome window");
        await conn.page.goto(EMPLOYER_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const url = await waitForLogin(conn.page, {
            timeoutMs: opts.timeoutMs,
            onPrompt: () => notice("[indeed-axi] complete the login (including 2FA / verification codes) in the opened window - waiting..."),
        });
        writeSessionRecord(opts.stateDir, { lastLogin: new Date().toISOString(), url });
        return { url, started };
    }, deps);
}
/** Ensure the browser, open the dashboard, classify the session. */
export async function runProbe(opts) {
    const deps = opts.deps ?? {};
    const { started } = await ensureQuiet(opts.stateDir, deps);
    return withDaemonPage(opts.stateDir, async (conn) => {
        await conn.page.goto(EMPLOYER_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        // Indeed's SPA client-side redirects to secure.indeed.com when logged
        // out; give that redirect time to land before classifying.
        await conn.page.waitForTimeout(5000);
        const url = conn.page.url();
        const state = classifyUrl(url);
        const passwordForm = await looksLikeLoginPage(conn.page);
        const effective = state === "logged-in" && passwordForm ? "auth" : state;
        if (effective === "logged-in") {
            writeSessionRecord(opts.stateDir, { lastLogin: new Date().toISOString(), url });
        }
        return { state: effective, url, started };
    }, deps);
}
async function ensureQuiet(stateDir, deps) {
    const state = await ensureDaemon(stateDir, deps);
    if (state.started) {
        const notice = deps.notice ?? ((line) => console.error(line));
        notice("[indeed-axi] starting the browser (visible Chrome window)...");
    }
    return { started: state.started };
}
const DEMO_CHECKLIST = [
    "discovery recording - demonstrate in the opened window:",
    "  1. open the employer dashboard home (candidates overview)",
    "  2. open one job's candidate list",
    "  3. open one candidate profile (resume + screening answers)",
    "  4. open a message thread and read it",
    "  5. send a message to a test candidate",
    "  6. move a candidate between pipeline stages",
    "  7. add a candidate note, if the UI offers notes",
    "  8. anything else you want automated - narrate it",
];
export async function runDiscover(opts) {
    const deps = opts.deps ?? {};
    const notice = deps.notice ?? ((line) => console.error(line));
    const stdin = deps.stdin ?? process.stdin;
    const run = createRunDir(opts.stateDir, "discover");
    const documentsDir = join(run.dir, "documents");
    const recorder = createRecorder({ documentsDir });
    const consoleErrors = [];
    const files = [];
    // --max-wait bounds the WHOLE run, including the login wait.
    const runStartedAt = Date.now();
    const remainingRunBudget = () => Math.max(0, opts.maxWaitMs - (Date.now() - runStartedAt));
    try {
        await withDaemonPage(opts.stateDir, async (conn) => {
            // Tracing over CDP-attached contexts may be unavailable; it is
            // best-effort and never blocks network capture.
            try {
                await conn.context.tracing.start({
                    title: `indeed-axi discover ${new Date().toISOString()}`,
                    screenshots: true,
                    snapshots: true,
                    sources: false,
                });
            }
            catch {
                notice("[indeed-axi] tracing unavailable over CDP - continuing with network capture");
            }
            recorder.attachContext(conn.context);
            const onPage = (page) => {
                page.on("console", (message) => {
                    if (message.type() === "error" && consoleErrors.length < 200) {
                        consoleErrors.push(message.text().slice(0, 500));
                    }
                });
                page.on("pageerror", (error) => {
                    if (consoleErrors.length < 200) {
                        consoleErrors.push(`pageerror: ${String(error).slice(0, 450)}`);
                    }
                });
            };
            onPage(conn.page);
            conn.context.on("page", onPage);
            notice(`[indeed-axi] opening ${opts.url}`);
            await conn.page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
            await waitForLogin(conn.page, {
                timeoutMs: Math.min(opts.loginTimeoutMs, remainingRunBudget()),
                onPrompt: () => notice("[indeed-axi] complete the login (including 2FA / verification codes) in the opened window - waiting..."),
            });
            for (const line of DEMO_CHECKLIST)
                notice(`[indeed-axi] ${line}`);
            notice("[indeed-axi] press Enter here to finish and write artifacts...");
            await waitForEnter(stdin, remainingRunBudget());
            // Final snapshots of whatever is on screen.
            try {
                await conn.page.screenshot({ path: join(run.dir, "final-screenshot.png"), fullPage: false });
                files.push("final-screenshot.png");
            }
            catch {
                // screenshot is best-effort
            }
            try {
                const aria = await conn.page.locator("html").ariaSnapshot();
                writeText(join(run.dir, "aria.yml"), aria);
                files.push("aria.yml");
            }
            catch {
                // aria snapshot is best-effort
            }
            try {
                const dom = sanitizeHtml(await conn.page.content());
                writeText(join(run.dir, "dom.html"), dom);
                files.push("dom.html");
            }
            catch {
                // dom snapshot is best-effort
            }
            await recorder.finish();
            try {
                const tracePath = join(run.dir, "trace.zip");
                await conn.context.tracing.stop({ path: tracePath });
                files.push("trace.zip");
            }
            catch {
                // tracing is best-effort
            }
        }, deps);
    }
    catch (error) {
        throw error instanceof AxiError
            ? error
            : new AxiError(`discovery failed: ${error instanceof Error ? error.message : String(error)}`, "LAUNCH_ERROR", ["Check the opened window state and rerun; artifacts may be partial"]);
    }
    writeText(join(run.dir, "network.json"), JSON.stringify(recorder.exchanges, null, 2));
    files.push("network.json");
    if (consoleErrors.length > 0) {
        writeText(join(run.dir, "console-errors.txt"), consoleErrors.join("\n"));
        files.push("console-errors.txt");
    }
    const documentCount = recorder.exchanges.filter((exchange) => exchange.savedTo).length;
    const index = {
        kind: "discover",
        url: opts.url,
        finishedAt: new Date().toISOString(),
        exchanges: recorder.exchanges.length,
        documents: documentCount,
        consoleErrors: consoleErrors.length,
        files: files.concat(documentCount > 0 ? ["documents/"] : []),
    };
    writeText(join(run.dir, "index.json"), JSON.stringify(index, null, 2));
    files.push("index.json");
    return {
        runDir: run.dir,
        runId: run.id,
        url: opts.url,
        exchanges: recorder.exchanges,
        documentCount,
        consoleErrors,
        files,
    };
}
/**
 * Resolve the manual-completion signal: one Enter line on a TTY, a piped
 * line, or EOF - bounded by maxWaitMs so no session hangs forever.
 */
export async function waitForEnter(stdin, maxWaitMs) {
    await new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            rl.close();
            stdin.removeListener("end", done);
            resolve();
        };
        const timer = setTimeout(done, maxWaitMs);
        const rl = createInterface({ input: stdin, terminal: false });
        rl.once("line", done);
        rl.once("close", done);
        stdin.once("end", done);
    });
}
