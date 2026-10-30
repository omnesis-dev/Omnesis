// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelConfigModal } from "./model-config.js";

vi.mock("../api.js", () => ({
  getRecentModels: vi.fn(() => Promise.resolve({ entries: [] })),
  getModelCredentialsStatus: vi.fn(),
}));

let host;
let oldDocument;
let oldWindow;
beforeEach(() => {
  oldDocument = globalThis.document;
  oldWindow = globalThis.window;
  const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  host = document.querySelector("#root");
});
afterEach(() => {
  render(null, host);
  if (oldDocument === undefined) delete globalThis.document;
  else globalThis.document = oldDocument;
  if (oldWindow === undefined) delete globalThis.window;
  else globalThis.window = oldWindow;
});

const overview = (backends) => ({
  capabilities: [{ role: "transcriber", title: "Transcriber" }],
  catalog: [],
  presets: [],
  inference: { assignments: {}, backends },
});
const modal = (data, props = {}) =>
  h(ModelConfigModal, { role: "transcriber", capTitle: "Transcriber", overview: data, onClose: () => {}, ...props });
const click = (text) =>
  [...host.querySelectorAll("button")]
    .find((button) => (button.querySelector(".backend-opt-title")?.textContent ?? button.textContent).trim() === text)
    .click();

const refusal = {
  role: "transcriber",
  model: "frozenlab/qwen3-asr:1.7b",
  supported: false,
  detail: "no transcription endpoint (HTTP 404 from /audio/transcriptions). This backend serves chat or embeddings only.",
};

it("says what a transcriber backend must serve before any model is picked", async () => {
  await act(async () =>
    render(modal(overview({ gpu: { type: "http", status: "ok", modelRoles: { "whisper-large-v3-turbo": ["transcriber"] } } })), host),
  );
  await act(async () => click("gpu"));
  expect(host.textContent).toContain("OpenAI audio transcription API");
  expect(host.textContent).toContain("a chat or embedding model cannot transcribe");
  // A model with no verdict is offered as usual.
  expect([...host.querySelectorAll("button")].some((b) => b.textContent.trim() === "Use")).toBe(true);
});

it("offers no Use button for a model the backend has already refused to transcribe with", async () => {
  const pick = vi.fn();
  await act(async () =>
    render(
      modal(
        overview({
          ollama: {
            type: "http",
            status: "ok",
            modelRoles: { "frozenlab/qwen3-asr:1.7b": ["transcriber"] },
            verdicts: [refusal],
          },
        }),
        { onPickHttp: pick },
      ),
      host,
    ),
  );
  await act(async () => click("ollama"));
  expect(host.textContent).toContain("This backend cannot serve transcriber");
  expect(host.textContent).toContain("no transcription endpoint");
  const cannot = [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cannot use");
  expect(cannot).toBeTruthy();
  expect(cannot.disabled).toBe(true);
  // Only the free-text box keeps a Use button; no listed model offers one.
  expect([...host.querySelectorAll(".picker-row .btn-tiny")].some((b) => b.textContent.trim() === "Use")).toBe(false);
  expect(pick).not.toHaveBeenCalled();
});

it("keeps offering a model whose verdict was inconclusive or for another role", async () => {
  await act(async () =>
    render(
      modal(
        overview({
          gpu: {
            type: "http",
            status: "ok",
            modelRoles: { whisper: ["transcriber"] },
            verdicts: [
              { role: "transcriber", model: "whisper", supported: false, inconclusive: true, detail: "fetch failed" },
              { role: "agent", model: "whisper", supported: false, detail: "HTTP 404" },
            ],
          },
        }),
      ),
      host,
    ),
  );
  await act(async () => click("gpu"));
  expect(host.textContent).not.toContain("cannot serve transcriber");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent.trim() === "Use")).toBe(true);
});
