import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { Page } from "playwright-core";
import {
  applicationFromPayload,
  candidateIdsFromPayload,
  conversationFromPayload,
  conversationsFromLookupPayload,
  employerFromPayload,
  jobsFromPayload,
  keySuffix,
  submissionFromPayload,
} from "../src/indeed/model.js";
import {
  getCandidate,
  listCandidates,
  listJobs,
  normalizeMilestone,
  resolveJobRef,
} from "../src/indeed/api.js";
import {
  diffAgainstStore,
  listPackets,
  packetFromSummary,
  readPacket,
  writePacket,
} from "../src/store/store.js";
import { appApiForTest, captureGraphqlHeaders, type ContextLike, type RequestLike } from "../src/browser/appapi.js";
import { getConversationAndEventsQueryFake } from "./fixtures.js";

const employerJobKey =
  "aXJpOi8vYXBpcy5pbmRlZWQuY29tL0VtcGxveWVySm9iL2FhYTFiMmMzLTRkNWUtNGY2MC04YTdiLTEyMzQ1Njc4OWFiYw==";

describe("model summarizers", () => {
  it("summarizes jobs with short refs", () => {
    const rows = jobsFromPayload({
      findEmployerJobs: {
        results: [
          {
            employerJob: {
              id: employerJobKey,
              jobData: { id: "jd1", title: "Executive Assistant", legacyId: "abc123" },
            },
          },
        ],
        estimatedTotalResultsCount: 1,
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.title).toBe("Executive Assistant");
    expect(rows[0]?.ref).toBe("aaa1b2c3-4d5e-4f60-8a7b-123456789abc");
    expect(rows[0]?.key).toBe(employerJobKey);
  });

  it("summarizes light candidate rows", () => {
    const rows = candidateIdsFromPayload({
      findCandidateSubmissions: {
        candidateSubmissions: [
          { id: "x", data: { legacyID: "aaaaaaaa0001", profile: { name: { displayName: "Alex Rivera" } } } },
          { id: "y", data: { legacyID: "aaaaaaaa0002", profile: { name: { displayName: "Jordan Solis" } } } },
        ],
      },
    });
    expect(rows).toEqual([
      { legacyId: "aaaaaaaa0001", name: "Alex Rivera" },
      { legacyId: "aaaaaaaa0002", name: "Jordan Solis" },
    ]);
  });

  it("summarizes a full submission", () => {
    const summary = submissionFromPayload({
      candidateSubmissions: {
        results: [
          {
            id: "subiri",
            data: {
              legacyID: "aaaaaaaa0001",
              submissionUuid: "eeeeeeee-1111-4222-8333-444444444444",
              created: 1790690921000,
              milestone: { milestone: { milestoneId: "NEW" }, startTime: 1790690921000 },
              profile: { name: { displayName: "Alex Rivera" }, location: { displayString: "Mexico City, CDMX" } },
              aggJob: {
                id: "aXJpOi8vYXBpcy5pbmRlZWQuY29tL0V4dGVybmFsSm9iUG9zdC9kZGRkZGRkZGRkZGQwMDAx",
                employerJob: { id: employerJobKey },
              },
            },
          },
        ],
      },
    });
    expect(summary?.name).toBe("Alex Rivera");
    expect(summary?.milestone).toBe("NEW");
    expect(summary?.employerJobRef).toBe("aaa1b2c3-4d5e-4f60-8a7b-123456789abc");
    expect(summary?.aggJobKey).toBe("dddddddddddd0001");
    expect(summary?.location).toBe("Mexico City, CDMX");
  });

  it("summarizes threads with roles", () => {
    const thread = conversationFromPayload(
      getConversationAndEventsQueryFake([
        {
          id: "m1",
          type: "MESSAGE",
          messageBody: "outbound screening questions",
          publicationDateTime: "2026-09-29T10:00:00Z",
          author: { role: "EMPLOYER" },
        },
        {
          id: "m2",
          type: "MESSAGE",
          messageBody: "candidate answers here",
          publicationDateTime: "2026-09-29T11:00:00Z",
          author: { role: "JOBSEEKER" },
        },
      ]),
    );
    expect(thread?.count).toBe(2);
    expect(thread?.messages[0]?.role).toBe("employer");
    expect(thread?.messages[1]?.role).toBe("jobseeker");
  });

  it("summarizes conversation lookups, applications, and employer", () => {
    expect(conversationsFromLookupPayload({ findConversations: { conversations: [{ id: "c1" }] } })).toEqual([
      { id: "c1", lastEventAt: undefined },
    ]);
    const application = applicationFromPayload({
      originalApplicationData: {
        applicationPreview: { html: "<p>answers</p>", fileName: "app.html" },
        attachments: [{}],
        postBody: { downloadUrl: "https://example.com/x.pdf" },
      },
    });
    expect(application?.attachments).toBe(1);
    expect(application?.html).toContain("answers");
    const employer = employerFromPayload({
      currentEmployerUser: { employer: { employerId: "cccccccccccccccccccccccccccc0001" } },
    });
    expect(employer?.advertiserKey).toBe("cccccccccccccccccccccccccccc0001");
  });

  it("keySuffix decodes uuids and hex tails", () => {
    expect(keySuffix(employerJobKey)).toBe("aaa1b2c3-4d5e-4f60-8a7b-123456789abc");
    expect(keySuffix("aXJpOi8vYXBpcy5pbmRlZWQuY29tL0V4dGVybmFsSm9iUG9zdC9kZGRkZGRkZGRkZGQwMDAx")).toBe(
      "dddddddddddd0001",
    );
  });
});

describe("normalizeMilestone", () => {
  it("accepts friendly and raw forms", () => {
    expect(normalizeMilestone("new")).toBe("NEW");
    expect(normalizeMilestone("phone-screened")).toBe("PHONE_SCREENED");
    expect(normalizeMilestone("OFFER_MADE")).toBe("OFFER_MADE");
    expect(normalizeMilestone("bogus")).toBeUndefined();
  });
});

describe("api wrappers (fake AppApi)", () => {
  it("listJobs and resolveJobRef resolve by uuid suffix", async () => {
    const secondJobKey = Buffer.from(
      "iri://apis.indeed.com/EmployerJob/11111111-2222-4333-8444-555555555555",
    ).toString("base64");
    const api = fakeApi([
      {
        match: "FindEmployerJobs",
        payload: {
          findEmployerJobs: {
            results: [
              { employerJob: { id: employerJobKey, jobData: { id: "jd", title: "Executive Assistant" } } },
              { employerJob: { id: secondJobKey, jobData: { id: "jd2", title: "Executive Assistant II" } } },
            ],
          },
        },
      },
    ]);
    const jobs = await listJobs(api);
    expect(jobs.length).toBe(2);
    const resolved = await resolveJobRef(api, "aaa1b2c3-4d5e-4f60-8a7b-123456789abc");
    expect(resolved.row.title).toBe("Executive Assistant");
  });

  it("resolveJobRef errors on ambiguity and no-match", async () => {
    const api = fakeApi([
      {
        match: "FindEmployerJobs",
        payload: {
          findEmployerJobs: {
            results: [
              { employerJob: { id: employerJobKey, jobData: { id: "jd", title: "Executive Assistant" } } },
              { employerJob: { id: employerJobKey, jobData: { id: "jd2", title: "Executive Assistant II" } } },
            ],
          },
        },
      },
    ]);
    await expect(resolveJobRef(api, "executive")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      suggestions: expect.arrayContaining([expect.stringContaining("Matching jobs")]),
    });
    await expect(resolveJobRef(api, "nothing")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      suggestions: expect.arrayContaining([expect.stringContaining("Available jobs")]),
    });
  });

  it("listCandidates sends the job filter and milestone scope", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const api = {
      gql: async (query: string, variables: Record<string, unknown>) => {
        calls.push({ query, variables });
        return { findCandidateSubmissions: { candidateSubmissions: [] } };
      },
    };
    await listCandidates(api, employerJobKey, ["NEW"], 10);
    const variables = calls[0]?.variables as {
      input: { filter: { jobs: { employerJobIds: string[] }; hiringMilestones: { milestoneIds: string[] } } };
      first: number;
    };
    expect(variables.input.filter.jobs.employerJobIds).toEqual([employerJobKey]);
    expect(variables.input.filter.hiringMilestones.milestoneIds).toEqual(["NEW"]);
    expect(variables.first).toBe(10);
  });

  it("getCandidate returns null for empty results", async () => {
    const api = fakeApi([{ match: "CRP_CandidateSubmissions", payload: { candidateSubmissions: { results: [] } } }]);
    expect(await getCandidate(api, "deadbeef0000")).toBeNull();
  });
});

