import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  connectDaemon,
  ensureDaemon,
  readDaemonState,
  startDaemonBrowser,
  stopDaemonBrowser,
  writeDaemonState,
  type DaemonDeps,
} from "../src/browser/daemon.js";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "indeed-axi-daemon-test-"));
}

function depsWith(overrides: Partial<DaemonDeps>): DaemonDeps {
  return {
    freePort: async () => 46000,
    executable: () => "/usr/bin/true-chrome",
    spawn: () => ({ pid: 4242, hasExited: () => false }),
    probe: async () => ({ ok: true, browserVersion: "Chrome/130.0.0.0" }),
    connect: async () => fakeBrowser(),
    sleep: async () => undefined,
    now: () => new Date("2026-09-28T00:00:00Z"),
    kill: () => undefined,
    isAlive: () => true,
    ...overrides,
  };
}

function fakeBrowser(): Browser {
  const context = fakeContext();
  return {
    contexts: () => [context],
    close: async () => undefined,
  } as unknown as Browser;
}

function fakeContext(): BrowserContext {
  const page = fakePage();
  const listeners: { page?: (page: Page) => void } = {};
  return {
    pages: () => [page],
    newPage: async () => page,
    addInitScript: async () => undefined,
    on: (event: string, handler: (page: Page) => void) => {
      if (event === "page") listeners.page = handler;
    },
  } as unknown as BrowserContext;
}

export function fakePage(url = "https://employers.indeed.com/c/dashboard"): Page {
  return {
    url: () => url,
    evaluate: async (source: string) => {
      if (source.includes("__iaInstall")) return true;
      if (source.includes("__iaErrors")) return [] as string[];
      return {
        url,
        title: "Employer dashboard",
        lines: ['- link "Candidates" [ref=e1]'],
        refs: 1,
      };
    },
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    locator: () => ({
      count: async () => 1,
      click: async () => undefined,
      fill: async () => undefined,
      selectOption: async () => undefined,
    }),
    keyboard: { press: async () => undefined },
    screenshot: async () => undefined,
    on: () => undefined,
  } as unknown as Page;
}

describe("daemon state", () => {
  it("round-trips and tolerates corruption", async () => {
    const dir = tempStateDir();
    expect(readDaemonState(dir)).toBeNull();
    writeDaemonState(dir, { port: 46000, pid: 99, startedAt: "2026-09-28T00:00:00Z" });
    expect(readDaemonState(dir)).toEqual({ port: 46000, pid: 99, startedAt: "2026-09-28T00:00:00Z" });
  });
});

describe("startDaemonBrowser", () => {
  it("spawns chrome with the cdp port and user-data-dir, then writes state", async () => {
    const dir = tempStateDir();
    const spawns: { command: string; args: string[]; userDataDir: string }[] = [];
    const deps = depsWith({
      spawn: (command, args, userDataDir) => {
        spawns.push({ command, args, userDataDir });
        return { pid: 4242, hasExited: () => false };
      },
    });
    const state = await startDaemonBrowser(dir, deps);
    expect(state).toEqual({
      port: 46000,
      pid: 4242,
      startedAt: new Date("2026-09-28T00:00:00Z").toISOString(),
    });
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.args).toContain("--remote-debugging-port=46000");
    expect(spawns[0]?.userDataDir).toBe(join(dir, "browser-profile"));
    expect(readDaemonState(dir)).toEqual(state);
  });

  it("fails loudly when chrome exits immediately (singleton conflict)", async () => {
    const dir = tempStateDir();
    const deps = depsWith({ spawn: () => ({ pid: 555, hasExited: () => true }) });
    await expect(startDaemonBrowser(dir, deps)).rejects.toThrowError(AxiError);
    expect(readDaemonState(dir)).toBeNull();
  });
});

describe("ensureDaemon", () => {
  it("reuses a reachable daemon without spawning", async () => {
    const dir = tempStateDir();
    writeDaemonState(dir, { port: 46000, pid: 99, startedAt: "2026-09-28T00:00:00Z" });
    const deps = depsWith({
      spawn: () => {
        throw new Error("must not spawn");
      },
    });
    const result = await ensureDaemon(dir, deps);
    expect(result.started).toBe(false);
    expect(result.pid).toBe(99);
  });

  it("starts a fresh daemon when the state is stale", async () => {
    const dir = tempStateDir();
    writeDaemonState(dir, { port: 46000, pid: 99, startedAt: "old" });
    let spawned = false;
    const deps = depsWith({
      probe: async () => (spawned ? { ok: true, browserVersion: "Chrome/130.0.0.0" } : { ok: false }),
      spawn: () => {
        spawned = true;
        return { pid: 4242, hasExited: () => false };
      },
    });
    const result = await ensureDaemon(dir, deps);
    expect(result.started).toBe(true);
    expect(result.pid).toBe(4242);
  });
});

describe("connectDaemon", () => {
  it("hands the caller the default context page and disconnects", async () => {
    const dir = tempStateDir();
    writeDaemonState(dir, { port: 46000, pid: 99, startedAt: "2026-09-28T00:00:00Z" });
    let closed = false;
    const deps = depsWith({
      connect: async () =>
        ({
          contexts: () => [fakeContext()],
          close: async () => {
            closed = true;
          },
        }) as unknown as Browser,
    });
    const seen = await connectDaemon(dir, deps).then(async (conn) => {
      const url = conn.page.url();
      await conn.disconnect();
      return url;
    });
    expect(seen).toBe("https://employers.indeed.com/c/dashboard");
    expect(closed).toBe(true);
  });

  it("raises DAEMON_NOT_RUNNING when nothing is reachable", async () => {
    const dir = tempStateDir();
    const deps = depsWith({ probe: async () => ({ ok: false }) });
    await expect(connectDaemon(dir, deps)).rejects.toMatchObject({
      code: "DAEMON_NOT_RUNNING",
    });
  });
});

describe("stopDaemonBrowser", () => {
  it("kills the recorded pid and clears the state", async () => {
    const dir = tempStateDir();
    writeDaemonState(dir, { port: 46000, pid: 99, startedAt: "2026-09-28T00:00:00Z" });
    const kills: [number, string][] = [];
    let endpointAlive = true;
    const deps = depsWith({
      probe: async () => ({ ok: endpointAlive }),
      kill: (pid, signal) => kills.push([pid, signal]),
      isAlive: () => true,
    });
    const originalKill = deps.kill;
    deps.kill = (pid, signal) => {
      originalKill(pid, signal);
      endpointAlive = false;
    };
    const result = await stopDaemonBrowser(dir, deps);
    expect(result).toBe("stopped");
    expect(kills).toEqual([[99, "SIGTERM"]]);
    expect(existsSync(join(dir, "browser-daemon.json"))).toBe(false);
  });

  it("is a no-op when nothing is running", async () => {
    const dir = tempStateDir();
    const result = await stopDaemonBrowser(dir, depsWith({}));
    expect(result).toBe("not-running");
  });
});
