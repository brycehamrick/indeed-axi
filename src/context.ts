import { resolveConfig, type IndeedConfig } from "./lib/env.js";
import { loadDotEnv, mergeEnv } from "./lib/dotenv.js";
import { resolveStateDir } from "./browser/session.js";
import {
  defaultProbeEndpoint,
  ensureDaemon,
  readDaemonState,
  stopDaemonBrowser,
  withDaemonPage,
  type DaemonConnection,
  type DaemonDeps,
} from "./browser/daemon.js";
import { withAppApi, type AppApi } from "./browser/appapi.js";
import { runDiscover, runLogin, runProbe, type RunnerDeps } from "./browser/runners.js";
import type { AxiRenderable } from "./lib/output.js";

/**
 * Shared command context. Commands receive it lazily so `--help` and
 * version probing never touch the browser. Tests construct their own with
 * injected daemon deps and browser runners.
 */

export interface BrowserRunners {
  login(opts: { stateDir: string; timeoutMs: number }): Promise<{ url: string; started: boolean }>;
  probe(opts: { stateDir: string }): Promise<{ state: string; url: string; started: boolean }>;
  discover(opts: {
    stateDir: string;
    url: string;
    loginTimeoutMs: number;
    maxWaitMs: number;
  }): Promise<{
    runDir: string;
    runId: string;
    url: string;
    exchanges: unknown[];
    documentCount: number;
    consoleErrors: string[];
    files: string[];
  }>;
}

export interface DaemonProbeInfo {
  running: boolean;
  port?: number;
  pid?: number;
  browserVersion?: string;
}

export interface DaemonOps {
  ensure(): Promise<{ port: number; pid: number; startedAt: string; started: boolean }>;
  withPage<T>(fn: (conn: DaemonConnection) => Promise<T>): Promise<T>;
  /** Read-only: never starts the browser. */
  probe(): Promise<DaemonProbeInfo>;
  stop(): Promise<"stopped" | "not-running">;
}

export interface CommandContext {
  config: IndeedConfig;
  stateDir: string;
  browser: BrowserRunners;
  daemon: DaemonOps;
  /** In-page authenticated GraphQL transport (auto-starts the browser). */
  app<T>(fn: (api: AppApi) => Promise<T>): Promise<T>;
  /** Merged environment (process env + .env file). */
  env: NodeJS.ProcessEnv;
}

export function createCommandContext(browserDeps?: RunnerDeps): CommandContext {
  const env = mergeEnv(loadDotEnv(), process.env);
  const stateDir = resolveStateDir(env);
  const deps: DaemonDeps = browserDeps ?? {};
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
      withPage: <T>(fn: (conn: DaemonConnection) => Promise<T>) =>
        withDaemonPage(stateDir, fn, deps, env),
      probe: () => daemonProbe(stateDir, deps),
      stop: () => stopDaemonBrowser(stateDir, deps),
    },
    app: <T>(fn: (api: AppApi) => Promise<T>) => withAppApi(stateDir, deps, fn),
  };
}

/** Read-only daemon probe: reports liveness without launching anything. */
async function daemonProbe(
  stateDir: string,
  deps: DaemonDeps,
): Promise<DaemonProbeInfo> {
  const probe = deps.probe ?? defaultProbeEndpoint;
  const state = readDaemonState(stateDir);
  if (!state) return { running: false };
  const result = await probe(state.port);
  if (!result.ok) return { running: false };
  return {
    running: true,
    port: state.port,
    pid: state.pid,
    browserVersion: result.browserVersion,
  };
}

let cached: CommandContext | undefined;

export function getCommandContext(): CommandContext {
  cached ??= createCommandContext();
  return cached;
}

export type { AxiRenderable };
