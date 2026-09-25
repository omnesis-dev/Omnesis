// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { tablesWritten } from "./testing/page-writes.js";
import { RefusedSourceStateError, withVersionedState } from "./state-runtime.js";
import {
  isStateEnvelope,
  SourceStateTooLargeError,
  type SourceStateSpec,
  type StateOutcome,
} from "./source-state.js";
import { emptySync, syncPage, type SyncCursor } from "./source.js";
import type { SourceInstance } from "./define-source.js";

interface Notes extends Record<string, unknown> {
  after: string;
}
const isNotes = (v: unknown): v is Notes =>
  typeof v === "object" && v !== null && typeof (v as Notes).after === "string";

const spec: SourceStateSpec<Notes> = {
  version: 2,
  decode: (v) => (isNotes(v) ? v : null),
  migrate: { 1: (old) => ({ after: (old as { cursor?: string }).cursor ?? "" }) },
};

/** Records what the source was handed, and returns a fixed next state. */
function recordingInstance(next: SyncCursor = { after: "next" }) {
  const seen: (SyncCursor | null)[] = [];
  const instance: SourceInstance = {
    sync: async (cursor) => {
      seen.push(cursor);
      return syncPage([], next);
    },
  };
  return { instance, seen };
}

describe("what the source is handed", () => {
  test.each([null, {}])(
    "an initial bookmark %j reports first-run rather than rebootstrap",
    async (stored) => {
      const starts: string[] = [];
      const instance: SourceInstance = {
        sync: async (_cursor, options) => {
          starts.push(options!.run!.start);
          return emptySync({ after: "next" });
        },
      };
      const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
      await wrapped.sync(stored, {
        run: { id: "fixture-run", reason: "manual", start: "resume", page: 0 },
      });
      expect(starts).toEqual(["first-run"]);
    },
  );
  test("class hooks and getters retain their private-field receiver", async () => {
    class ClassSource {
      #label = "active";
      readonly metadata = { title: "Notes" };
      get label() {
        return this.#label;
      }
      async sync() {
        return emptySync({ after: this.#label });
      }
      async suspend() {
        this.#label = "suspended";
      }
      async dispose() {
        this.#label = "disposed";
      }
    }
    const instance = new ClassSource();
    const originalSync = instance.sync;
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    const label = () => Reflect.get(wrapped, "label");
    expect(label()).toBe("active");
    expect({ ...wrapped }).toMatchObject({ metadata: { title: "Notes" } });
    expect(wrapped.suspend).toBe(wrapped.suspend);
    await wrapped.suspend?.();
    expect(label()).toBe("suspended");
    const result = await wrapped.sync(null);
    expect(result.cursor).toMatchObject({ state: { after: "suspended" } });
    await wrapped.dispose?.();
    expect(label()).toBe("disposed");
    expect(instance.sync).toBe(originalSync);
  });
  test("an envelope is unwrapped, so the source only ever sees its own state", async () => {
    const { instance, seen } = recordingInstance();
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    await wrapped.sync({ e: 1, v: 2, state: { after: "abc" } } as unknown as SyncCursor);
    expect(seen).toEqual([{ after: "abc" }]);
  });

  test("an older version is migrated before the source sees it", async () => {
    const { instance, seen } = recordingInstance();
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    await wrapped.sync({ e: 1, v: 1, state: { cursor: "legacy" } } as unknown as SyncCursor);
    expect(seen).toEqual([{ after: "legacy" }]);
  });

  test("a legacy unwrapped value is migrated too", async () => {
    const { instance, seen } = recordingInstance();
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    await wrapped.sync({ cursor: "from-before-envelopes" } as unknown as SyncCursor);
    expect(seen).toEqual([{ after: "from-before-envelopes" }]);
  });

  test("a first run hands null, exactly as before", async () => {
    const { instance, seen } = recordingInstance();
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    await wrapped.sync(null);
    expect(seen).toEqual([null]);
  });

  test("an unreadable state hands null, so the source starts over without knowing why", async () => {
    const { instance, seen } = recordingInstance();
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    await wrapped.sync({ e: 1, v: 2, state: { garbage: true } } as unknown as SyncCursor);
    expect(seen).toEqual([null]);
  });
});

describe("what the host persists", () => {
  test.each(["sync", "syncStructured"] as const)(
    "%s rejects oversized output before exposing a page and accepts the exact byte ceiling",
    async (lane) => {
      const sourceId = "fieldnotes:local";
      const next = { after: "é".repeat(40) };
      const envelope = { e: 1, v: 2, s: sourceId, state: next };
      const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
      expect(bytes).toBeGreaterThan(JSON.stringify(envelope).length);
      const stored = { e: 1, v: 2, s: sourceId, state: { after: "prior" } };
      const original = JSON.stringify(stored);
      const sync = vi.fn(async () => syncPage([], next, { deletedExternalIds: ["removed"] }));
      const syncStructured = vi.fn(async () => ({
        analytics: { tableName: "notes", records: [{ id: "new" }] },
        cursor: next,
        hasMore: false,
      }));
      const instance = { sync, syncStructured };
      // A page consumer can persist neither data nor cursor until sync resolves.
      // This is the wrapper boundary, not a substitute for runner integration.
      const persistPage = vi.fn();
      const wrapped = withVersionedState(instance, { ...spec, maxBytes: bytes - 1 }, { sourceId });
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(wrapped[lane]!(stored).then(persistPage)).rejects.toMatchObject({
          name: SourceStateTooLargeError.name,
          bytes,
          maxBytes: bytes - 1,
        });
        expect(JSON.stringify(stored)).toBe(original);
      }
      expect(persistPage).not.toHaveBeenCalled();
      expect(instance[lane]).toHaveBeenCalledTimes(3);
      expect(instance[lane === "sync" ? "syncStructured" : "sync"]).not.toHaveBeenCalled();

      const bounded = withVersionedState(instance, { ...spec, maxBytes: bytes }, { sourceId });
      const result = await bounded[lane]!(stored);
      expect(result.cursor).toEqual(envelope);
      expect(JSON.stringify(stored)).toBe(original);
    },
  );

  test("the returned state comes back wrapped and stamped", async () => {
    const { instance } = recordingInstance({ after: "2026-09-07" });
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    const result = await wrapped.sync(null);
    expect(result.cursor).toEqual({
      e: 1,
      v: 2,
      s: "fieldnotes:local",
      state: { after: "2026-09-07" },
    });
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("a returned value the source's own decoder rejects is stored unwrapped", async () => {
    // Stamping a version onto a value that does not deserve it would make the
    // next run resume from it. Leaving it unwrapped keeps it classified as
    // legacy, which is recoverable.
    const { instance } = recordingInstance({ partialPageBookkeeping: 3 });
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    const result = await wrapped.sync(null);
    expect(result.cursor).toEqual({ partialPageBookkeeping: 3 });
    expect(isStateEnvelope(result.cursor)).toBe(false);
  });

  test("a full cycle round-trips: what is written comes back to the source unchanged", async () => {
    const { instance, seen } = recordingInstance({ after: "x" });
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    const first = await wrapped.sync(null);
    await wrapped.sync(first.cursor);
    expect(seen).toEqual([null, { after: "x" }]);
  });

  test("everything else on the page is passed through untouched", async () => {
    const instance: SourceInstance = {
      sync: async () =>
        syncPage(
          [],
          { after: "x" },
          {
            hasMore: true,
            deletedExternalIds: ["gone-1"],
            progress: { phase: "bootstrap", processed: 4, total: 10 },
          },
        ),
    };
    const wrapped = withVersionedState(instance, spec, { sourceId: "s:1" });
    const result = await wrapped.sync(null);
    expect(result.hasMore).toBe(true);
    expect(result.deletedExternalIds).toEqual(["gone-1"]);
    expect(result.progress).toEqual({ phase: "bootstrap", processed: 4, total: 10 });
  });
});

describe("refusal", () => {
  test.each([
    { name: "future envelope", stored: { e: 1, v: 9, state: { after: "saved" } } },
    { name: "unreadable envelope", stored: { e: 1, v: 1, state: { pending: ["saved"] } } },
    { name: "unreadable legacy state", stored: { pending: ["saved"] } },
  ])("repeated refusal of $name preserves saved bytes in both lanes", async ({ stored }) => {
    const sync = vi.fn(async () => emptySync({ after: "unexpected" }));
    const syncStructured = vi.fn(async () => ({
      analytics: { tableName: "notes", records: [{ id: "unexpected" }] },
      cursor: { after: "unexpected" },
      hasMore: false,
    }));
    const onRefuse = vi.fn();
    const wrapped = withVersionedState(
      { sync, syncStructured },
      { version: 1, decode: spec.decode, onUnreadable: "stop" },
      { sourceId: "fieldnotes:local", onRefuse },
    );
    const original = JSON.stringify(stored);
    const persistPage = vi.fn();
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const lane of ["sync", "syncStructured"] as const) {
        await expect(wrapped[lane]!(stored).then(persistPage)).rejects.toBeInstanceOf(
          RefusedSourceStateError,
        );
        expect(JSON.stringify(stored)).toBe(original);
      }
    }
    expect(sync).not.toHaveBeenCalled();
    expect(syncStructured).not.toHaveBeenCalled();
    expect(persistPage).not.toHaveBeenCalled();
    expect(onRefuse).toHaveBeenCalledTimes(6);
  });

  test("state from a newer build stops the run instead of starting over", async () => {
    const { instance, seen } = recordingInstance();
    const onRefuse = vi.fn();
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local", onRefuse });
    await expect(wrapped.sync({ e: 1, v: 9, state: {} } as unknown as SyncCursor)).rejects.toThrow(
      RefusedSourceStateError,
    );
    // The source was never called, so nothing re-read the upstream.
    expect(seen).toEqual([]);
    expect(onRefuse).toHaveBeenCalledOnce();
    expect(onRefuse.mock.calls[0][0]).toContain("newer than this build");
  });

  test("a stop policy refuses rather than silently rebootstrapping", async () => {
    const stopping: SourceStateSpec<Notes> = { ...spec, onUnreadable: "stop" };
    const { instance, seen } = recordingInstance();
    const wrapped = withVersionedState(instance, stopping, { sourceId: "archive:local" });
    await expect(
      wrapped.sync({ e: 1, v: 2, state: { garbage: true } } as unknown as SyncCursor),
    ).rejects.toThrow(/Refusing to sync 'archive:local'/);
    expect(seen).toEqual([]);
  });

  test("the refusal error names the source, so a parked source is identifiable", async () => {
    const { instance } = recordingInstance();
    const wrapped = withVersionedState(instance, spec, { sourceId: "fieldnotes:local" });
    const err = await wrapped
      .sync({ e: 1, v: 9, state: {} } as unknown as SyncCursor)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedSourceStateError);
    expect((err as RefusedSourceStateError).sourceId).toBe("fieldnotes:local");
    const steps = (err as RefusedSourceStateError).remediation?.steps.join(" ");
    expect(steps).toContain("take a backup");
    expect(steps).toContain("verified that the source can recover its history");
    expect(steps).not.toContain("omnesis sources resync");
  });
});

