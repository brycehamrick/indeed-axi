/**
 * Canonical summarizers over raw Indeed GraphQL payloads. Pure functions -
 * fully unit-tested against shapes captured in the 2026-09-29 discovery.
 * Raw payloads are kept (store/`--full`) with these views derived on top.
 */

export interface JobRow {
  /** employerJob id (base64 iri) - the key for candidate filters. */
  key: string;
  /** Short stable suffix (uuid) for display and --job references. */
  ref: string;
  title: string;
  jobDataId: string;
  legacyId?: string;
}

interface Named {
  __typename?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Decode `<base64 iri>` keys to their short suffix (uuid/hex) for display. */
export function keySuffix(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  try {
    const decoded = Buffer.from(key, "base64").toString("utf8");
    const match = decoded.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,16})$/i);
    return match?.[1] ?? key.slice(-12);
  } catch {
    return key.slice(-12);
  }
}

export function jobsFromPayload(payload: Record<string, unknown>): JobRow[] {
  const findEmployerJobs = asRecord(payload["findEmployerJobs"]);
  const results = findEmployerJobs?.["results"];
  if (!Array.isArray(results)) return [];
  const rows: JobRow[] = [];
  for (const item of results) {
    const result = asRecord(item);
    const employerJob = asRecord(result?.["employerJob"]);
    const jobData = asRecord(employerJob?.["jobData"]);
    const key = str(employerJob?.["id"]);
    const title = str(jobData?.["title"]);
    if (key === undefined || title === undefined) continue;
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

export interface CandidateListRow {
  legacyId: string;
  name: string;
}

export function candidateIdsFromPayload(payload: Record<string, unknown>): CandidateListRow[] {
  const findCandidateSubmissions = asRecord(payload["findCandidateSubmissions"]);
  const submissions = findCandidateSubmissions?.["candidateSubmissions"];
  if (!Array.isArray(submissions)) return [];
  const rows: CandidateListRow[] = [];
  for (const item of submissions) {
    const submission = asRecord(item);
    const data = asRecord(submission?.["data"]);
    const profile = asRecord(data?.["profile"]);
    const name = asRecord(profile?.["name"]);
    const legacyId = str(data?.["legacyID"]);
    if (legacyId === undefined) continue;
    rows.push({ legacyId, name: str(name?.["displayName"]) ?? "(name hidden)" });
  }
  return rows;
}

export interface CandidateSummary {
  legacyId: string;
  submissionId: string;
  submissionUuid?: string;
  name: string;
  milestone: string;
  milestoneSince?: number;
  created?: number;
  /** EmployerJob base64 key from the submission's job edge. */
  employerJobKey?: string;
  /** Short uuid reference for the employer job. */
  employerJobRef?: string;
  /** Hex jobData id (stage moves). */
  jobId?: string;
  /** Job title from the submission's job edge. */
  jobTitle?: string;
  /** ExternalJobPost hex key (messaging aggJobKey). */
  aggJobKey?: string;
  location?: string;
  headline?: string;
  sources?: string[];
  raw: Record<string, unknown>;
}

export function submissionFromPayload(payload: Record<string, unknown>): CandidateSummary | null {
  const candidateSubmissions = asRecord(payload["candidateSubmissions"]);
  const results = candidateSubmissions?.["results"];
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = asRecord(results[0]);
  if (first === undefined) return null;
  const submissionId = str(first["id"]) ?? "";
  const data = asRecord(first["data"]);
  if (data === undefined) return null;

  const profile = asRecord(data["profile"]);
  const name = str(asRecord(profile?.["name"])?.["displayName"]) ?? "(name hidden)";
  const legacyId = str(data["legacyID"]) ?? "";

  const milestoneWrap = asRecord(data["milestone"]);
  const milestone = str(asRecord(milestoneWrap?.["milestone"])?.["milestoneId"]) ?? "UNKNOWN";
  const milestoneSince = typeof milestoneWrap?.["startTime"] === "number"
    ? (milestoneWrap["startTime"] as number)
    : undefined;
  const created = typeof data["created"] === "number" ? (data["created"] as number) : undefined;

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
    ? sourcesRaw.map((source) => str(asRecord(source as Named)?.["name"] ?? source)).filter((s): s is string => s !== undefined)
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

export interface ThreadMessage {
  id: string;
  role: "employer" | "jobseeker" | string;
  sentAt?: string;
  body: string;
}

export interface ThreadSummary {
  id: string;
  title?: string;
  created?: string;
  messages: ThreadMessage[];
  count: number;
}

export function conversationFromPayload(payload: Record<string, unknown>): ThreadSummary | null {
  const conversation = asRecord(payload["conversation"]);
  if (conversation === undefined) return null;
  const eventsConnection = asRecord(conversation["eventsConnection"]);
  const edges = eventsConnection?.["edges"];
  const messages: ThreadMessage[] = [];
  if (Array.isArray(edges)) {
    for (const edgeItem of edges) {
      const node = asRecord(asRecord(edgeItem)?.["node"]);
      if (node === undefined) continue;
      const type = str(node["type"]) ?? "";
      const body = str(node["messageBody"]);
      if (type !== "MESSAGE" || body === undefined) continue;
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

export interface ConversationRef {
  id: string;
  lastEventAt?: string;
}

export function conversationsFromLookupPayload(
  payload: Record<string, unknown>,
): ConversationRef[] {
  const findConversations = asRecord(payload["findConversations"]);
  const conversations = findConversations?.["conversations"];
  if (!Array.isArray(conversations)) return [];
  const refs: ConversationRef[] = [];
  for (const item of conversations) {
    const conversation = asRecord(item);
    const id = str(conversation?.["id"]);
    if (id === undefined) continue;
    refs.push({ id, lastEventAt: str(asRecord(conversation?.["lastEvent"])?.["publicationDateTime"]) });
  }
  return refs;
}

export interface ApplicationData {
  html?: string;
  fileName?: string;
  attachments: number;
  downloadUrl?: string;
}

export function applicationFromPayload(payload: Record<string, unknown>): ApplicationData | null {
  const application = asRecord(payload["originalApplicationData"]);
  if (application === undefined) return null;
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

export interface EmployerInfo {
  advertiserKey: string;
  employerName?: string;
}

export function employerFromPayload(payload: Record<string, unknown>): EmployerInfo | null {
  const currentEmployerUser = asRecord(payload["currentEmployerUser"]);
  const employer = asRecord(currentEmployerUser?.["employer"]);
  const advertiserKey = str(employer?.["employerId"]);
  if (advertiserKey === undefined) return null;
  return { advertiserKey, employerName: str(employer?.["name"]) };
}

/* ---------------- mutation responses ---------------- */

export interface SentEvent {
  eventId: string;
  conversationId?: string;
  sentAt?: string;
}

export function sentEventFromPayload(payload: Record<string, unknown>): SentEvent | null {
  const send = asRecord(payload["sendConversationEvent"]);
  if (send === undefined) return null;
  const event = asRecord(send["event"]);
  const eventId = str(event?.["id"]);
  if (eventId === undefined) return null;
  return {
    eventId,
    conversationId: str(send["conversationId"]),
    sentAt: str(event?.["publicationDateTime"]),
  };
}

export function milestoneFromPayload(payload: Record<string, unknown>): string | null {
  const update = asRecord(payload["updateCandidateSubmissionMilestone"]);
  return str(asRecord(update?.["candidateSubmissionMilestone"])?.["milestoneId"]) ?? null;
}

export interface NoteResult {
  id: string;
  created?: string;
}

export function noteFromPayload(payload: Record<string, unknown>): NoteResult | null {
  const create = asRecord(payload["createEmployerCandidateSubmissionFeedback"]);
  // The mutation returns feedback as an ARRAY (one entry per submission id).
  const feedbackRaw = create?.["feedback"];
  const feedback = Array.isArray(feedbackRaw)
    ? asRecord(feedbackRaw[0])
    : asRecord(feedbackRaw);
  const id = str(feedback?.["id"]);
  if (id === undefined) return null;
  const createdRaw = feedback?.["created"];
  const created =
    typeof createdRaw === "number"
      ? new Date(createdRaw).toISOString()
      : str(createdRaw);
  return { id, created };
}
