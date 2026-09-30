import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import {
  forbidExtraPositionals,
  parseFlags,
  requireHttpUrl,
  requirePositional,
  type FlagDefinition,
} from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import type { CommandContext } from "../context.js";
import type { DaemonConnection } from "../browser/daemon.js";
import { PAGE_ERRORS_SOURCE } from "../browser/daemon.js";
import {
  clipLines,
  DEFAULT_LINE_LIMIT,
  filterLines,
  isValidKey,
  parseTarget,
  SNAPSHOT_MAX_LINES,
  SNAPSHOT_SOURCE,
  type PageSnapshot,
} from "../browser/snapshot.js";
import { createRunDir } from "../browser/artifacts.js";
import type { Page } from "playwright-core";

export const BROWSER_HELP = `indeed-axi browser - drive the Indeed employer interface (playwright-axi loop)

The persistent headed Chrome on the employer profile. Commands share one
browser (the daemon): snapshot returns an outline with [ref=eN] tags, and
click/fill/select act on those refs, then return a fresh snapshot. Refs are
valid until the next snapshot or navigation - take a fresh snapshot after
page changes; stale refs fail loudly as STALE_REF.

subcommands:
  browser open [--url <url>]      start/attach the browser, navigate, snapshot
  browser status                  daemon liveness (never starts anything)
  browser close                   stop the browser
  browser goto <url>              navigate to an indeed.com URL and snapshot
  browser snapshot [--full] [--query <terms>]   page outline with refs
  browser find <terms...>         filtered outline lines with context
  browser click <ref|selector>    click and return a fresh snapshot
  browser fill <ref|selector> <text> [--submit] fill a field, optionally Enter
  browser select <ref|selector> <value>         choose a dropdown option
  browser press <key>             press a key (e.g. Enter, Control+A)
  browser eval <expression>       evaluate JS on the page, JSON result
  browser screenshot [--path <f>] save a PNG (state runs dir by default)
  browser console                 collected in-page errors (window errors)

flags (per subcommand):
  --url <url>, --full, --query <terms>, --submit, --path <file>, --json

Scoping: navigation and actions are limited to *.indeed.com pages - the
authenticated profile is never pointed elsewhere. Login state is detected
heuristically (URL + password-input check).

examples:
  indeed-axi browser open
  indeed-axi browser snapshot --query candidates
  indeed-axi browser click e12
  indeed-axi browser fill e15 "part-time content producer" --submit`;

const INDEED_HOST = /(^|\.)indeed\.com$/i;

function requireIndeedUrl(raw: string, label: string): string {
  const url = requireHttpUrl(raw, label);
  const host = new URL(url).hostname.toLowerCase();
  if (!INDEED_HOST.test(host)) {
    throw new AxiError(
      `${label} must target indeed.com, got ${host}`,
      "VALIDATION_ERROR",
      ["The indeed-axi browser profile is scoped to Indeed only"],
    );
  }
  return url;
}

interface SnapshotShape {
  page: { url: string; title: string };
  snapshot: Record<string, unknown>;
  outline: string[];
}

type SnapshotView = SnapshotShape;

async function snapshotView(
  page: Page,
  opts: { full?: boolean; query?: string[] },
): Promise<SnapshotView> {
  const snap = await page.evaluate<PageSnapshot>(SNAPSHOT_SOURCE);
  let lines = snap.lines;
  let matches: number | undefined;
  if (opts.query && opts.query.length > 0) {
    const filtered = filterLines(lines, opts.query);
    lines = filtered.lines;
    matches = filtered.matches;
  }
  const limit = opts.full === true ? SNAPSHOT_MAX_LINES : DEFAULT_LINE_LIMIT;
  const clipped = clipLines(lines, limit);
  return {
    page: { url: snap.url, title: snap.title },
    snapshot: {
      lines: snap.lines.length,
      refs: snap.refs,
      ...(matches !== undefined ? { matches } : {}),
      ...(clipped.truncated ? { shown: clipped.shown.length, truncated: true } : {}),
    },
    outline: clipped.shown,
  };
}

function locatorFor(page: Page, rawTarget: string) {
  const target = parseTarget(rawTarget);
  return {
    target,
    locator: page.locator(target.selector),
  };
}

