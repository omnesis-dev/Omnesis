// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Owns the entailment-verifier capability lifecycle for the gateway: resolve
 * the assignment fresh on every use, cache the loaded capability under a
 * stable signature of the resolution, and reload (disposing the old instance)
 * when the signature changes — so assigning or swapping the verifier model
 * from the portal takes effect on the next annotation write without a
 * gateway restart. An unset assignment resolves to null, which callers treat
 * as "gate absent".
 *
 * Every load, dispose, AND verify runs serialized through one tail promise —
 * the same fence TranscribeService uses — so a config swap can never dispose
 * a capability while a verify() is executing against it (for the local GGUF
 * path that would tear down a native llama.cpp context mid-generation).
 * Verifier traffic is low-QPS write-path work, so serialization costs
 * nothing observable.
 */

import { createHash } from "node:crypto";
import { assertNever, type EntailCapability, type ResolvedAssignment } from "@omnesis/core";
import { loadEntailmentFromResolved, type LoadEntailmentDeps } from "./entailment-loader.js";

/**
 * Stable signature for a resolved assignment, to detect config changes. The
 * http arm folds in everything a backend edit can change under the same
 * backendKey — url, path prefix, the egress flag, and an API-key fingerprint
 * — so editing a backend (or flipping `allowRemoteInference`) forces a
 * reload instead of silently reusing a completer built against the old
 * transport snapshot.
 */
function signatureOf(resolved: ResolvedAssignment, apiKey: string | undefined): string {
  switch (resolved.kind) {
    case "local":
      return `local:${resolved.catalogId}:${resolved.modelPath}:${resolved.available}`;
    case "replay":
      return `replay:${resolved.fixture ?? ""}`;
    case "http": {
      const keyPrint = createHash("sha256")
        .update(apiKey ?? "")
        .digest("hex")
        .slice(0, 8);
      return `http:${resolved.backendKey}:${resolved.url}:${resolved.apiPathPrefix ?? ""}:${resolved.model}:${resolved.available}:${resolved.allowRemoteInference}:${keyPrint}`;
    }
    case "anthropic":
      return `anthropic:${resolved.catalogId}:${resolved.available}:${resolved.allowRemoteInference}`;
    case "codex":
      return `codex:${resolved.model}:${resolved.available}:${resolved.allowRemoteInference}`;
    case "disabled":
      return "disabled";
    case "unresolved":
      return "unresolved";
    default:
      return assertNever(resolved);
  }
}

export class EntailmentVerifierService {
  private readonly resolveAssignment: () => ResolvedAssignment;
  private readonly deps: LoadEntailmentDeps;
  private current: { signature: string; capability: EntailCapability | null } | null = null;
  /** The serialization fence: every load/dispose/verify chains onto it. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * The stable facade handed to callers. Its verify() re-resolves the
   * assignment through the fence on every call, so callers can hold it
   * across config swaps without ever touching a disposed instance.
   */
  private readonly facade: EntailCapability = {
    verify: (input) =>
      this.enqueue(async () => {
        const capability = await this.ensureLoaded();
        if (!capability) throw new Error("entailment verifier unavailable");
        return capability.verify(input);
      }),
    dispose: () => {
      // Lifecycle is owned by the service (see dispose() below).
    },
  };

  constructor(opts: { resolveAssignment: () => ResolvedAssignment; deps: LoadEntailmentDeps }) {
    this.resolveAssignment = opts.resolveAssignment;
    this.deps = opts.deps;
  }

  /**
   * The live verifier for the current assignment, or null when the role is
   * unset/unloadable. Re-resolves per call; loads at most once per signature.
   */
  async get(): Promise<EntailCapability | null> {
    const capability = await this.enqueue(() => this.ensureLoaded());
    return capability ? this.facade : null;
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      const capability = this.current?.capability ?? null;
      this.current = null;
      if (capability) await Promise.resolve(capability.dispose()).catch(() => {});
    });
  }

  /** Runs on the fence only — never call outside enqueue(). */
  private async ensureLoaded(): Promise<EntailCapability | null> {
    const resolved = this.resolveAssignment();
    const apiKey =
      resolved.kind === "http" ? this.deps.getBackendApiKey?.(resolved.backendKey) : undefined;
    const signature = signatureOf(resolved, apiKey);
    if (this.current && this.current.signature === signature) {
      return this.current.capability;
    }
    // Serialized with every verify(), so nothing can be mid-call here.
    const previous = this.current?.capability ?? null;
    if (previous) await Promise.resolve(previous.dispose()).catch(() => {});
    const capability = await loadEntailmentFromResolved(resolved, this.deps);
    this.current = { signature, capability };
    return capability;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }
}
