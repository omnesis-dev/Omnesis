// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  readSessionTranscriptEvents,
  type SessionTranscriptReadParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "openclaw/plugin-sdk/routing";

import { AgentIntegrationClient, defaultIntegrationCapability } from "./client.js";
import {
  isSessionRoute,
  SESSION_ROUTE_CHANNEL,
  OpenClawCompletionRoutes,
} from "./openclaw-completion-routes.js";
import {
  hasIntegrationOAuth,
  loadOperationalIntegrationCredentials,
  subscriptionsAvailable,
  updateIntegrationCapabilities,
  type OperationalIntegrationCredentials,
} from "./credentials.js";
import { readGatewayCapabilities } from "./gateway-capabilities.js";
import { DurableIntegrationInbox, type WorkflowBinding } from "./inbox.js";
import {
  DurableTranscriptIngestor,
  type AgentConversationMessage,
  type TranscriptPage,
} from "./ingestion.js";
import {
  describeAnswerOutcome,
  integrationAnswerConversationHandle,
  firingAnswerConversationHandle,
  requestFiringAnswer,
  requestIntegrationAnswer,
  AnswerPendingError,
  ANSWER_DEADLINE_MS,
  ANSWER_SUBMIT_TIMEOUT_MS,
  type AnswerWaitOptions,
  type IntegrationAnswerRequest,
} from "./answer-wait.js";
import {
  GatewayRequestTimeoutError,
  IntegrationHttpError,
  PinnedGatewayHttpClient,
} from "./http.js";
import { NativeAnswerMcpClient, integrationOAuthFetch } from "./native-answer-mcp.js";
import { harnessClientName } from "./harness.js";
import { IntegrationOAuthProvider, SerializedIntegrationAuthProvider } from "./oauth.js";
import {
  REFRESH_KEEPALIVE_INTERVAL_MS,
  refreshKeepaliveDue,
  reissueIntegrationOAuthTokens,
} from "./oauth-keepalive.js";
import {
  agentIntegrationVersion,
  describeVersionDrift,
  INTEGRATION_SOURCE_COMMIT,
} from "./version.js";
import { createHarnessCliUpdater } from "./self-update.js";
import { silentIntegrationLogger, type IntegrationLogger } from "./logger.js";
import {
  deliveryBindings,
  type AnswerCompletionDelivery,
  type ReactionBindings,
  type SubscriptionDelivery,
  type WorkflowOutcomeReport,
  workflowOutcomeReportSchema,
  type WorkflowOutcomeStatus,
} from "./protocol.js";
import type {
  OpenClawPluginApi as OfficialOpenClawPluginApi,
  OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";

/** Wire shape deliberately kept local so the installable plugin has no private workspace dependency. */
type AnswerResponse =
  | { status: "released" | "released_with_reductions"; answer: string; [key: string]: unknown }
  | {
      status: "denied";
      reason:
        | "expired"
        | "user_denied"
        | "canceled"
        | "privacy_policy"
        | "hard_stop"
        // Returned to a run that asked for a settled outcome because nobody
        // was present to approve a hold.
        | "approval_not_available";
      [key: string]: unknown;
    }
  | { status: "approval_required"; taskId: string; [key: string]: unknown };

interface OpenClawSessionEntry {
  sessionId?: string;
  sessionFile?: string;
  spawnedBy?: string;
  lastChannel?: string;
  lastTo?: string;
  agentHarnessId?: string;
}

interface OpenClawMessage {
  role?: string;
  content?: unknown;
  timestamp?: number | string;
  idempotencyKey?: string;
}

interface OpenClawIntegrationApi {
  registrationMode: string;
  pluginConfig?: Record<string, unknown>;
  config?: unknown;
  getRuntimeConfig?(): unknown;
  logger?: IntegrationLogger;
  registerHook(
    events: string | string[],
    handler: () => void,
    options: { name: string; description?: string },
  ): void;
  registerService(service: {
    id: string;
    start(context: { stateDir: string; logger: IntegrationLogger }): Promise<void>;
    stop(context: { stateDir: string; logger: IntegrationLogger }): Promise<void>;
  }): void;
  registerTool(
    factory: (context: OpenClawPluginToolContext) => OpenClawAgentTool | null,
    options: { name: string; optional?: boolean },
  ): void;
  runtime: {
    agent: {
      session: {
        listSessionEntries(input: { agentId: string }): Iterable<{
          sessionKey: string;
          entry: OpenClawSessionEntry;
        }>;
      };
    };
    subagent: {
      run(input: {
        sessionKey: string;
        message: string;
        deliver: false;
        idempotencyKey: string;
      }): Promise<{ runId: string }>;
      /**
       * Resolves when the run identified by `runId` reaches its end, which is
       * the only completion signal OpenClaw offers a plugin: `run` resolves at
       * enqueue. Optional because an older harness build predates it, and a
       * run whose end cannot be observed is simply never reported on.
       */
      waitForRun?(input: {
        runId: string;
        timeoutMs?: number;
      }): Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
      /** Recent transcript of a session, newest last. */
      getSessionMessages?(input: {
        sessionKey: string;
        limit?: number;
      }): Promise<{ messages: unknown[] }>;
    };
    channel: {
      outbound: {
        loadAdapter(channel: string): Promise<
          | {
              sendText?(input: {
                cfg: unknown;
                to: string;
                text: string;
                accountId?: string;
                threadId?: string | number;
              }): Promise<unknown>;
            }
          | undefined
        >;
      };
    };
    tasks?: {
      managedFlows?: {
        bindSession(input: { sessionKey: string }): {
          createManaged?(input: { controllerId: string; goal: string }): { flowId: string };
        };
      };
    };
  };
}

interface OpenClawPluginToolContext {
  sessionKey?: string;
  /** Ephemeral OpenClaw session generation, supplied by the native runtime. */
  sessionId?: string;
  /** Trusted native reply route. Never accept a route in model-controlled tool input. */
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  /** Native ownership verdict retained for other OpenClaw tools. Omnesis trusts the installation. */
  senderIsOwner?: boolean;
}

export interface OpenClawConversationRoute {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
}

/**
 * Extract the runtime-owned delivery route before a model tool call returns.
 * The model never sees or supplies this data, so a completion cannot be
 * redirected by prompt injection or a forged tool argument.
 */
export function conversationRouteFromContext(
  context: OpenClawPluginToolContext,
): OpenClawConversationRoute | null {
  const route = context.deliveryContext;
  if (!route || typeof route.channel !== "string" || typeof route.to !== "string") return null;
  const channel = route.channel.trim();
  const to = route.to.trim();
  if (!channel || !to) return null;
  return {
    channel,
    to,
    ...(typeof route.accountId === "string" && route.accountId.trim()
      ? { accountId: route.accountId }
      : {}),
    ...(typeof route.threadId === "string" || typeof route.threadId === "number"
      ? { threadId: route.threadId }
      : {}),
  };
}

/** What a trusted OpenClaw session key says about the run asking the question. */
export interface OpenClawRunIdentity {
  /**
   * A scheduled run, with no human present to answer an approval prompt.
   * OpenClaw names an isolated cron run `agent:<agent>:cron:<job>:run:<run>`.
   */
  scheduled: boolean;
  /**
   * Identity of this run, for separating one ask from the next. A cron run id
   * changes on every firing, so today's run and tomorrow's are different asks
   * even when the question is word-for-word the same.
   */
  generation: string;
}

const CRON_SESSION_KEY = /:cron:.+:run:([^:]+)$/;

/**
 * How long a filed completion route can still be needed. An answer held for
 * approval is the only thing that arrives late, and it cannot outlive the
 * gateway's approval window, so a route older than this is unreachable.
 * Swept at start rather than on a timer: the routes are read only while this
 * service runs, so start is the one moment the set is guaranteed quiet.
 */
const COMPLETION_ROUTE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How long the start-time capability probe may take before the service gives
 * up and keeps the answer from its last successful start. Deliberately far
 * below the ordinary request budget: nothing about start should wait on a
 * gateway that is not there.
 */
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long one Omnesis ask may occupy a single native tool call.
 *
 * OpenClaw decides that per call: it reads a `timeoutMs` from the call's own
 * arguments, falls back to a per-tool config lookup covering only its own media
 * and message tools, and otherwise allows 90 seconds, capped at ten minutes.
 * An Omnesis answer routinely needs two to four minutes, so a call left on the
 * default is cut off mid-answer and the model is told the tool failed.
 *
 * The tool therefore asks the model to grant the longer window, and sizes its
 * own wait to whatever was actually granted, leaving a margin so it returns
 * under its own control rather than being killed. A model that omits the grant
 * still works: the wait shrinks to fit the default, the call reports that the
 * answer is still being prepared, and asking again resumes it.
 */
const OPENCLAW_DEFAULT_TOOL_TIMEOUT_MS = 90_000;
/** OpenClaw's ceiling on a granted tool timeout. */
const OPENCLAW_MAX_TOOL_TIMEOUT_MS = 600_000;
/** Returned this far ahead of the deadline, so the call ends on our terms. */
const OPENCLAW_TOOL_TIMEOUT_MARGIN_MS = 15_000;

/**
 * How long to keep watching a woken run for its end.
 *
 * Comfortably longer than a workflow that asks Omnesis several questions, each
 * of which can take minutes. A run that outlives this is not reported on at
 * all: it may still be working, and a status invented here would be a claim
 * about work nobody watched finish.
 */
const RUN_OUTCOME_WAIT_MS = 30 * 60 * 1000;
/**
 * How long shutdown waits for outcome watchers before leaving them behind.
 *
 * Long enough for a watcher whose run has already ended to finish posting its
 * report, and short enough to sit well inside the host's own service-stop
 * budget. The wait has to be bounded by something other than the watch itself:
 * a watcher parked in the harness's half-hour run wait would otherwise hold
 * shutdown open for half an hour. Leaving one behind is safe — it sees the
 * shutdown signal when it wakes and touches nothing.
 */
const OUTCOME_WATCHER_DRAIN_MS = 5_000;
/** How far back to look for the run's closing words. */
const RUN_OUTCOME_TRANSCRIPT_LIMIT = 20;
/** Ceiling the gateway puts on a workflow report. */
const MAX_OUTCOME_REPORT = 8_192;

/**
 * How many times a run's account of itself is posted before it is given up on.
 *
 * A report that never lands is worse than a late one: a firing with no report
 * reads as a workflow that did nothing, so a dropped post becomes a wrong
 * answer about what happened rather than an obviously missing one. Bounded
 * because the watcher holding the report is not a queue — nothing re-reads the
 * authority once this process is gone — so retrying forever would only park a
 * watcher on a gateway that is not coming back.
 */
const OUTCOME_REPORT_ATTEMPTS = 4;
/** Wait before the second post; each further attempt waits five times longer. */
const OUTCOME_REPORT_RETRY_MS = 1_000;

/**
 * Whether posting this report again could land where the last one did not.
 *
 * A gateway that answered at all has read the report and decided: it does not
 * know the firing, no longer honours the authority, will not accept the body.
 * Repeating that request produces the same decision every time. Only a request
 * that never got an answer, or one the gateway itself could not serve, is
 * worth sending again.
 */
function retryableOutcomeReport(error: unknown): boolean {
  if (!(error instanceof IntegrationHttpError)) return true;
  return error.status >= 500 || error.status === 429;
}

/** The window this call may use, from what the host was asked to grant it. */
export function openClawAnswerBudget(raw: Record<string, unknown>): AnswerWaitOptions {
  const asMs = (value: unknown, scale: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value * scale : 0;
  // The host reads either form, so a model reaching for seconds is honoured
  // rather than refused by the schema.
  const requested = asMs(raw.timeoutMs, 1) || asMs(raw.timeoutSeconds, 1_000);
  const granted = Math.min(
    requested > 0 ? requested : OPENCLAW_DEFAULT_TOOL_TIMEOUT_MS,
    OPENCLAW_MAX_TOOL_TIMEOUT_MS,
  );
  // Always strictly inside the grant. A fixed margin cannot be subtracted from
  // a grant smaller than itself, so a short grant yields a proportional share
  // instead: waiting past the grant is exactly what gets a call killed
  // mid-answer and reported to the model as a failed tool.
  const usable = Math.min(
    Math.max(granted - OPENCLAW_TOOL_TIMEOUT_MARGIN_MS, Math.floor(granted / 2)),
    ANSWER_DEADLINE_MS,
  );
  return {
    // Keep the submit-then-poll ladder. One request held open for the whole
    // window would never reach a poll, so a mid-window blip would settle the
    // ask instead of being retried.
    submitTimeoutMs: Math.min(usable, ANSWER_SUBMIT_TIMEOUT_MS),
    deadlineMs: usable,
  };
}

/**
 * Read the run identity out of the runtime-owned session key. The key is
 * supplied by OpenClaw, never by model-controlled tool input, so neither the
 * scheduled verdict nor the generation can be forged from a prompt.
 */
export function openClawRunIdentity(context: OpenClawPluginToolContext): OpenClawRunIdentity {
  const sessionKey = context.sessionKey ?? "";
  // The whole key is the generation, not just the captured run id: it carries
  // the job as well, so two jobs that happen to share a run id stay distinct.
  if (CRON_SESSION_KEY.test(sessionKey)) return { scheduled: true, generation: sessionKey };
  return { scheduled: false, generation: context.sessionId ?? sessionKey };
}

/** Send a terminal privacy outcome directly to its captured native conversation. */
export interface OpenClawCompletionDeliveryApi {
  config?: unknown;
  getRuntimeConfig?(): unknown;
  runtime: OpenClawIntegrationApi["runtime"];
}

/**
 * What a resumed run is told when an answer it asked for is finally released.
 *
 * Says plainly that this is the answer to the earlier ask, because the run has
 * no memory of asking: it ended when the gateway said the answer was held, and
 * this is a fresh turn in the same session. Without that framing the model
 * reads an unexplained answer as a new instruction.
 */
export function answerCompletionContinuation(response: AnswerResponse): string {
  return (
    "The Omnesis answer you asked for earlier was held for the user's approval, " +
    "and they have now approved it. This is that answer — it is the reply to " +
    "your earlier question, not a new request:\n\n" +
    formatAnswerCompletion(response)
  );
}

export async function sendAnswerCompletion(
  api: OpenClawCompletionDeliveryApi,
  route: OpenClawConversationRoute,
  response: AnswerResponse,
): Promise<void> {
  const adapter = await api.runtime.channel.outbound.loadAdapter(route.channel);
  if (!adapter?.sendText) {
    throw new Error(`OpenClaw outbound adapter is unavailable for ${route.channel}`);
  }
  const config = api.getRuntimeConfig?.() ?? api.config;
  if (!config) throw new Error("OpenClaw runtime config is unavailable for completion delivery");
  await adapter.sendText({
    cfg: config,
    to: route.to,
    text: formatAnswerCompletion(response),
    ...(route.accountId ? { accountId: route.accountId } : {}),
    ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
  });
}

function formatAnswerCompletion(response: AnswerResponse): string {
  switch (response.status) {
    case "released":
    case "released_with_reductions":
      return response.answer;
    case "denied":
      return response.reason === "expired"
        ? "The Omnesis approval expired before an answer could be released."
        : response.reason === "user_denied"
          ? "The Omnesis approval was declined, so no answer was released."
          : response.reason === "canceled"
            ? "The Omnesis request was cancelled before an answer could be released."
            : "Omnesis kept that answer private, so no answer was released.";
    case "approval_required":
      throw new Error("cannot deliver a non-terminal Omnesis answer completion");
  }
}

interface OpenClawToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

interface OpenClawAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenClawToolResult>;
}

interface CursorEntry {
  era: string;
  occurredAt: number;
  boundaryFingerprints: string[];
  /** Number of official runtime transcript events consumed for this session generation. */
  eventCount?: number;
  /** Hash of the official runtime event prefix; detects compaction/reset under the same ID. */
  prefixHash?: string;
}

type CursorMap = Record<string, CursorEntry>;

interface OpenClawServiceSlot {
  current: OpenClawIntegrationService | null;
}

const openClawServiceSlot: OpenClawServiceSlot = { current: null };

function parseCursor(raw: string | null): CursorMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const cursor: CursorMap = {};
    for (const [sessionKey, candidate] of Object.entries(parsed)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const value = candidate as Record<string, unknown>;
      if (
        typeof value.era !== "string" ||
        typeof value.occurredAt !== "number" ||
        !Number.isFinite(value.occurredAt) ||
        !Array.isArray(value.boundaryFingerprints) ||
        !value.boundaryFingerprints.every((item) => typeof item === "string")
      ) {
        continue;
      }
      cursor[sessionKey] = {
        era: value.era,
        occurredAt: value.occurredAt,
        boundaryFingerprints: value.boundaryFingerprints,
        ...(typeof value.eventCount === "number" &&
        Number.isSafeInteger(value.eventCount) &&
        value.eventCount >= 0
          ? { eventCount: value.eventCount }
          : {}),
        ...(typeof value.prefixHash === "string" && /^[a-f0-9]{64}$/.test(value.prefixHash)
          ? { prefixHash: value.prefixHash }
          : {}),
      };
    }
    return cursor;
  } catch {
    return {};
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = block as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Whether the gateway is holding this answer for the user to approve. */
function isHeldForApproval(answer: unknown): boolean {
  return (
    typeof answer === "object" &&
    answer !== null &&
    (answer as { status?: unknown }).status === "approval_required"
  );
}

export function isConversationSession(sessionKey: string, entry: OpenClawSessionEntry): boolean {
  if (entry.spawnedBy || isCronSessionKey(sessionKey) || isSubagentSessionKey(sessionKey)) {
    return false;
  }
  const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
  const parsed = parseAgentSessionKey(baseSessionKey ?? sessionKey);
  if (!parsed) return false;
  if (parsed.rest === "main") return true;

  const rest = parsed.rest.split(":").filter(Boolean);
  if (rest[0] === "run") return false;
  const peerKindIndex = rest.findIndex((part) =>
    ["direct", "dm", "group", "channel"].includes(part),
  );
  return peerKindIndex >= 0 && peerKindIndex < rest.length - 1;
}

export function identityFromSession(
  sessionKey: string,
  entry: OpenClawSessionEntry,
): { channel: string; chatId: string } {
  const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
  const parsed = parseAgentSessionKey(baseSessionKey ?? sessionKey);
  if (!parsed || parsed.rest === "main") {
    return { channel: "local", chatId: "main" };
  }

  const rest = parsed.rest.split(":").filter(Boolean);
  const peerKindIndex = rest.findIndex((part) =>
    ["direct", "dm", "group", "channel"].includes(part),
  );
  const embeddedChannel = peerKindIndex > 0 ? rest[0] : undefined;
  const channel = (entry.lastChannel || embeddedChannel || "local").toLowerCase();
  return {
    channel: channel === "main" ? "local" : channel,
    chatId: (entry.lastTo || rest.slice(peerKindIndex + 1).join(":")).toLowerCase(),
  };
}

function occurredAtOf(message: OpenClawMessage): number | null {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  if (typeof message.timestamp === "string") {
    const parsed = Date.parse(message.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function messageFingerprint(
  role: "user" | "assistant",
  text: string,
  occurredAt: number,
  idempotencyKey: string | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify([role, text, occurredAt, idempotencyKey ?? null]))
    .digest("hex");
}

function messageId(sessionKey: string, era: string, fingerprint: string): string {
  return `openclaw:${createHash("sha256")
    .update(JSON.stringify([sessionKey, era, fingerprint]))
    .digest("hex")}`;
}

function transcriptPrefixHash(events: unknown[], count = events.length): string {
  return createHash("sha256")
    .update(JSON.stringify(events.slice(0, count)))
    .digest("hex");
}

function transcriptMessageOf(event: unknown): OpenClawMessage | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as {
    id?: unknown;
    type?: unknown;
    timestamp?: unknown;
    message?: unknown;
  };
  if (
    record.type !== "message" ||
    !record.message ||
    typeof record.message !== "object" ||
    Array.isArray(record.message)
  ) {
    return null;
  }
  const message = record.message as OpenClawMessage;
  const recordTimestamp =
    typeof record.timestamp === "string" || typeof record.timestamp === "number"
      ? record.timestamp
      : undefined;
  return {
    ...message,
    timestamp: message.timestamp ?? recordTimestamp,
    idempotencyKey:
      message.idempotencyKey ??
      (typeof record.id === "string" ? `transcript:${record.id}` : undefined),
  };
}

function stableSessionKey(workflowHandle: string): string {
  return `agent:main:subagent:omnesis-${workflowHandle}`;
}

/**
 * The author's referents, laid out so the instruction's nouns resolve.
 *
 * An instruction is prose written by someone who knew which conversation,
 * address or record they meant. Without these the woken run has to guess, and
 * a guess either lands somewhere wrong or the work is done and dropped.
 */
function bindingsSection(bindings: ReactionBindings): string[] {
  const entries = Object.entries(bindings);
  if (entries.length === 0) return [];
  return [
    "",
    "The instruction above refers to these resources. They are the real ones — use them",
    "exactly as given rather than searching for or inventing your own:",
    ...entries.map(([key, value]) => `- ${key}: ${value}`),
  ];
}

/** The whole of what a woken run is told. */
export function backgroundPrompt(delivery: SubscriptionDelivery): string {
  return [
    `Omnesis workflow ${delivery.workflowHandle} received firing ${delivery.firingId}.`,
    "",
    "Follow this exact subscriber-authored reaction instruction:",
    delivery.reaction.instruction,
    ...bindingsSection(deliveryBindings(delivery)),
    "",
    "The wake intentionally contains no private corpus detail. Ask Omnesis what caused the",
    "firing with the omnesis_subscription_answer tool. The scoped credential is private",
    "to that tool and must never appear in a prompt, transcript, tool input, or output.",
    "For a catalog-backed SQL watch, Answer only confirms that the approved condition",
    "became true; it never returns query rows or computed values.",
    "This is a dedicated background session. Do not send output to any unrelated human chat.",
    "Notify the user only when and how the reaction instruction calls for it.",
    "",
    "Nobody is reading this session. Every effect the instruction asks for — a message, an",
    "email, a filed record — happens only if you make the tool call that causes it. When you",
    "end your turn with text, that text is not delivered to anyone: it is reported to Omnesis",
    "as this run's account of what you did. Write it as that account, and never as the",
    "notification itself.",
  ].join("\n");
}

const subscriptionAnswerParameters = {
  type: "object",
  properties: {
    firingId: {
      type: "string",
      description: "Opaque firing identifier from the Omnesis wake.",
    },
    question: {
      type: "string",
      minLength: 1,
      maxLength: 16_384,
      description: "Question to ask within this firing's privacy-reviewed scope.",
    },
    timeoutMs: {
      type: "number",
      description:
        "Always pass 600000. An Omnesis answer takes minutes, and this grants the call the " +
        "time it needs; without it the call is cut short and you have to ask all over again.",
    },
    timeoutSeconds: {
      type: "number",
      description: "Alternative to timeoutMs, in seconds. Pass 600 if you use this instead.",
    },
  },
  required: ["firingId", "question"],
  additionalProperties: false,
} as const;

/**
 * The referents a caller supplied, or none.
 *
 * Validated here as well as by the gateway so a malformed map is refused with
 * something the model can act on, rather than as a schema error about a
 * request it has already forgotten the shape of. Control characters are
 * rejected because a binding is rendered into a woken run's prompt as a
 * referent to trust, and a newline in one could forge a line of its own.
 */
export function readBindings(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("bindings must be an object of key/value strings");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (entries.length > 32) throw new Error("at most 32 bindings");
  const clean: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string") throw new Error(`binding "${key}" must be a string`);
    if (key.length < 1 || key.length > 64 || value.length < 1 || value.length > 512) {
      throw new Error(`binding "${key}" is outside the permitted length`);
    }
    if (/\p{Cc}/u.test(key) || /\p{Cc}/u.test(value)) {
      throw new Error(`binding "${key}" must not contain control characters`);
    }
    clean[key] = value;
  }
  return clean;
}

const subscriptionManagementParameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "get", "update", "revoke"],
    },
    id: { type: "string", minLength: 1, maxLength: 256 },
    condition: { type: "string", minLength: 1, maxLength: 4_000 },
    reaction: { type: "string", minLength: 1, maxLength: 8_000 },
    bindings: {
      type: "object",
      description:
        "What the reaction's words point at, as key/value pairs — the conversation to post in, " +
        "the address to write to, the record to update. Omnesis never interprets them: a key " +
        "means whatever the reaction says it means, and both are carried to the run verbatim. " +
        "Set them when the reaction names something a woken run could not otherwise resolve. " +
        "Creation only, since they are part of what the user approves.",
      additionalProperties: { type: "string", minLength: 1, maxLength: 512 },
      maxProperties: 32,
    },
    idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
    workflowId: { type: "string", minLength: 1, maxLength: 200 },
    expiresAt: {
      anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
    },
    status: { type: "string", enum: ["active", "paused"] },
    expectedRevision: {
      type: "integer",
      minimum: 1,
      description: "Current revision returned by list or get; required for update.",
    },
  },
  required: ["action"],
  allOf: [
    {
      if: { properties: { action: { const: "update" } }, required: ["action"] },
      then: {
        required: ["expectedRevision"],
        not: {
          anyOf: [
            { required: ["status", "condition"] },
            { required: ["status", "reaction"] },
            { required: ["status", "expiresAt"] },
          ],
        },
      },
    },
  ],
  additionalProperties: false,
} as const;