describe("store", () => {
  it("round-trips packets and diffs against live rows", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "indeed-axi-store-test-"));
    const packet = packetFromSummary({
      legacyId: "aaaaaaaa0001",
      submissionId: "s1",
      name: "Alex Rivera",
      milestone: "NEW",
      employerJobKey,
      employerJobRef: "aaa1b2c3",
      raw: { id: "s1", data: { legacyID: "aaaaaaaa0001" } },
    });
    writePacket(stateDir, packet);
    expect(readPacket(stateDir, "aaaaaaaa0001")?.name).toBe("Alex Rivera");
    expect(listPackets(stateDir).length).toBe(1);

    const diff = diffAgainstStore(
      stateDir,
      [
        { legacyId: "aaaaaaaa0001", name: "Alex Rivera" },
        { legacyId: "aaaaaaaa0002", name: "Jordan" },
      ],
      new Map([["aaaaaaaa0001", "NEW"]]),
    );
    expect(diff.fresh).toEqual(["aaaaaaaa0002"]);
    expect(diff.unchanged).toEqual(["aaaaaaaa0001"]);
    expect(diff.changed).toEqual([]);
  });
});

describe("appapi", () => {
  it("captures graphql headers, drops unsafe ones", async () => {
    const context = new FakeContext();
    const page = { url: () => "https://employers.indeed.com/x", reload: async () => undefined };
    const promise = captureGraphqlHeaders(context as unknown as ContextLike, page, {
      nudgeMs: 5,
      timeoutMs: 1000,
    });
    context.emitRequest({
      url: () => "https://apis.indeed.com/graphql",
      headers: () => ({
        "content-type": "application/json",
        authorization: "Bearer xyz",
        cookie: "secret=1",
        "content-length": "42",
        "x-csrf-token": "t",
      }),
    });
    const headers = await promise;
    expect(headers["authorization"]).toBe("Bearer xyz");
    expect(headers["x-csrf-token"]).toBe("t");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["cookie"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
  });

  it("gql surfaces auth errors and graphql errors", async () => {
    const unauthorized = appApiForTest(
      fakePageWithFetch(async () => ({ status: 403, text: "denied" })),
    );
    await expect(unauthorized.gql("query X{}", {})).rejects.toMatchObject({ code: "AUTH_ERROR" });

    const graphqlError = appApiForTest(
      fakePageWithFetch(async () => ({
        status: 200,
        text: JSON.stringify({ data: null, errors: [{ message: "schema drifted" }] }),
      })),
    );
    await expect(graphqlError.gql("query X{}", {})).rejects.toMatchObject({ code: "APP_API_ERROR" });

    const ok = appApiForTest(
      fakePageWithFetch(async () => ({ status: 200, text: JSON.stringify({ data: { x: 1 } }) })),
    );
    expect(await ok.gql("query X{}", {})).toEqual({ x: 1 });
  });

  it("rejects with TIMEOUT when no graphql traffic is observed", async () => {
    const context = new FakeContext();
    const page = { url: () => "https://employers.indeed.com/x", reload: async () => undefined };
    await expect(
      captureGraphqlHeaders(context as unknown as ContextLike, page, { nudgeMs: 5, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "AUTH_ERROR" });
  });
});

/* ----------------------- helpers ----------------------- */

function fakeApi(
  routes: Array<{ match: string; payload: Record<string, unknown> }>,
): { gql: (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>> } {
  return {
    gql: async (query: string) => {
      for (const route of routes) {
        if (query.includes(route.match)) return route.payload;
      }
      throw new AxiError(`fake api: no route for query starting "${query.slice(0, 40)}"`, "APP_API_ERROR");
    },
  };
}

function fakePageWithFetch(
  respond: (req: { url: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }>,
): Page {
  return {
    evaluate: async (_fn: unknown, arg: { url: string; headers: Record<string, string>; body: string }) =>
      respond(arg),
  } as unknown as Page;
}

class FakeContext {
  private handler?: (request: RequestLike) => void;

  on(_event: "request", handler: (request: RequestLike) => void): void {
    this.handler = handler;
  }

  off(): void {
    this.handler = undefined;
  }

  emitRequest(request: RequestLike): void {
    this.handler?.(request);
  }
}
