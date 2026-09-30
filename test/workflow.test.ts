import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDigest, filterByJob, ageInDays } from "../src/indeed/digest.js";
import { scoreCommand } from "../src/commands/score.js";
import { digestCommand } from "../src/commands/digest.js";
import { candidateGetCommand } from "../src/commands/candidates.js";
import {
  appendScore,
  attachThread,
  latestScore,
  packetFromSummary,
  readPacket,
  writePacket,
} from "../src/store/store.js";import type { CommandContext } from "../src/context.js";
import type { AppApi } from "../src/browser/appapi.js";

function packet(
  legacyId: string,
  name: string,
  overrides: Partial<Parameters<typeof packetFromSummary>[0]> & {
    jobTitle?: string;
    thread?: Parameters<typeof attachThread>[1];
    scores?: Array<{ stage: "application" | "screening" | "test"; score: number; rationale: string }>;
  } = {},
) {
  const base = packetFromSummary(
    {
      legacyId,
      submissionId: `sub-${legacyId}`,
      submissionUuid: `uuid-${legacyId}`,
      name,
      milestone: overrides.milestone ?? "NEW",
      employerJobKey: "jobkey",
      employerJobRef: "ref-a",
      raw: { id: `sub-${legacyId}`, data: { legacyID: legacyId } },
    },
    overrides.jobTitle,
  );
  let out = base;
  if (overrides.thread !== undefined) out = attachThread(out, overrides.thread);
  for (const score of overrides.scores ?? []) {
    out = appendScore(out, score);
  }
  return out;
}

describe("digest engine", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it("classifies scored, awaiting (with chase/expire), replied, unscored, no-thread", () => {
    const view = buildDigest(
      [
        packet("scored1", "Ada", {
          jobTitle: "Executive Assistant",
          scores: [{ stage: "application", score: 9, rationale: "strong systems" }],
        }),
        packet("scored2", "Bo", {
          scores: [
            { stage: "application", score: 5, rationale: "thin" },
            { stage: "screening", score: 8, rationale: "latest wins" },
          ],
        }),
        packet("chasing", "Cara", {
          thread: thread("chasing", "employer", daysAgo(6)),
        }),
        packet("expired", "Dan", {
          thread: thread("expired", "employer", daysAgo(12)),
        }),
        packet("replied", "Eve", {
          thread: thread("replied", "jobseeker", daysAgo(1)),
        }),
        packet("fresh", "Finn", {}),
      ],
      { now, chaseDays: 5, expireDays: 10 },
    );
    expect(view.total).toBe(6);
    expect(view.counts.scored).toBe(2);
    // ranking uses the latest score: Bo's screening 8 sits above Ada's 9? no -
    // ranked by score desc, Ada 9 first
    expect(view.scored[0]?.id).toBe("scored1");
    expect(view.scored[1]?.score).toBe(8);
    expect(view.counts.awaiting_reply).toBe(2);
    expect(view.counts.chase_eligible).toBe(2); // 6d and 12d both >= 5
    expect(view.counts.expire_eligible).toBe(1);
    expect(view.counts.replied).toBe(1);
    expect(view.counts.unscored).toBe(4);
    expect(view.counts.no_thread).toBe(3);
    const expiredRow = view.awaitingReply.find((row) => row.id === "expired");
    expect(expiredRow?.ageDays).toBe(12);
    expect(expiredRow?.expire).toBe(true);
  });

  it("filterByJob matches by title prefix and ref, case-insensitive", () => {
    const packets = [
      packet("a", "A", { jobTitle: "Executive Assistant – Media" }),
      packet("b", "B", { jobTitle: "Content Producer" }),
    ];
    expect(filterByJob(packets, "executive").length).toBe(1);
    expect(filterByJob(packets, "ref-a").length).toBe(2);
    expect(filterByJob(packets, undefined).length).toBe(2);
    expect(filterByJob(packets, "nope").length).toBe(0);
  });

  it("ageInDays handles missing and malformed dates", () => {
    expect(ageInDays(undefined, now)).toBeUndefined();
    expect(ageInDays("not-a-date", now)).toBeUndefined();
    expect(ageInDays("2026-09-23T12:00:00Z", now)).toBe(7);
  });
});

function thread(
  candidateId: string,
  lastRole: "employer" | "jobseeker",
  lastAt: string,
): Parameters<typeof attachThread>[1] {
  return {
    id: `conv-${candidateId}`,
    messages: [
      { id: "m1", role: "employer", sentAt: "2026-09-01T00:00:00Z", body: "questions" },
      { id: "m2", role: lastRole, sentAt: lastAt, body: "latest" },
    ],
    count: 2,
  } as Parameters<typeof attachThread>[1];
}

describe("store scores and thread cache", () => {
  it("appendScore + latestScore order by time", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "indeed-axi-score-test-"));
    let p = packet("s1", "Sam");
    p = appendScore(p, {
      stage: "application",
      score: 5,
      rationale: "first",
      scoredAt: "2026-09-28T12:00:00Z",
    });
    p = appendScore(p, {
      stage: "screening",
      score: 8,
      rationale: "second",
      scoredAt: "2026-09-30T12:00:00Z",
    });
    writePacket(stateDir, p);
    const loaded = readPacket(stateDir, "s1");
    expect(loaded?.scores.length).toBe(2);
    expect(latestScore(loaded!)?.score).toBe(8);
  });

  it("attachThread caches in/out timestamps", () => {
    const p = packet("t1", "Tia");
    const withThread = attachThread(p, thread("t1", "jobseeker", "2026-09-29T10:00:00Z"));
    expect(withThread.thread?.lastMessageRole).toBe("jobseeker");
    expect(withThread.thread?.lastInboundAt).toBe("2026-09-29T10:00:00Z");
    expect(withThread.thread?.lastOutboundAt).toBe("2026-09-01T00:00:00Z");
  });
});

