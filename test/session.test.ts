import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import {
  acquireLock,
  classifyUrl,
  deleteSessionRecord,
  lockPath,
  profileExists,
  purgeProfile,
  readSessionRecord,
  releaseLock,
  resolveStateDir,
  writeSessionRecord,
} from "../src/browser/session.js";
import { createRunDir, sanitizeHtml } from "../src/browser/artifacts.js";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "indeed-axi-session-test-"));
}

describe("state dir and session record", () => {
  it("defaults to ~/.indeed-axi and honors INDEED_STATE_DIR", () => {
    expect(resolveStateDir()).toBe(join(homedir(), ".indeed-axi"));
    expect(resolveStateDir({ INDEED_STATE_DIR: "/tmp/custom-state" })).toBe("/tmp/custom-state");
  });

  it("round-trips the session record and tolerates corruption", () => {
    const dir = tempStateDir();
    expect(readSessionRecord(dir)).toBeNull();
    writeSessionRecord(dir, { lastLogin: "2026-09-28T00:00:00Z", url: "https://employers.indeed.com/c/dashboard" });
    expect(readSessionRecord(dir)).toEqual({
      lastLogin: "2026-09-28T00:00:00Z",
      url: "https://employers.indeed.com/c/dashboard",
    });
    writeFileSync(join(dir, "session.json"), "{corrupt", "utf8");
    expect(readSessionRecord(dir)).toBeNull();
    deleteSessionRecord(dir);
    expect(existsSync(join(dir, "session.json"))).toBe(false);
  });

  it("purge removes only the profile and record", () => {
    const dir = tempStateDir();
    const profile = join(dir, "browser-profile");
    const runs = join(dir, "runs", "keep-me");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "Cookies"), "fake", "utf8");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "trace.zip"), "fake", "utf8");
    writeSessionRecord(dir, { lastLogin: "x", url: "y" });
    expect(profileExists(dir)).toBe(true);

    purgeProfile(dir);
    expect(profileExists(dir)).toBe(false);
    expect(existsSync(join(dir, "session.json"))).toBe(false);
    expect(existsSync(join(runs, "trace.zip"))).toBe(true);
  });
});

describe("lock", () => {
  it("rejects a second holder while alive and replaces stale locks", () => {
    const dir = tempStateDir();
    acquireLock(dir, { pid: 111, isAlive: () => true });
    expect(readFileSync(lockPath(dir), "utf8").trim()).toBe("111");

    expect(() => acquireLock(dir, { pid: 222, isAlive: () => true })).toThrowError(AxiError);
    try {
      acquireLock(dir, { pid: 222, isAlive: () => true });
    } catch (error) {
      expect((error as AxiError).code).toBe("LOCK_HELD");
    }

    // re-entrant acquire by the same pid is allowed
    acquireLock(dir, { pid: 111, isAlive: () => true });

    // a stale lock (dead pid) is replaced
    acquireLock(dir, { pid: 333, isAlive: () => false });
    expect(readFileSync(lockPath(dir), "utf8").trim()).toBe("333");

    releaseLock(dir);
    expect(existsSync(lockPath(dir))).toBe(false);
  });
});

describe("classifyUrl", () => {
  it("classifies employer dashboard, auth pages, and away URLs", () => {
    expect(classifyUrl("https://employers.indeed.com/c/dashboard")).toBe("logged-in");
    expect(classifyUrl("https://hires.indeed.com/jobs")).toBe("logged-in");
    expect(classifyUrl("https://employers.indeed.com/candidates/123")).toBe("logged-in");
    expect(classifyUrl("https://secure.indeed.com/auth")).toBe("auth");
    expect(classifyUrl("https://employers.indeed.com/login")).toBe("auth");
    expect(classifyUrl("https://www.indeed.com/viewjob?jk=x")).toBe("away");
    expect(classifyUrl("https://www.google.com/")).toBe("away");
    expect(classifyUrl("https://evilindeed.com/login")).toBe("away");
    expect(classifyUrl("not a url")).toBe("away");
  });
});

describe("artifacts", () => {
  it("creates timestamped run dirs", () => {
    const dir = tempStateDir();
    const run = createRunDir(dir, "discover", () => new Date(2026, 8, 28, 10, 20, 30));
    expect(run.id).toBe("discover-20260928-102030-" + run.id.split("-").pop());
    expect(existsSync(run.dir)).toBe(true);
  });

  it("sanitizes scripts and comments from html", () => {
    const dirty = '<div>ok</div><script>var token="x"</script><!-- secret -->';
    const clean = sanitizeHtml(dirty);
    expect(clean).toContain("ok");
    expect(clean).not.toContain("token");
    expect(clean).not.toContain("secret");
  });
});
