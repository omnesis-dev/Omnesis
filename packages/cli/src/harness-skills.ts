// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";

/**
 * The Omnesis skill installed into external agent harnesses by
 * `omnesis connect <harness>`.
 *
 * Both OpenClaw and Hermes surface skills the same way: a compact name +
 * description catalog in the system prompt, with the full SKILL.md body
 * loaded on demand when the model judges it relevant.
 *
 * Only the frontmatter differs per harness:
 * - OpenClaw parses `metadata.openclaw`; the installed native plugin owns its
 *   private integration state, so only the ordinary CLI binary is required.
 * - Hermes parses `prerequisites.commands`; its adapter reads the same private
 *   integration state convention and needs no environment bearer.
 *
 * The body differs per *gateway*. Watch management rides on a gateway runtime
 * that ships separately from the rest of the integration, and the installed
 * plugin registers those tools only where the gateway offers them. A skill
 * that described them anyway would teach the model to reach for a tool that
 * is not there — and then to explain the absence to the user as a fault.
 */

export const HARNESSES = ["openclaw", "hermes"] as const;
export type Harness = (typeof HARNESSES)[number];

export const SKILL_NAME = "omnesis";

/** What the gateway this installation talks to actually offers. */
export interface HarnessSkillCapabilities {
  /** Watch management and Watch-reaction delivery. */
  subscriptions: boolean;
}

function skillDescription(capabilities: HarnessSkillCapabilities): string {
  return capabilities.subscriptions
    ? "Ask the user's private Omnesis knowledge base questions, or create and manage " +
        "privacy-reviewed watches over their documents and analytics."
    : "Ask the user's private Omnesis knowledge base questions.";
}

function watchSection(): string {
  return ` A **watch** asks Omnesis to keep
an eye on that index and tell you when something happens. There are two kinds:

- a document watch, which evaluates each new document as it is indexed. It can match
  precisely — who a document is from or to, its type, its title, or any field the source
  declares about it, combined with and/or/not — or by meaning, when the condition is
  better described than enumerated. It does not backfill documents already indexed; or
- an analytics watch, over metrics and records already ingested. It fires either when a new
  record **arrives**, or when a **condition over the data becomes true** —
  filtered existence, \`count\`/\`sum\`/\`avg\`/\`min\`/\`max\`, grouping,
  rolling or prior windows, arithmetic, and comparisons. Say which you mean:
  "when a new weight reading arrives" is an arrival; "when my weight goes above 80 kg" is a
  condition. A condition already true on the first evaluation fires immediately.

Describe either kind in natural language. Omnesis decides whether the request maps safely to a
document match or an analytics query; never write SQL or a TriggerSpec yourself. A wake contains
only opaque identifiers, the subscriber-authored reaction, and a short-lived Answer authority.
For an analytics watch, the wake and firing-bound Answer reveal only that the approved condition
became true, never query rows or computed values.`;
}

function whenToUseSection(capabilities: HarnessSkillCapabilities): string {
  return capabilities.subscriptions
    ? `Use it for a one-off question about the user's Omnesis knowledge base, or when the user asks to
watch for future information and take a specific action after a match. Do not create a watch for
a one-off lookup.`
    : `Use it for any question about the user's Omnesis knowledge base — their calendar, email,
messages, contacts, files, notes, tasks, or anything else indexed there.`;
}

function watchManagementSection(): string {
  return `

To manage watches, call the native \`omnesis_subscriptions\` tool — the transport keeps its own
name for the object. It supports \`create\`, \`list\`, \`get\`, \`update\`, and \`revoke\`.
For create, provide:

- \`condition\`: the natural-language match condition
- \`reaction\`: the exact action instruction
- \`bindings\`: what the reaction's words point at, as key/value strings — the conversation
  to post in, the address to write to, the record to update. Set them whenever the reaction
  names something a woken run could not work out for itself, and refer to them by name in
  the reaction ("post in the channel given as the slack_channel referent"). Omnesis never
  interprets them; a key means whatever the reaction says it means. Creation only, so decide
  them before you create the watch
- \`idempotencyKey\`: a stable key of at least eight characters so retries cannot create
  duplicates

Optionally provide \`workflowId\` to deliberately continue an existing dedicated background
workflow. Optionally provide \`expiresAt\` as an epoch-millisecond timestamp. For update,
\`expiresAt: null\` resets expiry to the gateway's safe default; \`status\` may be \`active\`
or \`paused\`. Before update, list or get the watch and pass its current \`revision\`
as \`expectedRevision\`. If the gateway reports a revision conflict, show it to the user and
fetch the new state; never silently retry an update.

Inside a delivered watch's dedicated background session, use the native
\`omnesis_subscription_answer\` tool to ask what caused that specific firing. Supply the
opaque \`firingId\` from the wake. The plugin resolves the private, firing-bound authority
and derives stable request identity; never ask for or pass a token or conversation ID.`;
}

