import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { optionalInt, parseFlags, type FlagDefinition } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { errorMessage } from "../lib/guard.js";
import {
  deleteSessionRecord,
  profileDir,
  profileExists,
  purgeProfile,
  readSessionRecord,
} from "../browser/session.js";
import type { CommandContext } from "../context.js";

export const AUTH_HELP = `indeed-axi auth - employer browser-session state

subcommands:
  auth status            report the browser session state (--browser to probe live)
  auth login             open a visible Chrome window and wait for manual login
  auth logout            close the browser and clear the session record (--purge deletes the profile)

flags:
  --timeout <ms>         (login) max wait for manual login (default 300000)
  --browser              (status) verify the live session in the browser
  --purge                (logout) delete the browser profile and session record
  --json                 machine-readable JSON instead of TOON

The browser session uses a dedicated persistent profile under
~/.indeed-axi/browser-profile - never your primary Chrome profile. Login is
manual (email + password, 2FA / verification codes included). The
Playwright-controlled browser is the only web client for indeed.com; cookies
are never exported or replayed.

There is no API key: Indeed exposes no public employer API, so everything
goes through the authenticated browser.

examples:
  indeed-axi auth status
  indeed-axi auth login
  indeed-axi auth login --timeout 600000
  indeed-axi auth logout --purge`;

const STATUS_FLAGS: Record<string, FlagDefinition> = {
  browser: { type: "boolean" },
  json: { type: "boolean" },
};

const LOGIN_FLAGS: Record<string, FlagDefinition> = {
  timeout: { type: "string" },
  json: { type: "boolean" },
};

const LOGOUT_FLAGS: Record<string, FlagDefinition> = {
  purge: { type: "boolean" },
  json: { type: "boolean" },
};

export async function authCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  if (sub === undefined) {
    return { help_text: AUTH_HELP };
  }
  if (sub === "status") return status(args.slice(1), ctx);
  if (sub === "login") return login(args.slice(1), ctx);
  if (sub === "logout") return logout(args.slice(1), ctx);
  throw new AxiError(`auth: unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
    "Implemented: `auth status`, `auth login`, `auth logout`",
    "Run `indeed-axi auth --help` for the reference",
  ]);
}

function browserSection(ctx: CommandContext): Record<string, unknown> {
  const record = readSessionRecord(ctx.stateDir);
  return {
    profile: profileExists(ctx.stateDir) ? "present" : "missing",
    last_login: record?.lastLogin ?? null,
    ...(record ? { last_url: record.url } : {}),
  };
}

async function status(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi auth status";
  const { values } = parseFlags(args, commandPath, STATUS_FLAGS);
  const json = values["json"] === true;

  let browser: Record<string, unknown>;
  if (values["browser"] === true) {
    try {
      const probe = await ctx.browser.probe({ stateDir: ctx.stateDir });
      browser = {
        ...browserSection(ctx),
        live: { state: probe.state, url: probe.url },
      };
    } catch (error) {
      browser = {
        ...browserSection(ctx),
        live: { error: errorMessage(error) },
      };
    }
  } else {
    browser = { ...browserSection(ctx), live: "not probed (pass --browser to verify live)" };
  }

  const loggedIn = typeof browser.live === "object" && (browser.live as { state?: string }).state === "logged-in";
  return renderResult(
    {
      auth: {
        browser_session: browser,
      },
      help: loggedIn
        ? [
            "Run `indeed-axi browser open` to start driving the employer dashboard",
            "Run `indeed-axi discover` to record dashboard traffic for domain commands",
          ]
        : [
            "Run `indeed-axi auth login` to establish the employer session",
            "Run `indeed-axi auth status --browser` to re-verify anytime",
          ],
    },
    json,
  );
}

async function login(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi auth login";
  const { values } = parseFlags(args, commandPath, LOGIN_FLAGS);
  const json = values["json"] === true;
  const timeoutMs =
    optionalInt(values, "timeout", { min: 10_000, max: 3_600_000 }) ?? 300_000;

  const result = await ctx.browser.login({ stateDir: ctx.stateDir, timeoutMs });
  return renderResult(
    {
      auth: {
        browser_session: {
          logged_in: true,
          url: result.url,
          profile: profileDir(ctx.stateDir),
          browser: "running (headed Chrome stays open for browser commands)",
        },
      },
      help: [
        "Run `indeed-axi auth status --browser` to re-verify anytime",
        "Run `indeed-axi browser open` to start driving the dashboard",
        "Run `indeed-axi discover` to record dashboard traffic for domain commands",
      ],
    },
    json,
  );
}

async function logout(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi auth logout";
  const { values } = parseFlags(args, commandPath, LOGOUT_FLAGS);
  const json = values["json"] === true;

  const stopped = await ctx.daemon.stop();

  if (values["purge"] === true) {
    purgeProfile(ctx.stateDir);
    return renderResult(
      {
        auth: {
          browser_session: { profile: "deleted", session_record: "deleted" },
        },
        browser: stopped,
        help: ["Run `indeed-axi auth login` to create a fresh profile and log in again"],
      },
      json,
    );
  }

  const hadRecord = readSessionRecord(ctx.stateDir) !== null;
  deleteSessionRecord(ctx.stateDir);
  return renderResult(
    {
      auth: {
        browser_session: {
          session_record: hadRecord ? "deleted" : "absent",
          profile: profileExists(ctx.stateDir) ? "kept (pass --purge to delete)" : "missing",
        },
      },
      browser: stopped,
      help: [
        "Run `indeed-axi auth logout --purge` to delete the browser profile too",
        "Run `indeed-axi auth login` to log in again",
      ],
    },
    json,
  );
}