/**
 * The workflow Omnesis minted for a scheduled run, so later asks in that run
 * join it.
 *
 * A workflow is one bounded external job, and cumulative disclosure — the
 * protection against many individually harmless questions reconstructing a
 * protected fact — accumulates against it. Asks that each mint a fresh
 * workflow never accumulate, so the identifier has to be carried forward.
 *
 * It is carried here rather than asked of the model. A workflow id is minted
 * by Omnesis and means nothing outside it; a model can only echo one it was
 * given, and the identifiers it does hold — the cron job it runs as, its own
 * session — belong to the harness. A wrong one names something that does not
 * exist, which the gateway rejects as not-found on every attempt alike.
 *
 * Only a scheduled run carries one. Its bounds are unambiguous — one firing,
 * minutes long — whereas a conversation lasts as long as someone keeps
 * talking, so a workflow pinned to it would accumulate for days and then
 * outlive the gateway's workflow expiry. And only the workflow is carried,
 * never the answer conversation: a conversation admits one active task, so
 * reusing one still holding an approval would refuse every later ask until a
 * human resolved it. A supplied workflow with no conversation mints a fresh
 * conversation under the same workflow, which is exactly what is wanted.
 */
interface RunAnswerThread {
  /** Minted by the run's first answer, and reused for the rest of it. */
  workflowId?: string;
  /**
   * The workflow each question was first submitted under. The request id is
   * derived from what is sent, so a repeat of one question has to be sent
   * exactly as it was first sent or it becomes a different ask and buys a
   * second agent turn — the one thing repeating must never do.
   */
  asks: Map<string, string | undefined>;
}

