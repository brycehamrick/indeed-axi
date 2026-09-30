import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { chromium } from "playwright-core";
import { acquireLock, isPidAlive, profileDir, releaseLock } from "./session.js";
export function daemonStatePath(stateDir) {
    return join(stateDir, "browser-daemon.json");
}
export function readDaemonState(stateDir) {
    const path = daemonStatePath(stateDir);
    if (!existsSync(path))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed.port === "number" &&
            Number.isInteger(parsed.port) &&
            typeof parsed.pid === "number" &&
            Number.isInteger(parsed.pid) &&
            typeof parsed.startedAt === "string") {
            return { port: parsed.port, pid: parsed.pid, startedAt: parsed.startedAt };
        }
    }
    catch {
        // fall through: corrupt state is treated as absent
    }
    return null;
}
export function writeDaemonState(stateDir, state) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(daemonStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
export function deleteDaemonState(stateDir) {
    const path = daemonStatePath(stateDir);
    if (existsSync(path))
        rmSync(path);
}
export async function defaultProbeEndpoint(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(1500),
        });
        if (!response.ok)
            return { ok: false };
        const body = (await response.json());
        return {
            ok: true,
            browserVersion: typeof body.Browser === "string" ? body.Browser : undefined,
        };
    }
    catch {
        return { ok: false };
    }
}
/* ------------------------------------------------------------------ */
/* Chrome executable resolution                                        */
/* ------------------------------------------------------------------ */
const MAC_CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
];
const LINUX_CHROME_PATHS = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
];
export function resolveChromeExecutable(env = process.env) {
    const explicit = env["INDEED_BROWSER_BIN"]?.trim();
    if (explicit && explicit.length > 0)
        return explicit;
    for (const candidate of [...MAC_CHROME_PATHS, ...LINUX_CHROME_PATHS]) {
        if (existsSync(candidate))
            return candidate;
    }
    // Playwright-installed bundled chromium, when present.
    try {
        const bundled = chromium.executablePath();
        if (bundled && existsSync(bundled))
            return bundled;
    }
    catch {
        // not installed - fall through to the error
    }
    throw new AxiError("no usable Chrome/Chromium found for the browser transport", "LAUNCH_ERROR", [
        "Install Google Chrome, or",
        "Set INDEED_BROWSER_BIN to a Chrome/Chromium binary path, or",
        "Run `npx playwright@latest install chromium` for a bundled browser",
    ]);
}
export const defaultFreePort = () => new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resolve(port));
    });
});
export const defaultSpawn = (command, args, userDataDir) => {
    const child = spawn(command, [
        ...args,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,900",
        "--window-position=60,60",
        "about:blank",
    ], { detached: true, stdio: "ignore" });
    child.unref();
    let exited = false;
    child.on("exit", () => {
        exited = true;
    });
    return {
        pid: child.pid ?? -1,
        hasExited: () => exited,
    };
};
const START_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 8_000;
/** Start the daemon if it is not already running; return the live state. */
export async function ensureDaemon(stateDir, deps = {}, env = process.env) {
    const probe = deps.probe ?? defaultProbeEndpoint;
    const existing = readDaemonState(stateDir);
    if (existing && (await probe(existing.port)).ok) {
        return { ...existing, started: false };
    }
    return { ...(await startDaemonBrowser(stateDir, deps, env)), started: true };
}
export async function startDaemonBrowser(stateDir, deps = {}, env = process.env) {
    const doSpawn = deps.spawn ?? defaultSpawn;
    const freePort = deps.freePort ?? defaultFreePort;
    const probe = deps.probe ?? defaultProbeEndpoint;
    const executable = deps.executable ?? ((e) => resolveChromeExecutable(e));
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = deps.now ?? (() => new Date());
    const port = await freePort();
    const command = executable(env);
    acquireLock(stateDir);
    try {
        const proc = doSpawn(command, [`--remote-debugging-port=${port}`], profileDir(stateDir));
        if (proc.pid <= 0) {
            throw new AxiError("Chrome failed to start (no pid)", "LAUNCH_ERROR", [
                "Check that INDEED_BROWSER_BIN points to a working Chrome binary",
            ]);
        }
        const deadline = Date.now() + START_TIMEOUT_MS;
        for (;;) {
            if (proc.hasExited()) {
                throw new AxiError("Chrome exited immediately - another instance may hold the profile", "LAUNCH_ERROR", [
                    "Close any Chrome window using this profile (it lives under the indeed-axi state dir) and retry",
                    "If none is open, delete the stale profile lock inside the state dir",
                ]);
            }
            if ((await probe(port)).ok)
                break;
            if (Date.now() >= deadline) {
                throw new AxiError(`Chrome did not expose its DevTools endpoint within ${START_TIMEOUT_MS}ms`, "LAUNCH_ERROR", ["Retry; if it persists, set INDEED_BROWSER_BIN to a known-good Chrome binary"]);
            }
            await sleep(250);
        }
        const state = { port, pid: proc.pid, startedAt: now().toISOString() };
        writeDaemonState(stateDir, state);
        return state;
    }
    finally {
        releaseLock(stateDir);
    }
}
async function defaultConnect(endpoint) {
    return chromium.connectOverCDP(endpoint);
}
/**
 * In-page instrumentation installed on every daemon connection: an error
 * collector that survives across CLI invocations (it lives in the page, not
 * in any single Node process). Idempotent per document.
 */
