// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import { loadSourceMeta, setSourceMeta, sourceIconUrl, sourceLabel, sourceUnitName } from "./format.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

const DESCRIPTOR_ICON = "data:image/png;base64,ZGVzY3JpcHRvcg==";
const SYNCED_ICON = "data:image/png;base64,c3luY2Vk";

describe("startup source metadata", () => {
  beforeEach(() => setSourceMeta({}));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shell metadata reads have a deadline and preserve the cache on timeout", async () => {
    vi.useFakeTimers();
    setSourceMeta({ "example-source": { label: "Current label" } });
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const read = loadSourceMeta();
    await vi.advanceTimersByTimeAsync(10_000);
    await read;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(sourceLabel("example-source")).toBe("Current label");
  });

  it("an aborted metadata refresh never publishes a late response over the current cache", async () => {
    setSourceMeta({ "example-source": { label: "Current label" } });
    const controller = new AbortController();
    const response = deferredResponse();
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return response.promise;
    });
    vi.stubGlobal("fetch", fetch);
    const read = loadSourceMeta(controller.signal);
    controller.abort();
    response.resolve(Response.json({}));
    await read;
    expect(sourceLabel("example-source")).toBe("Current label");
  });

  it.each(["synced", "descriptor"])(
    "requests both maps before either completes and merges independently of %s finishing first",
    async (first) => {
      const synced = deferredResponse();
      const descriptors = deferredResponse();
      const fetch = vi.fn((url: string) =>
        url === "/portal/source-meta.json" ? synced.promise : descriptors.promise,
      );
      vi.stubGlobal("fetch", fetch);
      setSourceMeta({ "example-source": { label: "Previous label" } });
      const loading = loadSourceMeta();
      expect(fetch.mock.calls).toEqual([
        ["/portal/source-meta.json", { signal: expect.any(AbortSignal) }],
        ["/admin/source-descriptors", { signal: expect.any(AbortSignal) }],
      ]);
      const syncResponse = Response.json({
        "example-source:account": { icon: SYNCED_ICON, label: "Account label" },
      });
      const descriptorResponse = Response.json({
        items: [
          {
            id: "example-source",
            name: "Descriptor label",
            icon: { imageDataUri: DESCRIPTOR_ICON },
            unitName: "entries",
          },
        ],
      });
      if (first === "synced") synced.resolve(syncResponse);
      else descriptors.resolve(descriptorResponse);
      await Promise.resolve();
      expect(sourceLabel("example-source")).toBe("Previous label");
      if (first === "synced") descriptors.resolve(descriptorResponse);
      else synced.resolve(syncResponse);
      await loading;
      expect(sourceLabel("example-source:account")).toBe("Account label");
      expect(sourceIconUrl("example-source:account")).toBe(SYNCED_ICON);
      expect(sourceLabel("example-source:another-account")).toBe("Descriptor label");
      expect(sourceIconUrl("example-source:another-account")).toBe(DESCRIPTOR_ICON);
      expect(sourceUnitName("example-source")).toBe("entries");
    },
  );

  it("uses descriptor fallback when synced metadata fails without losing the other request", async () => {
    const synced = deferredResponse();
    const descriptors = deferredResponse();
    vi.stubGlobal("fetch", (url: string) =>
      url === "/portal/source-meta.json" ? synced.promise : descriptors.promise,
    );
    const loading = loadSourceMeta();
    synced.reject(new Error("unavailable"));
    descriptors.resolve(
      Response.json({
        items: [{ id: "example-source", name: "Example source", unitName: "entries" }],
      }),
    );
    await loading;
    expect(sourceLabel("example-source")).toBe("Example source");
    expect(sourceUnitName("example-source")).toBe("entries");
  });

  it("retains synced metadata when descriptors are unavailable", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/portal/source-meta.json"
        ? Response.json({ "example-source:account": { label: "Synced label", icon: SYNCED_ICON } })
        : new Response(null, { status: 503 }),
    );
    await loadSourceMeta();
    expect(sourceLabel("example-source:account")).toBe("Synced label");
    expect(sourceIconUrl("example-source:account")).toBe(SYNCED_ICON);
  });

  it.each(["older", "newer"])(
    "keeps the latest source refresh authoritative when the %s request finishes first",
    async (first) => {
      const oldSync = deferredResponse();
      const oldDescriptors = deferredResponse();
      const newSync = deferredResponse();
      const newDescriptors = deferredResponse();
      const responses = [oldSync, oldDescriptors, newSync, newDescriptors];
      vi.stubGlobal("fetch", vi.fn(() => responses.shift()!.promise));
      setSourceMeta({ "example-source": { label: "Previous label" } });
      const older = loadSourceMeta();
      const newer = loadSourceMeta();
      const completeOlder = () => {
        oldSync.resolve(Response.json({ "example-source": { label: "Old source label" } }));
        oldDescriptors.resolve(Response.json({ items: [] }));
      };
      const completeNewer = () => {
        newSync.resolve(Response.json({ "example-source": { label: "Updated source label" } }));
        newDescriptors.resolve(Response.json({ items: [] }));
      };
      if (first === "older") {
        completeOlder();
        await older;
        expect(sourceLabel("example-source")).toBe("Previous label");
        completeNewer();
      } else {
        completeNewer();
        await newer;
        expect(sourceLabel("example-source")).toBe("Updated source label");
        completeOlder();
      }
      await Promise.all([older, newer]);
      expect(sourceLabel("example-source")).toBe("Updated source label");
    },
  );

  it("does not overwrite explicitly supplied metadata when an older network request settles", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", (url: string) => url === "/portal/source-meta.json"
      ? pending.promise : Promise.resolve(Response.json({ items: [] })));
    const loading = loadSourceMeta();
    setSourceMeta({ "example-source": { label: "Host supplied label" } });
    pending.resolve(Response.json({ "example-source": { label: "Older network label" } }));
    await loading;
    expect(sourceLabel("example-source")).toBe("Host supplied label");
  });
});
