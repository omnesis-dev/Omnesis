// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect, vi } from "vitest";

// Smoke test: the Models view module — and the components it composes — must
// import cleanly (no syntax errors, no bad import paths, valid htm templates).
// We can't drive the full hooked component without a DOM renderer, but importing
// the module evaluates every top-level `html` template tag and import, which is
// where a typo in the rewrite would blow up. The leaf `CapabilityIcon` is pure,
// so we render it to a vnode and assert its shape.

// Mock the api module so importing the view doesn't try real network helpers.
vi.mock("../api.js", () => ({
  getModelsOverview: vi.fn(),
  saveModelBehavior: vi.fn(),
  getSystemInfo: vi.fn(),
  installModel: vi.fn(),
  cancelModelDownload: vi.fn(),
  uninstallModel: vi.fn(),
  activateModel: vi.fn(),
  getModelCredentialsStatus: vi.fn(),
  setModelProviderCredentials: vi.fn(),
  assignCapability: vi.fn(),
  addHttpBackend: vi.fn(),
  removeHttpBackend: vi.fn(),
  probeBackend: vi.fn(),
  refreshCodexBackend: vi.fn(),
  getCodexRuntimeUpdate: vi.fn(),
  startCodexRuntimeUpdate: vi.fn(),
  cancelCodexRuntimeUpdate: vi.fn(),
  startCodexLogin: vi.fn(),
  getCodexLogin: vi.fn(),
  cancelCodexLogin: vi.fn(),
  removeCodexBackend: vi.fn(),
  rebuildIndex: vi.fn(),
  getAdminConfig: vi.fn(),
  patchAdminConfig: vi.fn(),
}));

describe("models view module", () => {
  it("imports the ModelsView without throwing", async () => {
    // @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
    const mod = await import("./models.js");
    expect(typeof mod.ModelsView).toBe("function");
  });

  it("resolves the path segment under the Models tab to what it shows", async () => {
    // @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
    const { resolveModelsSection } = await import("./models.js");
    const served = ["embedder", "agent", "ocr"];

    // No segment → the grid; "backends" → the backend list.
    expect(resolveModelsSection(null, served)).toEqual({ view: "grid", role: null });
    expect(resolveModelsSection("backends", served)).toEqual({ view: "backends", role: null });

    // A served capability opens its own detail — this is where the portal's
    // "Configure the agent in Models" link points.
    expect(resolveModelsSection("agent", served)).toEqual({ view: "capability", role: "agent" });

    // A capability the gateway doesn't advertise falls back to the grid rather
    // than rendering a detail with nothing behind it.
    expect(resolveModelsSection("privacy-reviewer", served)).toEqual({ view: "grid", role: null });
    expect(resolveModelsSection("not-a-role", [])).toEqual({ view: "grid", role: null });
  });

  it("CapabilityIcon renders a vnode for a known slug and the fallback", async () => {
    // @ts-expect-error — portal JS module.
    const { CapabilityIcon, hasCapabilityGlyph } = await import("../components/capability-icon.js");
    expect(hasCapabilityGlyph("binary")).toBe(true);
    expect(hasCapabilityGlyph("not-a-real-slug")).toBe(false);
    // Invoke as a plain function — it returns an htm/preact vnode object.
    const vnode = CapabilityIcon({ icon: "binary", size: 24 });
    expect(vnode).toBeTruthy();
    expect(vnode.type).toBe("svg");
    expect(hasCapabilityGlyph("shield-check")).toBe(true);
    // Fallback path still yields a vnode (the neutral dot), never throws.
    expect(CapabilityIcon({ icon: "totally-unknown" })).toBeTruthy();
  });
});