function watchRules(): string {
  return `
- Confirm the condition and reaction with the user before creating or materially changing a
  watch.
- Make the reaction operationally precise: say what to inspect, what decision to make, and
  whether or how to notify the user. Do not invent a summary push or firing-rate budget.
- For an analytics watch, never promise to report the current value, baseline, percentage, count,
  matching group, or any other computed result. The permitted result is only that the approved
  condition became true. Document watches may inspect their matched documents through the
  firing-bound Answer tool.
- Never claim old documents will be checked by a document watch. It starts with documents
  arriving after creation. An analytics watch is different: it evaluates
  currently ingested analytics, including on its initial evaluation.
- Do not claim support for absence or "nothing arrived" conditions, wall-clock schedules or
  deadlines whose passage is itself the event, arbitrary derived state outside the analytics
  catalog, or cross-table/cross-source joins.
- Never use TriggerSpec, trigger commands, or the \`omnesis watches\` CLI commands. Use the
  native tool, which uses the explicit agent/skill authority already provisioned for this
  harness. The paired OpenClaw or Hermes installation is one integration identity: every
  valid session in that installation has the same Watch-management authority. Creating or
  revising a Watch may activate it, leave it pending for approval, or deny it according to the
  user's Omnesis privacy policy. Report the returned status accurately.`;
}

function noWatchRule(): string {
  return `
- Watches are not available on this installation of Omnesis. If the user asks you to watch
  for something in their data and act on it later, say that this installation cannot, and
  offer to answer the question now instead. Never use TriggerSpec, trigger commands, or the
  \`omnesis watches\` CLI commands to approximate one.`;
}

function skillBody(capabilities: HarnessSkillCapabilities): string {
  return `# Omnesis

Omnesis is the user's local, private personal knowledge base.${
    capabilities.subscriptions ? watchSection() : ""
  }

## When to use this skill

${whenToUseSection(capabilities)}

## How to use it

Always ask by calling the native \`omnesis_answer\` tool — in a conversation, in a
cron, and in any other background run. Never run the \`omnesis\` CLI from a shell
to ask a question, and never ask the user to wake you or poll for a result.

Preparing an answer runs a full search and a privacy review, so it takes a few
minutes — often longer than a single tool call is allowed to last. If the tool
offers a \`timeoutMs\`, always pass \`600000\`: it grants the call the time the
answer needs, so it finishes in one go.

A call can still come back saying the answer is still being prepared. That is
not a failure, not an answer, and never something to report to the user: the
work is still running. **Call the tool again immediately with the identical
question.** The repeat attaches to the answer already being prepared rather than
starting new work, so it costs nothing, and one of those repeats returns the
answer. Keep going until you have one — a message saying Omnesis is still
preparing something is never the right thing to send.

Once it does return, the answer is handed back to you, so you can use it for
whatever the rest of your work needs — sending a message, updating something,
deciding what to do next, or nothing user-visible at all.

A scheduled run has nobody present to approve anything, so Omnesis returns a
settled outcome instead of holding one. Treat a \`denied\` response with reason
\`approval_not_available\` as a privacy-protected omission, not a failure:
complete the rest of the work and say only that the requested part could not be
included without interactive approval. The user can adjust their privacy policy
if they want future runs to include it.

In a conversation, an answer may instead come back as \`approval_required\`. That
is not a failure either: Omnesis has already asked the user in the Omnesis app
and will deliver the result to this conversation once they decide. Tell the user
you are waiting on their approval, do not reveal or infer the held result, and do
not promise that Omnesis sends the message itself.

## Writing a cron that asks Omnesis

When you set up a scheduled job that needs something from Omnesis, write the
prompt so it *describes the question* — "ask Omnesis how this week's training
compares with last week's" — and never so it prescribes a shell command. A prompt
that names the \`omnesis\` CLI will send the run down a path that cannot ask
properly.

Give the job enough time. Do not set a tight per-job timeout on a cron that asks
Omnesis; if you find one already set below about ten minutes, raise it.${
    capabilities.subscriptions ? watchManagementSection() : ""
  }

## Hard rules
${capabilities.subscriptions ? watchRules() : noWatchRule()}
- The connection's OAuth sign-in and the operational device credentials belong to the native integration. Never
  ask the user for them, print them, or try to read the integration state file from a shell.
- The gateway is a remote service the user operates. If a command cannot connect, report the
  error; never try to start, stop, or reconfigure the gateway.
`;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildOpenClawSkill(capabilities: HarnessSkillCapabilities): string {
  const frontmatter = [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${yamlQuote(skillDescription(capabilities))}`,
    `metadata: { "openclaw": { "emoji": "🧠", "requires": { "bins": ["omnesis"] } } }`,
    "---",
    "",
  ].join("\n");
  return frontmatter + skillBody(capabilities);
}

export function buildHermesSkill(capabilities: HarnessSkillCapabilities): string {
  const frontmatter = [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${yamlQuote(skillDescription(capabilities))}`,
    "platforms: [linux, macos]",
    "prerequisites:",
    "  commands: [omnesis]",
    "metadata:",
    "  hermes:",
    "    tags: [personal-data, memory, privacy, omnesis]",
    "---",
    "",
  ].join("\n");
  return frontmatter + skillBody(capabilities);
}

export function buildHarnessSkill(
  harness: Harness,
  capabilities: HarnessSkillCapabilities,
): string {
  switch (harness) {
    case "openclaw":
      return buildOpenClawSkill(capabilities);
    case "hermes":
      return buildHermesSkill(capabilities);
    default:
      return assertNever(harness);
  }
}
