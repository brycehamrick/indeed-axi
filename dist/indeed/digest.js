import { latestScore } from "../store/store.js";
/**
 * Digest engine: pure classification over local packets. Zero browser, zero
 * API calls - the agent loop syncs first, then digests. Process timing
 * windows (chase/expire) come from the operator's platform-agnostic process
 * documents; defaults are 5/10 days.
 */
export const DEFAULT_CHASE_DAYS = 5;
export const DEFAULT_EXPIRE_DAYS = 10;
export function ageInDays(fromIso, now) {
    if (fromIso === undefined)
        return undefined;
    const parsed = Date.parse(fromIso);
    if (Number.isNaN(parsed))
        return undefined;
    return Math.floor((now.getTime() - parsed) / 86_400_000);
}
/** Filter packets by --job: employerJobRef exact, or job-title prefix (ci). */
export function filterByJob(packets, jobRef) {
    if (jobRef === undefined)
        return packets;
    const needle = jobRef.trim().toLowerCase();
    return packets.filter((packet) => packet.employerJobRef?.toLowerCase() === needle ||
        (packet.jobTitle !== undefined && packet.jobTitle.toLowerCase().startsWith(needle)));
}
export function buildDigest(packets, opts = {}) {
    const chaseDays = opts.chaseDays ?? DEFAULT_CHASE_DAYS;
    const expireDays = opts.expireDays ?? DEFAULT_EXPIRE_DAYS;
    const now = opts.now ?? new Date();
    const scored = [];
    const awaitingReply = [];
    const replied = [];
    const unscored = [];
    const noThread = [];
    const byMilestone = {};
    for (const packet of packets) {
        byMilestone[packet.milestone] = (byMilestone[packet.milestone] ?? 0) + 1;
        const row = {
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
        }
        else if (packet.thread.lastMessageRole === "employer" && packet.thread.lastMessageAt !== undefined) {
            const ageDays = ageInDays(packet.thread.lastMessageAt, now) ?? 0;
            awaitingReply.push({
                ...row,
                lastMessageAt: packet.thread.lastMessageAt,
                ageDays,
                chase: ageDays >= chaseDays,
                expire: ageDays >= expireDays,
            });
        }
        else if (packet.thread.lastMessageRole === "jobseeker") {
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
