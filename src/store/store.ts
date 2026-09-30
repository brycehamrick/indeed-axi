import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApplicationData, CandidateSummary, ThreadSummary } from "../indeed/model.js";
import { htmlToText } from "../lib/htmltext.js";

/**
 * Local candidate store: one JSON packet per candidate under
 * `<stateDir>/store/candidates/<legacyId>.json`. User-level state, never
 * committed - resumes and threads are PII (see AGENTS.md).
 *
 * Packets are the scoring substrate: the agent reads them, AI scores get
 * recorded alongside (scores[] is reserved for the workflow layer), and
 * syncs diff against fetchedAt + milestone so re-runs are cheap.
 */

export interface ScoreRecord {
  stage: "application" | "screening" | "test";
  score: number;
  rationale: string;
  scoredAt: string;
  rubric?: string;
}

export interface ThreadCache {
  id: string;
  fetchedAt: string;
  messageCount: number;
  /** Timestamp of the most recent inbound (candidate) message. */
  lastInboundAt?: string;
  /** Timestamp of the most recent outbound (employer) message. */
  lastOutboundAt?: string;
  /** Role of whoever sent the last message - "employer" means we await a reply. */
  lastMessageRole?: "employer" | "jobseeker";
  lastMessageAt?: string;
}

export interface CandidatePacket {
  legacyId: string;
  name: string;
  milestone: string;
  created?: number;
  fetchedAt: string;
  employerJobRef?: string;
  jobTitle?: string;
  summary: {
    submissionUuid?: string;
    location?: string;
    headline?: string;
    aggJobKey?: string;
    sources?: string[];
  };
  submission: Record<string, unknown>;
  application?: ApplicationData & { fetchedAt: string; text?: string };
  thread?: ThreadCache;
  scores: ScoreRecord[];
}

export function storeDir(stateDir: string): string {
  return join(stateDir, "store", "candidates");
}

export function packetPath(stateDir: string, legacyId: string): string {
  return join(storeDir(stateDir), `${legacyId}.json`);
}

export function packetFromSummary(
  summary: CandidateSummary,
  jobTitle?: string,
): CandidatePacket {
  return {
    legacyId: summary.legacyId,
    name: summary.name,
    milestone: summary.milestone,
    created: summary.created,
    fetchedAt: new Date().toISOString(),
    employerJobRef: summary.employerJobRef,
    jobTitle,
    summary: {
      submissionUuid: summary.submissionUuid,
      location: summary.location,
      headline: summary.headline,
      aggJobKey: summary.aggJobKey,
      sources: summary.sources,
    },
    submission: summary.raw,
    scores: [],
  };
}

export function writePacket(stateDir: string, packet: CandidatePacket): void {
  mkdirSync(storeDir(stateDir), { recursive: true });
  writeFileSync(packetPath(stateDir, packet.legacyId), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
}

export function readPacket(stateDir: string, legacyId: string): CandidatePacket | null {
  const path = packetPath(stateDir, legacyId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CandidatePacket>;
    if (typeof parsed.legacyId === "string" && typeof parsed.name === "string") {
      return { scores: [], ...parsed } as CandidatePacket;
    }
  } catch {
    // corrupt packet treated as absent
  }
  return null;
}

export function listPackets(stateDir: string): CandidatePacket[] {
  const dir = storeDir(stateDir);
  if (!existsSync(dir)) return [];
  const packets: CandidatePacket[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const packet = readPacket(stateDir, file.replace(/\.json$/, ""));
    if (packet !== null) packets.push(packet);
  }
  packets.sort((a, b) => {
    const left = a.created ?? 0;
    const right = b.created ?? 0;
    return right - left;
  });
  return packets;
}

export interface SyncDiff {
  fresh: string[];
  changed: string[];
  unchanged: string[];
}

/** Compare live list rows against the store by name/milestone drift. */
export function diffAgainstStore(
  stateDir: string,
  rows: Array<{ legacyId: string; name: string }>,
  liveMilestones: Map<string, string>,
): SyncDiff {
  const diff: SyncDiff = { fresh: [], changed: [], unchanged: [] };
  for (const row of rows) {
    const packet = readPacket(stateDir, row.legacyId);
    if (packet === null) {
      diff.fresh.push(row.legacyId);
    } else {
      const liveMilestone = liveMilestones.get(row.legacyId);
      if (packet.name !== row.name || (liveMilestone !== undefined && packet.milestone !== liveMilestone)) {
        diff.changed.push(row.legacyId);
      } else {
        diff.unchanged.push(row.legacyId);
      }
    }
  }
  return diff;
}

export function attachThread(packet: CandidatePacket, thread: ThreadSummary): CandidatePacket {
  const messages = thread.messages;
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastInbound = [...messages].reverse().find((message) => message.role === "jobseeker");
  const lastOutbound = [...messages].reverse().find((message) => message.role === "employer");
  return {
    ...packet,
    thread: {
      id: thread.id,
      fetchedAt: new Date().toISOString(),
      messageCount: thread.count,
      lastInboundAt: lastInbound?.sentAt,
      lastOutboundAt: lastOutbound?.sentAt,
      ...(last !== undefined
        ? {
            lastMessageRole: last.role === "employer" ? "employer" : "jobseeker",
            lastMessageAt: last.sentAt,
          }
        : {}),
    },
  };
}

export function attachApplication(packet: CandidatePacket, application: ApplicationData): CandidatePacket {
  return {
    ...packet,
    application: {
      ...application,
      fetchedAt: new Date().toISOString(),
      ...(application.html !== undefined ? { text: htmlToText(application.html) } : {}),
    },
  };
}

/** Append a score record (the workflow layer's local write). */
export function appendScore(
  packet: CandidatePacket,
  score: Omit<ScoreRecord, "scoredAt"> & { scoredAt?: string },
): CandidatePacket {
  return {
    ...packet,
    scores: [
      ...packet.scores,
      { ...score, scoredAt: score.scoredAt ?? new Date().toISOString() } as ScoreRecord,
    ],
  };
}

/** The most recent score record, if any. */
export function latestScore(packet: CandidatePacket): ScoreRecord | undefined {
  if (packet.scores.length === 0) return undefined;
  return [...packet.scores].sort((a, b) => (a.scoredAt < b.scoredAt ? 1 : -1))[0];
}
