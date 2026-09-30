import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagesCommand } from "../src/commands/messages.js";
import { stageCommand } from "../src/commands/stage.js";
import { candidatesCommand } from "../src/commands/candidates.js";
import { addNote, moveStage, normalizeMoveTarget, sendMessage } from "../src/indeed/api.js";
import type { AppApi } from "../src/browser/appapi.js";
import type { CommandContext } from "../src/context.js";

/**
 * Gate tests: every mutation command must prove that without --confirm the
 * mutating GraphQL document is never sent (reads are fine), and that with
 * --confirm the mutation runs and is verified.
 */

interface Route {
  match: string;
  payload: Record<string, unknown>;
  mutate?: boolean;
}

interface RecordingApi extends AppApi {
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
}

function makeCtx(routes: Route[]): { ctx: CommandContext; api: RecordingApi } {
  const stateDir = mkdtempSync(join(tmpdir(), "indeed-axi-gate-test-"));
  const calls: RecordingApi["calls"] = [];
  const api = {
    calls,
    gql: async (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      for (const route of routes) {
        if (query.includes(route.match)) return route.payload;
      }
      throw new Error(`no fake route matching "${query.slice(0, 40)}"`);
    },
  } as RecordingApi;
  const ctx = {
    config: { stateDir },
    stateDir,
    env: {},
    browser: {},
    daemon: {},
    app: <T>(fn: (api: AppApi) => Promise<T>) => fn(api),
  } as unknown as CommandContext;
  return { ctx, api };
}

const submissionRoute: Route = {
  match: "CRP_CandidateSubmissions",
  payload: {
    candidateSubmissions: {
      results: [
        {
          id: "subiri",
          data: {
            legacyID: "aaaaaaaa0001",
            submissionUuid: "eeeeeeee-1111-4222-8333-444444444444",
            created: 1790690921000,
            milestone: { milestone: { milestoneId: "NEW" }, startTime: 1790690921000 },
            profile: { name: { displayName: "Alex Rivera" } },
            aggJob: {
              id: "aXJpOi8vYXBpcy5pbmRlZWQuY29tL0V4dGVybmFsSm9iUG9zdC9kZGRkZGRkZGRkZGQwMDAx",
              employerJob: {
                id: "aXJpOi8vYXBpcy5pbmRlZWQuY29tL0VtcGxveWVySm9iL2FhYTFiMmMzLTRkNWUtNGY2MC04YTdiLTEyMzQ1Njc4OWFiYw==",
              },
            },
            job: {
              node: {
                jobData: { id: "bbbbbbbbbbbbbbbbbbbb0001", title: "Executive Assistant – Media & Operations" },
              },
            },
          },
        },
      ],
    },
  },
};

const employerRoute: Route = {
  match: "GetCurrentEmployerUser",
  payload: { currentEmployerUser: { employer: { employerId: "cccccccccccccccccccccccccccc0001" } } },
};

const lookupRoute: Route = {
  match: "FindConversationsByCandidateKey",
  payload: { findConversations: { conversations: [{ id: "conv1" }] } },
};

const verifyThreadRoute: Route = {
  match: "GetConversationAndEvents",
  payload: {
    conversation: {
      id: "conv1",
      eventsConnection: {
        edges: [
          {
            node: {
              id: "newevent",
              type: "MESSAGE",
              messageBody: "planned body",
              publicationDateTime: "2026-09-30T10:00:00Z",
              author: { role: "EMPLOYER" },
            },
          },
        ],
      },
    },
  },
};

const sendMutationRoute: Route = {
  match: "mutation SendConversationEvent",
  mutate: true,
  payload: {
    sendConversationEvent: {
      conversationId: "conv1",
      event: { id: "newevent", publicationDateTime: "2026-09-30T10:00:00Z" },
    },
  },
};

const stageMutationRoute: Route = {
  match: "mutation UpdateCandidateStatus",
  mutate: true,
  payload: {
    updateCandidateSubmissionMilestone: {
      candidateSubmissionMilestone: { milestoneId: "REVIEWED" },
    },
  },
};

const noteMutationRoute: Route = {
  match: "mutation CreateEmployerCandidateSubmissionNoteFeedback",
  mutate: true,
  payload: {
    createEmployerCandidateSubmissionFeedback: {
      feedback: { id: "note1", created: "2026-09-30T10:00:00Z" },
    },
  },
};

function mutationCalls(api: RecordingApi): number {
  return api.calls.filter((call) => call.query.trimStart().startsWith("mutation")).length;
}

