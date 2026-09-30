import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { parseFlags, requirePositional, requiredString, type FlagDefinition } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
import { snippet } from "../lib/truncate.js";
import { attachThread, readPacket, writePacket } from "../store/store.js";
import {
  conversationEvents,
  conversationsForCandidate,
  currentEmployer,
} from "../indeed/api.js";
import type { CommandContext } from "../context.js";

export const MESSAGES_HELP = `indeed-axi messages - candidate message threads

subcommands:
  messages read <legacyId> [--full]   one candidate's Indeed message thread
  messages send <legacyId> --text "..." [--confirm]
                                      send one message (preview without --confirm)
  messages unread                     live unread conversation count

flags:
  --text <text>           (send) the message body to send
  --confirm               (send) actually send - without it, prints a preview
  --full                  full message bodies (default truncates to 160 chars)
  --json                  machine-readable JSON instead of TOON

Threads are fetched live through the authenticated session. Sends are
gated: without --confirm the command resolves the candidate, shows exactly
what would be sent, and makes zero mutation calls. With --confirm it sends
one message and verifies by independently re-reading the thread. One send
per invocation - never bulk.

examples:
  indeed-axi messages read aaaaaaaa0001
  indeed-axi messages read aaaaaaaa0001 --full
  indeed-axi messages send aaaaaaaa0001 --text "Quick follow-up: ..."
  indeed-axi messages send aaaaaaaa0001 --text "..." --confirm`;

const READ_FLAGS: Record<string, FlagDefinition> = {
  full: { type: "boolean" },
  json: { type: "boolean" },
};

const SEND_FLAGS: Record<string, FlagDefinition> = {
  text: { type: "string" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

const UNREAD_FLAGS: Record<string, FlagDefinition> = {
  json: { type: "boolean" },
};

export async function messagesCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  if (sub === undefined) {
    return { help_text: MESSAGES_HELP };
  }
  if (sub === "read") return read(args.slice(1), ctx);
  if (sub === "send") return send(args.slice(1), ctx);
  if (sub === "unread") return unread(args.slice(1), ctx);
  throw new AxiError(`messages: unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
    "Implemented: `messages read`, `messages send`, `messages unread`",
    "Run `indeed-axi messages --help` for the reference",
  ]);
}

async function read(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi messages read";
  const { values, positionals } = parseFlags(args, commandPath, READ_FLAGS);
  const json = values["json"] === true;
  const legacyId = requirePositional(positionals, 0, "legacyId", commandPath);
  if (positionals.length > 1) throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");
  const full = values["full"] === true;

  const thread = await ctx.app(async (api) => {
    const employer = await currentEmployer(api);
    if (employer === null) {
      throw new AxiError("could not resolve the employer account", "APP_API_ERROR", [
        "Run `indeed-axi auth login` to refresh the session, then retry",
      ]);
    }
    const conversations = await conversationsForCandidate(api, employer.advertiserKey, legacyId);
    if (conversations.length === 0) return null;
    return conversationEvents(api, conversations[0]!.id);
  });

  // Cache the thread state into the local packet so digests can age it.
  if (thread !== null) {
    const packet = readPacket(ctx.stateDir, legacyId);
    if (packet !== null) {
      writePacket(ctx.stateDir, attachThread(packet, thread));
    }
  }

  if (thread === null) {
    return renderResult(
      {
        messages: { candidate: legacyId, threads: 0, count: 0 },
        note: "no conversation found for this candidate",
        help: [
          "Ids come from `indeed-axi candidates list` - never guess",
          "Candidates you have never messaged have no thread",
        ],
      },
      json,
    );
  }

  return renderResult(
    {
      messages: {
        candidate: legacyId,
        conversation: snippet(thread.id, 24),
        ...(thread.title !== undefined ? { title: snippet(thread.title, 80) } : {}),
        count: thread.count,
      },
      list: thread.messages.map((message) => ({
        role: message.role === "employer" ? "out" : "in",
        ...(message.sentAt !== undefined ? { at: message.sentAt } : {}),
        body: full ? message.body : snippet(message.body, 160),
      })),
      help: [
        "Rerun with --full for complete message bodies",
        "Reply drafting and gated sending arrive in Phase 2",
      ],
    },
    json,
  );
}

async function unread(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi messages unread";
  const { values, positionals } = parseFlags(args, commandPath, UNREAD_FLAGS);
  const json = values["json"] === true;
  if (positionals.length > 0) throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");

  const { unreadConversationCount } = await import("../indeed/api.js");
  const count = await ctx.app((api) => unreadConversationCount(api));
  return renderResult(
    {
      messages: { unread: count ?? "unknown" },
      help: ["Run `indeed-axi messages read <id>` for a thread"],
    },
    json,
  );
}

async function send(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "indeed-axi messages send";
  const { values, positionals } = parseFlags(args, commandPath, SEND_FLAGS);
  const json = values["json"] === true;
  const legacyId = requirePositional(positionals, 0, "legacyId", commandPath);
  if (positionals.length > 1) throw new AxiError(`${commandPath}: unexpected arguments`, "VALIDATION_ERROR");
  const body = requiredString(values, "text", commandPath);
  const confirm = values["confirm"] === true;

  const { sendMessage, currentEmployer, getCandidate } = await import("../indeed/api.js");
  const resolved = await ctx.app(async (api) => {
    const summary = await getCandidate(api, legacyId);
    if (summary === null) return null;
    const employer = await currentEmployer(api);
    if (employer === null) {
      throw new AxiError("could not resolve the employer account", "APP_API_ERROR", [
        "Run `indeed-axi auth login` to refresh the session, then retry",
      ]);
    }
    // Prefer sending into the existing thread (conversation id) - it works
    // even when the submission hides its job key.
    const conversations = await conversationsForCandidate(
      api,
      employer.advertiserKey,
      legacyId,
    );
    return {
      summary,
      advertiserKey: employer.advertiserKey,
      conversationId: conversations[0]?.id,
    };
  });
  if (resolved === null) {
    throw new AxiError(`no candidate submission found for ${legacyId}`, "NOT_FOUND", [
      "Ids come from `indeed-axi candidates list` - never guess",
    ]);
  }
  const { summary, advertiserKey, conversationId } = resolved;

  const preview = {
    send: {
      candidate: { id: summary.legacyId, name: summary.name, milestone: summary.milestone },
      ...(summary.jobTitle !== undefined ? { job: summary.jobTitle } : {}),
      chars: body.length,
      words: body.split(/\s+/).filter((word) => word.length > 0).length,
      verification: "thread re-read after send",
    },
    message: body,
  };

  if (!confirm) {
    return renderResult(
      {
        ...preview,
        help: [
          "Preview only - zero messages were sent",
          "Rerun with --confirm to send this message",
        ],
      },
      json,
    );
  }

  const result = await ctx.app((api) =>
    sendMessage(api, {
      advertiserKey,
      aggJobKey: summary.aggJobKey,
      candidateKey: summary.legacyId,
      body,
      ...(conversationId !== undefined ? { conversationId } : {}),
    }),
  );
  return renderResult(
    {
      sent: {
        candidate: { id: summary.legacyId, name: summary.name },
        event: result.eventId,
        ...(result.sentAt !== undefined ? { at: result.sentAt } : {}),
        verified: result.verified,
        ...(result.threadCount !== undefined ? { thread_messages: result.threadCount } : {}),
      },
      help: result.verified
        ? [
            "Verified by an independent thread re-read",
            "Run `indeed-axi messages read <id>` to see the thread",
          ]
        : [
            "Send succeeded but verification by re-read failed - check `messages read` before retrying",
          ],
    },
    json,
  );
}