async function actAndSnapshot(
  conn: DaemonConnection,
  rawTarget: string,
  act: (locator: ReturnType<Page["locator"]>) => Promise<void>,
  opts: { full?: boolean },
): Promise<SnapshotView> {
  const { target, locator } = locatorFor(conn.page, rawTarget);
  const count = await locator.count();
  if (count === 0) {
    throw new AxiError(
      target.kind === "ref"
        ? `ref ${rawTarget} not found on the page - it is stale (page changed since the last snapshot)`
        : `selector matched nothing: ${rawTarget}`,
      target.kind === "ref" ? "STALE_REF" : "NOT_FOUND",
      ["Run `indeed-axi browser snapshot` for a fresh outline with current refs"],
    );
  }
  try {
    await act(locator);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.split("\n")[0]?.slice(0, 200) ?? String(error) : String(error);
    throw new AxiError(
      `action failed on ${rawTarget}: ${reason}`,
      "ACTION_FAILED",
      [
        "The element may be hidden or covered - run `indeed-axi browser snapshot` and choose a visible ref (offscreen elements carry no ref)",
        "Scroll with `indeed-axi browser press End` or eval window.scrollBy(0, 800), then re-snapshot",
      ],
    );
  }
  await conn.page.waitForTimeout(400);
  return snapshotView(conn.page, opts);
}

export async function browserCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined) {
    return { help_text: BROWSER_HELP };
  }
  switch (sub) {
    case "open":
      return open(rest, ctx);
    case "status":
      return status(rest, ctx);
    case "close":
      return close(rest, ctx);
    case "goto":
      return goto(rest, ctx);
    case "snapshot":
      return snapshot(rest, ctx);
    case "find":
      return find(rest, ctx);
    case "click":
      return click(rest, ctx);
    case "fill":
      return fill(rest, ctx);
    case "select":
      return select(rest, ctx);
    case "press":
      return press(rest, ctx);
    case "eval":
      return evalCmd(rest, ctx);
    case "screenshot":
      return screenshot(rest, ctx);
    case "console":
      return consoleCmd(rest, ctx);
    default:
      throw new AxiError(`browser: unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `indeed-axi browser --help` for the reference",
      ]);
  }
}

const OPEN_FLAGS: Record<string, FlagDefinition> = {
  url: { type: "string" },
  json: { type: "boolean" },
};

async function open(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser open";
  const { values, positionals } = parseFlags(args, commandPath, OPEN_FLAGS);
  const json = values["json"] === true;
  forbidExtraPositionals(positionals, 0, commandPath);

  const url = values["url"] !== undefined ? requireIndeedUrl(String(values["url"]), "--url") : undefined;
  const ensured = await ctx.daemon.ensure();
  const view = await ctx.daemon.withPage(async (conn) => {
    const target = url ?? (isIndeedUrl(conn.page.url()) ? conn.page.url() : "https://employers.indeed.com/");
    if (!isIndeedUrl(conn.page.url()) || url !== undefined) {
      await conn.page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await conn.page.waitForTimeout(1200);
    }
    return snapshotView(conn.page, {});
  });
  return renderResult(
    {
      browser: {
        started: ensured.started,
        port: ensured.port,
        pid: ensured.pid,
        ...(ensured.startedAt ? { since: ensured.startedAt } : {}),
      },
      ...view,
      help: [
        "Act on the outline with `indeed-axi browser click eN` / `fill eN \"text\"`",
        "Run `indeed-axi browser find <terms>` to narrow the outline",
      ],
    },
    json,
  );
}

const STATUS_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

async function status(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser status";
  const { values, positionals } = parseFlags(args, commandPath, STATUS_FLAGS);
  const json = values["json"] === true;
  forbidExtraPositionals(positionals, 0, commandPath);

  const probe = await ctx.daemon.probe();
  return renderResult(
    {
      browser: probe.running
        ? {
            running: true,
            port: probe.port,
            pid: probe.pid,
            ...(probe.browserVersion ? { version: probe.browserVersion } : {}),
          }
        : { running: false },
      help: probe.running
        ? ["Run `indeed-axi browser snapshot` for the current page outline"]
        : ["Run `indeed-axi browser open` to start the browser (visible Chrome window)"],
    },
    json,
  );
}

const CLOSE_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

async function close(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser close";
  const { values, positionals } = parseFlags(args, commandPath, CLOSE_FLAGS);
  const json = values["json"] === true;
  forbidExtraPositionals(positionals, 0, commandPath);

  const result = await ctx.daemon.stop();
  return renderResult(
    {
      browser: { running: false, result },
      help: ["Run `indeed-axi browser open` to start it again"],
    },
    json,
  );
}

const GOTO_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  json: { type: "boolean" },
};

