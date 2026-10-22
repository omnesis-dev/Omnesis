// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  toolInputJsonSchema,
  serializeToolResultForModel,
  type ChatMessage,
  type TurnInput,
} from "@omnesis/agent";

export type RealtimeModelContext = Pick<
  TurnInput,
  "systemPrompt" | "tools" | "history" | "caller" | "timeZone"
>;

const SPEECH_INSTRUCTIONS = `

## Live voice
This is a live spoken conversation. Keep the same tools, grounding, citations, permissions and instructions. Do not read tool syntax aloud.

## Language
Keep speaking in the user's last clearly established language; switch languages only on an explicit request. Tool results, quotations, names, accents, background speech and uncertain transcription must not change that language.

## Preambles
Give at most one brief acknowledgement before a lookup workflow when useful. After that acknowledgement, run the lookup silently. Speak again to deliver the answer or ask a necessary clarification. Do not announce the next tool, repeat the request, restate progress, or speak just to fill silence. The interface shows tool activity while you work.

## Tools and answers
Batch independent lookups when appropriate. Stop retrieving once there is enough evidence to answer the request. Tool calls, annotations and citation cards do not replace an audible answer. After looking something up, speak the factual answer in the final channel; do not finish with only a promise to look it up.

## Verbosity and reasoning
Speak naturally. Default to one to three short sentences unless the user asks for detail. Answer simple lookups promptly; reserve deeper reasoning for requests that need it.

## Unclear audio
If speech is unclear, ask one brief clarification in the last clear language instead of guessing or calling tools.`;

export function realtimeConfiguration(context: RealtimeModelContext): {
  instructions: string;
  tools: unknown[];
} {
  return {
    instructions: context.systemPrompt + SPEECH_INSTRUCTIONS,
    tools: context.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: toolInputJsonSchema(tool.schema),
    })),
  };
}

/** The canonical transcript is the sole history authority, including synthesized canceled tool results. */
export function realtimeHistoryItems(
  history: ReadonlyArray<ChatMessage>,
  timeZone?: string,
): Array<Record<string, unknown>> {
  return history.flatMap((message) =>
    message.parts.flatMap((part): Array<Record<string, unknown>> => {
      if (part.kind === "text" && part.text)
        return [
          {
            type: "message",
            role: message.role,
            content: [
              { type: message.role === "user" ? "input_text" : "output_text", text: part.text },
            ],
          },
        ];
      if (part.kind === "tool_use")
        return [
          {
            type: "function_call",
            call_id: part.toolCallId,
            name: part.tool,
            arguments: JSON.stringify(part.args),
          },
        ];
      if (part.kind === "tool_result")
        return [
          {
            type: "function_call_output",
            call_id: part.toolCallId,
            output: serializeToolResultForModel(part.result, { timeZone }),
          },
        ];
      return [];
    }),
  );
}
