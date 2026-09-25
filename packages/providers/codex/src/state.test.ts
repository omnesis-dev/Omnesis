// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isStateEnvelope, withVersionedState, type StateOutcome } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { codexStateSpec } from "./state.js";
import source from "./index.js";
import type { LocalAgentSessionCursor } from "@omnesis/source-sdk/local-agent-sessions";

const SOURCE_ID = SourceId("codex:test");
const PROVIDER_ID = ProviderId("codex:test");

function iso(minute: number): string {
  return new Date(2026, 0, 8, 9, minute).toISOString();
}

function line(type: string, minute: number, payload: Record<string, unknown>) {
  return { type, timestamp: iso(minute), payload };
}

function writeJsonl(path: string, rows: Record<string, unknown>[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("codexStateSpec via the host decorator", () => {
  let codexHome: string;

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  async function makeVersionedInstance() {
    codexHome = mkdtempSync(join(tmpdir(), "codex-state-"));
    writeJsonl(join(codexHome, "sessions", "rollout-codex-session-1.jsonl"), [
      line("session_meta", 0, {
        id: "codex-session-1",
        session_id: "codex-session-1",
        cwd: "/work/example",
        source: "cli",
      }),
      line("event_msg", 0, { type: "user_message", message: "Inspect the build" }),
      line("response_item", 1, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Build is fine." }],
      }),
    ]);

    const raw = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const outcomes: StateOutcome[] = [];
    const instance = withVersionedState(raw, codexStateSpec, {
      sourceId: "codex:test",
      onResolve: (outcome) => outcomes.push(outcome),
    });
    return { instance, outcomes };
  }

  test("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const { instance, outcomes } = await makeVersionedInstance();

    const first = await instance.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);
    expect(first.documents).toHaveLength(1);

    const second = await instance.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  test("resumes a cursor mid-cycle — not only the settled shape — and writes back an envelope", async () => {
    const { instance, outcomes } = await makeVersionedInstance();

    // What the shared local-agent-sessions module persists partway through a
    // page walk that has not yet reached a short page: `pendingFileKeys`,
    // `cycleTotal`, `cyclePhase` and `snapshotSafe` are all set, unlike the
    // settled shape where they are absent. `decode` must accept this or every
    // partial page would be reclassified as legacy and re-migrated on the
    // next page.
    const midCycleCursor: LocalAgentSessionCursor = {
      version: 2,
      scanKey: "stale-scan-key",
      files: {},
      pendingFileKeys: ["/some/session-a.jsonl", "/some/session-b.jsonl"],
      cycleTotal: 3,
      cyclePhase: "bootstrap",
      snapshotSafe: true,
    };
    expect(codexStateSpec.decode(midCycleCursor)).not.toBeNull();

    const result = await instance.sync(midCycleCursor);
    expect(outcomes[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("an unrecognised stored value rebootstraps rather than silently wedging", async () => {
    const { instance, outcomes } = await makeVersionedInstance();

    const result = await instance.sync({ somethingElse: true } as never);
    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
    // A rebootstrap behaves exactly like a first run: the session on disk is
    // still fully indexed, nothing is skipped as "already seen".
    expect(result.documents).toHaveLength(1);
  });
});
