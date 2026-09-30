import { resolveConfig } from "./lib/env.js";
import { loadDotEnv, mergeEnv } from "./lib/dotenv.js";
import { resolveStateDir } from "./browser/session.js";
import { defaultProbeEndpoint, ensureDaemon, readDaemonState, stopDaemonBrowser, withDaemonPage, } from "./browser/daemon.js";
import { withAppApi } from "./browser/appapi.js";
import { runDiscover, runLogin, runProbe } from "./browser/runners.js";
export function createCommandContext(browserDeps) {
    const env = mergeEnv(loadDotEnv(), process.env);
    const stateDir = resolveStateDir(env);
    const deps = browserDeps ?? {};
    return {
        config: resolveConfig(stateDir),
        stateDir,
        env,
        browser: {
            login: (opts) => runLogin({ ...opts, deps }),
            probe: (opts) => runProbe({ ...opts, deps }),
            discover: (opts) => runDiscover({ ...opts, deps }),
        },
        daemon: {
            ensure: () => ensureDaemon(stateDir, deps, env),
            withPage: (fn) => withDaemonPage(stateDir, fn, deps, env),
            probe: () => daemonProbe(stateDir, deps),
            stop: () => stopDaemonBrowser(stateDir, deps),
        },
        app: (fn) => withAppApi(stateDir, deps, fn),
    };
}
/** Read-only daemon probe: reports liveness without launching anything. */
async function daemonProbe(stateDir, deps) {
    const probe = deps.probe ?? defaultProbeEndpoint;
    const state = readDaemonState(stateDir);
    if (!state)
        return { running: false };
    const result = await probe(state.port);
    if (!result.ok)
        return { running: false };
    return {
        running: true,
        port: state.port,
        pid: state.pid,
        browserVersion: result.browserVersion,
    };
}
let cached;
export function getCommandContext() {
    cached ??= createCommandContext();
    return cached;
}
