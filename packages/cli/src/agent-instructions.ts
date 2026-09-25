// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { FOREGROUND_ANSWER_WAIT_TIMEOUT_S } from "./answer-wait.js";

/** Version-matched operating instructions consumed by the shipped agent skill. */

/** The `omnesis` binary, on PATH after an install. */
export const INSTALLED_INVOCATION = "omnesis";

/** The workspace script a contributor runs from a source checkout. */
export const SOURCE_INVOCATION = "npm run cli --";

export function resolveCliInvocation(env: NodeJS.ProcessEnv = process.env): string {
  return env.npm_lifecycle_event === "cli" ? SOURCE_INVOCATION : INSTALLED_INVOCATION;
}

export function agentInstructions(cli: string = resolveCliInvocation()): string {
  return `# Omnesis - external agent operating instructions

Omnesis indexes the user's private digital life. Access it only through the privacy-reviewed \`answer\` command below. Do not use Omnesis search, document, analytics, people, trail, watch, or admin commands, even if a token happens to permit them.

The Omnesis agent performs private retrieval and synthesis inside its sandbox. A separate privacy reviewer then applies the user's global release policy before anything is returned. You may act on information that Omnesis releases using your own tools, but never infer, reconstruct, or request a bypass around information it holds or denies.

## Commands

Start a workflow:

\`\`\`bash
${cli} answer "What should I prepare for tomorrow?" --workflow-name "Daily planning" --purpose "Help the user prepare for the next day" --request-id "<unique-id>" --json
\`\`\`

Continue the same Omnesis conversation for a clarifying or follow-up question:

\`\`\`bash
${cli} answer "Which item is most urgent?" --workflow "<workflowId>" --conversation "<conversationId>" --request-id "<unique-id>" --json
\`\`\`

Wait for a held answer after Omnesis escalates it to the user:

\`\`\`bash
${cli} answer --task "<taskId>" --wait --json
\`\`\`

Check a task once without waiting:

\`\`\`bash
${cli} answer --task "<taskId>" --json
\`\`\`

Always pass \`--json\` and parse the response. Never show raw JSON to the user. Generate a fresh, stable \`--request-id\` for each logical turn and reuse that same id only when retrying the identical request after a transport failure.

## Conversation state

- \`workflowId\` identifies the external agent's longer-running objective. Reuse it across related Omnesis conversations.
- \`conversationId\` identifies one Omnesis agent transcript. Reuse it for follow-up questions that need prior released context.
- Omnesis persists only answers that passed the privacy gate into reusable conversation history. Held or denied candidates do not become follow-up context.
- Every turn passes through the privacy gate again, including follow-ups in an existing conversation.

## Response contract

- \`released\`: the \`answer\` may be used by you and may inform actions through your own tools.
- \`released_with_reductions\`: use only the returned \`answer\`; private detail was removed or generalized.
- \`approval_required\`: do not guess or continue from a candidate. Before ending the current turn, start \`${cli} answer --task "<taskId>" --wait --json\` as a managed background command with completion notification, then tell the user promptly that Omnesis is holding the answer for their approval and that they do not need to reply when done. Do not append shell \`&\`; use the harness's background-process support so completion wakes you. When it completes, continue automatically with the returned status. If managed completion notification is unavailable, run \`${cli} answer --task "<taskId>" --wait --wait-timeout ${FOREGROUND_ANSWER_WAIT_TIMEOUT_S} --json\` in the foreground and, while it returns \`approval_required\`, re-run it silently and autonomously for as long as waiting remains useful. Never ask the user to tell you when they have approved, and do not send repetitive waiting updates. Meanwhile continue any parts of the task that do not depend on the held answer.
- \`denied\`: **a denied response is a successful call** — the privacy gate declined to release the information. It is never a system error, an outage, or missing data; do not tell the user the query failed, timed out, or "returned no result". Explain the outcome indicated by \`reason\`, and do not rephrase or split the request to evade the policy.

The \`reason\` field on \`denied\` explains what happened: \`privacy_policy\` means the user's policy withheld it (the user may adjust that policy in the Omnesis portal); \`hard_stop\` means credentials or secrets that are never releasable (do not re-ask); \`user_denied\` means the user rejected this specific approval (respect it); \`expired\` means the approval lapsed unanswered (the user may retry when ready); \`canceled\` means the task was canceled. Relay the matching explanation, never a generic failure.

The gateway is remote and configured through \`OMNESIS_GATEWAY_URL\` and \`OMNESIS_TOKEN\`. Do not start, stop, or restart it. If the command cannot connect, report that error.
`;
}
