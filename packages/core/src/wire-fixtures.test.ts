// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The checked-in fixture files must be what these definitions produce.
 *
 * They exist so Swift and Kotlin decode the same bytes TypeScript writes. That
 * only holds while the files on disk match the vocabulary — a contract change
 * that updates the types and forgets the corpus leaves the native clients
 * decoding last release's wire and passing.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveSourceState, type SourceStateSpec } from "@omnesis/source-sdk";
import { SyncError, type SyncErrorKind, type SyncErrorOptions } from "./sync-error.js";
import { parseEventPayload } from "./ws-messages.js";
import {
  COVERAGE_FIXTURES,
  FAILURE_FIXTURES,
  STATE_FIXTURES,
  AUTH_CHALLENGE_FIXTURES,
  CONTRACT_MESSAGE_FIXTURES,
  renderWireFixture,
  WIRE_FIXTURES,
} from "./wire-fixtures.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Every copy of the corpus. The native hosts receive one module directory
 * each — the dispatcher rsyncs `android/` and `ios/`, not the repository — so
 * the fixtures have to live inside the trees that travel. Checking all three
 * is what keeps three copies from becoming three vocabularies.
 */
const DIRS = [
  join(ROOT, "wire-fixtures"),
  join(ROOT, "android/core-transport/src/test/resources/wire-fixtures"),
  join(ROOT, "ios/Tests/OmnesisTests/wire-fixtures"),
];

describe("wire fixtures through production consumers", () => {
  const stateSpec: SourceStateSpec<{ offset: number }> = {
    version: 2,
    onUnreadable: "stop",
    legacyVersion: () => 2,
    decode: (raw) =>
      typeof raw === "object" && raw !== null && "offset" in raw && typeof raw.offset === "number"
        ? { offset: raw.offset }
        : null,
  };

  test.each(STATE_FIXTURES)("$name follows the real state policy", (fixture) => {
    const outcome = resolveSourceState(stateSpec, JSON.parse(renderWireFixture(fixture)), {
      sourceId: "things:local",
    });
    if (fixture.name === "state-envelope-from-newer-build") {
      expect(outcome).toMatchObject({ kind: "refused", storedVersion: 99 });
    } else {
      expect(outcome).toMatchObject({ kind: "resume", state: { offset: 12 } });
    }
  });

  test.each(FAILURE_FIXTURES)("$name preserves failure routing", (fixture) => {
    const raw = JSON.parse(renderWireFixture(fixture)) as SyncErrorOptions & {
      kind: SyncErrorKind;
      message: string;
    };
    const error = new SyncError(raw.kind, raw.message, raw);
    for (const [key, value] of Object.entries(raw)) expect(Reflect.get(error, key)).toEqual(value);
  });

  test.each(COVERAGE_FIXTURES)("$name survives sync status validation", (fixture) => {
    const progress = JSON.parse(renderWireFixture(fixture));
    const event = { sourceId: "fixture:local", state: "syncing", progress };
    expect(parseEventPayload("sync.status", event)).toEqual({ ok: true, value: event });
  });

  test.each(AUTH_CHALLENGE_FIXTURES)("$name survives gateway forwarding", (fixture) => {
    expect(parseEventPayload("auth.update", fixture.value)).toEqual({
      ok: true,
      value: fixture.value,
    });
  });

  test.each([
    ["auth-complete-extras", "auth.complete"],
    ["sync-status-partial-warning", "sync.status"],
  ] as const)("%s preserves every declared field", (name, event) => {
    const fixture = CONTRACT_MESSAGE_FIXTURES.find((entry) => entry.name === name)!;
    expect(parseEventPayload(event, fixture.value)).toEqual({ ok: true, value: fixture.value });
  });
});

describe("wire fixtures on disk", () => {
  test("the corpus is not empty, or every case below proves nothing", () => {
    expect(WIRE_FIXTURES.length).toBeGreaterThanOrEqual(10);
  });

  test.each(WIRE_FIXTURES.map((f) => [f.name, f] as const))("%s", (name, fixture) => {
    for (const dir of DIRS) {
      const path = join(dir, `${name}.json`);
      expect(existsSync(path), `${path} is missing — run \`npm run wire-fixtures\``).toBe(true);
      expect(
        readFileSync(path, "utf-8"),
        `${path} has drifted from its definition — run \`npm run wire-fixtures\`. ` +
          `Until it matches, the decoder reading that copy is being tested against an ` +
          `older wire than this build sends.`,
      ).toBe(renderWireFixture(fixture));
    }
  });

  test("every fixture carries a note saying why its arm exists", () => {
    // A fixture nobody can explain is one a reader will delete when it breaks.
    for (const fixture of WIRE_FIXTURES) {
      expect(fixture.note.length, `${fixture.name} needs a note`).toBeGreaterThan(20);
    }
  });

  test("names are unique, so one file cannot silently shadow another", () => {
    const names = WIRE_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