/** Bounds the map in a long-lived plugin process; a firing is never revisited. */
const MAX_TRACKED_RUNS = 256;

/** Rounds of "still being prepared" before an ask is reported as out of time. */
const MAX_PENDING_ROUNDS = 3;

/**
 * A rejection that names something the gateway will not accept again — a
 * workflow it cannot find, one that has expired or closed, an answer
 * conversation already busy. Retrying such an ask unchanged fails the same
 * way every time; retrying it without the carried workflow can succeed.
 */
function settledRejection(error: unknown): boolean {
  if (!(error instanceof IntegrationHttpError)) return false;
  if (error.status === 404) return true;
  return error.status === 409 && error.code !== "ANSWER_IN_PROGRESS";
}

const ordinaryAnswerParameters = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 1, maxLength: 10_000 },
    timeoutMs: {
      type: "number",
      description:
        "Always pass 600000. An Omnesis answer takes minutes, and this grants the call the " +
        "time it needs; without it the call is cut short and you have to ask all over again.",
    },
    timeoutSeconds: {
      type: "number",
      description: "Alternative to timeoutMs, in seconds. Pass 600 if you use this instead.",
    },
  },
  required: ["question"],
  additionalProperties: false,
} as const;

export class OpenClawTranscriptSource {
  constructor(
    private readonly api: OpenClawIntegrationApi,
    private readonly readTranscriptEvents: (
      params: SessionTranscriptReadParams,
    ) => Promise<unknown[]> = readSessionTranscriptEvents,
  ) {}

