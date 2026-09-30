import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { htmlToText } from "../lib/htmltext.js";
export function storeDir(stateDir) {
    return join(stateDir, "store", "candidates");
}
export function packetPath(stateDir, legacyId) {
    return join(storeDir(stateDir), `${legacyId}.json`);
}
export function packetFromSummary(summary, jobTitle) {
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
export function writePacket(stateDir, packet) {
    mkdirSync(storeDir(stateDir), { recursive: true });
    writeFileSync(packetPath(stateDir, packet.legacyId), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
}
export function readPacket(stateDir, legacyId) {
    const path = packetPath(stateDir, legacyId);
    if (!existsSync(path))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed.legacyId === "string" && typeof parsed.name === "string") {
            return { scores: [], ...parsed };
        }
    }
    catch {
        // corrupt packet treated as absent
    }
    return null;
}
export function listPackets(stateDir) {
    const dir = storeDir(stateDir);
    if (!existsSync(dir))
        return [];
    const packets = [];
    for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json"))
            continue;
        const packet = readPacket(stateDir, file.replace(/\.json$/, ""));
        if (packet !== null)
            packets.push(packet);
    }
    packets.sort((a, b) => {
        const left = a.created ?? 0;
        const right = b.created ?? 0;
        return right - left;
    });
    return packets;
}
/** Compare live list rows against the store by name/milestone drift. */
export function diffAgainstStore(stateDir, rows, liveMilestones) {
    const diff = { fresh: [], changed: [], unchanged: [] };
    for (const row of rows) {
        const packet = readPacket(stateDir, row.legacyId);
        if (packet === null) {
            diff.fresh.push(row.legacyId);
        }
        else {
            const liveMilestone = liveMilestones.get(row.legacyId);
            if (packet.name !== row.name || (liveMilestone !== undefined && packet.milestone !== liveMilestone)) {
                diff.changed.push(row.legacyId);
            }
            else {
                diff.unchanged.push(row.legacyId);
            }
        }
    }
    return diff;
}
export function attachThread(packet, thread) {
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
export function attachApplication(packet, application) {
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
export function appendScore(packet, score) {
    return {
        ...packet,
        scores: [
            ...packet.scores,
            { ...score, scoredAt: score.scoredAt ?? new Date().toISOString() },
        ],
    };
}
/** The most recent score record, if any. */
export function latestScore(packet) {
    if (packet.scores.length === 0)
        return undefined;
    return [...packet.scores].sort((a, b) => (a.scoredAt < b.scoredAt ? 1 : -1))[0];
}
