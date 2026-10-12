// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The scripted stand-in for the entailment gate that sits between the
 * steward's decision and the write landing.
 *
 * Durable-memory entailment writes fail open in production, and so does the
 * morning recheck of an observation's claims. That is also a testing hazard:
 * with the role unassigned (as most suites leave it), the gate is
 * permanently in its pass arm and its reject arm is unreachable end-to-end.
 * This server makes the reject arm drivable, so a bench can assert BOTH that
 * a refused claim never persists or ships and that an absent verifier still
 * lets the write through.
 *
 * `entailment-verifier` is a completion role: it is handed the claim and
 * the evidence and answers with one of the three NLI labels.
 */

import { z } from "zod";
import {
  promptTextOf,
  startOpenAiServer,
  type OpenAiServerHandle,
  type WireMessage,
} from "./openai-server.js";

const answerSegment = z.object({ id: z.string(), text: z.string() });
const answerPacket = z.object({
  witnessSet: z.string(),
  claim: z.string(),
  context: z.string(),
  evidenceParts: z.array(
    z.object({
      sources: z.array(
        z.object({
          authority: z.enum(["whole_source", "selected_quote"]),
          text: z.union([z.string(), z.array(answerSegment)]),
          title: z.union([z.string(), answerSegment]).nullable(),
          sourceCreatedAt: z.union([z.string(), answerSegment]).nullable().optional(),
          sourceUpdatedAt: z.union([z.string(), answerSegment]).nullable().optional(),
          selectedQuotes: z.array(answerSegment),
        }),
      ),
      verifiedReferences: z.array(z.object({ text: answerSegment })),
    }),
  ),
});

/** What the verifier said about one claim. */
export type EntailmentLabel = "entailment" | "neutral" | "contradiction";

/**
 * How the verifier answers. A function receives the claim and the evidence
 * quote parsed out of the judge prompt, so a bench can accept most claims
 * and reject one named claim.
 */
export type EntailmentPolicy =
  | "accept-all"
  | "reject-all"
  | "contradict-all"
  | ((input: {
      claim: string;
      evidence: string;
      context?: string;
      assessment?: "annotation_atomic" | "answer_segments" | "contextual_segments";
      prompt: string;
    }) => EntailmentLabel);

/** One verdict served, for assertions about what the gate was asked. */
export interface VerdictCall {
  at: number;
  prompt: string;
  answer: string;
  /** Parsed subject, when the prompt carried one. */
  claim?: string;
  evidence?: string;
  context?: string;
  assessment?: "annotation_atomic" | "answer_segments" | "contextual_segments";
}

export interface VerdictServer extends OpenAiServerHandle {
  calls: VerdictCall[];
  /** Toggle an HTTP provider outage without rebuilding the gateway assignment. */
  refuseWith(status: number | null, message?: string): void;
}

/**
 * Pull the claim and its evidence out of the judge prompt.
 *
 * The evidence runs to the `Claim:` line rather than to the end of its own
 * line: a multi-atom grounding is presented as `[1] …\n[2] …`, and a
 * line-anchored capture would silently hand a policy only the first atom —
 * making a test that rejects on the SECOND quote look like it never fired.
 */