describe("score command", () => {
  function makeCtx(routes: Array<{ match: string; payload: Record<string, unknown> }>) {
    const stateDir = mkdtempSync(join(tmpdir(), "indeed-axi-scorecmd-test-"));
    const calls: string[] = [];
    const api: AppApi = {
      gql: async (query: string) => {
        calls.push(query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "?");
        for (const route of routes) {
          if (query.includes(route.match)) return route.payload;
        }
        throw new Error("no route");
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
    return { ctx, calls, stateDir };
  }

  const noteRoute = {
    match: "mutation CreateEmployerCandidateSubmissionNoteFeedback",
    payload: {
      createEmployerCandidateSubmissionFeedback: {
        feedback: [{ id: "note-1", created: 1790783013187 }],
      },
    },
  };

  it("records locally with zero mutations (no gate needed)", async () => {
    const { ctx, calls } = makeCtx([noteRoute]);
    writePacket(ctx.stateDir, packet("s1", "Sam"));
    const result = (await scoreCommand(
      ["record", "s1", "--stage", "application", "--score", "8", "--rationale", "strong"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["recorded"]).toMatchObject({ stage: "application", score: 8 });
    expect(calls.filter((call) => call.startsWith("Create"))).toHaveLength(0);
  });

  it("--note without --confirm previews everything and writes nothing", async () => {
    const { ctx, calls } = makeCtx([noteRoute]);
    writePacket(ctx.stateDir, packet("s1", "Sam"));
    const result = (await scoreCommand(
      ["record", "s1", "--stage", "screening", "--score", "9", "--rationale", "clear answers", "--rubric", "ea-v1", "--note"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["note_preview"]).toContain("9/10");
    expect(result["note_preview"]).toContain("[ea-v1]");
    expect((result["help"] as string[]).join(" ")).toContain("Preview only");
    expect(calls.filter((call) => call.startsWith("Create"))).toHaveLength(0);
    // nothing recorded locally either
    expect(readPacket(ctx.stateDir, "s1")?.scores.length).toBe(0);
  });

  it("--note --confirm writes the note", async () => {
    const { ctx, calls } = makeCtx([noteRoute]);
    writePacket(ctx.stateDir, packet("s1", "Sam"));
    const result = (await scoreCommand(
      ["record", "s1", "--stage", "screening", "--score", "9", "--rationale", "clear", "--note", "--confirm"],
      ctx,
    )) as Record<string, unknown>;
    expect(result["noted"]).toBeDefined();
    expect(calls).toContain("CreateEmployerCandidateSubmissionNoteFeedback");
  });

  it("validates inputs and requires a local packet", async () => {
    const { ctx } = makeCtx([]);
    await expect(
      scoreCommand(["record", "x", "--stage", "bogus", "--score", "5", "--rationale", "r"], ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      scoreCommand(["record", "x", "--stage", "application", "--score", "11", "--rationale", "r"], ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      scoreCommand(["record", "nobody", "--stage", "application", "--score", "5", "--rationale", "r"], ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("digest command", () => {
  function makeCtx(stateDir: string): CommandContext {
    return {
      config: { stateDir },
      stateDir,
      env: {},
      browser: {},
      daemon: {},
      app: async <T>(fn: (api: AppApi) => Promise<T>) => {
        throw new Error("digest must be offline");
      },
    } as unknown as CommandContext;
  }

  it("renders offline from the store with aging flags", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "indeed-axi-digestcmd-test-"));
    const now = new Date("2026-09-30T12:00:00Z");
    writePacket(
      stateDir,
      packet("top", "Ada", {
        jobTitle: "Executive Assistant",
        scores: [{ stage: "application", score: 9, rationale: "top of the pile" }],
      }),
    );
    writePacket(
      stateDir,
      packet("chase", "Cara", {
        jobTitle: "Executive Assistant",
        thread: thread("chase", "employer", new Date(now.getTime() - 7 * 86_400_000).toISOString()),
      }),
    );
    const result = (await digestCommand(["--job", "executive"], makeCtx(stateDir))) as Record<string, unknown>;
    expect(result["digest"]).toMatchObject({ candidates: 2 });
    expect(result["top"]).toBeDefined();
    const awaiting = result["awaiting"] as Array<{ id: string; flag?: string }>;
    expect(awaiting[0]).toMatchObject({ id: "chase", flag: "CHASE" });
  });

  it("reports a definitive empty state for unknown jobs", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "indeed-axi-digestcmd-empty-"));
    const result = (await digestCommand(["--job", "nothing"], makeCtx(stateDir))) as Record<string, unknown>;
    expect(result["digest"]).toMatchObject({ candidates: 0 });
    expect(result["note"]).toContain("0 packets match");
  });
});

describe("candidate get shows scores + thread cache", () => {
  it("renders score history and thread direction", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "indeed-axi-get-score-"));
    const p = attachThread(
      packet("s1", "Sam", {
        scores: [{ stage: "application", score: 7, rationale: "solid background" }],
      }),
      thread("s1", "jobseeker", "2026-09-29T10:00:00Z"),
    );
    writePacket(stateDir, p);
    const ctx = {
      config: { stateDir },
      stateDir,
      env: {},
      browser: {},
      daemon: {},
      app: async () => {
        throw new Error("store hit should not go live");
      },
    } as unknown as CommandContext;
    const result = (await candidateGetCommand(["s1"], ctx)) as Record<string, unknown>;
    const scores = result["scores"] as Array<{ score: number; why: string }>;
    expect(scores?.[0]?.score).toBe(7);
    expect(result["thread"]).toMatchObject({ messages: 2, last_from: "candidate" });
  });
});
