import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { Page } from "playwright-core";

/**
 * Browser session state: the persistent Chrome profile location, the local
 * launch lock, and Indeed auth-state classification.
 *
 * Rules (REQUIREMENTS.md, Browser transport):
 * - All browsing is headed. No headless background execution.
 * - The profile lives under the user-level state dir; the user's primary
 *   Chrome profile is never touched.
 * - The Playwright-controlled browser is the only web client for
 *   indeed.com - cookies are never exported or replayed elsewhere.
 */

export const PROFILE_DIR_NAME = "browser-profile";

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["INDEED_STATE_DIR"]?.trim();
  if (override && override.length > 0) return override;
  return join(homedir(), ".indeed-axi");
}

export function profileDir(stateDir: string): string {
  return join(stateDir, PROFILE_DIR_NAME);
}

export interface SessionRecord {
  lastLogin: string;
  url: string;
}

export function sessionRecordPath(stateDir: string): string {
  return join(stateDir, "session.json");
}

export function readSessionRecord(stateDir: string): SessionRecord | null {
  const path = sessionRecordPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionRecord>;
    if (typeof parsed.lastLogin === "string" && typeof parsed.url === "string") {
      return { lastLogin: parsed.lastLogin, url: parsed.url };
    }
  } catch {
    // fall through: corrupt record is treated as absent
  }
  return null;
}

export function writeSessionRecord(stateDir: string, record: SessionRecord): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(sessionRecordPath(stateDir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function deleteSessionRecord(stateDir: string): void {
  const path = sessionRecordPath(stateDir);
  if (existsSync(path)) rmSync(path);
}

export function profileExists(stateDir: string): boolean {
  return existsSync(profileDir(stateDir));
}

/** Delete the browser profile and session record. Scoped to exact paths only. */
export function purgeProfile(stateDir: string): void {
  const profile = profileDir(stateDir);
  if (!profile.startsWith(join(stateDir, ""))) {
    throw new AxiError("refusing to purge a profile outside the state directory", "API_ERROR");
  }
  if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
  deleteSessionRecord(stateDir);
}

/* ------------------------------------------------------------------ */
/* Lock                                                                */
/* ------------------------------------------------------------------ */

export function lockPath(stateDir: string): string {
  return join(stateDir, "lock");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

/** One browser launch at a time. Stale locks (dead pid) are replaced. */
export function acquireLock(stateDir: string, opts: LockOptions = {}): void {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isPidAlive;
  mkdirSync(stateDir, { recursive: true });
  const path = lockPath(stateDir);
  if (existsSync(path)) {
    const held = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isInteger(held) && held !== pid && isAlive(held)) {
      throw new AxiError(
        `another indeed-axi browser launch is active (pid ${held})`,
        "LOCK_HELD",
        ["Wait for it to finish, or kill that process if it is stale"],
      );
    }
  }
  writeFileSync(path, `${pid}\n`, "utf8");
}

export function releaseLock(stateDir: string): void {
  const path = lockPath(stateDir);
  if (existsSync(path)) rmSync(path);
}

/* ------------------------------------------------------------------ */
/* Auth classification                                                 */
/* ------------------------------------------------------------------ */

export type BrowserAuthState = "logged-in" | "auth" | "away";

const INDEED_HOST = /(^|\.)indeed\.com$/i;
const AUTH_HOST = /^(secure|auth|signin|account)\./i;
const AUTH_PATH = /\/(login|signin|signup|register|logout|auth)(\/|$|\?|#)/i;
const EMPLOYER_HOST = /^(employers|hires|dashboard|employer)\./i;

/**
 * Classify a URL by login state without touching page internals, so the
 * heuristic stays testable and easy to revise after discovery.
 *
 * - employer hosts (employers/hires/dashboard.Indeed.com) -> logged-in
 * - auth hosts (secure.indeed.com) and login-ish paths -> auth
 * - everything else (including www.indeed.com job-seeker pages and
 *   non-Indeed hosts) -> away
 */
export function classifyUrl(raw: string): BrowserAuthState {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "away";
  }
  const host = url.hostname.toLowerCase();
  if (!INDEED_HOST.test(host)) return "away";
  if (AUTH_HOST.test(host) || AUTH_PATH.test(url.pathname)) return "auth";
  if (EMPLOYER_HOST.test(host)) return "logged-in";
  return "away";
}

/**
 * A visible password input means an auth form regardless of what the URL
 * claims - Indeed's SPA can serve the app shell to logged-out visitors
 * before a client-side redirect, so the URL alone can false-positive.
 */
export async function looksLikeLoginPage(page: Page): Promise<boolean> {
  try {
    return (await page.locator('input[type="password"]').count()) > 0;
  } catch {
    return false;
  }
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs?: number;
  /** Called once when a login page (or non-employer URL) is first observed. */
  onPrompt?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait for manual login: poll the URL and DOM until an employer dashboard
 * page is reached. Timeout raises TIMEOUT with guidance; the caller keeps
 * the browser open (the daemon owns its lifecycle).
 */
export async function waitForLogin(page: Page, opts: WaitOptions): Promise<string> {
  const pollMs = opts.pollMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  let prompted = false;
  for (;;) {
    const state = classifyUrl(page.url());
    if (state === "logged-in" && !(await looksLikeLoginPage(page))) return page.url();
    if (!prompted) {
      // give redirects a moment before declaring a login is needed
      await sleep(1500);
      const retryState = classifyUrl(page.url());
      if (retryState === "logged-in" && !(await looksLikeLoginPage(page))) return page.url();
      prompted = true;
      opts.onPrompt?.();
    }
    if (Date.now() >= deadline) {
      throw new AxiError(
        `login not completed within ${opts.timeoutMs}ms`,
        "TIMEOUT",
        [
          "Complete the login (including 2FA / verification codes) in the opened window and rerun",
          "Pass a larger --timeout if you need more time",
        ],
      );
    }
    await sleep(pollMs);
  }
}