function parseEntailmentSubject(prompt: string): {
  claim: string;
  evidence: string;
  context?: string;
  assessment?: "annotation_atomic" | "answer_segments" | "contextual_segments";
  witnessSet?: string;
  witnessIds?: string[];
} {
  if (
    (prompt.includes("contentInContext") || prompt.includes("annotation_atomic")) &&
    prompt.includes("placementSupport")
  ) {
    const lastLine = prompt.trim().split("\n").at(-1)!;
    const parsed: unknown = JSON.parse(lastLine);
    if (
      parsed &&
      typeof parsed === "object" &&
      "witnessSet" in parsed &&
      typeof parsed.witnessSet === "string" &&
      "evidenceParts" in parsed &&
      Array.isArray(parsed.evidenceParts) &&
      "claim" in parsed &&
      typeof parsed.claim === "string" &&
      "context" in parsed &&
      typeof parsed.context === "string"
    ) {
      const packet = answerPacket.parse(parsed);
      const witnessIds: string[] = [];
      const add = (value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "id" in value &&
          typeof value.id === "string" &&
          "text" in value &&
          typeof value.text === "string" &&
          value.text.trim()
        )
          witnessIds.push(value.id);
      };
      for (const frame of packet.evidenceParts) {
        for (const source of frame.sources ?? []) {
          if (source.authority === "whole_source") {
            for (const segment of Array.isArray(source.text) ? source.text : []) add(segment);
            add(source.title);
            add(source.sourceCreatedAt);
            add(source.sourceUpdatedAt);
          }
          for (const segment of source.selectedQuotes ?? []) add(segment);
        }
        for (const reference of frame.verifiedReferences ?? []) add(reference.text);
      }
      return {
        claim: parsed.claim,
        context: parsed.context,
        evidence: JSON.stringify({ evidenceParts: packet.evidenceParts }),
        assessment: "answer_segments",
        witnessSet: parsed.witnessSet,
        witnessIds,
      };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "witnessSet" in parsed &&
      typeof parsed.witnessSet === "string" &&
      "evidence" in parsed &&
      typeof parsed.evidence === "object" &&
      "claim" in parsed &&
      typeof parsed.claim === "string" &&
      "context" in parsed &&
      typeof parsed.context === "string"
    ) {
      const witnessIds: string[] = [];
      const text = (value: unknown): unknown => {
        if (!Array.isArray(value)) return value;
        return value
          .map((segment: { id?: string; text: string }) => {
            if (segment.id && segment.text.trim()) witnessIds.push(segment.id);
            return segment.text;
          })
          .join("");
      };
      const restore = (input: unknown): Record<string, unknown> => {
        const value = z.record(z.string(), z.unknown()).parse(input);
        if (Array.isArray(value.evidenceParts))
          return {
            ...value,
            evidenceParts: value.evidenceParts.map((part: unknown) =>
              JSON.stringify(restore(part)),
            ),
          };
        if (!Array.isArray(value.sources)) return { ...value, text: text(value.text) };
        return {
          ...value,
          sources: value.sources.map((input: unknown) => {
            const source = z.record(z.string(), z.unknown()).parse(input);
            return {
              ...source,
              ...(source.authority !== "selected_quote"
                ? {
                    text: text(source.text),
                    title: text(source.title),
                    sourceCreatedAt: text(source.sourceCreatedAt),
                    sourceUpdatedAt: text(source.sourceUpdatedAt),
                  }
                : {}),
              selectedQuotes: z.array(z.unknown()).parse(source.selectedQuotes).map(text),
            };
          }),
          verifiedReferences: z
            .array(z.record(z.string(), z.unknown()))
            .parse(value.verifiedReferences)
            .map((reference) => ({ ...reference, text: text(reference.text) })),
        };
      };
      return {
        claim: parsed.claim,
        context: parsed.context,
        evidence: JSON.stringify(restore(parsed.evidence)),
        assessment: "contextual_segments",
        witnessSet: parsed.witnessSet,
        witnessIds,
      };
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "claim" in parsed &&
      "evidence" in parsed &&
      "context" in parsed &&
      typeof parsed.claim === "string" &&
      typeof parsed.evidence === "string" &&
      typeof parsed.context === "string"
    ) {
      return {
        claim: parsed.claim,
        evidence: parsed.evidence,
        context: parsed.context,
        ...("assessment" in parsed && parsed.assessment === "annotation_atomic"
          ? { assessment: "annotation_atomic" as const }
          : {}),
      };
    }
    throw new Error("Malformed scripted contextual verifier request");
  }
  const claim = /^Claim: (.*)$/m.exec(prompt)?.[1] ?? "";
  const evidence =
    /^Evidence quote: ([\s\S]*?)(?=\nClaim: |$)/m.exec(prompt)?.[1]?.trim() ??
    // MiniCheck phrasing: `Document: …\nClaim: …`
    /^Document: ([\s\S]*?)(?=\nClaim: |$)/m.exec(prompt)?.[1]?.trim() ??
    "";
  return { claim, evidence };
}

