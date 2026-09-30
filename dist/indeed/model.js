/**
 * Canonical summarizers over raw Indeed GraphQL payloads. Pure functions -
 * fully unit-tested against shapes captured in the 2026-09-29 discovery.
 * Raw payloads are kept (store/`--full`) with these views derived on top.
 */
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function str(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
/** Decode `<base64 iri>` keys to their short suffix (uuid/hex) for display. */
export function keySuffix(key) {
    if (key === undefined)
        return undefined;
    try {
        const decoded = Buffer.from(key, "base64").toString("utf8");
        const match = decoded.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,16})$/i);
        return match?.[1] ?? key.slice(-12);
    }
    catch {
        return key.slice(-12);
    }
}
export function jobsFromPayload(payload) {
    const findEmployerJobs = asRecord(payload["findEmployerJobs"]);
    const results = findEmployerJobs?.["results"];
    if (!Array.isArray(results))
        return [];
    const rows = [];
    for (const item of results) {
        const result = asRecord(item);
        const employerJob = asRecord(result?.["employerJob"]);
        const jobData = asRecord(employerJob?.["jobData"]);
        const key = str(employerJob?.["id"]);
        const title = str(jobData?.["title"]);
        if (key === undefined || title === undefined)
            continue;
        rows.push({
            key,
            ref: keySuffix(key) ?? key,
            title,
            jobDataId: str(jobData?.["id"]) ?? "",
            legacyId: str(jobData?.["legacyId"]),
        });
    }
    return rows;
}
export function candidateIdsFromPayload(payload) {
    const findCandidateSubmissions = asRecord(payload["findCandidateSubmissions"]);
    const submissions = findCandidateSubmissions?.["candidateSubmissions"];
    if (!Array.isArray(submissions))
        return [];
    const rows = [];
    for (const item of submissions) {
        const submission = asRecord(item);
        const data = asRecord(submission?.["data"]);
        const profile = asRecord(data?.["profile"]);
        const name = asRecord(profile?.["name"]);
        const legacyId = str(data?.["legacyID"]);
        if (legacyId === undefined)
            continue;
        rows.push({ legacyId, name: str(name?.["displayName"]) ?? "(name hidden)" });
    }
    return rows;
}
export function submissionFromPayload(payload) {
    const candidateSubmissions = asRecord(payload["candidateSubmissions"]);
    const results = candidateSubmissions?.["results"];
    if (!Array.isArray(results) || results.length === 0)
        return null;
    const first = asRecord(results[0]);
    if (first === undefined)
        return null;
    const submissionId = str(first["id"]) ?? "";
    const data = asRecord(first["data"]);
    if (data === undefined)
        return null;
    const profile = asRecord(data["profile"]);
    const name = str(asRecord(profile?.["name"])?.["displayName"]) ?? "(name hidden)";
    const legacyId = str(data["legacyID"]) ?? "";
    const milestoneWrap = asRecord(data["milestone"]);
    const milestone = str(asRecord(milestoneWrap?.["milestone"])?.["milestoneId"]) ?? "UNKNOWN";
    const milestoneSince = typeof milestoneWrap?.["startTime"] === "number"
        ? milestoneWrap["startTime"]
        : undefined;
    const created = typeof data["created"] === "number" ? data["created"] : undefined;
    const aggJob = asRecord(data["aggJob"]);
    const employerJobKey = str(asRecord(aggJob?.["employerJob"])?.["id"]);
    const aggJobKey = keySuffix(str(aggJob?.["id"]));
    const jobNodeJobData = asRecord(asRecord(asRecord(data["job"])?.["node"])?.["jobData"]);
    const jobId = str(jobNodeJobData?.["id"]);
    const jobTitle = str(jobNodeJobData?.["title"]);
    const location = str(asRecord(profile?.["location"])?.["displayString"]);
    const talent = asRecord(data["talentRepresentation"]);
    const headline = str(talent?.["headline"]);
    const sourcesRaw = data["sources"];
    const sources = Array.isArray(sourcesRaw)
        ? sourcesRaw.map((source) => str(asRecord(source)?.["name"] ?? source)).filter((s) => s !== undefined)
        : undefined;
    return {
        legacyId,
        submissionId,
        submissionUuid: str(data["submissionUuid"]),
        name,
        milestone,
        milestoneSince,
        created,
        employerJobKey,
        employerJobRef: keySuffix(employerJobKey),
        jobId,
        jobTitle,
        aggJobKey,
        location,
        headline,
        sources,
        raw: first,
    };
}
export function conversationFromPayload(payload) {
    const conversation = asRecord(payload["conversation"]);
    if (conversation === undefined)
        return null;
    const eventsConnection = asRecord(conversation["eventsConnection"]);
    const edges = eventsConnection?.["edges"];
    const messages = [];
    if (Array.isArray(edges)) {
        for (const edgeItem of edges) {
            const node = asRecord(asRecord(edgeItem)?.["node"]);
            if (node === undefined)
                continue;
            const type = str(node["type"]) ?? "";
            const body = str(node["messageBody"]);
            if (type !== "MESSAGE" || body === undefined)
                continue;
            messages.push({
                id: str(node["id"]) ?? "",
                role: (str(asRecord(node["author"])?.["role"]) ?? "").toLowerCase(),
                sentAt: str(node["publicationDateTime"]),
                body,
            });
        }
    }
    return {
        id: str(conversation["id"]) ?? "",
        title: str(conversation["title"]),
        created: str(conversation["creationDateTime"]),
        messages,
        count: messages.length,
    };
}
export function conversationsFromLookupPayload(payload) {
    const findConversations = asRecord(payload["findConversations"]);
    const conversations = findConversations?.["conversations"];
    if (!Array.isArray(conversations))
        return [];
    const refs = [];
    for (const item of conversations) {
        const conversation = asRecord(item);
        const id = str(conversation?.["id"]);
        if (id === undefined)
            continue;
        refs.push({ id, lastEventAt: str(asRecord(conversation?.["lastEvent"])?.["publicationDateTime"]) });
    }
    return refs;
}
export function applicationFromPayload(payload) {
    const application = asRecord(payload["originalApplicationData"]);
    if (application === undefined)
        return null;
    const preview = asRecord(application["applicationPreview"]);
    const postBody = asRecord(application["postBody"]);
    const attachments = application["attachments"];
    return {
        html: str(preview?.["html"]),
        fileName: str(preview?.["fileName"]),
        attachments: Array.isArray(attachments) ? attachments.length : 0,
        downloadUrl: str(postBody?.["downloadUrl"]),
    };
}
export function employerFromPayload(payload) {
    const currentEmployerUser = asRecord(payload["currentEmployerUser"]);
    const employer = asRecord(currentEmployerUser?.["employer"]);
    const advertiserKey = str(employer?.["employerId"]);
    if (advertiserKey === undefined)
        return null;
    return { advertiserKey, employerName: str(employer?.["name"]) };
}
export function sentEventFromPayload(payload) {
    const send = asRecord(payload["sendConversationEvent"]);
    if (send === undefined)
        return null;
    const event = asRecord(send["event"]);
    const eventId = str(event?.["id"]);
    if (eventId === undefined)
        return null;
    return {
        eventId,
        conversationId: str(send["conversationId"]),
        sentAt: str(event?.["publicationDateTime"]),
    };
}
export function milestoneFromPayload(payload) {
    const update = asRecord(payload["updateCandidateSubmissionMilestone"]);
    return str(asRecord(update?.["candidateSubmissionMilestone"])?.["milestoneId"]) ?? null;
}
export function noteFromPayload(payload) {
    const create = asRecord(payload["createEmployerCandidateSubmissionFeedback"]);
    // The mutation returns feedback as an ARRAY (one entry per submission id).
    const feedbackRaw = create?.["feedback"];
    const feedback = Array.isArray(feedbackRaw)
        ? asRecord(feedbackRaw[0])
        : asRecord(feedbackRaw);
    const id = str(feedback?.["id"]);
    if (id === undefined)
        return null;
    const createdRaw = feedback?.["created"];
    const created = typeof createdRaw === "number"
        ? new Date(createdRaw).toISOString()
        : str(createdRaw);
    return { id, created };
}