async function goto(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser goto";
  const { values, positionals } = parseFlags(args, commandPath, GOTO_FLAGS);
  const json = values["json"] === true;
  const url = requireIndeedUrl(requirePositional(positionals, 0, "url", commandPath), "<url>");
  forbidExtraPositionals(positionals, 1, commandPath);
  const full = values["full"] === true;

  const view = await ctx.daemon.withPage(async (conn) => {
    await conn.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await conn.page.waitForTimeout(1200);
    return snapshotView(conn.page, { full });
  });
  return renderResult(
    {
      ...view,
      help: [
        "Act on the outline with `indeed-axi browser click eN` / `fill eN \"text\"`",
        "Run `indeed-axi browser find <terms>` to narrow the outline",
      ],
    },
    json,
  );
}

const SNAPSHOT_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  query: { type: "string", multiple: true },
  json: { type: "boolean" },
};

async function snapshot(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser snapshot";
  const { values, positionals } = parseFlags(args, commandPath, SNAPSHOT_FLAGS);
  const json = values["json"] === true;
  forbidExtraPositionals(positionals, 0, commandPath);

  const query = Array.isArray(values["query"]) ? (values["query"] as string[]) : undefined;
  const view = await ctx.daemon.withPage((conn) =>
    snapshotView(conn.page, { full: values["full"] === true, query }),
  );
  return renderResult(
    {
      ...view,
      help: [
        "Act on the outline with `indeed-axi browser click eN` / `fill eN \"text\"`",
        ...(view.snapshot["truncated"] ? ["Rerun with --full for the complete outline"] : []),
      ],
    },
    json,
  );
}

const FIND_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

async function find(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser find";
  const { values, positionals } = parseFlags(args, commandPath, FIND_FLAGS);
  const json = values["json"] === true;
  const terms = positionals.map((term) => term.trim()).filter((term) => term.length > 0);
  if (terms.length === 0) {
    throw new AxiError(`${commandPath}: missing <terms>`, "VALIDATION_ERROR", [
      "Example: `indeed-axi browser find candidates message`",
    ]);
  }

  const view = await ctx.daemon.withPage(async (conn) => {
    const snap = await conn.page.evaluate<PageSnapshot>(SNAPSHOT_SOURCE);
    const filtered = filterLines(snap.lines, terms);
    return {
      page: { url: snap.url, title: snap.title },
      snapshot: { lines: snap.lines.length, refs: snap.refs, matches: filtered.matches },
      outline: filtered.lines,
    };
  });
  const matches = Number(view.snapshot["matches"] ?? 0);
  return renderResult(
    {
      ...view,
      ...(matches === 0 ? { note: "0 matches - try fewer or different terms" } : {}),
      help: [
        "Act on the outline with `indeed-axi browser click eN` / `fill eN \"text\"`",
        "Run `indeed-axi browser snapshot --full` if the outline was clipped",
      ],
    },
    json,
  );
}

const CLICK_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  json: { type: "boolean" },
};

async function click(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser click";
  const { values, positionals } = parseFlags(args, commandPath, CLICK_FLAGS);
  const json = values["json"] === true;
  const target = requirePositional(positionals, 0, "ref", commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);

  const view = await ctx.daemon.withPage((conn) =>
    actAndSnapshot(conn, target, (locator) => locator.click({ timeout: 15_000 }), {
      full: values["full"] === true,
    }),
  );
  return renderResult(
    {
      ...view,
      help: nextStepHelp(),
    },
    json,
  );
}

const FILL_FLAGS: Record<string, FlagDefinition> = {
  submit: { type: "boolean" },
  full: { type: "boolean" },
  json: { type: "boolean" },
};

async function fill(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser fill";
  const { values, positionals } = parseFlags(args, commandPath, FILL_FLAGS);
  const json = values["json"] === true;
  const target = requirePositional(positionals, 0, "ref", commandPath);
  const text = requirePositional(positionals, 1, "text", commandPath);
  forbidExtraPositionals(positionals, 2, commandPath);

  const view = await ctx.daemon.withPage(async (conn) => {
    const view = await actAndSnapshot(conn, target, (locator) => locator.fill(text, { timeout: 15_000 }), {
      full: values["full"] === true,
    });
    if (values["submit"] === true) {
      await conn.page.keyboard.press("Enter");
      await conn.page.waitForTimeout(800);
      return snapshotView(conn.page, { full: values["full"] === true });
    }
    return view;
  });
  return renderResult(
    {
      ...view,
      help: nextStepHelp(),
    },
    json,
  );
}

const SELECT_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  json: { type: "boolean" },
};

