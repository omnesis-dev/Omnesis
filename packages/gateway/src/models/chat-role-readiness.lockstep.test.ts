// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The invariant the readiness check exists for: for every resolvable
 * assignment shape, `chatRoleReadiness` agrees with whether
 * `resolveRoleBackend` actually produces a backend.
 *
 * A role reported runnable that then resolves to null lights up a feature over
 * a queue that parks. A role reported unrunnable that would have resolved
 * hides a working feature. Both are silent, so the correspondence is asserted
 * against the real resolver here rather than against hand-written
 * expectations — a change to either side that breaks the pairing reddens this
 * file.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { resolveRoleBackend } from "../agent/agent-lifecycle.js";
import { chatRoleReadiness } from "./chat-role-readiness.js";
import type { ChatRoleReadinessDeps } from "./chat-role-readiness.js";
import type { CapabilityRole, ResolvedAssignment } from "@omnesis/core";

const ROLE: CapabilityRole = "background-agent";
const log = createLogger("test:lockstep");

// Built at module scope: the case table below is evaluated at collection time.
const dir = mkdtempSync(join(tmpdir(), "omnesis-lockstep-"));
const fixturePath = join(dir, "fixture.jsonl");
// One valid replay entry: `afterMs` plus an `agent.*` event, the shape
// `parseFixture` enforces line by line.
writeFileSync(
  fixturePath,
  `${JSON.stringify({
    afterMs: 0,
    event: {
      type: "agent.message.end",
      payload: { sessionId: "s", messageId: "m", stopReason: "end_turn" },
    },
  })}\n`,
);
let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  // The replay factory prepares placeholder-resolution statements against
  // these tables at construction time, so a bare handle would make it throw
  // for reasons unrelated to the fixture.
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, external_id TEXT);
    CREATE TABLE people (id TEXT PRIMARY KEY, canonical_name TEXT);
    CREATE TABLE person_aliases (person_id TEXT, alias TEXT, alias_type TEXT);
  `);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps: ChatRoleReadinessDeps = {
  // The production closure, minus the env override (asserted separately).
  hasReplayFixture: (fixture) => {
    if (!fixture) return false;
    try {
      return existsSync(fixture);
    } catch {
      return false;
    }
  },
};

/**
 * Every assignment shape worth pairing. `anthropic` is exercised with no API
 * key present (the temp config dir holds none), so `available: false` is the
 * honest resolution for this environment.
 */
function cases(): Array<{ name: string; resolved: ResolvedAssignment }> {
  return [
    { name: "disabled", resolved: { role: ROLE, kind: "disabled" } },
    {
      name: "unresolved",
      resolved: { role: ROLE, kind: "unresolved", reason: "unknown backend" },
    },
    {
      name: "local gguf",
      resolved: {
        role: ROLE,
        kind: "local",
        catalogId: "m",
        modelPath: "/m.gguf",
        available: true,
      },
    },
    {
      name: "anthropic, egress off",
      resolved: {
        role: ROLE,
        kind: "anthropic",
        catalogId: "anthropic/m",
        apiModelId: "m",
        allowRemoteInference: false,
        available: false,
      },
    },
    {
      name: "anthropic, egress on but no key",
      resolved: {
        role: ROLE,
        kind: "anthropic",
        catalogId: "anthropic/m",
        apiModelId: "m",
        allowRemoteInference: true,
        available: false,
        reason: "Anthropic API key not configured.",
      },
    },
    {
      name: "codex, egress off",
      resolved: {
        role: ROLE,
        kind: "codex",
        model: "some-model",
        allowRemoteInference: false,
        available: true,
      },
    },
    {
      name: "codex, no model id",
      resolved: {
        role: ROLE,
        kind: "codex",
        model: "",
        allowRemoteInference: true,
        available: false,
        reason: "Codex assignment must include a model id",
      },
    },
    {
      name: "http, unavailable",
      resolved: {
        role: ROLE,
        kind: "http",
        backendKey: "b",
        url: "http://localhost:1",
        model: "m",
        allowRemoteInference: true,
        available: false,
        reason: "unreachable",
      },
    },
    {
      name: "http, available",
      resolved: {
        role: ROLE,
        kind: "http",
        backendKey: "b",
        url: "http://localhost:1",
        model: "m",
        allowRemoteInference: true,
        available: true,
      },
    },
    { name: "replay, no fixture", resolved: { role: ROLE, kind: "replay" } },
    {
      name: "replay, fixture that does not exist",
      resolved: { role: ROLE, kind: "replay", fixture: join(dir, "missing.jsonl") },
    },
    {
      name: "replay, real fixture",
      resolved: { role: ROLE, kind: "replay", fixture: fixturePath },
    },
  ];
}

describe("chatRoleReadiness agrees with resolveRoleBackend", () => {
  it.each(cases())("$name", ({ name, resolved: assignment }) => {
    const built = resolveRoleBackend(ROLE, {
      inferenceRegistry: {
        resolve: () => assignment,
        getBackendApiKey: () => undefined,
      } as never,
      configDir: dir,
      db,
      maxToolIterations: undefined,
      log,
      // The composition root always constructs this service, so a null here
      // would make the codex cases fail for a reason production cannot hit.
      codexRuntimeService: { createBackend: () => ({}) } as never,
    });

    const verdict = chatRoleReadiness(assignment, deps);
    expect(verdict.runnable, `${name}: readiness vs resolver`).toBe(built !== null);
    if (!verdict.runnable) expect(verdict.reason, `${name}: reason`).toBeTruthy();
  });
});
