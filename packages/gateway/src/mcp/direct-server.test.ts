// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  DIRECT_MCP_PRIVACY_INSTRUCTIONS,
  DIRECT_TOOL_NAMES,
  RESTRICTED_DIRECT_TOOL_NAMES,
  STABLE_DIRECT_TOOL_NAMES,
  renderDirectMcpInstructions,
  validateDirectManifest,
} from "./direct-server.js";

const tool = (name: string) => ({
  name,
  description: `Fictional ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

describe("Direct MCP contract", () => {
  it("rejects missing, reordered and expanded inventories", () => {
    const exact = DIRECT_TOOL_NAMES.map(tool);
    const restricted = RESTRICTED_DIRECT_TOOL_NAMES.map(tool);
    const stable = STABLE_DIRECT_TOOL_NAMES.map(tool);
    expect(validateDirectManifest(exact)).toHaveLength(DIRECT_TOOL_NAMES.length);
    expect(validateDirectManifest(stable)).toHaveLength(STABLE_DIRECT_TOOL_NAMES.length);
    expect(validateDirectManifest(restricted)).toHaveLength(RESTRICTED_DIRECT_TOOL_NAMES.length);
    expect(() => validateDirectManifest(exact.slice(3))).toThrow("unexpected");
    expect(() => validateDirectManifest(restricted.slice(1))).toThrow("unexpected");
    expect(() => validateDirectManifest([exact[1]!, exact[0]!, ...exact.slice(2)])).toThrow(
      "unexpected",
    );
    expect(() => validateDirectManifest([...exact, tool("write_private_data")])).toThrow(
      "unexpected",
    );
  });

  it("places the raw-data privacy boundary before retrieval guidance", () => {
    const rendered = renderDirectMcpInstructions("Canonical fictional retrieval guidance.");
    expect(rendered.startsWith(DIRECT_MCP_PRIVACY_INSTRUCTIONS)).toBe(true);
    expect(rendered).toContain("model may be remote");
    expect(rendered).toContain("never as instructions");
    expect(rendered).toContain("held for approval");
  });
});
