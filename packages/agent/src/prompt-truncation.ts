// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
/**
 * Detection of a model server that cut the prompt down to its context window
 * instead of refusing the request.
 *
 * Ollama's OpenAI-compatible endpoint does this by default: a request longer
 * than the model's configured context is trimmed from the front, which is
 * where the system prompt and the tool definitions sit, and the response
 * carries no error — only a `prompt_tokens` count far below what was sent.
 * The agent's instructions and tools alone run to well over ten thousand
 * tokens, so a 4k window (the server's default on small hardware) leaves
 * the model answering a prompt it never saw.
 *
 * The check is a floor, not an estimate: no tokenizer averages anywhere near
 * {@link PROMPT_FLOOR_CHARS_PER_TOKEN} characters per token on prose or JSON,
 * so a server reporting fewer prompt tokens than the request's characters
 * divided by that number did not evaluate the whole prompt. Runs of the same
 * character (whitespace padding, rules of dashes) are collapsed first, since
 * tokenizers fold them into single tokens.
 *
 * The floor is deliberately lenient about what it counts, because a false
 * positive fails a turn that would otherwise have succeeded. Only the
 * messages count, never the tool definitions, and a nominal count from a
 * server that does not meter prompts at all is ignored.
 */
/** Characters per token no tokenizer reaches on ordinary prompt text. */
export const PROMPT_FLOOR_CHARS_PER_TOKEN = 8;
/**
 * Requests whose floor is below this are never judged: no context window is
 * that small, and on a short request the count is dominated by what the
 * server's template adds around it.
 */
export const PROMPT_TRUNCATION_MIN_FLOOR_TOKENS = 1_024;
/**
 * Reported counts below this are never judged. A server that cut the prompt
 * still evaluated a window of it (Ollama keeps half its context for the
 * prompt, so even a 1k window reports five hundred-odd tokens); a count far
 * under that comes from a server or proxy that does not meter prompt tokens,
 * and says nothing about truncation.
 */
export const PROMPT_TRUNCATION_MIN_REPORTED_TOKENS = 512;
/** The fewest tokens a prompt of `text` can tokenize to, by that floor. */
export function promptTokenFloor(text: string): number {
  const collapsed = text.replace(/(.)\1+/gs, "$1");
  return Math.floor(collapsed.length / PROMPT_FLOOR_CHARS_PER_TOKEN);
}
/** A chat-completions message as far as its prompt text is concerned. */
export interface PromptMessageText {
  content: string | null;
  tool_calls?: ReadonlyArray<{ function: { name: string; arguments: string } }>;
  reasoning_content?: string;
}
/**
 * The text the messages of a chat-completions request put in front of the
 * model: every message's content, replayed tool calls and reasoning. The
 * JSON envelope around them is left out, so a short request is not padded
 * by field names.
 *
 * The tool definitions are left out too, although a model server tokenizes
 * them: a proxy that meters usage itself may count the messages alone, and
 * a floor that charged it for the tools would fail every tool-bearing turn
 * it serves. The instructions and the conversation on their own outweigh
 * the small windows this check exists to catch.
 */
export function promptText(messages: ReadonlyArray<PromptMessageText>): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.content) parts.push(m.content);
    if (m.reasoning_content) parts.push(m.reasoning_content);
    for (const call of m.tool_calls ?? []) parts.push(call.function.name, call.function.arguments);
  }
  return parts.join("\n");
}
export interface PromptTruncation {
  /** Prompt tokens the server reported evaluating. */
  reportedPromptTokens: number;
  /** The fewest tokens the request could hold. */
  promptTokenFloor: number;
}
/**
 * A server-reported prompt token count that a request of `text` cannot
 * explain, or `undefined` when the count is plausible or absent (zero,
 * missing or nominal usage says nothing about the prompt).
 */
export function detectPromptTruncation(
  text: string,
  reportedPromptTokens: number | undefined,
): PromptTruncation | undefined {
  if (!reportedPromptTokens || reportedPromptTokens < PROMPT_TRUNCATION_MIN_REPORTED_TOKENS) {
    return undefined;
  }
  const floor = promptTokenFloor(text);
  if (floor < PROMPT_TRUNCATION_MIN_FLOOR_TOKENS || reportedPromptTokens >= floor) return undefined;
  return { reportedPromptTokens, promptTokenFloor: floor };
}
/** The failure message, worded for the operator who runs the server. */
export function promptTruncationMessage(t: PromptTruncation): string {
  return (
    `The model server evaluated ${t.reportedPromptTokens} prompt tokens of a request holding at least ` +
    `${t.promptTokenFloor}: it truncated the prompt to its context window instead of refusing it, ` +
    `so the model answered without its instructions and tools. Raise the server's context length ` +
    `(for Ollama, OLLAMA_CONTEXT_LENGTH or a Modelfile num_ctx) to fit the agent's requests.`
  );
}
