import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { parseFlags, type FlagDefinition } from "../lib/args.js";
import { renderResult } from "../lib/output.js";

export const SKILL_HELP = `indeed-axi skill install - install the agent skill

usage:
  skill install [--dir <path>] [--force]

flags:
  --dir <path>     skills directory to install into
                   (default ~/.agents/skills)
  --force          overwrite an existing different version
  --json           machine-readable JSON instead of TOON

Writes the indeed-axi SKILL.md into <dir>/indeed-axi/SKILL.md so coding
agents (Claude Code, Codex, OpenCode, Hermes, ...) pick it up as a skill.
Idempotent: an identical file is a no-op; a changed file requires --force.

Works without a global install: npx indeed-axi skill install

examples:
  indeed-axi skill install
  npx -y indeed-axi skill install
  indeed-axi skill install --dir ~/.agents/skills --force`;

const INSTALL_FLAGS: Record<string, FlagDefinition> = {
  dir: { type: "string" },
  force: { type: "boolean" },
  json: { type: "boolean" },
};

/** Locate the packaged SKILL.md relative to this module (dist/ -> package root). */
export function resolveSkillSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "skills", "indeed-axi", "SKILL.md"), // dist/commands -> package root
    join(here, "..", "..", "..", "skills", "indeed-axi", "SKILL.md"), // src fallback
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new AxiError(
    "could not locate the packaged SKILL.md",
    "APP_ERROR",
    ["The npm package may be incomplete - reinstall, or copy skills/indeed-axi/SKILL.md manually"],
  );
}

export interface SkillInstallResult {
  path: string;
  outcome: "installed" | "identical" | "updated";
}

export function installSkill(opts: {
  skillsDir: string;
  force: boolean;
  source: string;
}): SkillInstallResult {
  const content = readFileSync(opts.source, "utf8");
  const target = join(opts.skillsDir, "indeed-axi", "SKILL.md");
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing === content) {
      return { path: target, outcome: "identical" };
    }
    if (!opts.force) {
      throw new AxiError(
        "a different version of the skill is already installed",
        "VALIDATION_ERROR",
        [`Target: ${target}`, "Rerun with --force to overwrite"],
      );
    }
    writeFileSync(target, content, "utf8");
    return { path: target, outcome: "updated" };
  }
  writeFileSync(target, content, "utf8");
  return { path: target, outcome: "installed" };
}

export async function skillCommand(args: string[]): Promise<AxiRenderable> {
  const sub = args[0];
  if (sub !== "install") {
    return { help_text: SKILL_HELP };
  }
  const commandPath = "indeed-axi skill install";
  const { values, positionals } = parseFlags(args.slice(1), commandPath, INSTALL_FLAGS);
  const json = values["json"] === true;
  if (positionals.length > 0) {
    return { help_text: SKILL_HELP };
  }
  const skillsDir =
    typeof values["dir"] === "string" && values["dir"].trim().length > 0
      ? values["dir"]
      : join(homedir(), ".agents", "skills");
  const force = values["force"] === true;

  const source = resolveSkillSource();
  const result = installSkill({ skillsDir, force, source });
  return renderResult(
    {
      skill: {
        name: "indeed-axi",
        path: result.path,
        result: result.outcome,
      },
      help: [
        "New agent sessions now see the indeed-axi skill",
        "Run `indeed-axi setup hooks` for ambient session context too",
      ],
    },
    json,
  );
}
