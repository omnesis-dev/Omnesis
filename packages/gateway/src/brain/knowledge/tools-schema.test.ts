// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createLogger } from "@omnesis/core";
import {
  convertToolsToResponses,
  convertToolsToCodexDynamicTools,
  zodToJsonSchema,
} from "@omnesis/agent";
import { resolveBrainSettings } from "../config.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeEngine } from "./engine.js";
import { directKnowledgeGate } from "./writer.js";
import { buildKnowledgeTools } from "./tools.js";

it("advertises actual placement fields and dynamic revision maps to model backends", () => {
  const db = new Database(":memory:");
  try {
    const log = createLogger("knowledge-schema-test"),
      getSettings = () => resolveBrainSettings(),
      clock = () => 1;
    const writeGate = directKnowledgeGate(db);
    const service = new KnowledgeService({ db, writeGate, getSettings, clock, log });
    const engine = new KnowledgeEngine({
      db,
      service,
      writeGate,
      getSettings,
      clock,
      log,
      decisions: { getDecision: () => null, log, recordSpend: async () => {} },
    });
    const tools = buildKnowledgeTools(service, {
      runId: "schema-run",
      batchId: "schema-batch",
      engine,
    });
    const save = tools.find((tool) => tool.name === "knowledge_save")!;
    const schema = zodToJsonSchema(save.schema);
    const branches = schema.properties?.placementAssessment?.anyOf;
    expect(branches).toHaveLength(3);
    const integrated = branches!.find((branch) =>
      branch.properties?.status?.enum?.includes("integrated"),
    )!;
    expect(integrated.required).toEqual(["status", "reason", "links"]);
    expect(integrated.additionalProperties).toBe(false);
    const links = integrated.properties!.links!;
    expect(links).toMatchObject({ type: "array", minItems: 1, maxItems: 16 });
    expect(links.items).toMatchObject({
      type: "object",
      required: ["fromId", "toId", "kind", "otherRevision"],
      additionalProperties: false,
      properties: {
        fromId: { type: "string" },
        toId: { type: "string" },
        kind: { type: "string", enum: ["part_of", "belongs_to_project", "related_to"] },
        otherRevision: { type: "integer", minimum: 0 },
      },
    });
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.node?.properties?.inputVersions).toMatchObject({
      type: "object",
      additionalProperties: { anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }] },
    });
    expect(schema.properties?.node?.properties?.ownerId?.anyOf).toEqual([
      { type: "string", minLength: 1, maxLength: 256 },
      { type: "null" },
    ]);
    const organization = tools.find((tool) => tool.name === "knowledge_organization_complete")!;
    expect(zodToJsonSchema(organization.schema).properties?.targetVersions).toEqual({
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    });
    // Production adapters must transport these nested shapes without flattening them.
    expect(convertToolsToResponses([save])[0]!.parameters).toEqual(schema);
    expect(convertToolsToCodexDynamicTools([save])[0]!.inputSchema).toEqual(schema);
  } finally {
    db.close();
  }
});
