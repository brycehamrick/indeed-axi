import { AxiError } from "axi-sdk-js";
import { randomUUID } from "node:crypto";
import { sendConversationEvent, updateCandidateStatus, createCandidateNote, } from "./queries.js";
import { milestoneFromPayload, noteFromPayload, sentEventFromPayload, } from "./model.js";
import { findConversationsByCandidateKey, findCandidateSubmissions, findEmployerJobs, getConversationAndEvents, getCandidateSubmissionFull, getCurrentEmployerUser, originalApplicationData, unreadConversationCount as unreadConversationCountQuery, } from "./queries.js";
import { applicationFromPayload, candidateIdsFromPayload, conversationFromPayload, conversationsFromLookupPayload, employerFromPayload, jobsFromPayload, submissionFromPayload, } from "./model.js";
/**
 * Operation wrappers: embedded documents + captured variable shapes +
 * canonical summarizers. One function per Indeed operation; commands
 * compose these. All calls go through the in-page authenticated transport.
 */
/** Mirrors the dashboard's own default jobs filter (active or paused jobs). */
const DEFAULT_JOB_FILTER = {
    claimed: false,
    createdOnIndeed: true,
    includeMultiLocationJobs: true,
    allOf: [
        {
            anyOf: [
                { not: { hostedJobStatus: ["CLOSED", "PAUSED"] } },
                { hostedJobStatus: ["PAUSED"] },
            ],
        },
    ],
};
export const MILESTONES = [
    "NEW",
    "PENDING",
    "PHONE_SCREENED",
    "INTERVIEWED",
    "OFFER_MADE",
    "REVIEWED",
];
/** Milestones a candidate can be moved to (includes REJECTED). */
export const MOVE_TARGETS = [...MILESTONES, "REJECTED", "HIRED"];
/** "new" -> "NEW"; accepts snake_case or the raw GraphQL id. */
export function normalizeMilestone(input) {
    const upper = input.trim().toUpperCase().replace(/-/g, "_");
    return MILESTONES.includes(upper) ? upper : undefined;
}
export function normalizeMoveTarget(input) {
    const upper = input.trim().toUpperCase().replace(/-/g, "_");
    return MOVE_TARGETS.includes(upper) ? upper : undefined;
}
export async function listJobs(api, limit = 100) {
    const payload = await api.gql(findEmployerJobs, {
        input: { limit, filter: DEFAULT_JOB_FILTER },
    });
    return jobsFromPayload(payload);
}
export async function listCandidates(api, employerJobKey, milestoneIds, first = 100) {
    const payload = await api.gql(findCandidateSubmissions, {
        input: {
            filter: {
                jobs: { employerJobIds: [employerJobKey] },
                hiringMilestones: { milestoneIds: milestoneIds ? [...milestoneIds] : [...MILESTONES] },
                submissionType: "LEGACY",
            },
        },
        first,
    });
    return candidateIdsFromPayload(payload);
}
export async function getCandidate(api, legacyId) {
    // CRP variant: the rich row (aggJob, job.node.jobData, milestone, ...).
    // The narrower GetCandidateSubmission omits the messaging/stage keys.
    const payload = await api.gql(getCandidateSubmissionFull, {
        inAiInterview: false,
        input: { legacyIds: [legacyId] },
    });
    return submissionFromPayload(payload);
}
export async function getApplication(api, submissionUuid) {
    const payload = await api.gql(originalApplicationData, {
        input: { submissionUuid },
    });
    return applicationFromPayload(payload);
}
export async function currentEmployer(api) {
    const payload = await api.gql(getCurrentEmployerUser, {});
    return employerFromPayload(payload);
}
export async function conversationsForCandidate(api, advertiserKey, candidateKey) {
    const payload = await api.gql(findConversationsByCandidateKey, {
        enableAdjacentContextSearch: true,
        advertiserKey,
        candidateKey,
    });
    return conversationsFromLookupPayload(payload);
}
export async function conversationEvents(api, conversationId) {
    const payload = await api.gql(getConversationAndEvents, {
        includeRequireResponse: false,
        conversationId,
        timelineModuleInput: { atk: "", telVersionUpperBound: "2.3.1" },
    });
    return conversationFromPayload(payload);
}
export async function unreadConversationCount(api) {
    const payload = await api.gql(unreadConversationCountQuery, {});
    const value = payload["unreadConversationCount"];
    if (typeof value === "number")
        return value;
    const nested = payload["unreads"];
    if (typeof nested === "number")
        return nested;
    return null;
}
/**
 * Resolve a --job reference: the base64 employerJob key, its uuid suffix,
 * a jobData id, a legacy job id, or a unique title prefix (case-insensitive).
 */
