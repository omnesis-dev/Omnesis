// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { LlamaCppCompleter } from "./llama-cpp-completer.js";

describe("LlamaCppCompleter", () => {
  test("constructor accepts model path", () => {
    const provider = new LlamaCppCompleter("/path/to/model.gguf");
    expect(provider.name).toBe("llama-cpp");
  });

  test("constructor accepts custom unload timeout", () => {
    const provider = new LlamaCppCompleter("/path/to/model.gguf", {
      unloadTimeoutMs: 30_000,
    });
    expect(provider.name).toBe("llama-cpp");
  });

  test("dispose is idempotent (no-op when not loaded)", async () => {
    const provider = new LlamaCppCompleter("/path/to/model.gguf");
    // Should not throw
    await provider.dispose();
    await provider.dispose();
  });
});
