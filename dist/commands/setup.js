import { installSessionStartHooks, sessionStartHookStatus } from "axi-sdk-js";
import { oneOf, parseFlags } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
export const SETUP_HELP = `indeed-axi setup - install ambient context and inspect installation

subcommands:
  setup hooks    install or repair Claude Code / Codex / OpenCode session-start hooks
  setup status   report hook installation without writing anything
  setup remove   remove indeed-axi managed hooks, leaving unrelated entries alone

flags:
  --scope user|project   target home-directory config (default) or this repo's config

The hook injects the indeed-axi home view (session state, browser daemon
state, command cheatsheet) as ambient context at the start of every
session, so the agent knows the tool exists before you mention it.

examples:
  indeed-axi setup hooks
  indeed-axi setup hooks --scope project
  indeed-axi setup status`;
const SETUP_FLAGS = {
    scope: { type: "string" },
};
const HOOK_OPTIONS = {
    marker: "indeed-axi",
    binaryNames: ["indeed-axi"],
};
export async function setupCommand(args) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub !== "hooks" && sub !== "status" && sub !== "remove") {
        return { help_text: SETUP_HELP };
    }
    const commandPath = `indeed-axi setup ${sub}`;
    const { values } = parseFlags(rest, commandPath, SETUP_FLAGS);
    const scope = oneOf(values, "scope", ["user", "project"]) ?? "user";
    if (sub === "status") {
        const status = sessionStartHookStatus({ ...HOOK_OPTIONS, scope });
        return {
            hooks: {
                scope,
                claude_code: { installed: status.claude.installed, path: status.claude.path },
                codex: {
                    installed: status.codex.installed,
                    path: status.codex.path,
                    user_feature_enabled: status.codex.userFeatureEnabled,
                },
                opencode: { installed: status.opencode.installed, path: status.opencode.path },
            },
            help: [
                "Run `indeed-axi setup hooks` to install or repair missing hooks",
                "Run `indeed-axi setup hooks --scope project` for repo-local ambient context",
            ],
        };
    }
    if (sub === "remove") {
        const { uninstallSessionStartHooks } = await import("axi-sdk-js");
        uninstallSessionStartHooks({ ...HOOK_OPTIONS, scope });
        return {
            hooks: { scope, removed: true },
            help: ["Run `indeed-axi setup hooks` to reinstall"],
        };
    }
    const messages = [];
    installSessionStartHooks({
        ...HOOK_OPTIONS,
        scope,
        onError: (message) => messages.push(message),
    });
    const status = sessionStartHookStatus({ ...HOOK_OPTIONS, scope });
    return renderResult({
        hooks: {
            scope,
            claude_code: status.claude.installed,
            codex: status.codex.installed,
            opencode: status.opencode.installed,
            ...(messages.length > 0 ? { warnings: messages } : {}),
        },
        help: [
            "New sessions now start with the indeed-axi dashboard as ambient context",
            "Run `indeed-axi setup status` anytime to verify",
        ],
    }, false);
}