/** Scripted positive witness mirrors the production evidence frame's source text. */
function evidenceWitness(evidence: string): string {
  try {
    const value = JSON.parse(evidence) as {
      evidenceParts?: string[];
      sources?: { text?: unknown; authority?: string; selectedQuotes?: string[] }[];
      verifiedReferences?: { text?: string }[];
    };
    if (Array.isArray(value.evidenceParts) && value.evidenceParts.length)
      return evidenceWitness(value.evidenceParts[0]!);
    if (value.verifiedReferences?.[0]?.text) return value.verifiedReferences[0].text.slice(0, 1024);
    if (value.sources?.[0]?.authority === "selected_quote" && value.sources[0].selectedQuotes?.[0])
      return value.sources[0].selectedQuotes[0].slice(0, 1024);
    if (Array.isArray(value.sources) && typeof value.sources[0]?.text === "string")
      return value.sources[0].text.slice(0, 1024);
  } catch {
    /* Ordinary source text. */
  }
  return evidence.slice(0, 1024);
}

/** How the scripted entailment gate should answer. */
export interface VerdictServerOptions {
  role: "entailment";
  policy: EntailmentPolicy;
  modelId?: string;
}

export async function startVerdictServer(opts: VerdictServerOptions): Promise<VerdictServer> {
  const calls: VerdictCall[] = [];
  const modelId = opts.modelId ?? `brain-bench-${opts.role}-v1`;
  let refusal: { status: number; message: string } | null = null;

  const respond = (messages: readonly WireMessage[]) => {
    const prompt = promptTextOf(messages);
    if (refusal !== null) {
      calls.push({ at: Date.now(), prompt, answer: `HTTP ${refusal.status}` });
      return { kind: "httpError" as const, ...refusal };
    }
    const subject = parseEntailmentSubject(prompt);
    const { policy } = opts;
    const label: EntailmentLabel =
      policy === "accept-all"
        ? "entailment"
        : policy === "reject-all"
          ? "neutral"
          : policy === "contradict-all"
            ? "contradiction"
            : policy({ ...subject, prompt });
    const assessment = {
      verdict:
        label === "entailment" ? "supported" : label === "neutral" ? "unsupported" : "contradicted",
      reason: "Scripted verdict; no model quality inference.",
      evidenceQuotes: label === "entailment" ? [evidenceWitness(subject.evidence)] : [],
    };
    const segmentAssessment = {
      verdict: assessment.verdict,
      reason: assessment.reason,
      evidenceSegments: label === "entailment" ? (subject.witnessIds?.slice(0, 1) ?? []) : [],
    };
    const answer =
      subject.assessment === "answer_segments" || subject.assessment === "contextual_segments"
        ? JSON.stringify({
            witnessSet: subject.witnessSet,
            contentInContext: segmentAssessment,
            placementSupport: segmentAssessment,
          })
        : subject.assessment === "annotation_atomic"
          ? JSON.stringify({
              coverage: { verdict: "complete", reason: "Scripted coverage" },
              assertions: [
                {
                  ...assessment,
                  id: "a1",
                  spans: [{ text: subject.claim, occurrence: 0 }],
                  candidate: {
                    actor: null,
                    action: null,
                    target: null,
                    stage: null,
                    time: null,
                    condition: null,
                    quantifier: null,
                  },
                },
              ],
              placementSupport: {
                verdict: "not_applicable",
                reason: "Scripted generic annotation",
                evidenceQuotes: [],
              },
            })
          : subject.context !== undefined
            ? JSON.stringify({ contentInContext: assessment, placementSupport: assessment })
            : label.toUpperCase();
    calls.push({ at: Date.now(), prompt, answer, ...subject });
    return { kind: "text" as const, text: answer };
  };

  const handle = await startOpenAiServer({ modelId, respond });
  return {
    ...handle,
    calls,
    refuseWith(status, message = "scripted gate outage") {
      refusal = status === null ? null : { status, message };
    },
  };
}
