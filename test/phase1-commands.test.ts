import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobsCommand } from "../src/commands/jobs.js";
import { candidatesCommand, candidateGetCommand } from "../src/commands/candidates.js";
import { messagesCommand } from "../src/commands/messages.js";
import { readPacket } from "../src/store/store.js";
import type { AppApi } from "../src/browser/appapi.js";
import type { CommandContext } from "../src/context.js";

const employerJobKey =
  "aXJpOi8vYXBpcy5pbmRlZWQuY29tL0VtcGxveWVySm9iL2FhYTFiMmMzLTRkNWUtNGY2MC04YTdiLTEyMzQ1Njc4OWFiYw==";

interface Route {
  match: string;
  payload: Record<string, unknown>;
}

function makeCtx(routes: Route[]): { ctx: CommandContext; calls: string[] } {
  const stateDir = mkdtempSync(join(tmpdir(), "indeed-axi-phase1-test-"));
  const calls: string[] = [];
  const api: AppApi = {
    gql: async (query: string) => {
      calls.push(query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "?");
      for (const route of routes) {
        if (query.includes(route.match)) return route.payload;
      }
      throw new Error(`no fake route matching "${route.label}"`);
    },
  };
  const ctx = {
    config: { stateDir },
    stateDir,
    env: {},
    browser: {},
    daemon: {},
    app: <T>(fn: (api: AppApi) => Promise<T>) => fn(api),
  } as unknown as CommandContext;
  return { ctx, calls };
}

const jobsRoute: Route = {
  match: "FindEmployerJobs",
  label: "jobs",
  payload: {
    findEmployerJobs: {
      results: [
        {
          employerJob: {
            id: employerJobKey,
            jobData: { id: "jd", title: "Executive Assistant", legacyId: "joblegacy1" },
          },
        },
      ],
    },
  },
};

const listRoute: Route = {
  match: "CandidateListIds",
  label: "list",
  payload: {
    findCandidateSubmissions: {
      candidateSubmissions: [
        { id: "s1", data: { legacyID: "aaaaaaaa0001", profile: { name: { displayName: "Alex Rivera" } } } },
      ],
    },
  },
};

const submissionRoute: Route = {
  match: "CRP_CandidateSubmissions",
  label: "submission",
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
            profile: { name: { displayName: "Alex Rivera" }, location: { displayString: "Mexico City" } },
            aggJob: { id: "aggkey", employerJob: { id: employerJobKey } },
          },
        },
      ],
    },
  },
};

describe("jobs command", () => {
  it("lists jobs with refs", async () => {
    const { ctx } = makeCtx([jobsRoute]);
    const result = (await jobsCommand(["list"], ctx)) as Record<string, unknown>;
    expect(result["jobs"]).toMatchObject({ count: 1 });
    expect(result["list"]).toEqual([{ ref: "aaa1b2c3-4d5e-4f60-8a7b-123456789abc", title: "Executive Assistant" }]);
  });
});

