// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { wrapEvent, type ChatBackend, type TurnInput } from "@omnesis/agent";
import { CodexOcr } from "./codex-ocr.js";
import { loadOcrFromResolved, type LoadOcrDeps } from "./loader.js";
import { OcrService, type OcrServiceDeps } from "./ocr-service.js";
import type { ResolvedCodex } from "@omnesis/core";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const assignment: ResolvedCodex = {
  role: "ocr",
  kind: "codex",
  model: "vision-fixture",
  available: true,
  allowRemoteInference: true,
};

function backend(
  text: string,
  before?: () => Promise<void>,
): ChatBackend & { inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  return {
    name: "codex",
    model: "vision-fixture",
    inputs,
    async *runTurn(input) {
      inputs.push(input);
      await before?.();
      yield wrapEvent("agent.text.delta", {
        sessionId: input.sessionId,
        messageId: input.messageId,
        delta: text,
      });
      yield wrapEvent("agent.message.end", {
        sessionId: input.sessionId,
        messageId: input.messageId,
        stopReason: "end_turn",
      });
    },
  };
}

describe("Codex OCR", () => {
  it("sends image bytes inline on a tool-free fresh turn", async () => {
    const model = backend("  INVENTED LABEL\nSecond line  ");
    const ocr = new CodexOcr({ backend: model });
    expect(await ocr.recognize(png, "image/png")).toEqual({ text: "INVENTED LABEL\nSecond line" });
    expect(model.inputs[0]).toMatchObject({
      tools: [],
      history: [],
      images: [{ url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` }],
    });
  });

  it("accepts a successful empty transcription", async () => {
    const ocr = new CodexOcr({ backend: backend("") });
    expect(await ocr.recognize(png, "image/png")).toEqual({ text: "" });
  });

  it("propagates failures so an unavailable backend does not silently drop an image", async () => {
    const ocr = new CodexOcr({
      backend: backend("", async () => {
        throw new Error("offline");
      }),
    });
    await expect(ocr.recognize(png, "image/png")).rejects.toThrow("offline");
  });

  it("bounds a stalled recognition by a deadline", async () => {
    const ocr = new CodexOcr({
      backend: backend("", () => new Promise(() => {})),
      timeoutMs: 10,
    });
    await expect(ocr.recognize(png, "image/png")).rejects.toThrow("timed out");
  });

  it("does not create a runtime for an unavailable assignment", async () => {
    const createCodexBackend = vi.fn().mockReturnValue(backend(""));
    const deps = {
      codexRuntimeService: { createBackend: createCodexBackend },
    } satisfies LoadOcrDeps;
    expect(await loadOcrFromResolved({ ...assignment, available: false }, deps)).toBeNull();
    expect(createCodexBackend).not.toHaveBeenCalled();
    expect(await loadOcrFromResolved(assignment)).toBeNull();
    expect(await loadOcrFromResolved(assignment, deps)).toBeInstanceOf(CodexOcr);
  });

  it("refuses a discovered text-only model, including after a catalog refresh", async () => {
    const model = backend("Recognized text");
    let inputModalities: Array<"text" | "image"> = ["text", "image"];
    const snapshot = () => ({
      type: "codex" as const,
      configured: true,
      loggedIn: true,
      status: "ok" as const,
      models: [model.model],
      modelDetails: [
        { id: model.model, model: model.model, displayName: model.model, inputModalities },
      ],
    });
    const createBackend = vi.fn().mockReturnValue(model);
    const deps = { codexRuntimeService: { createBackend, snapshot } } satisfies OcrServiceDeps;
    const service = new OcrService({ resolveAssignment: () => assignment, deps });
    expect(await service.recognize(png, "image/png")).toEqual({ text: "Recognized text" });
    inputModalities = ["text"];
    expect(await service.recognize(png, "image/png")).toBeNull();
    expect(await loadOcrFromResolved(assignment, deps)).toBeNull();
    expect(createBackend).toHaveBeenCalledTimes(1);
  });

  it("stops sending images when cloud permission is revoked for a cached assignment", async () => {
    const model = backend("Earlier image");
    let resolved = assignment;
    const createBackend = vi.fn().mockReturnValue(model);
    const deps = { codexRuntimeService: { createBackend } } satisfies OcrServiceDeps;
    const service = new OcrService({ resolveAssignment: () => resolved, deps });
    expect(await service.recognize(png, "image/png")).toEqual({ text: "Earlier image" });
    resolved = { ...assignment, allowRemoteInference: false };
    expect(await service.recognize(png, "image/png")).toBeNull();
    expect(model.inputs).toHaveLength(1);
    expect(createBackend).toHaveBeenCalledTimes(1);
  });

  it("rasterizes PDF pages and preserves page alignment through Codex", async () => {
    const model = backend("Page text");
    const deps = {
      codexRuntimeService: { createBackend: vi.fn().mockReturnValue(model) },
      rasterizePdf: async () => [png, png],
    } satisfies OcrServiceDeps;
    const service = new OcrService({ resolveAssignment: () => assignment, deps });
    expect(
      await service.recognize(new Uint8Array([1]), "application/pdf", { pages: [2] }),
    ).toMatchObject({ pageTexts: ["", "Page text"], pages: 2 });
    expect(model.inputs).toHaveLength(1);
  });

  it("lets an active recognition finish when its assignment is replaced", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = backend("Earlier page", () => pending);
    const ocr = new CodexOcr({ backend: model });
    const result = ocr.recognize(png, "image/png");
    await ocr.dispose();
    release();
    expect(await result).toEqual({ text: "Earlier page" });
  });
});
