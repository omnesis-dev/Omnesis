// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * LlamaCppCompleter — local LLM text generation via node-llama-cpp.
 * Follows the same lazy-load + auto-unload pattern as the embedder.
 *
 * Generation runs on the main event loop. For a ~150-token completion on a
 * 1.5B model that is ~3-5s of native-call blocking, during which `/admin/*`
 * HTTP handlers stall (visible as `slow GET` warnings in the log). Deployments
 * that care about that latency should assign an HTTP or Anthropic-hosted
 * backend to the role instead, which keeps generation off this process.
 */

import { createLogger, type CompleteCapability } from "@omnesis/core";
import { getLlamaModule, getLlamaInstance } from "../llama-instance.js";
import type { LlamaCompletion, LlamaContext, LlamaModel } from "node-llama-cpp";

const log = createLogger("inference:completer");

function basenameWithoutExt(p: string): string {
  const base = p.split(/[/\\]/).pop() ?? p;
  return base.replace(/\.gguf$/i, "");
}

export class LlamaCppCompleter implements CompleteCapability {
  readonly name = "llama-cpp";
  readonly modelId: string;
  private modelPath: string;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;
  private completion: LlamaCompletion | null = null;
  private unloadTimer?: ReturnType<typeof setTimeout>;
  private unloadTimeoutMs: number;

  constructor(modelPath: string, opts?: { unloadTimeoutMs?: number }) {
    this.modelPath = modelPath;
    this.modelId = basenameWithoutExt(modelPath);
    this.unloadTimeoutMs = opts?.unloadTimeoutMs ?? 60_000;
  }

  async complete(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: readonly string[];
    },
  ): Promise<string> {
    await this.ensureLoaded();
    this.resetUnloadTimer();
    if (!this.completion) throw new Error("completion model not loaded");

    // node-llama-cpp's `LlamaCompletion.generateCompletion` accepts a
    // `customStopTriggers` array of strings/TokenTriggers. Pass our
    // optional `stop` through unchanged; if the caller didn't provide
    // any, omit the option so node-llama-cpp's default behaviour
    // applies. This stops the model the moment it tries to regenerate
    // a `QUERY:` / `SUBJECT:` block past its actual answer.
    const result = await this.completion.generateCompletion(prompt, {
      maxTokens: opts?.maxTokens ?? 150,
      temperature: opts?.temperature ?? 0.3,
      ...(opts?.stop && opts.stop.length > 0 ? { customStopTriggers: [...opts.stop] } : {}),
    });

    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.model) return;

    log.info(`Loading completion model: ${this.modelPath}`);
    const startMs = Date.now();

    const [llama, llamaInstance] = await Promise.all([getLlamaModule(), getLlamaInstance()]);

    this.model = await llamaInstance.loadModel({ modelPath: this.modelPath });
    this.context = await this.model.createContext({ contextSize: "auto" });
    const contextSequence = this.context.getSequence();
    this.completion = new llama.LlamaCompletion({ contextSequence });

    log.info(`Completion model loaded in ${Date.now() - startMs}ms`);
  }

  private resetUnloadTimer(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => this.unload(), this.unloadTimeoutMs);
  }

  private async unload(): Promise<void> {
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = undefined;
    }

    if (this.completion) {
      this.completion = null;
    }
    if (this.context) {
      await this.context.dispose();
      this.context = null;
    }
    if (this.model) {
      await this.model.dispose();
      this.model = null;
    }

    log.info("Completion model unloaded (idle timeout)");
  }

  async dispose(): Promise<void> {
    await this.unload();
    log.info("Completion model disposed");
  }
}