describe("candidates commands", () => {
  it("list requires --job and resolves the ref via a live jobs lookup", async () => {
    const { ctx, calls } = makeCtx([jobsRoute, listRoute]);
    const result = (await candidatesCommand(["list", "--job", "executive"], ctx)) as Record<string, unknown>;
    expect(result["candidates"]).toMatchObject({ count: 1 });
    const list = result["list"] as Array<{ id: string; name: string }>;
    expect(list[0]).toEqual({ id: "aaaaaaaa0001", name: "Alex Rivera" });
    expect(calls).toContain("FindEmployerJobs");
    expect(calls).toContain("CandidateListIds");
  });

  it("list rejects bad stages and missing --job", async () => {
    const { ctx } = makeCtx([jobsRoute, listRoute]);
    await expect(candidatesCommand(["list", "--job", "x", "--stage", "bogus"], ctx)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(candidatesCommand(["list"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("sync fetches fresh candidates into the store", async () => {
    const { ctx } = makeCtx([jobsRoute, listRoute, submissionRoute]);
    const result = (await candidatesCommand(["sync", "--job", "executive"], ctx)) as Record<string, unknown>;
    expect(result["sync"]).toMatchObject({
      job: "Executive Assistant",
      found: 1,
      fresh: 1,
      fetched: 1,
    });
    const packet = readPacket(ctx.stateDir, "aaaaaaaa0001");
    expect(packet?.name).toBe("Alex Rivera");
    expect(packet?.milestone).toBe("NEW");
    expect(packet?.summary.submissionUuid).toBe("eeeeeeee-1111-4222-8333-444444444444");
  });

  it("candidate get reads the store and renders application excerpt", async () => {
    const { ctx } = makeCtx([submissionRoute]);
    await candidatesCommand(["sync", "--job", "executive"], ctx).catch(() => undefined);
    // seed store directly (sync needs list routes here)
    const seeded = makeCtx([jobsRoute, listRoute, submissionRoute]);
    await candidatesCommand(["sync", "--job", "executive"], seeded.ctx);
    const result = (await candidateGetCommand(["aaaaaaaa0001"], seeded.ctx)) as Record<string, unknown>;
    expect(result["candidate"]).toMatchObject({ id: "aaaaaaaa0001", name: "Alex Rivera", milestone: "NEW" });
    expect(Array.isArray(result["help"])).toBe(true);
    void ctx;
  });

  it("candidate get --refresh goes live", async () => {
    const { ctx, calls } = makeCtx([submissionRoute]);
    const result = (await candidateGetCommand(["aaaaaaaa0001", "--refresh"], ctx)) as Record<string, unknown>;
    expect(result["candidate"]).toMatchObject({ name: "Alex Rivera" });
    expect(calls).toContain("CRP_CandidateSubmissions");
  });
});

describe("messages command", () => {
  const employerRoute: Route = {
    match: "GetCurrentEmployerUser",
    label: "employer",
    payload: { currentEmployerUser: { employer: { employerId: "cccccccccccccccccccccccccccc0001" } } },
  };
  const lookupRoute: Route = {
    match: "FindConversationsByCandidateKey",
    label: "lookup",
    payload: { findConversations: { conversations: [{ id: "conv1" }] } },
  };
  const threadRoute: Route = {
    match: "GetConversationAndEvents",
    label: "thread",
    payload: {
      conversation: {
        id: "conv1",
        eventsConnection: {
          edges: [
            {
              node: {
                id: "m1",
                type: "MESSAGE",
                messageBody: "outbound screening questions",
                publicationDateTime: "2026-09-29T10:00:00Z",
                author: { role: "EMPLOYER" },
              },
            },
            {
              node: {
                id: "m2",
                type: "MESSAGE",
                messageBody: "candidate answers here",
                publicationDateTime: "2026-09-29T11:00:00Z",
                author: { role: "JOBSEEKER" },
              },
            },
          ],
        },
      },
    },
  };

  it("read resolves the thread and renders roles in/out", async () => {
    const { ctx, calls } = makeCtx([employerRoute, lookupRoute, threadRoute]);
    const result = (await messagesCommand(["read", "aaaaaaaa0001"], ctx)) as Record<string, unknown>;
    expect(result["messages"]).toMatchObject({ count: 2 });
    const list = result["list"] as Array<{ role: string }>;
    expect(list[0]?.role).toBe("out");
    expect(list[1]?.role).toBe("in");
    expect(calls).toContain("GetConversationAndEvents");
  });

  it("read reports a definitive empty state with no thread", async () => {
    const { ctx } = makeCtx([
      employerRoute,
      {
        match: "FindConversationsByCandidateKey",
        label: "lookup-empty",
        payload: { findConversations: { conversations: [] } },
      },
    ]);
    const result = (await messagesCommand(["read", "000000000000"], ctx)) as Record<string, unknown>;
    expect(result["messages"]).toMatchObject({ threads: 0, count: 0 });
    expect(result["note"]).toContain("no conversation");
  });

  it("unread reports the live count", async () => {
    const { ctx } = makeCtx([
      { match: "UnreadConversationCount", label: "unread", payload: { unreadConversationCount: 3 } },
    ]);
    const result = (await messagesCommand(["unread"], ctx)) as Record<string, unknown>;
    expect(result["messages"]).toMatchObject({ unread: 3 });
  });
});
