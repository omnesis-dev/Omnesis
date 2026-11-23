// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isStateEnvelope, withVersionedState, type StateOutcome } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { antigravityStateSpec } from "./state.js";
import source from "./index.js";
import type { LocalAgentSessionCursor } from "@omnesis/source-sdk/local-agent-sessions";

const SOURCE_ID = SourceId("antigravity:test");
const PROVIDER_ID = ProviderId("antigravity:test");

function iso(minute: number): string {
  return new Date(2026, 0, 8, 9, minute).toISOString();
}

function writeTranscript(home: string, convId: string, rows: Record<string, unknown>[]): void {
  const path = join(home, "brain", convId, ".system_generated", "logs", "transcript_full.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("antigravityStateSpec via the host decorator", () => {
  let antigravityHome: string;

  afterEach(() => {
    rmSync(antigravityHome, { recursive: true, force: true });
  });

  async function makeVersionedInstance() {
    antigravityHome = mkdtempSync(join(tmpdir(), "antigravity-state-"));
    writeTranscript(antigravityHome, "conv-state-1", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: iso(0),
        content: "<USER_REQUEST>\nInspect the build\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(1),
        model: "gemini-4-neon-high",
        content: "Build is fine.",
      },
    ]);

    const raw = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { antigravityHome },
    });
    const outcomes: StateOutcome[] = [];
    const instance = withVersionedState(raw, antigravityStateSpec, {
      sourceId: "antigravity:test",
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

  test("resumes a cursor mid-cycle and writes back an envelope", async () => {
    const { instance, outcomes } = await makeVersionedInstance();

    const midCycleCursor: LocalAgentSessionCursor = {
      version: 2,
      scanKey: "stale-scan-key",
      files: {},
      pendingFileKeys: ["key-a", "key-b"],
      cycleTotal: 3,
      cyclePhase: "bootstrap",
      snapshotSafe: true,
    };
    expect(antigravityStateSpec.decode(midCycleCursor)).not.toBeNull();

    const result = await instance.sync(midCycleCursor);
    expect(outcomes[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("an unrecognised stored value rebootstraps rather than silently wedging", async () => {
    const { instance, outcomes } = await makeVersionedInstance();

    const result = await instance.sync({ somethingElse: true } as never);
    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
    expect(result.documents).toHaveLength(1);
  });
});