async function select(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser select";
  const { values, positionals } = parseFlags(args, commandPath, SELECT_FLAGS);
  const json = values["json"] === true;
  const target = requirePositional(positionals, 0, "ref", commandPath);
  const value = requirePositional(positionals, 1, "value", commandPath);
  forbidExtraPositionals(positionals, 2, commandPath);

  const view = await ctx.daemon.withPage((conn) =>
    actAndSnapshot(
      conn,
      target,
      async (locator) => {
        try {
          await locator.selectOption(value, { timeout: 15_000 });
        } catch {
          // fall back to matching by visible label
          await locator.selectOption({ label: value }, { timeout: 15_000 });
        }
      },
      { full: values["full"] === true },
    ),
  );
  return renderResult(
    {
      ...view,
      help: nextStepHelp(),
    },
    json,
  );
}

const PRESS_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  json: { type: "boolean" },
};

async function press(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser press";
  const { values, positionals } = parseFlags(args, commandPath, PRESS_FLAGS);
  const json = values["json"] === true;
  const key = requirePositional(positionals, 0, "key", commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  if (!isValidKey(key)) {
    throw new AxiError(
      `${commandPath}: unsupported key name: ${key}`,
      "VALIDATION_ERROR",
      ["Examples: Enter, Tab, Escape, ArrowDown, Control+A"],
    );
  }

  const view = await ctx.daemon.withPage(async (conn) => {
    await conn.page.keyboard.press(key);
    await conn.page.waitForTimeout(400);
    return snapshotView(conn.page, { full: values["full"] === true });
  });
  return renderResult(
    {
      ...view,
      help: nextStepHelp(),
    },
    json,
  );
}

const EVAL_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  json: { type: "boolean" },
};

async function evalCmd(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser eval";
  const { values, positionals } = parseFlags(args, commandPath, EVAL_FLAGS);
  const json = values["json"] === true;
  const expression = requirePositional(positionals, 0, "expression", commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);

  const result = await ctx.daemon.withPage(async (conn) => {
    if (!isIndeedUrl(conn.page.url())) {
      throw new AxiError(
        "the browser is not on an indeed.com page",
        "VALIDATION_ERROR",
        ["Run `indeed-axi browser goto <indeed-url>` first"],
      );
    }
    return conn.page.evaluate(expression) as Promise<unknown>;
  });
  let rendered: unknown;
  try {
    rendered = JSON.stringify(result, null, 2) ?? "undefined";
  } catch {
    rendered = String(result);
  }
  return renderResult(
    {
      eval: { result: rendered },
      help: ["Use --json output for machine-readable results"],
    },
    json,
  );
}

const SCREENSHOT_FLAGS: Record<string, FlagDefinition> = {
  path: { type: "string" },
  json: { type: "boolean" },
};

async function screenshot(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser screenshot";
  const { values, positionals } = parseFlags(args, commandPath, SCREENSHOT_FLAGS);
  const json = values["json"] === true;
  forbidExtraPositionals(positionals, 0, commandPath);

  const explicit = values["path"] !== undefined ? String(values["path"]) : undefined;
  const run = createRunDir(ctx.stateDir, "shot");
  const path = explicit ?? `${run.dir}/screenshot.png`;
  const url = await ctx.daemon.withPage(async (conn) => {
    await conn.page.screenshot({ path, fullPage: false });
    return conn.page.url();
  });
  return renderResult(
    {
      screenshot: { path, url },
      help: ["The PNG is local-only; the runs directory is user-level state"],
    },
    json,
  );
}

const CONSOLE_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

async function consoleCmd(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi browser console";
  const { values, positionals } = parseFlags(args, commandPath, CONSOLE_FLAGS);
  const json = values["json"] === true;
  forbidExtraPositionals(positionals, 0, commandPath);

  const errors = await ctx.daemon.withPage((conn) =>
    conn.page.evaluate<string[]>(PAGE_ERRORS_SOURCE),
  );
  return renderResult(
    {
      console: { errors: errors.length },
      ...(errors.length > 0 ? { list: errors } : {}),
      help: errors.length > 0 ? ["Errors reset on the next page load"] : ["No collected page errors"],
    },
    json,
  );
}

function isIndeedUrl(raw: string): boolean {
  try {
    return INDEED_HOST.test(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function nextStepHelp(): string[] {
  return [
    "Continue with `click eN` / `fill eN \"text\"` / `find <terms>`",
    "Run `indeed-axi browser snapshot` if the page changed unexpectedly",
  ];
}