  async readPage(cursor: string | null, _signal: AbortSignal): Promise<TranscriptPage> {
    const before = parseCursor(cursor);
    const after: CursorMap = {};
    const messages: AgentConversationMessage[] = [];
    const entries = this.api.runtime.agent.session.listSessionEntries({ agentId: "main" });
    for (const { sessionKey, entry } of entries) {
      if (!isConversationSession(sessionKey, entry)) continue;
      const previous = before[sessionKey];
      const era = entry.sessionId;
      if (!era) {
        this.api.logger?.warn(`Skipping OpenClaw transcript without a sessionId: ${sessionKey}`);
        if (previous) after[sessionKey] = previous;
        continue;
      }
      let events: unknown[];
      try {
        events = await this.readTranscriptEvents({
          agentId: "main",
          sessionKey,
          sessionId: era,
        });
      } catch (error) {
        this.api.logger?.warn(
          `Could not read OpenClaw transcript ${sessionKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (previous) after[sessionKey] = previous;
        continue;
      }
      const candidateCount = previous?.era === era ? previous.eventCount : undefined;
      const prefixStillMatches =
        candidateCount !== undefined &&
        candidateCount <= events.length &&
        previous?.prefixHash !== undefined &&
        transcriptPrefixHash(events, candidateCount) === previous.prefixHash;
      // The runtime can compact or reset a transcript without changing the
      // public session identity. Replay that replacement from its beginning.
      // Stable record IDs make the gateway upsert idempotent.
      const rewritten = candidateCount !== undefined && !prefixStillMatches;
      const sameGeneration = previous?.era === era && !rewritten;
      const since = sameGeneration ? previous.occurredAt : 0;
      const seenAtBoundary = sameGeneration
        ? new Set(previous.boundaryFingerprints)
        : new Set<string>();
      const startAt = prefixStillMatches ? candidateCount : 0;
      let maximumOccurredAt = since;
      let fingerprintsAtMaximum = sameGeneration
        ? new Set(previous.boundaryFingerprints)
        : new Set<string>();
      const identity = identityFromSession(sessionKey, entry);
      for (const event of events.slice(startAt)) {
        const message = transcriptMessageOf(event);
        if (!message) continue;
        const role =
          message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : null;
        const text = messageText(message.content);
        const occurredAt = occurredAtOf(message);
        if (!role || !text || occurredAt === null) continue;
        const fingerprint = messageFingerprint(role, text, occurredAt, message.idempotencyKey);
        if (occurredAt > maximumOccurredAt) {
          maximumOccurredAt = occurredAt;
          fingerprintsAtMaximum = new Set([fingerprint]);
        } else if (occurredAt === maximumOccurredAt) {
          fingerprintsAtMaximum.add(fingerprint);
        }
        if (occurredAt < since || (occurredAt === since && seenAtBoundary.has(fingerprint))) {
          continue;
        }
        messages.push({
          id: messageId(sessionKey, era, fingerprint),
          harness: "openclaw",
          channel: identity.channel,
          chatId: identity.chatId,
          role,
          text,
          occurredAt,
        });
      }
      after[sessionKey] = {
        era,
        occurredAt: maximumOccurredAt,
        boundaryFingerprints: [...fingerprintsAtMaximum].sort(),
        eventCount: events.length,
        prefixHash: transcriptPrefixHash(events),
      };
    }
    messages.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
    return { messages, nextCursor: JSON.stringify(after), hasMore: false };
  }
}

class OpenClawIntegrationService {
  private inbox: DurableIntegrationInbox | null = null;
  private delivery: AgentIntegrationClient | null = null;
  private ingestion: DurableTranscriptIngestor | null = null;
  private credentials: OperationalIntegrationCredentials | null = null;
  private credentialsPath: string | null = null;
  private answerMcp: NativeAnswerMcpClient | null = null;
  private completionRoutes: OpenClawCompletionRoutes | null = null;
  /** How many times one ask has come back still being prepared. */
  private readonly pendingAsks = new Map<string, number>();
  /** The stable request id for a conversational ask that is still running. */
  private readonly pendingAskIds = new Map<string, string>();
  /** Workflow and answer conversation Omnesis minted, per run. */
  private readonly runThreads = new Map<string, RunAnswerThread>();
  /** Watchers waiting for a woken run to end so its outcome can be reported. */
  private readonly outcomeWatchers = new Set<Promise<void>>();
  /** Aborted by `stop`, so no watcher acts on a run after the service is gone. */
  private shutdown = new AbortController();
  private logger: IntegrationLogger = silentIntegrationLogger;
  /**
   * Whether this gateway offers Watch management at all. Optimistic until the
   * service has actually spoken to a gateway, so an installation whose
   * gateway is momentarily unreachable keeps the surface it was installed
   * with rather than silently losing a tool.
   */
  private subscriptionsEnabled = true;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Held so shutdown never races a half-written credential file. */
  private keepaliveInFlight: Promise<void> | null = null;

  constructor(
    private readonly api: OpenClawIntegrationApi,
    private readonly slot: OpenClawServiceSlot,
  ) {}

  nudge(): void {
    this.ingestion?.nudge();
  }

  toolForContext(context: OpenClawPluginToolContext): OpenClawAgentTool | null {
    const sessionKey = context.sessionKey;
    if (!sessionKey?.startsWith("agent:main:subagent:omnesis-")) return null;
    // Only a Watch firing ever opens one of those sessions, so on a gateway
    // without Watches this tool has nothing to be asked about.
    if (!this.subscriptionsEnabled) return null;
    return {
      name: "omnesis_subscription_answer",
      label: "Omnesis Subscription Answer",
      description:
        "Ask Omnesis a question scoped to the current subscription firing. " +
        "The private firing credential is resolved from the trusted session context. " +
        "Preparing an answer takes minutes, so ALWAYS pass timeoutMs 600000 — that grants " +
        "this call the time it needs and it finishes in one go. If a call still comes back " +
        "saying the answer is being prepared, that is not a failure and not something to " +
        "tell the user: call again immediately with the identical question, which attaches " +
        "to the answer already being prepared rather than starting new work.",
      parameters: subscriptionAnswerParameters,
      execute: async (_toolCallId, raw, signal) => {
        const active = this.slot.current;
        if (!active) throw new Error("integration service is not running");
        return active.answerForSession(sessionKey, raw, signal);
      },
    };
  }

  ordinaryAnswerToolForContext(context: OpenClawPluginToolContext): OpenClawAgentTool | null {
    // Asking needs a trusted session and nothing else. A reply route is what
    // lets a *later* result be delivered back, so it decides whether an
    // approval addendum is possible — never whether a question may be asked.
    // Requiring it here would hide the tool from any scheduled run that
    // messages nowhere, or somewhere other than its origin, and send the model
    // to an unsupervised shell/CLI path instead.
    if (!context.sessionKey) return null;
    const route = conversationRouteFromContext(context);
    return {
      name: "omnesis_answer",
      label: "Omnesis Answer",
      description:
        "Use this first for questions about the user's personal calendar or meeting links, " +
        "email, messages, contacts, files, notes, tasks, or other data stored in Omnesis. " +
        "Omnesis cannot browse or search the live internet: it answers only from the user's " +
        "already-captured corpus, fixed at capture time, so combine its answer with your own " +
        "search or browse tools when the question also needs current outside-world facts. " +
        "Do not try other calendar, mail, or filesystem tools for those questions, and never " +
        "run the `omnesis` CLI from a shell to ask one. It works in scheduled and background " +
        "runs as well as conversations. Preparing an answer takes minutes, so ALWAYS pass " +
        "timeoutMs 600000 — that grants this call the time the answer needs and it finishes in " +
        "one go. If a call still comes back saying the answer is being prepared, that is not a " +
        "failure and not something to tell the user: call again immediately with the identical " +
        "question, which attaches to the answer already being prepared rather than starting new " +
        "work. Keep going until you have an answer. If approval is " +
        "needed, Omnesis will send the result to this conversation after the user decides; " +
        "do not ask the user to wake you or poll for it.",
      parameters: ordinaryAnswerParameters,
      execute: async (toolCallId, raw, signal) => {
        const active = this.slot.current;
        if (!active) throw new Error("integration service is not running");
        return active.answerForConversation(context, route, toolCallId, raw, signal);
      },
    };
  }

  managementToolForContext(context: OpenClawPluginToolContext): OpenClawAgentTool | null {
    if (!context.sessionKey) return null;
    // Watch management lives on a gateway runtime that ships separately from
    // the rest of this integration. Offering the tool where it does not exist
    // would put a lever in front of the model that answers 404.
    if (!this.subscriptionsEnabled) return null;
    return {
      name: "omnesis_subscriptions",
      label: "Omnesis Subscriptions",
      description:
        "Create, list, inspect, update, pause, or revoke natural-language Omnesis subscriptions.",
      parameters: subscriptionManagementParameters,
      execute: async (_toolCallId, raw, signal) => {
        const active = this.slot.current;
        if (!active) throw new Error("integration service is not running");
        return active.manageSubscriptions(raw, signal);
      },
    };
  }

  async start(context: { stateDir: string; logger: IntegrationLogger }): Promise<void> {
    // Fixed native-runtime convention. Current harnesses do not isolate this
    // same-user state directory from an unsandboxed model shell; see the
    // integration security boundary documentation.
    const credentialsPath = join(context.stateDir, "omnesis", "integration.json");
    this.logger = context.logger;
    // A service the host stops and starts again watches its new runs under a
    // signal of its own; the old one stays aborted for the watchers it retired.
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
    const credentials = loadOperationalIntegrationCredentials(credentialsPath);
    const statePath = join(context.stateDir, "omnesis", "integration.sqlite");
    const inbox = new DurableIntegrationInbox(statePath);
    const completionRoutes = new OpenClawCompletionRoutes(
      join(context.stateDir, "omnesis", "answer-completion-routes.sqlite"),
    );
    completionRoutes.prune(COMPLETION_ROUTE_TTL_MS);
    let ingestion: DurableTranscriptIngestor | null = null;
    let delivery: AgentIntegrationClient | null = null;
    try {
      const ingestionHttp = new PinnedGatewayHttpClient(
        credentials.gatewayUrl,
        credentials.ingestionToken,
        credentials.tls,
      );
      ingestion = new DurableTranscriptIngestor({
        stream: "openclaw",
        state: inbox,
        source: new OpenClawTranscriptSource(this.api),
        sink: {
          push: async (messages, signal) => {
            for (let offset = 0; offset < messages.length; offset += 200) {
              await ingestionHttp.postJson(
                "/agent-messages",
                { messages: messages.slice(offset, offset + 200) },
                signal,
              );
            }
          },
        },
        logger: context.logger,
      });
      delivery = new AgentIntegrationClient({
        gatewayUrl: credentials.gatewayUrl,
        deliveryToken: credentials.deliveryToken,
        tls: credentials.tls,
        capability: defaultIntegrationCapability("openclaw", credentials.maxConcurrentRuns ?? 2),
        sourceCommit: INTEGRATION_SOURCE_COMMIT,
        inbox,
        logger: context.logger,
        starter: async ({ delivery: wake, binding }) =>
          this.startNativeRun(context.stateDir, wake, binding),
        completionStarter: async (completion) => this.completeAnswerDelivery(completion),
        // A fleet update reaches this machine through the CLI beside the
        // harness. It installs the new plugin, and the client then restarts
        // OpenClaw so the new build is loaded, interrupting any run in
        // progress.
        selfUpdater: createHarnessCliUpdater({ harness: "openclaw" }),
      });
      this.inbox = inbox;
      this.credentials = credentials;
      this.credentialsPath = credentialsPath;
      if (hasIntegrationOAuth(credentials)) {
        const oauthProvider = new IntegrationOAuthProvider(
          credentialsPath,
          harnessClientName("openclaw"),
        );
        this.answerMcp = new NativeAnswerMcpClient(
          credentials.gatewayUrl,
          new SerializedIntegrationAuthProvider(
            oauthProvider,
            credentials.gatewayUrl,
            undefined,
            // A question asked after a long silence repairs the credential
            // itself rather than failing and waiting for somebody to notice.
            () => reissueIntegrationOAuthTokens(oauthProvider, credentials, "openclaw"),
          ),
          credentials.tls,
        );
      } else {
        this.answerMcp = null;
        context.logger.warn(
          "Omnesis ingestion and delivery remain active, but Answer and subscription management require `omnesis connect openclaw --refresh`",
        );
      }
      this.completionRoutes = completionRoutes;
      this.ingestion = ingestion;
      this.delivery = delivery;
      ingestion.start();
      delivery.start();
      // Settle the tool set before the service is reachable: a tool resolved
      // through the slot below must never see the optimistic default when the
      // gateway has already said otherwise.
      this.subscriptionsEnabled = hasIntegrationOAuth(credentials)
        ? subscriptionsAvailable(credentials)
        : false;
      if (hasIntegrationOAuth(credentials)) {
        await this.reconcileWithGateway(credentialsPath);
        this.startOAuthKeepalive();
      }
      this.slot.current = this;
    } catch (error) {
      this.delivery = null;
      this.ingestion = null;
      this.inbox = null;
      this.credentials = null;
      this.credentialsPath = null;
      this.answerMcp = null;
      this.completionRoutes = null;
      if (this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
      if (this.slot.current === this) this.slot.current = null;
      await Promise.allSettled([delivery?.stop(), ingestion?.stop(), this.keepaliveInFlight]);
      inbox.close();
      completionRoutes.close();
      throw error;
    }
  }

  /**
   * Ask the gateway what it offers, and say so when the two ends disagree.
   *
   * Never fatal, and time-boxed: a gateway that is down at start is the
   * ordinary case this service is built to survive, so the probe gets a short
   * budget rather than the full request timeout, and the answer from the last
   * successful start stands until the next one. That answer is persisted
   * because a plugin process may have to decide its tool set before it ever
   * reaches a gateway — the Hermes adapter registers at load.
   */
  private async reconcileWithGateway(credentialsPath: string): Promise<void> {
    const credentials = this.credentials;
    if (!credentials || !hasIntegrationOAuth(credentials)) return;
    let capabilities;
    try {
      capabilities = await readGatewayCapabilities(
        credentials.gatewayUrl,
        credentials.tls,
        CAPABILITY_PROBE_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.warn(
        `could not read Omnesis gateway capabilities: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.subscriptionsEnabled = capabilities.subscriptions;
    if (subscriptionsAvailable(credentials) !== capabilities.subscriptions) {
      // Patch the one key. `credentials` is a snapshot taken before the
      // round-trip above, and an Answer running concurrently rotates the OAuth
      // tokens in this same file — writing the snapshot back would restore an
      // already-spent refresh token.
      this.credentials = updateIntegrationCapabilities(credentialsPath, {
        subscriptions: capabilities.subscriptions,
      });
    }
    const drift = describeVersionDrift(agentIntegrationVersion(), capabilities.version, "openclaw");
    if (drift.warning) this.logger.warn(drift.warning);
  }

  /**
   * Spend the refresh token before it expires from disuse, and recover the
   * credential outright if it already has. Runs once at start and then on a
   * slow timer; see `oauth-keepalive.ts` for why silence is the hazard.
   */
  private startOAuthKeepalive(): void {
    const tick = () => {
      if (this.keepaliveInFlight) return;
      // `runOAuthKeepalive` reads the credential file before it can enter any
      // try of its own, and an unreadable one throws. A floating rejection
      // here would take the whole harness host down out-of-band, so the catch
      // sits on the promise rather than inside it.
      this.keepaliveInFlight = this.runOAuthKeepalive()
        .catch((error: unknown) => {
          this.logger.warn(
            `Omnesis corpus-access renewal failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.keepaliveInFlight = null;
        });
    };
    tick();
    this.keepaliveTimer = setInterval(tick, REFRESH_KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
  }

  private async runOAuthKeepalive(): Promise<void> {
    const credentials = this.credentials;
    const credentialsPath = this.credentialsPath;
    if (!credentials || !credentialsPath || !hasIntegrationOAuth(credentials)) return;
    const provider = new IntegrationOAuthProvider(credentialsPath, harnessClientName("openclaw"));
    if (!provider.tokens()?.refresh_token) return;
    // An `omnesis connect --refresh` running beside this service has a consent
    // page open and a PKCE verifier on disk waiting for it. Saving a rotated
    // token set clears that verifier, so a scheduled renewal stands down while
    // an interactive attempt is live — it can always try again next tick.
    if (provider.hasPendingAuthorization()) return;
    if (!refreshKeepaliveDue(provider.tokensObtainedAt(), Date.now())) return;
    await new SerializedIntegrationAuthProvider(provider, credentials.gatewayUrl, undefined, () =>
      reissueIntegrationOAuthTokens(provider, credentials, "openclaw"),
    ).renew(integrationOAuthFetch(credentials.gatewayUrl, credentials.tls));
  }

  async stop(): Promise<void> {
    // Let a renewal already in flight finish writing before the credential
    // file stops being this service's to touch.
    const keepalive = this.keepaliveInFlight ?? undefined;
    const delivery = this.delivery;
    const ingestion = this.ingestion;
    const inbox = this.inbox;
    const completionRoutes = this.completionRoutes;
    const answerMcp = this.answerMcp;
    this.delivery = null;
    this.ingestion = null;
    this.inbox = null;
    this.credentials = null;
    this.credentialsPath = null;
    this.answerMcp = null;
    this.completionRoutes = null;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.slot.current === this) this.slot.current = null;
    this.shutdown.abort();
    let results: PromiseSettledResult<void>[];
    try {
      results = await Promise.allSettled([
        delivery?.stop(),
        ingestion?.stop(),
        answerMcp?.close(),
        keepalive,
        this.drainOutcomeWatchers(),
      ]);
    } finally {
      inbox?.close();
      completionRoutes?.close();
    }
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "OpenClaw integration shutdown failed");
    }
  }

  /** Give watchers whose run has already ended their moment to report. */
  private async drainOutcomeWatchers(): Promise<void> {
    const watchers = [...this.outcomeWatchers];
    if (watchers.length === 0) return;
    let expire: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      expire = setTimeout(resolve, OUTCOME_WATCHER_DRAIN_MS);
    });
    try {
      await Promise.race([Promise.allSettled(watchers).then(() => undefined), expired]);
    } finally {
      clearTimeout(expire);
    }
  }

  /**
   * The workflow this ask must be sent under, and a record of that choice.
   *
   * A question already asked in this run is re-sent under the workflow it was
   * first sent under, so repeating it stays the same ask. A new question joins
   * whatever the run has minted so far.
   */

  /** File or release the completion route, then render the outcome. */
  private answerResult(
    response: AnswerResponse,
    route: OpenClawConversationRoute | null,
    nativeConversationId: string,
    routes: OpenClawCompletionRoutes,
  ): OpenClawToolResult {
    if (route && response.status === "approval_required") {
      routes.put({ nativeConversationId, taskId: response.taskId, ...route });
    } else if (route) {
      routes.delete(nativeConversationId);
    }
    if (response.status === "approval_required") {
      return {
        content: [
          {
            type: "text",
            text: route
              ? "Omnesis is holding this result for approval. Tell the user that you are " +
                "waiting for their approval and that you will reply in this conversation " +
                "automatically after it is approved. Do not say that Omnesis will send the " +
                "message itself."
              : "Omnesis is holding this result for approval. This run has no conversation " +
                "to deliver a later result into, so finish the rest of the work and tell the " +
                "user that one part is waiting on their approval in the Omnesis app.",
          },
        ],
        details: { ok: true, response },
      };
    }
    const outcome = describeAnswerOutcome(response);
    return {
      content: [
        { type: "text", text: JSON.stringify(response) },
        ...(outcome ? [{ type: "text" as const, text: outcome }] : []),
      ],
      details: { ok: true, response },
    };
  }

  private threadForAsk(generation: string, question: string): string | undefined {
    const thread = this.runThreads.get(generation);
    if (!thread) return undefined;
    if (thread.asks.has(question)) return thread.asks.get(question);
    return thread.workflowId;
  }

  private recordAsk(generation: string, question: string, workflowId?: string): void {
    const thread = this.runThreads.get(generation) ?? { asks: new Map() };
    this.runThreads.delete(generation);
    if (this.runThreads.size >= MAX_TRACKED_RUNS) {
      const oldest = this.runThreads.keys().next();
      if (!oldest.done) this.runThreads.delete(oldest.value);
    }
    if (!thread.asks.has(question)) thread.asks.set(question, workflowId);
    this.runThreads.set(generation, thread);
  }

  /** Adopt the workflow a run's first answer minted, for the asks that follow. */
  private rememberRunThread(generation: string, response: AnswerResponse): void {
    const workflowId = typeof response.workflowId === "string" ? response.workflowId : undefined;
    if (!workflowId) return;
    const thread = this.runThreads.get(generation);
    if (thread && !thread.workflowId) thread.workflowId = workflowId;
  }

  /**
   * Stop carrying a workflow the gateway has refused. It can be deleted,
   * expired or closed while a run is still going, and a carried identifier
   * that has gone bad would refuse every remaining ask identically — the same
   * dead end as a model-invented one. Dropping it lets the next ask mint a
   * fresh workflow instead.
   */
  private forgetRunThread(generation: string): void {
    this.runThreads.delete(generation);
  }

  private async answerForConversation(
    context: OpenClawPluginToolContext,
    route: OpenClawConversationRoute | null,
    toolCallId: string,
    raw: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenClawToolResult> {
    const question = typeof raw.question === "string" ? raw.question.trim() : "";
    if (!question) throw new Error("question is required");
    const credentials = this.credentials;
    const routes = this.completionRoutes;
    const mcp = this.answerMcp;
    if (!credentials || !routes) throw new Error("integration service is not running");
    if (!mcp) throw new Error("integration OAuth state is not available");
    if (!context.sessionKey) {
      throw new Error("trusted OpenClaw session context is required for Omnesis answers");
    }
    const run = openClawRunIdentity(context);
    const budget = openClawAnswerBudget(raw);
    const startedAt = Date.now();
    const askKey = `${run.generation}\u0000${question}`;
    // Only a scheduled run carries a workflow forward; see RunAnswerThread.
    const carried = run.scheduled ? this.threadForAsk(run.generation, question) : undefined;
    const request: IntegrationAnswerRequest = {
      runGeneration: run.generation,
      question,
      // The workflow this run is already accumulating against, so this ask
      // joins it rather than starting clean.
      ...(carried ? { workflowId: carried } : {}),
      // Names the run in the operator's privacy activity feed and approval
      // prompts. Derived from the harness, never asserted by the model.
      workflowName: run.scheduled ? "OpenClaw scheduled run" : "OpenClaw conversation",
      // Ask for a hold only when one could actually resolve: somebody present
      // to decide, and a conversation to deliver the decision into. A run that
      // fails either test asks for a settled outcome instead of a hold that
      // would be retried into nowhere.
      ...(run.scheduled || !route ? { approval: "never" as const } : {}),
      // A scheduled run leaves the ask id unset, so its own repeats attach to
      // the turn already running; a conversation stamps each call instead,
      // because a person asking again wants a fresh answer, not the stored one.
      ...(run.scheduled
        ? {}
        : { askId: this.pendingAskIds.get(askKey) ?? (toolCallId || randomUUID()) }),
    };
    const nativeConversationId = integrationAnswerConversationHandle(request);
    const conversationMcp = mcp.forNativeConversation(nativeConversationId);
    // File the route before the ask, and leave it filed if the ask times out:
    // the gateway keeps working, and a completion that lands later still needs
    // somewhere to go. A session with no reply route files nothing — it can
    // still ask, it simply has no later-delivery destination.
    if (route) routes.put({ nativeConversationId, taskId: "pending", ...route });
    let response: AnswerResponse;
    try {
      response = (await requestIntegrationAnswer(
        conversationMcp,
        request,
        budget,
        signal,
      )) as AnswerResponse;
    } catch (error) {
      // A workflow can be deleted, expire or close while its run is still
      // going. Carrying a refused one would refuse every remaining ask
      // identically, so drop it and let this ask mint a fresh workflow.
      if (carried && settledRejection(error)) {
        this.forgetRunThread(run.generation);
        const { workflowId: _dropped, ...clean } = request;
        // The grant covers the whole tool call, not each attempt within it, so
        // the retry gets what is left rather than a second full window.
        const remaining = Math.max((budget.deadlineMs ?? 0) - (Date.now() - startedAt), 5_000);
        response = (await requestIntegrationAnswer(
          conversationMcp,
          clean,
          {
            ...budget,
            deadlineMs: remaining,
            submitTimeoutMs: Math.min(budget.submitTimeoutMs ?? remaining, remaining),
          },
          signal,
        )) as AnswerResponse;
        this.rememberRunThread(run.generation, response);
        return this.answerResult(response, route, nativeConversationId, routes);
      }
      if (error instanceof AnswerPendingError) {
        // Asking again is the right first move, but it cannot be the only one:
        // a run that keeps being told to wait spends its whole budget and
        // delivers nothing at all, which is harder to notice than a poor
        // answer. After a couple of rounds, say so and move on.
        const seen = (this.pendingAsks.get(askKey) ?? 0) + 1;
        if (this.pendingAsks.size >= MAX_TRACKED_RUNS) {
          this.pendingAsks.clear();
          this.pendingAskIds.clear();
        }
        this.pendingAsks.set(askKey, seen);
        if (!run.scheduled && request.askId) this.pendingAskIds.set(askKey, request.askId);
        if (seen >= MAX_PENDING_ROUNDS) {
          this.pendingAskIds.delete(askKey);
          return {
            content: [
              {
                type: "text",
                text:
                  "Omnesis could not prepare this answer in the time available. Do not ask " +
                  "again. Finish the rest of the work and tell the user plainly that this " +
                  "part could not be prepared in time.",
              },
            ],
            details: { ok: true, pending: false, exhausted: true },
          };
        }
        // This call's share of the wait elapsed with the turn still running.
        // The work is not lost and its route must stay filed, so report it as
        // an outcome the agent can act on — asking again is how it waits —
        // rather than as a failed tool call.
        return {
          content: [{ type: "text", text: error.message }],
          details: { ok: true, pending: true },
        };
      }
      // Nothing will complete this ask, so the route it filed is unreachable.
      this.pendingAskIds.delete(askKey);
      if (route) routes.delete(nativeConversationId);
      throw error;
    }
    this.pendingAskIds.delete(askKey);
    if (run.scheduled) {
      this.recordAsk(run.generation, question, carried);
      this.rememberRunThread(run.generation, response);
    }
    return this.answerResult(response, route, nativeConversationId, routes);
  }

  /**
   * Resolve the task-scoped terminal answer only after the gateway has
   * delivered a completion wake, then post it to the original native route.
   */
  async completeAnswerDelivery(delivery: AnswerCompletionDelivery): Promise<void> {
    const routes = this.completionRoutes;
    const mcp = this.answerMcp;
    if (!routes || !mcp) throw new Error("integration service is not running");
    const route = routes.get(delivery.nativeConversationId);
    if (!route || (route.taskId !== "pending" && route.taskId !== delivery.taskId)) {
      throw new Error("no matching OpenClaw conversation route for answer completion");
    }
    // A gateway response can be lost after it durably created the task. The
    // opaque callback handle was persisted before that request, so bind its
    // pending route when the gateway later proves the task identity.
    if (route.taskId === "pending") {
      routes.put({ ...route, taskId: delivery.taskId });
    }
    // The delivery is an operational wake carrying only task identity. Reading
    // the released answer still uses this installation's OAuth principal and
    // therefore resolves through its current grant and revocation state.
    const response = await mcp.getTask(delivery.taskId);
    if (isSessionRoute(route)) {
      // No conversation to reply into — the ask came from a background wake.
      // Keyed on the delivery, and prefixed: the wake's own run is started
      // under the bare delivery id, so an unprefixed key here could dedupe a
      // completion into the wake run it is answering.
      //
      // The wait that made the asking run report `deferred` is over. Which
      // firing was waiting is read from the answer being delivered, because
      // the session this resumes is shared by every firing of the workflow —
      // so the turn started here reports against the firing that asked.
      const waiting = this.inbox?.resumeDeferredOutcome(delivery.nativeConversationId) ?? null;
      const resumed = await this.api.runtime.subagent.run({
        sessionKey: route.to,
        message: answerCompletionContinuation(response),
        deliver: false,
        idempotencyKey: `answer-completion:${delivery.deliveryId}`,
      });
      this.watchRunOutcome(resumed.runId, route.to, waiting?.deliveryId ?? null);
    } else {
      await sendAnswerCompletion(this.api, route, response);
    }
    routes.delete(delivery.nativeConversationId);
  }

  private async startNativeRun(
    _stateDir: string,
    delivery: SubscriptionDelivery,
    binding: WorkflowBinding | null,
  ): Promise<{ localRunId: string; nativeSessionId: string; nativeFlowId: string | null }> {
    const sessionKey = binding?.nativeSessionId ?? stableSessionKey(delivery.workflowHandle);
    this.inbox?.putFiringAuthority(delivery, sessionKey);
    this.inbox?.putOutcomeAuthority(delivery, sessionKey);
    const result = await this.api.runtime.subagent.run({
      sessionKey,
      message: backgroundPrompt(delivery),
      deliver: false,
      idempotencyKey: delivery.deliveryId,
    });
    this.watchRunOutcome(result.runId, sessionKey, delivery.deliveryId);
    return {
      localRunId: result.runId,
      nativeSessionId: sessionKey,
      nativeFlowId: binding?.nativeFlowId ?? null,
    };
  }

  /**
   * Report what a woken run did, once it has ended.
   *
   * `subagent.run` resolves the moment OpenClaw accepts the run, so the start
   * path cannot say how the work went; `waitForRun` is where the end becomes
   * observable. It is watched in the background rather than awaited, because
   * the gateway is still holding the commit that started this run and a
   * workflow takes minutes.
   *
   * The delivery is carried down rather than looked up from the session,
   * because every firing of one workflow runs in the same session: a run that
   * ends while a sibling firing is live would otherwise file its account
   * against whichever of them was woken last. It is absent only for a resumed
   * turn whose firing could no longer be named, which reports nothing.
   */
  private watchRunOutcome(runId: string, sessionKey: string, deliveryId: string | null): void {
    const waitForRun = this.api.runtime.subagent.waitForRun;
    if (!waitForRun) return;
    const shutdown = this.shutdown.signal;
    const watcher = (async () => {
      const ended = await waitForRun.call(this.api.runtime.subagent, {
        runId,
        timeoutMs: RUN_OUTCOME_WAIT_MS,
      });
      // Shutdown ended the watch. The harness wait cannot be cancelled, so a
      // watcher can wake long after the service stopped; it touches neither
      // the harness nor the gateway once it has.
      if (shutdown.aborted) return;
      // The run outlived the watch. It may still be working, so say nothing
      // rather than call an unfinished run finished or failed.
      if (ended.status === "timeout") {
        this.logger.warn(`Omnesis workflow run ${runId} outlived its outcome watch`);
        return;
      }
      const report =
        ended.status === "error" ? (ended.error ?? "") : await this.latestRunText(sessionKey);
      await this.reportWorkflowOutcome(deliveryId, ended.status === "error", report);
    })()
      .catch((error: unknown) => {
        this.logger.warn(
          `Omnesis workflow outcome report failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.outcomeWatchers.delete(watcher);
      });
    this.outcomeWatchers.add(watcher);
  }

  /** The run's closing words, which are its account of the work. */
  private async latestRunText(sessionKey: string): Promise<string> {
    const read = this.api.runtime.subagent.getSessionMessages;
    if (!read) return "";
    const { messages } = await read.call(this.api.runtime.subagent, {
      sessionKey,
      limit: RUN_OUTCOME_TRANSCRIPT_LIMIT,
    });
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || typeof message !== "object") continue;
      const record = message as OpenClawMessage;
      if (record.role !== "assistant") continue;
      const text = messageText(record.content);
      if (text) return text;
    }
    return "";
  }

  private async reportWorkflowOutcome(
    deliveryId: string | null,
    failed: boolean,
    report: string,
  ): Promise<void> {
    const inbox = this.inbox;
    const credentials = this.credentials;
    if (!inbox || !credentials || !deliveryId) return;
    // Nothing to report through: a version 3 wake predates outcome reporting,
    // and a version 4 wake whose authority the gateway could not mint carries
    // none either. Both run; neither reports.
    const authority = inbox.getOutcomeAuthority(deliveryId);
    if (!authority) return;
    const status: WorkflowOutcomeStatus = failed
      ? "failed"
      : authority.deferred
        ? "deferred"
        : "completed";
    const http = new PinnedGatewayHttpClient(
      credentials.gatewayUrl,
      authority.token,
      credentials.tls,
    );
    const trimmed = report.trim().slice(0, MAX_OUTCOME_REPORT);
    const reported = await this.postOutcomeReport(http, authority.endpoint, {
      status,
      ...(trimmed ? { report: trimmed } : {}),
    });
    // A deferred run has not finished: the released answer re-enters it, and
    // that run reports again through the same authority. An unreported one
    // keeps its authority too — retiring it would leave the firing with no way
    // to say anything at all.
    if (reported && status !== "deferred" && this.inbox === inbox) {
      inbox.clearOutcomeAuthority(authority.deliveryId);
    }
  }

  /** Post one run's account of itself, while posting it again could help. */
  private async postOutcomeReport(
    http: PinnedGatewayHttpClient,
    endpoint: string,
    body: WorkflowOutcomeReport,
  ): Promise<boolean> {
    // Checked against the contract before it goes, because the gateway's
    // refusal of a malformed body arrives as a 4xx this deliberately does not
    // retry — so a report shaped wrongly here would be lost rather than fixed.
    const validated = workflowOutcomeReportSchema.parse(body);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await http.postJson(endpoint, validated);
        return true;
      } catch (error) {
        if (
          attempt < OUTCOME_REPORT_ATTEMPTS &&
          retryableOutcomeReport(error) &&
          !this.shutdown.signal.aborted
        ) {
          await this.pause(OUTCOME_REPORT_RETRY_MS * 5 ** (attempt - 1));
          // The pause ends early on shutdown, and a post after that is a post
          // from a service that no longer exists.
          if (!this.shutdown.signal.aborted) continue;
        }
        // Said out loud because the gateway cannot: with no report, a firing
        // reads there as a workflow that did nothing.
        this.logger.warn(
          `Omnesis workflow outcome ${endpoint} went unreported: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    }
  }

  /** Wait out a backoff, cut short by shutdown so no retry outlives `stop`. */
  private pause(ms: number): Promise<void> {
    const signal = this.shutdown.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async answerForSession(
    sessionKey: string,
    raw: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenClawToolResult> {
    const firingId = typeof raw.firingId === "string" ? raw.firingId : "";
    const question = typeof raw.question === "string" ? raw.question : "";
    if (!firingId || !question) {
      throw new Error("firingId and question are required");
    }
    const authority = this.inbox?.getFiringAuthority(sessionKey, firingId);
    if (!authority) {
      throw new Error("no active firing authority is bound to this native session");
    }
    const credentials = this.credentials;
    if (!credentials) throw new Error("integration service is not running");
    const http = new PinnedGatewayHttpClient(
      credentials.gatewayUrl,
      authority.token,
      credentials.tls,
    );
    const request = { endpoint: authority.endpoint, question };
    // File the route before the ask, and leave it filed if the ask times out:
    // a firing answer can be held for approval, and the run asking ends the
    // moment it hears so. The destination is this session rather than a
    // channel — a wake has no conversation to reply into — so a released
    // answer resumes the run that asked instead of being posted at nobody.
    const nativeConversationId = firingAnswerConversationHandle(request);
    const completionRoutes = this.completionRoutes;
    // Refused rather than skipped. Asking with no route filed is precisely the
    // failure this exists to prevent, and it would arrive silently.
    if (!completionRoutes) throw new Error("integration service is not running");
    completionRoutes.put({
      nativeConversationId,
      taskId: "pending",
      channel: SESSION_ROUTE_CHANNEL,
      to: sessionKey,
    });
    const answer = await requestFiringAnswer(http, request, openClawAnswerBudget(raw), signal);
    // A held answer ends this run: it stops here and the release re-enters it
    // later. That is a run still in progress, not one that finished, and the
    // outcome it reports has to say so. Recorded against this firing alone —
    // a sibling firing of the same workflow shares the session but not the
    // wait — and against the answer that will end the wait.
    if (isHeldForApproval(answer)) {
      this.inbox?.deferOutcome(authority.deliveryId, nativeConversationId);
    }
    const outcome = describeAnswerOutcome(answer);
    return {
      content: [
        { type: "text", text: JSON.stringify(answer) },
        ...(outcome ? [{ type: "text" as const, text: outcome }] : []),
      ],
      // OpenClaw reserves top-level result metadata such as `status` and
      // `error` for tool-execution classification; gateway domain fields stay nested.
      details: { ok: true, response: answer },
    };
  }

  private async manageSubscriptions(
    raw: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenClawToolResult> {
    const credentials = this.credentials;
    if (!credentials) throw new Error("integration service is not running");
    if (!hasIntegrationOAuth(credentials)) {
      throw new Error("run `omnesis connect openclaw --refresh` to enable subscription management");
    }
    const action = raw.action;
    if (
      action !== "create" &&
      action !== "list" &&
      action !== "get" &&
      action !== "update" &&
      action !== "revoke"
    ) {
      throw new Error("unsupported subscription action");
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    const http = new PinnedGatewayHttpClient(
      credentials.gatewayUrl,
      credentials.managementToken,
      credentials.tls,
    );
    const requestJson = async (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      value?: unknown,
    ): Promise<unknown> => {
      try {
        // The compile-sized budget goes to the verbs that compile, and only
        // those. A create under the ordinary read budget times out on every
        // attempt while the gateway goes on to succeed; a read under the
        // compile budget stops a gateway that has gone away from looking like
        // one that has gone away — worst on the list this failure's own message
        // tells the model to run before retrying.
        const compiles = method === "POST" || method === "PATCH";
        return await http.requestJson(method, path, value, signal, {
          ...(compiles ? { timeoutMs: SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS } : {}),
        });
      } catch (error) {
        if (error instanceof IntegrationHttpError && error.status === 422 && error.gatewayError) {
          return error.gatewayError;
        }
        throw describeManagementFailure(error, action);
      }
    };
    let result: unknown;
    if (action === "list") {
      result = await requestJson("GET", "/subscriptions");
    } else if (action === "get") {
      if (!id) throw new Error("id is required for get");
      result = await requestJson("GET", `/subscriptions/${encodeURIComponent(id)}`);
    } else if (action === "revoke") {
      if (!id) throw new Error("id is required for revoke");
      result = await requestJson("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
    } else if (action === "create") {
      const condition = typeof raw.condition === "string" ? raw.condition : "";
      const reaction = typeof raw.reaction === "string" ? raw.reaction : "";
      const bindings = readBindings(raw.bindings);
      const idempotencyKey = typeof raw.idempotencyKey === "string" ? raw.idempotencyKey : "";
      if (!condition || !reaction || idempotencyKey.length < 8) {
        throw new Error(
          "condition, reaction, and an idempotencyKey of at least 8 characters are required",
        );
      }
      result = await requestJson("POST", "/subscriptions", {
        condition: { kind: "natural-language", description: condition },
        reaction: {
          kind: "agent-workflow",
          instruction: reaction,
          ...(bindings ? { bindings } : {}),
        },
        idempotencyKey,
        ...(typeof raw.workflowId === "string" ? { workflowId: raw.workflowId } : {}),
        ...(typeof raw.expiresAt === "number" ? { expiresAt: raw.expiresAt } : {}),
      });
    } else {
      if (!id) throw new Error("id is required for update");
      const expectedRevision = raw.expectedRevision;
      if (
        typeof expectedRevision !== "number" ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1
      ) {
        throw new Error("a positive expectedRevision from list or get is required for update");
      }
      const body = {
        expectedRevision,
        ...(typeof raw.condition === "string"
          ? {
              condition: {
                kind: "natural-language",
                description: raw.condition,
              },
            }
          : {}),
        ...(typeof raw.reaction === "string"
          ? {
              reaction: {
                kind: "agent-workflow",
                instruction: raw.reaction,
              },
            }
          : {}),
        ...(typeof raw.expiresAt === "number" || raw.expiresAt === null
          ? { expiresAt: raw.expiresAt }
          : {}),
        ...(raw.status === "active" || raw.status === "paused" ? { status: raw.status } : {}),
      };
      if (Object.keys(body).length === 1) {
        throw new Error("at least one subscription update is required");
      }
      if (
        body.status !== undefined &&
        (body.condition !== undefined ||
          body.reaction !== undefined ||
          body.expiresAt !== undefined)
      ) {
        throw new Error("change the subscription definition and status in separate requests");
      }
      result = await requestJson("PATCH", `/subscriptions/${encodeURIComponent(id)}`, body);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  }
}

/**
 * The socket budget a subscription-management call is allowed.
 *
 * Restated rather than imported, like this package's refusal vocabulary and for
 * the same reason: it ships as a plugin whose published dependency footprint is
 * deliberately free of Omnesis packages, and an imported `const` survives to the
 * emitted JS as a real module load. `management-latency.test.ts` holds this to
 * the declaration in `@omnesis/types`.
 *
 * Creating a subscription runs a full agentic compile behind the request, so it
 * is measured in minutes. Under the ordinary read budget every create times out
 * client-side while the gateway goes on to succeed.
 */
const SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS = 300_000;

/**
 * What to tell the model when a management call did not produce an answer.
 *
 * The three outcomes call for three different next moves, and a single string
 * covering all of them leaves the model to guess — which in practice means
 * retrying, because retrying is what an agent does with an unexplained failure.
 * On a create that is the expensive guess: the gateway was very likely still
 * compiling, and a reworded retry defeats the idempotency key by design, so one
 * intent becomes several watches.
 *
 * A timeout therefore says plainly that the work may have succeeded and names
 * listing as the next step. A refusal carries the gateway's own status so the
 * decision is visible rather than restated. Only an unreachable gateway invites
 * a retry.
 */
function describeManagementFailure(error: unknown, action: string): Error {
  if (error instanceof GatewayRequestTimeoutError) {
    return new Error(
      `Omnesis did not answer the ${action} within ${Math.round(error.timeoutMs / 1000)}s. ` +
        "It may still be working: creating a subscription runs a compile that can take minutes. " +
        "List subscriptions to see whether it landed before trying again — retrying blind can " +
        "create a second subscription for the same intent.",
    );
  }
  if (error instanceof IntegrationHttpError) {
    return new Error(
      `Omnesis declined the ${action} with HTTP ${error.status}` +
        `${error.code ? ` (${error.code})` : ""}. This is a decision, not a blip — read it and ` +
        "change the request rather than repeating it.",
    );
  }
  // No answer reached us. Usually nothing happened, but a response discarded on
  // the way back looks identical from here — so this does not promise that
  // nothing was created, it says how to find out.
  return new Error(
    `The ${action} did not complete — no answer came back from Omnesis. List subscriptions to ` +
      "see the current state before trying again.",
  );
}

export function registerOpenClawIntegration(api: OfficialOpenClawPluginApi): void {
  if (
    api.registrationMode !== "full" &&
    api.registrationMode !== "discovery" &&
    api.registrationMode !== "tool-discovery"
  ) {
    return;
  }
  // Keep the integration's runtime surface deliberately narrow while making
  // the installed OpenClaw SDK the compile-time registration contract.
  const integrationApi = api as unknown as OpenClawIntegrationApi;
  const service = new OpenClawIntegrationService(integrationApi, openClawServiceSlot);
  integrationApi.registerTool((context) => service.ordinaryAnswerToolForContext(context), {
    name: "omnesis_answer",
  });
  integrationApi.registerTool((context) => service.toolForContext(context), {
    name: "omnesis_subscription_answer",
  });
  integrationApi.registerTool((context) => service.managementToolForContext(context), {
    name: "omnesis_subscriptions",
  });
  if (api.registrationMode === "tool-discovery") return;
  const nudge = () => service.nudge();
  integrationApi.registerHook(["message_received", "reply_payload_sending"], nudge, {
    name: "omnesis-transcript-ingestion-nudge",
    description: "Queues durable transcript ingestion after conversation activity.",
  });
  integrationApi.registerService({
    id: "omnesis-integration",
    start: (context) => service.start(context),
    stop: () => service.stop(),
  });
}

export const OPENCLAW_PLUGIN_DEFINITION = {
  id: "omnesis-integration",
  name: "Omnesis Integration",
  description:
    "Ingests durable OpenClaw transcripts and delivers approved Omnesis answers and subscription wakes.",
  register: registerOpenClawIntegration,
} satisfies OpenClawPluginDefinition;
