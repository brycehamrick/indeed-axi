import type { CandidatePacket } from "../store/store.js";
import { latestScore } from "../store/store.js";

/**
 * Digest engine: pure classification over local packets. Zero browser, zero
 * API calls - the agent loop syncs first, then digests. Process timing
 * windows (chase/expire) come from the operator's platform-agnostic process
 * documents; defaults are 5/10 days.
 */

export const DEFAULT_CHASE_DAYS = 5;
export const DEFAULT_EXPIRE_DAYS = 10;

export interface DigestOptions {
  chaseDays?: number;
  expireDays?: number;
  now?: Date;
}

export interface DigestRow {
  id: string;
  name: string;
  milestone: string;
  job?: string;
}

export interface ScoredRow extends DigestRow {
  score: number;
  stage: string;
  rationale: string;
  scoredAt: string;
}

export interface AwaitingRow extends DigestRow {
  lastMessageAt?: string;
  ageDays: number;
  chase: boolean;
  expire: boolean;
}

export interface DigestView {
  total: number;
  scored: ScoredRow[];
  awaitingReply: AwaitingRow[];
  replied: DigestRow[];
  unscored: DigestRow[];
  noThread: DigestRow[];
  counts: {
    scored: number;
    awaiting_reply: number;
    chase_eligible: number;
    expire_eligible: number;
    replied: number;
    unscored: number;
    no_thread: number;
    by_milestone: Record<string, number>;
  };
}

export function ageInDays(fromIso: string | undefined, now: Date): number | undefined {
  if (fromIso === undefined) return undefined;
  const parsed = Date.parse(fromIso);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor((now.getTime() - parsed) / 86_400_000);
}

/** Filter packets by --job: employerJobRef exact, or job-title prefix (ci). */
export function filterByJob(
  packets: CandidatePacket[],
  jobRef: string | undefined,
): CandidatePacket[] {
  if (jobRef === undefined) return packets;
  const needle = jobRef.trim().toLowerCase();
  return packets.filter(
    (packet) =>
      packet.employerJobRef?.toLowerCase() === needle ||
      (packet.jobTitle !== undefined && packet.jobTitle.toLowerCase().startsWith(needle)),
  );
}

export function buildDigest(
  packets: CandidatePacket[],
  opts: DigestOptions = {},
): DigestView {
  const chaseDays = opts.chaseDays ?? DEFAULT_CHASE_DAYS;
  const expireDays = opts.expireDays ?? DEFAULT_EXPIRE_DAYS;
  const now = opts.now ?? new Date();

  const scored: ScoredRow[] = [];
  const awaitingReply: AwaitingRow[] = [];
  const replied: DigestRow[] = [];
  const unscored: DigestRow[] = [];
  const noThread: DigestRow[] = [];
  const byMilestone: Record<string, number> = {};

  for (const packet of packets) {
    byMilestone[packet.milestone] = (byMilestone[packet.milestone] ?? 0) + 1;
    const row: DigestRow = {
      id: packet.legacyId,
      name: packet.name,
      milestone: packet.milestone,
      ...(packet.jobTitle !== undefined ? { job: packet.jobTitle } : {}),
    };
    const score = latestScore(packet);
    if (score !== undefined) {
      scored.push({
        ...row,
        score: score.score,
        stage: score.stage,
        rationale: score.rationale,
        scoredAt: score.scoredAt,
      });
    }
    if (packet.thread === undefined) {
      noThread.push(row);
    } else if (packet.thread.lastMessageRole === "employer" && packet.thread.lastMessageAt !== undefined) {
      const ageDays = ageInDays(packet.thread.lastMessageAt, now) ?? 0;
      awaitingReply.push({
        ...row,
        lastMessageAt: packet.thread.lastMessageAt,
        ageDays,
        chase: ageDays >= chaseDays,
        expire: ageDays >= expireDays,
      });
    } else if (packet.thread.lastMessageRole === "jobseeker") {
      replied.push(row);
    }
    if (score === undefined) {
      unscored.push(row);
    }
  }

  scored.sort((a, b) => b.score - a.score || (a.scoredAt < b.scoredAt ? 1 : -1));

  return {
    total: packets.length,
    scored,
    awaitingReply,
    replied,
    unscored,
    noThread,
    counts: {
      scored: scored.length,
      awaiting_reply: awaitingReply.length,
      chase_eligible: awaitingReply.filter((row) => row.chase).length,
      expire_eligible: awaitingReply.filter((row) => row.expire).length,
      replied: replied.length,
      unscored: unscored.length,
      no_thread: noThread.length,
      by_milestone: byMilestone,
    },
  };
}