describe("messages send gate", () => {
  it("never sends the mutation without --confirm", async () => {
    const { ctx, api } = makeCtx([
      submissionRoute,
      employerRoute,
      { match: "FindConversationsByCandidateKey", payload: { findConversations: { conversations: [] } } },
      sendMutationRoute,
    ]);
    const result = (await messagesCommand(
      ["send", "aaaaaaaa0001", "--text", "planned body"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["send"]).toBeDefined();
    expect(result["message"]).toBe("planned body");
    expect(Array.isArray(result["help"])).toBe(true);
    expect((result["help"] as string[]).join(" ")).toContain("Preview only");
    expect(mutationCalls(api)).toBe(0);
  });

  it("sends and verifies with --confirm", async () => {
    const { ctx, api } = makeCtx([
      submissionRoute,
      employerRoute,
      sendMutationRoute,
      lookupRoute,
      verifyThreadRoute,
    ]);
    const result = (await messagesCommand(
      ["send", "aaaaaaaa0001", "--text", "planned body", "--confirm"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["sent"]).toMatchObject({ verified: true, event: "newevent" });
    expect(mutationCalls(api)).toBe(1);
  });

  it("requires --text and rejects unknown ids", async () => {
    const { ctx } = makeCtx([submissionRoute, employerRoute]);
    await expect(
      messagesCommand(["send", "aaaaaaaa0001"], ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const emptyResults: Route = {
      match: "CRP_CandidateSubmissions",
      payload: { candidateSubmissions: { results: [] } },
    };
    const empty = makeCtx([emptyResults]);
    await expect(
      messagesCommand(["send", "000000000000", "--text", "hi"], empty.ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("stage move gate", () => {
  it("never mutates without --confirm", async () => {
    const { ctx, api } = makeCtx([submissionRoute, stageMutationRoute]);
    const result = (await stageCommand(
      ["move", "aaaaaaaa0001", "--to", "reviewed"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["move"]).toMatchObject({ from: "NEW", to: "REVIEWED" });
    expect(mutationCalls(api)).toBe(0);
  });

  it("moves and verifies with --confirm", async () => {
    const { ctx, api } = makeCtx([submissionRoute, stageMutationRoute]);
    const result = (await stageCommand(
      ["move", "aaaaaaaa0001", "--to", "reviewed", "--confirm"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["moved"]).toMatchObject({ to: "REVIEWED", verified: true });
    expect(mutationCalls(api)).toBe(1);
  });

  it("is a no-op when already at the target", async () => {
    const { ctx, api } = makeCtx([submissionRoute, stageMutationRoute]);
    const result = (await stageCommand(
      ["move", "aaaaaaaa0001", "--to", "new", "--confirm"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["move"]).toMatchObject({ note: expect.stringContaining("already") });
    expect(mutationCalls(api)).toBe(0);
  });

  it("validates the target milestone", async () => {
    const { ctx } = makeCtx([submissionRoute]);
    await expect(
      stageCommand(["move", "aaaaaaaa0001", "--to", "bogus"], ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("normalizeMoveTarget includes rejected and hired", () => {
    expect(normalizeMoveTarget("rejected")).toBe("REJECTED");
    expect(normalizeMoveTarget("phone-screened")).toBe("PHONE_SCREENED");
    expect(normalizeMoveTarget("hired")).toBe("HIRED");
    expect(normalizeMoveTarget("bogus")).toBeUndefined();
  });
});

describe("candidates note gate", () => {
  it("never mutates without --confirm", async () => {
    const { ctx, api } = makeCtx([submissionRoute, noteMutationRoute]);
    const result = (await candidatesCommand(
      ["note", "aaaaaaaa0001", "--text", "AI screen 8/10"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["note"]).toMatchObject({ comment: "AI screen 8/10" });
    expect(mutationCalls(api)).toBe(0);
  });

  it("creates the note with --confirm", async () => {
    const { ctx, api } = makeCtx([submissionRoute, noteMutationRoute]);
    const result = (await candidatesCommand(
      ["note", "aaaaaaaa0001", "--text", "AI screen 8/10", "--confirm"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["noted"]).toMatchObject({ id: "note1" });
    expect(mutationCalls(api)).toBe(1);
  });
});

describe("write wrappers", () => {
  it("sendMessage uses the context scope shape and verifies via re-read", async () => {
    const { ctx } = makeCtx([
      employerRoute,
      sendMutationRoute,
      lookupRoute,
      verifyThreadRoute,
    ]);
    const result = await ctx.app((api) =>
      sendMessage(api, {
        advertiserKey: "adv",
        aggJobKey: "dddddddddddd0001",
        candidateKey: "aaaaaaaa0001",
        body: "planned body",
      }),
    );
    expect(result.verified).toBe(true);
    expect(result.eventId).toBe("newevent");
  });

  it("moveStage sends the exact id pairs", async () => {
    const { ctx, api } = makeCtx([stageMutationRoute]);
    const result = await ctx.app((api2) =>
      moveStage(api2, {
        candidateSubmissionId: "subiri",
        jobId: "bbbbbbbbbbbbbbbbbbbb0001",
        milestoneId: "REVIEWED",
      }),
    );
    expect(result).toMatchObject({ milestoneId: "REVIEWED", verified: true });
    const mutation = api.calls.find((call) => call.query.startsWith("mutation"));
    expect(mutation?.variables).toEqual({
      statusInput: {
        move: {
          milestoneId: "REVIEWED",
          candidateSubmissionEmployerJobIdPairs: [
            { candidateSubmissionId: "subiri", jobId: "bbbbbbbbbbbbbbbbbbbb0001" },
          ],
        },
      },
    });
  });

  it("addNote sends the feedback input shape", async () => {
    const { ctx, api } = makeCtx([noteMutationRoute]);
    const result = await ctx.app((api2) =>
      addNote(api2, { candidateSubmissionId: "subiri", comment: "note text" }),
    );
    expect(result.id).toBe("note1");
    const mutation = api.calls.find((call) => call.query.startsWith("mutation"));
    expect(mutation?.variables).toEqual({
      createEmployerCandidateSubmissionFeedbackInput: {
        candidateSubmissionIds: "subiri",
        comment: "note text",
        source: { eventType: "NOTE" },
      },
    });
  });
});