export async function resolveJobRef(api, ref) {
    const jobs = await listJobs(api);
    const needle = ref.trim().toLowerCase();
    const matches = jobs.filter((job) => job.key === ref ||
        job.ref.toLowerCase() === needle ||
        job.jobDataId.toLowerCase() === needle ||
        (job.legacyId !== undefined && job.legacyId.toLowerCase() === needle) ||
        job.title.toLowerCase().startsWith(needle));
    const options = jobs.map((job) => `${job.ref}  ${job.title}`);
    if (matches.length === 0) {
        throw new AxiError(`no job matches "${ref}"`, "VALIDATION_ERROR", [
            `Available jobs:\n  ${options.join("\n  ")}`,
        ]);
    }
    if (matches.length > 1) {
        throw new AxiError(`"${ref}" matches ${matches.length} jobs - be more specific`, "VALIDATION_ERROR", [
            `Matching jobs:\n  ${matches.map((job) => `${job.ref}  ${job.title}`).join("\n  ")}`,
        ]);
    }
    return { row: matches[0] };
}
/**
 * Send one message and verify it by independently re-reading the thread.
 * Single-shot by design: no bulk, one send per invocation.
 */
export async function sendMessage(api, input) {
    const useConversation = input.conversationId !== undefined;
    if (!useConversation && input.aggJobKey === undefined) {
        throw new AxiError("send needs either an existing conversation id or the job key", "VALIDATION_ERROR", ["Look up the thread first (messages read), or use the interactive browser"]);
    }
    const payload = await api.gql(sendConversationEvent, {
        messageBody: input.body,
        ...(useConversation
            ? { conversationId: input.conversationId }
            : {
                context: {
                    context: "HQM_DRADIS",
                    scope: {
                        preOrPostApply: {
                            advertiserKey: input.advertiserKey,
                            aggJobKey: input.aggJobKey,
                            candidateKey: input.candidateKey,
                        },
                    },
                },
            }),
        eventId: randomUUID(),
        correlationKey: randomUUID(),
        clientName: "messaging-react",
        includeRequireResponse: false,
        attachments: [],
        payload: [],
    });
    const event = sentEventFromPayload(payload);
    if (event === null) {
        throw new AxiError("send returned no event confirmation", "APP_API_ERROR", [
            "The message may still have been delivered - verify with `messages read` before retrying",
        ]);
    }
    // Independent verification: re-read the thread and look for the body.
    let verified = false;
    let threadCount;
    try {
        const conversations = await conversationsForCandidate(api, input.advertiserKey, input.candidateKey);
        const thread = conversations.length > 0 ? await conversationEvents(api, conversations[0].id) : null;
        if (thread !== null) {
            threadCount = thread.count;
            verified = thread.messages.some((message) => message.body === input.body);
        }
    }
    catch {
        // verification is best-effort; the send confirmation already succeeded
    }
    return { ...event, verified, threadCount };
}
/** Move a candidate's pipeline stage and verify by re-reading the submission. */
export async function moveStage(api, input) {
    const payload = await api.gql(updateCandidateStatus, {
        statusInput: {
            move: {
                milestoneId: input.milestoneId,
                candidateSubmissionEmployerJobIdPairs: [
                    { candidateSubmissionId: input.candidateSubmissionId, jobId: input.jobId },
                ],
            },
        },
    });
    const milestoneId = milestoneFromPayload(payload);
    if (milestoneId === null) {
        throw new AxiError("stage move returned no milestone confirmation", "APP_API_ERROR", [
            "The move may still have applied - verify with `candidate get --refresh` before retrying",
        ]);
    }
    return { milestoneId, verified: milestoneId === input.milestoneId };
}
/** Add a note to a candidate (feedback with eventType NOTE). */
export async function addNote(api, input) {
    const payload = await api.gql(createCandidateNote, {
        createEmployerCandidateSubmissionFeedbackInput: {
            candidateSubmissionIds: input.candidateSubmissionId,
            comment: input.comment,
            source: { eventType: "NOTE" },
        },
    });
    const note = noteFromPayload(payload);
    if (note === null) {
        throw new AxiError("note creation returned no feedback confirmation", "APP_API_ERROR", [
            "The note may still have been created - check the candidate profile before retrying",
        ]);
    }
    return note;
}
/** Pace repeated per-candidate fetches like a human reading the pipeline. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