export const INIT_SCRIPT = `(() => {
  if (window.__iaInstall) return;
  window.__iaInstall = true;
  const errors = (window.__iaErrors = window.__iaErrors || []);
  const push = (entry) => {
    try {
      const text = String(entry && entry.message ? entry.message : entry).slice(0, 500);
      errors.push(text);
      if (errors.length > 200) errors.shift();
    } catch (e) { /* never throw from the collector */ }
  };
  window.addEventListener('error', (event) => push(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => push(event.reason));
})()`;
export const PAGE_ERRORS_SOURCE = `(() => (window.__iaErrors ? window.__iaErrors.slice() : []))()`;
/**
 * Connect to the running daemon and hand the caller its default context
 * and front page. Starts nothing; use ensureDaemon first (or withPage).
 */
export async function connectDaemon(stateDir, deps = {}) {
    const probe = deps.probe ?? defaultProbeEndpoint;
    const connect = deps.connect ?? defaultConnect;
    const state = readDaemonState(stateDir);
    if (!state || !(await probe(state.port)).ok) {
        throw new AxiError("the indeed-axi browser is not running", "DAEMON_NOT_RUNNING", [
            "Run `indeed-axi browser open` to start it (a visible Chrome window)",
        ]);
    }
    const browser = await withTimeout(connect(`http://127.0.0.1:${state.port}`), CONNECT_TIMEOUT_MS);
    const context = browser.contexts()[0];
    if (!context) {
        await browser.close().catch(() => undefined);
        throw new AxiError("the running Chrome has no default context", "LAUNCH_ERROR", [
            "Run `indeed-axi browser close` and `indeed-axi browser open` to recover",
        ]);
    }
    const page = context.pages().find((candidate) => !candidate.url().startsWith("devtools")) ??
        (await context.newPage());
    await installInstrumentation(page, context);
    return {
        browser,
        context,
        page,
        disconnect: async () => {
            // For connected browsers, close() only disconnects this client.
            await browser.close().catch(() => undefined);
        },
    };
}
async function installInstrumentation(page, context) {
    try {
        const installed = await page.evaluate('Boolean(window && window.__iaInstall)');
        if (!installed) {
            await context.addInitScript(INIT_SCRIPT);
            await page.evaluate(INIT_SCRIPT);
        }
    }
    catch {
        // instrumentation is best-effort (e.g. a mid-navigation page)
    }
}
/**
 * Ensure the daemon is running, connect, run `fn` with the connection,
 * then disconnect. Auto-starts the visible Chrome when needed.
 */
export async function withDaemonPage(stateDir, fn, deps = {}, env = process.env) {
    await ensureDaemon(stateDir, deps, env);
    const conn = await connectDaemon(stateDir, deps);
    try {
        return await fn(conn);
    }
    finally {
        await conn.disconnect();
    }
}
/** Stop the daemon: terminate Chrome by pid, then clear the state file. */
export async function stopDaemonBrowser(stateDir, deps = {}) {
    const probe = deps.probe ?? defaultProbeEndpoint;
    const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    const isAlive = deps.isAlive ?? isPidAlive;
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const state = readDaemonState(stateDir);
    if (!state || !(await probe(state.port)).ok) {
        if (state)
            deleteDaemonState(stateDir);
        return "not-running";
    }
    if (isAlive(state.pid)) {
        try {
            kill(state.pid, "SIGTERM");
        }
        catch {
            // already gone
        }
        const deadline = Date.now() + 5_000;
        while ((await probe(state.port)).ok && Date.now() < deadline) {
            await sleep(250);
        }
        if ((await probe(state.port)).ok && isAlive(state.pid)) {
            try {
                kill(state.pid, "SIGKILL");
            }
            catch {
                // already gone
            }
        }
    }
    deleteDaemonState(stateDir);
    return "stopped";
}
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`connect timed out after ${ms}ms`)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
