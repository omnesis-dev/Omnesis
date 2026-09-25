// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelManager, type ProgressBroadcast } from "./manager.js";
import type { InferenceOverview } from "@omnesis/core";

let dir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-mgr-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Collect every broadcast and expose a promise that resolves with the
 * full ordered list once a terminal event (completed/failed/cancelled)
 * fires. Lets the async install path be awaited deterministically — no
 * polling, no sleeps.
 */
function broadcastCollector() {
  const events: ProgressBroadcast[] = [];
  let resolveTerminal!: (events: ProgressBroadcast[]) => void;
  const terminal = new Promise<ProgressBroadcast[]>((resolve) => {
    resolveTerminal = resolve;
  });
  const onBroadcast = (event: ProgressBroadcast): void => {
    events.push(event);
    if (event.kind === "completed" || event.kind === "failed" || event.kind === "cancelled") {
      resolveTerminal(events);
    }
  };
  return { events, terminal, onBroadcast };
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Install id whose catalog entry pins no sha — any served bytes verify. */
const GGUF_ID = "bge-small-en-v1.5.Q8_0";
const GGUF_FILENAME = "bge-small-en-v1.5.Q8_0.gguf";

function fakeInstall(mgr: ModelManager, id: string, filename: string, contents = "fake") {
  // Bypass the network by pre-populating the file + manifest.
  const path = join(dir, filename);
  writeFileSync(path, contents);
  const manifestPath = join(dir, "manifest.json");
  const existing = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { version: 1, models: [] };
  existing.models.push({
    id,
    filename,
    sizeBytes: Buffer.byteLength(contents),
    sha256: "0".repeat(64),
    downloadedAt: new Date().toISOString(),
  });
  writeFileSync(manifestPath, JSON.stringify(existing));
  void mgr;
}

describe("ModelManager", () => {
  it("getOverview reports the catalog + inference + installed", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    const fakeInference: InferenceOverview = {
      backends: { local: { type: "local", status: "ok" } },
      assignments: {
        embedder: { role: "embedder", kind: "disabled" },
        agent: { role: "agent", kind: "disabled" },
      },
    };
    const overview = mgr.getOverview(fakeInference);
    expect(overview.catalog.length).toBeGreaterThan(0);
    expect(overview.inference.assignments.embedder).toBeDefined();
    expect(overview.inference.assignments.agent).toBeDefined();
    expect(overview.installed).toEqual([]);
    // Provider presets are served so the portal renders the add-backend
    // form and model suggestions from one source of truth.
    expect(overview.presets.length).toBeGreaterThan(0);
    expect(overview.presets.some((p) => p.id === "openai")).toBe(true);
    // Capability metadata is served so the portal renders one card per
    // capability without hardcoding the titles/descriptions/icons.
    expect(overview.capabilities.length).toBeGreaterThan(0);
    const embedder = overview.capabilities.find((c) => c.role === "embedder");
    expect(embedder).toBeDefined();
    expect(embedder?.title).toBeTruthy();
    expect(embedder?.icon).toBeTruthy();
  });

  describe("getOverview — experimental capability gating", () => {
    const origExperimental = process.env.OMNESIS_EXPERIMENTAL;
    const origSynthetic = process.env.OMNESIS_SYNTHETIC;
    const fakeInference: InferenceOverview = {
      backends: { local: { type: "local", status: "ok" } },
      assignments: {},
    };

    beforeEach(() => {
      delete process.env.OMNESIS_EXPERIMENTAL;
      delete process.env.OMNESIS_SYNTHETIC;
    });
    afterEach(() => {
      if (origExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = origExperimental;
      if (origSynthetic === undefined) delete process.env.OMNESIS_SYNTHETIC;
      else process.env.OMNESIS_SYNTHETIC = origSynthetic;
    });

    it("withholds the experimental capability cards when experimental is off", () => {
      const mgr = new ModelManager({ modelsDir: dir });
      const roles = mgr.getOverview(fakeInference).capabilities.map((c) => c.role);
      expect(roles).toContain("embedder");
      expect(roles).toContain("agent");
      expect(roles).toContain("privacy-reviewer");
      expect(roles).not.toContain("background-agent");
      expect(roles).not.toContain("watch-judge");
      expect(roles).not.toContain("entailment-verifier");
      expect(roles).not.toContain("brief-judge");
    });

    it("serves the experimental capability cards when OMNESIS_EXPERIMENTAL=1", () => {
      process.env.OMNESIS_EXPERIMENTAL = "1";
      const mgr = new ModelManager({ modelsDir: dir });
      const roles = mgr.getOverview(fakeInference).capabilities.map((c) => c.role);
      expect(roles).toContain("background-agent");
      expect(roles).toContain("watch-judge");
      expect(roles).toContain("entailment-verifier");
    });

    it("serves the section field so clients can group core vs cognition", () => {
      process.env.OMNESIS_EXPERIMENTAL = "1";
      const mgr = new ModelManager({ modelsDir: dir });
      const caps = mgr.getOverview(fakeInference).capabilities;
      expect(caps.find((c) => c.role === "embedder")?.section).toBe("core");
      expect(caps.find((c) => c.role === "background-agent")?.section).toBe("cognition");
      expect(caps.find((c) => c.role === "watch-judge")?.section).toBe("cognition");
      expect(caps.find((c) => c.role === "entailment-verifier")?.section).toBe("cognition");
    });
  });

  it("isInstalled returns true once the file + manifest are present", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    expect(mgr.isInstalled("nomic-embed-text-v1.5.Q8_0")).toBe(false);
    fakeInstall(mgr, "nomic-embed-text-v1.5.Q8_0", "nomic-embed-text-v1.5.Q8_0.gguf");
    expect(mgr.isInstalled("nomic-embed-text-v1.5.Q8_0")).toBe(true);
  });

  it("isInstalled returns true for Anthropic API entries (always conceptually installed)", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    expect(mgr.isInstalled("anthropic/claude-haiku-4-5-20251001")).toBe(true);
  });

  it("install rejects synchronously for already-installed entries", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    fakeInstall(mgr, "nomic-embed-text-v1.5.Q8_0", "nomic-embed-text-v1.5.Q8_0.gguf");
    expect(() => mgr.install("nomic-embed-text-v1.5.Q8_0")).toThrow(/already installed/);
  });

  it("install rejects API entries — there's nothing to download", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    expect(() => mgr.install("anthropic/claude-haiku-4-5-20251001")).toThrow(/not installable/);
  });

  it("install rejects unknown ids", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    expect(() => mgr.install("does-not-exist")).toThrow(/unknown catalog id/);
  });

  it("uninstall refuses when isActive returns true", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    fakeInstall(mgr, "nomic-embed-text-v1.5.Q8_0", "nomic-embed-text-v1.5.Q8_0.gguf");
    expect(() => mgr.uninstall("nomic-embed-text-v1.5.Q8_0", { isActive: () => true })).toThrow(
      /currently active/,
    );
  });

  it("uninstall removes the file + manifest entry", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    fakeInstall(mgr, "nomic-embed-text-v1.5.Q8_0", "nomic-embed-text-v1.5.Q8_0.gguf");
    expect(existsSync(join(dir, "nomic-embed-text-v1.5.Q8_0.gguf"))).toBe(true);
    mgr.uninstall("nomic-embed-text-v1.5.Q8_0", { isActive: () => false });
    expect(existsSync(join(dir, "nomic-embed-text-v1.5.Q8_0.gguf"))).toBe(false);
    expect(mgr.isInstalled("nomic-embed-text-v1.5.Q8_0")).toBe(false);
  });

  it("reconcileOnStartup adopts catalog GGUFs that exist on disk but aren't in the manifest", async () => {
    // Simulates the upgrade path: a pre-model-manager user manually
    // dropped nomic-embed-text-v1.5.Q8_0.gguf into ~/.config/omnesis/models/.
    // After the manager ships, the file should be reflected as installed
    // without forcing a redundant 145 MB redownload.
    const mgr = new ModelManager({ modelsDir: dir });
    writeFileSync(join(dir, "nomic-embed-text-v1.5.Q8_0.gguf"), "fake gguf content");
    expect(mgr.isInstalled("nomic-embed-text-v1.5.Q8_0")).toBe(false);
    await mgr.reconcileOnStartup();
    expect(mgr.isInstalled("nomic-embed-text-v1.5.Q8_0")).toBe(true);
    // Manifest should now carry the adopted entry with a real sha and
    // `downloadedFrom: "adopted-from-disk"` provenance.
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.models.find(
      (m: { id: string }) => m.id === "nomic-embed-text-v1.5.Q8_0",
    );
    expect(entry).toBeDefined();
    expect(entry.downloadedFrom).toBe("adopted-from-disk");
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reconcileOnStartup leaves an existing manifest entry alone (no double-adopt)", async () => {
    const mgr = new ModelManager({ modelsDir: dir });
    fakeInstall(
      mgr,
      "nomic-embed-text-v1.5.Q8_0",
      "nomic-embed-text-v1.5.Q8_0.gguf",
      "the-real-thing",
    );
    await mgr.reconcileOnStartup();
    // sha256 stays at the placeholder we wrote (not adopted-recomputed)
    // because the manifest entry was already there.
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const entry = manifest.models.find(
      (m: { id: string }) => m.id === "nomic-embed-text-v1.5.Q8_0",
    );
    expect(entry.sha256).toBe("0".repeat(64));
  });

  it("reconcileOnStartup prunes manifest entries whose file vanished", async () => {
    const mgr = new ModelManager({ modelsDir: dir });
    // Manifest claims a file is installed, but it isn't.
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "phantom",
            filename: "phantom.gguf",
            sizeBytes: 1,
            sha256: "x",
            downloadedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await mgr.reconcileOnStartup();
    expect(mgr.isInstalled("phantom")).toBe(false);
  });

  it("getOverview surfaces inference overview + activeDownloads", () => {
    const mgr = new ModelManager({ modelsDir: dir, hasAnthropicApiKey: () => true });
    const fakeInference: InferenceOverview = {
      backends: {
        local: { type: "local", status: "ok" },
        anthropic: { type: "anthropic", status: "ok" },
      },
      assignments: {
        embedder: { role: "embedder", kind: "disabled" },
        agent: {
          role: "agent",
          kind: "anthropic",
          catalogId: "anthropic/claude-haiku-4-5-20251001",
          apiModelId: "claude-haiku-4-5-20251001",
          available: true,
        },
      },
    };
    const overview = mgr.getOverview(fakeInference);
    const agentAssignment = overview.inference.assignments.agent;
    expect(agentAssignment.kind).toBe("anthropic");
    if (agentAssignment.kind === "anthropic") {
      expect(agentAssignment.catalogId).toBe("anthropic/claude-haiku-4-5-20251001");
      expect(agentAssignment.available).toBe(true);
    }
    expect(overview.activeDownloads).toEqual([]);
  });

  it("serves and looks up a live dynamic Anthropic catalog entry", () => {
    const dynamic = {
      kind: "anthropic-api" as const,
      id: "anthropic/claude-fable-5",
      apiModelId: "claude-fable-5",
      name: "Claude Fable 5 (Anthropic API)",
      roles: ["agent"] as const,
      author: "Anthropic",
      license: "Anthropic Commercial Terms",
      description: "Dynamic test model.",
    };
    const mgr = new ModelManager({ modelsDir: dir, catalog: () => [dynamic] });
    const fakeInference: InferenceOverview = {
      backends: { local: { type: "local", status: "ok" } },
      assignments: {
        embedder: { role: "embedder", kind: "disabled" },
        agent: { role: "agent", kind: "disabled" },
      },
    };

    expect(mgr.getOverview(fakeInference).catalog).toEqual([dynamic]);
    expect(mgr.getCatalogEntry(dynamic.id)).toEqual(dynamic);
    expect(mgr.isInstalled(dynamic.id)).toBe(true);
  });

  it("install completion writes the manifest entry and broadcasts started→completed", async () => {
    const served = Buffer.from("fictional-bge-small-weights-block-for-tests", "utf8");
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(served), {
        status: 200,
        headers: { "content-length": String(served.byteLength) },
      })) as typeof globalThis.fetch;

    const { events, terminal, onBroadcast } = broadcastCollector();
    const mgr = new ModelManager({ modelsDir: dir, onBroadcast });

    const { downloadId } = mgr.install(GGUF_ID);
    // While the fetch streams, the catalog id is reported as downloading.
    expect(mgr.isDownloading(GGUF_ID)).toBe(true);

    await terminal;

    // started fires first with the catalog filename; completed last.
    const started = events.find((e) => e.kind === "started");
    expect(started).toMatchObject({ kind: "started", downloadId, modelId: GGUF_ID });
    const completed = events.at(-1);
    expect(completed?.kind).toBe("completed");
    if (completed?.kind === "completed") {
      expect(completed.downloadId).toBe(downloadId);
      expect(completed.modelId).toBe(GGUF_ID);
      expect(completed.manifest.id).toBe(GGUF_ID);
      expect(completed.manifest.sha256).toBe(sha256Hex(served));
      expect(completed.manifest.sizeBytes).toBe(served.byteLength);
    }

    // The manifest on disk now records the model; the active map is clear.
    expect(mgr.isInstalled(GGUF_ID)).toBe(true);
    expect(mgr.isDownloading(GGUF_ID)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const entry = manifest.models.find((m: { id: string }) => m.id === GGUF_ID);
    expect(entry).toBeDefined();
    expect(entry.sha256).toBe(sha256Hex(served));
  });

  it("install failure broadcasts failed with the DownloadError code and writes no manifest entry", async () => {
    // A server error → DownloadError("http_status"); the manager must
    // surface a `failed` (not `cancelled`) event carrying that code.
    globalThis.fetch = (async () =>
      new Response("upstream blew up", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;

    const { events, terminal, onBroadcast } = broadcastCollector();
    const mgr = new ModelManager({ modelsDir: dir, onBroadcast });

    const { downloadId } = mgr.install(GGUF_ID);
    await terminal;

    const last = events.at(-1);
    expect(last?.kind).toBe("failed");
    if (last?.kind === "failed") {
      expect(last.downloadId).toBe(downloadId);
      expect(last.modelId).toBe(GGUF_ID);
      expect(last.code).toBe("http_status");
      expect(last.message).toMatch(/500/);
    }

    // Failure leaves nothing installed and the active map clear.
    expect(mgr.isInstalled(GGUF_ID)).toBe(false);
    expect(mgr.isDownloading(GGUF_ID)).toBe(false);
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("cancel aborts an in-flight download and broadcasts cancelled (not failed)", async () => {
    // Body emits a chunk then errors when the download's AbortSignal
    // fires — deterministic abort with no timers.
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x47, 0x47, 0x55, 0x46]));
          const onAbort = () => controller.error(new Error("aborted by signal"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;

    const { events, terminal, onBroadcast } = broadcastCollector();
    const mgr = new ModelManager({ modelsDir: dir, onBroadcast });

    const { downloadId } = mgr.install(GGUF_ID);
    expect(mgr.isDownloading(GGUF_ID)).toBe(true);
    expect(mgr.cancel(GGUF_ID)).toBe(true);

    await terminal;

    const last = events.at(-1);
    expect(last?.kind).toBe("cancelled");
    if (last?.kind === "cancelled") {
      expect(last.downloadId).toBe(downloadId);
      expect(last.modelId).toBe(GGUF_ID);
    }
    // A cancel is not a failure — no `failed` event is emitted.
    expect(events.some((e) => e.kind === "failed")).toBe(false);

    expect(mgr.isInstalled(GGUF_ID)).toBe(false);
    expect(mgr.isDownloading(GGUF_ID)).toBe(false);
    // Aborted download leaves no straggler partial behind.
    expect(existsSync(join(dir, `${GGUF_FILENAME}.partial`))).toBe(false);
  });

  it("cancel is a no-op for a model that is not downloading", () => {
    const mgr = new ModelManager({ modelsDir: dir });
    expect(mgr.cancel(GGUF_ID)).toBe(false);
  });

  it("doctor flags size and sha256 mismatches when an installed file is corrupted", async () => {
    // Install a real GGUF file via the download path so the manifest
    // records a true sha/size, then corrupt it on disk.
    const served = Buffer.from("healthy-embedder-weights-payload", "utf8");
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(served), {
        status: 200,
        headers: { "content-length": String(served.byteLength) },
      })) as typeof globalThis.fetch;
    const { terminal, onBroadcast } = broadcastCollector();
    const mgr = new ModelManager({ modelsDir: dir, onBroadcast });
    mgr.install(GGUF_ID);
    await terminal;

    // Healthy right after install: no issues.
    expect((await mgr.doctor(GGUF_ID)).issues).toEqual([]);

    // Corrupt the file: different length AND different content than the
    // manifest recorded → both a size and a sha mismatch.
    writeFileSync(join(dir, GGUF_FILENAME), Buffer.from("tampered-and-shorter", "utf8"));
    const { issues } = await mgr.doctor(GGUF_ID);
    expect(issues.some((i) => /size mismatch/.test(i))).toBe(true);
    expect(issues.some((i) => /sha256 mismatch/.test(i))).toBe(true);
  });

  it("doctor reports 'no manifest entry' for an uninstalled model", async () => {
    const mgr = new ModelManager({ modelsDir: dir });
    const { issues } = await mgr.doctor(GGUF_ID);
    expect(issues).toEqual(["no manifest entry"]);
  });
});