describe("observability", () => {
  test("every resolution is reported, so a rebootstrap is never silent", async () => {
    const outcomes: StateOutcome[] = [];
    const { instance } = recordingInstance();
    const wrapped = withVersionedState(instance, spec, {
      sourceId: "fieldnotes:local",
      onResolve: (o) => outcomes.push(o),
    });
    await wrapped.sync(null);
    await wrapped.sync({ e: 1, v: 1, state: { cursor: "a" } } as unknown as SyncCursor);
    await wrapped.sync({ e: 1, v: 2, state: { after: "b" } } as unknown as SyncCursor);
    await wrapped.sync({ e: 1, v: 2, state: { junk: true } } as unknown as SyncCursor);
    expect(outcomes.map((o) => o.kind)).toEqual(["fresh", "migrated", "resume", "rebootstrap"]);
  });
});

describe("structured sources", () => {
  test("the analytics lane is wrapped the same way", async () => {
    const seen: (SyncCursor | null)[] = [];
    const instance: SourceInstance = {
      sync: async () => emptySync(),
      syncStructured: async (cursor) => {
        seen.push(cursor);
        return {
          analytics: { tableName: "t", records: [{ id: 1 }] },
          cursor: { after: "z" },
          hasMore: false,
        };
      },
    };
    const wrapped = withVersionedState(instance, spec, { sourceId: "rows:local" });
    const result = await wrapped.syncStructured!({
      e: 1,
      v: 1,
      state: { cursor: "old" },
    } as unknown as SyncCursor);
    expect(seen).toEqual([{ after: "old" }]);
    expect(result.cursor).toEqual({ e: 1, v: 2, s: "rows:local", state: { after: "z" } });
    // The decorator rewrites only the cursor; the page it wraps passes through.
    expect(tablesWritten(result)).toEqual(["t"]);
  });

  test("a cursor the source's own decoder rejects is reported, not silently demoted", async () => {
    // The value is still stored — refusing to record progress would be worse —
    // but unstamped, so the next run classifies it as legacy and migrates it.
    // A source that stamps its generation only on settled pages would have
    // every mid-cycle page quietly demoted to the oldest one, and nothing
    // anywhere would say so.
    const unencodable: string[] = [];
    const strict: SourceStateSpec = {
      version: 1,
      decode: (v) =>
        typeof v === "object" && v !== null && "settled" in v
          ? (v as Record<string, unknown>)
          : null,
    };
    const instance: SourceInstance = {
      sync: async () => syncPage([], { midCycle: true }, { hasMore: true }),
    };
    const wrapped = withVersionedState(instance, strict, {
      sourceId: "partial:local",
      onUnencodable: ({ sourceId }) => unencodable.push(sourceId),
    });

    const result = await wrapped.sync(null);
    expect(unencodable).toEqual(["partial:local"]);
    // Stored as it came back, so the page's progress is not thrown away.
    expect(isStateEnvelope(result.cursor)).toBe(false);
    expect(result.cursor).toEqual({ midCycle: true });
  });

  test("an instance without an analytics lane does not grow one", async () => {
    const { instance } = recordingInstance();
    const wrapped = withVersionedState(instance, spec, { sourceId: "s:1" });
    expect(wrapped.syncStructured).toBeUndefined();
  });
});

describe("sources that declare nothing", () => {
  test("are returned untouched, so nothing about them changes", async () => {
    const { instance } = recordingInstance();
    expect(withVersionedState(instance, undefined, { sourceId: "s:1" })).toBe(instance);
  });

  test("keep every other member of the instance", async () => {
    const instance: SourceInstance = {
      sync: async () => emptySync(),
      watchPaths: ["/tmp/vault"],
      suspend: async () => {},
      resume: async () => {},
      dispose: async () => {},
    };
    const wrapped = withVersionedState(instance, spec, { sourceId: "s:1" });
    expect(wrapped.watchPaths).toEqual(["/tmp/vault"]);
    expect(typeof wrapped.suspend).toBe("function");
    expect(typeof wrapped.resume).toBe("function");
    expect(typeof wrapped.dispose).toBe("function");
  });
});
