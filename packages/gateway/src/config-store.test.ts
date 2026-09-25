// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ConfigBootError, ConfigStore } from "./config-store.js";

let dir: string;
let path: string;
let store: ConfigStore;

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-config-"));
  path = join(dir, "omnesis.json");
  store = new ConfigStore({ filePath: path, watchDebounceMs: 40 });
});

afterEach(() => {
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("ConfigStore — load", () => {
  test("missing file starts empty and is OK", async () => {
    await store.load();
    expect(store.get()).toEqual({});
    expect(store.getStatus().ok).toBe(true);
  });

  test("valid file loads and parses", async () => {
    writeFileSync(path, JSON.stringify({ indexer: { cycleInterval: "5m" } }));
    await store.load();
    expect(store.get()).toEqual({ indexer: { cycleInterval: "5m" } });
  });

  test("invalid JSON on boot fails loud (refuses to start on defaults)", async () => {
    // A non-empty file with unparseable content must NOT degrade to {} on boot:
    // running on defaults (wrong embedder, no inference backends) and then
    // persisting that emptiness over the real config is exactly how a config
    // gets wiped. Refuse to start instead.
    writeFileSync(path, "{ not json");
    await expect(store.load()).rejects.toBeInstanceOf(ConfigBootError);
  });

  test("genuinely-invalid config on boot fails loud", async () => {
    // A real validation error (bad range) that stripping can't repair must
    // halt startup, not silently keep an empty config.
    writeFileSync(path, JSON.stringify({ sources: { default: { syncInterval: "invalid" } } }));
    await expect(store.load()).rejects.toBeInstanceOf(ConfigBootError);
  });

  test("empty file on boot starts empty (genuinely no config)", async () => {
    writeFileSync(path, "   \n");
    await store.load();
    expect(store.get()).toEqual({});
    expect(store.getStatus().ok).toBe(true);
  });

  test("an existing-but-unreadable config file on boot fails loud", async () => {
    // Make the config path a directory so readFileSync throws EISDIR. An
    // existing-but-unreadable file (permissions, EISDIR, I/O error) must halt
    // boot rather than degrade to defaults and persist the loss.
    mkdirSync(path);
    await expect(store.load()).rejects.toBeInstanceOf(ConfigBootError);
  });
});

describe("ConfigStore — lenient unknown-key strip on load (config-wipe regression)", () => {
  test("a since-removed key is stripped on load; the rest of the config survives", async () => {
    // Reproduces the incident: a config written by an older build still
    // carries a setting removed from the schema. The strict
    // schema rejects that whole document — pre-fix, the gateway booted on {},
    // losing the inference backends + assignments + source overrides. The
    // load path must strip the dead key and keep everything else.
    const legacy = {
      indexer: { cycleInterval: "5m" },
      inference: { allowRemoteInference: true },
      sources: { web: { removedSetting: true, syncInterval: "10m" } },
    };
    writeFileSync(path, JSON.stringify(legacy));
    await store.load();

    expect(store.getStatus().ok).toBe(true);
    const cfg = store.get();
    // Everything that is still valid is preserved untouched.
    expect(cfg.indexer?.cycleInterval).toBe("5m");
    expect(cfg.inference?.allowRemoteInference).toBe(true);
    expect(cfg.sources?.web?.syncInterval).toBe("10m");
    // The removed key is gone.
    expect((cfg.sources?.web as Record<string, unknown>).removedSetting).toBeUndefined();
  });

  test("a later patch persists the full config, not just the patched subtree", async () => {
    // The second half of the catastrophe: after booting on {}, the collector's
    // per-source registration patch wrote `{sources:{…}}` over the file,
    // permanently dropping inference. With the config loaded intact, the same
    // patch must merge onto it and persist inference unchanged.
    const legacy = {
      inference: { allowRemoteInference: true },
      sources: { web: { removedSetting: true } },
    };
    writeFileSync(path, JSON.stringify(legacy));
    await store.load();

    const res = await store.patch({ sources: { app: { syncInterval: "15m" } } });
    expect(res.ok).toBe(true);

    const persisted = JSON.parse(readFileSync(path, "utf-8"));
    expect(persisted.inference?.allowRemoteInference).toBe(true);
    expect(persisted.sources?.app?.syncInterval).toBe("15m");
    // The removed setting never comes back, on disk either.
    expect(persisted.sources?.web?.removedSetting).toBeUndefined();
  });

  test("a config of only since-removed keys strips to {} and boots — does not fail loud", async () => {
    // The strip and the fail-loud branches interact: a file that reduces to {}
    // after stripping must succeed (it's effectively an empty config), not trip
    // the boot guard.
    writeFileSync(path, JSON.stringify({ goneTopLevelKnob: true, alsoGone: { x: 1 } }));
    await store.load();
    expect(store.getStatus().ok).toBe(true);
    expect(store.get()).toEqual({});
  });

  test("the API mutation path stays strict — unknown keys are rejected, not stripped", async () => {
    // Lenience is load-only. An interactive PATCH adding an unrecognized key is
    // a typo and must fail, preserving the strict-schema safety net.
    await store.load();
    const res = await store.patch({ sources: { web: { removedSetting: true } } });
    expect(res.ok).toBe(false);
  });
});

describe("ConfigStore — patch / put", () => {
  beforeEach(async () => {
    await store.load();
  });

  test("patch merges and persists to disk", async () => {
    const res = await store.patch({ indexer: { cycleInterval: "10m" } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.version).toBe(1);
      expect(res.changedPaths).toEqual(["/indexer/cycleInterval"]);
      expect(res.config.indexer?.cycleInterval).toBe("10m");
    }
    const persisted = JSON.parse(readFileSync(path, "utf-8"));
    expect(persisted.indexer.cycleInterval).toBe("10m");
  });

  test("patch rejects on schema error without touching disk", async () => {
    const res = await store.patch({ sources: { default: { syncInterval: "invalid" } } });
    expect(res.ok).toBe(false);
    expect(existsSync(path)).toBe(false); // file never created
  });

  test("null in patch deletes keys", async () => {
    await store.patch({ indexer: { cycleInterval: "10m" } });
    const res = await store.patch({ indexer: { cycleInterval: null } });
    expect(res.ok).toBe(true);
    expect(store.get().indexer).toEqual({});
  });

  test("put replaces wholesale", async () => {
    await store.patch({
      indexer: { cycleInterval: "10m" },
      search: { params: { rrfK: 60 } },
    });
    const res = await store.put({ search: { params: { rrfK: 42 } } });
    expect(res.ok).toBe(true);
    expect(store.get().indexer).toBeUndefined();
    expect(store.get().search?.params?.rrfK).toBe(42);
  });

  test("no-op patch returns changedPaths=[] and doesn't bump version", async () => {
    await store.patch({ indexer: { cycleInterval: "10m" } });
    const beforeVersion = store.getStatus().version;
    const res = await store.patch({ indexer: { cycleInterval: "10m" } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changedPaths).toEqual([]);
    expect(store.getStatus().version).toBe(beforeVersion);
  });

  test("concurrent patches serialize (no lost update)", async () => {
    const results = await Promise.all([
      store.patch({ indexer: { cycleInterval: "15m" } }),
      store.patch({ search: { params: { rrfK: 42 } } }),
      store.patch({ indexer: { cycleInterval: "20m" } }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const final = store.get();
    // The three patches applied in order, so the winning value is "20m".
    expect(final.indexer?.cycleInterval).toBe("20m");
    expect(final.search?.params?.rrfK).toBe(42);
    // File on disk matches in-memory state.
    const persisted = JSON.parse(readFileSync(path, "utf-8"));
    expect(persisted.indexer.cycleInterval).toBe("20m");
  });
});

describe("ConfigStore — listeners + file watcher", () => {
  beforeEach(async () => {
    await store.load();
  });

  test("listener fires on patch with changedPaths", async () => {
    let captured: string[] | null = null;
    store.onChange((_b, _a, paths) => {
      captured = paths;
    });
    await store.patch({ search: { params: { rrfK: 42 } } });
    expect(captured).toEqual(["/search/params/rrfK"]);
  });

  test("listener unsubscribe stops receiving updates", async () => {
    let count = 0;
    const stop = store.onChange(() => {
      count += 1;
    });
    await store.patch({ indexer: { cycleInterval: "15m" } });
    stop();
    await store.patch({ indexer: { cycleInterval: "20m" } });
    expect(count).toBe(1);
  });

  test("external file edit triggers reload + listener", async () => {
    let changed: string[] | null = null;
    store.onChange((_b, _a, paths) => {
      changed = paths;
    });
    // fs.watch registers with the kernel asynchronously (FSEvents on darwin);
    // writes in the first few ms after watcher start can miss the
    // subscription. Give it a moment.
    await wait(100);
    writeFileSync(path, JSON.stringify({ indexer: { cycleInterval: "30m" } }));
    // Poll instead of a fixed wait — the watcher+debounce combined with
    // parallel fs activity in other tests can push the callback past a
    // tight margin on macOS.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && store.get().indexer?.cycleInterval !== "30m") {
      await wait(20);
    }
    expect(store.get().indexer?.cycleInterval).toBe("30m");
    expect(changed).toContain("/indexer/cycleInterval");
  });

  test("our own writes don't re-trigger listeners (hash-dedup)", async () => {
    let count = 0;
    store.onChange(() => {
      count += 1;
    });
    await store.patch({ indexer: { cycleInterval: "10m" } }); // count → 1 from patch
    // Give the file watcher a chance to fire on our own write and prove it's ignored.
    await wait(120);
    expect(count).toBe(1);
  });

  test("invalid external edit leaves config + sets lastError", async () => {
    await store.patch({ indexer: { cycleInterval: "45m" } });
    writeFileSync(path, "{ bogus");
    {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && store.getStatus().ok) await wait(20);
    }
    expect(store.get().indexer?.cycleInterval).toBe("45m");
    expect(store.getStatus().ok).toBe(false);
    // A subsequent valid edit clears lastError.
    writeFileSync(path, JSON.stringify({ indexer: { cycleInterval: "60m" } }));
    {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && store.get().indexer?.cycleInterval !== "60m") await wait(20);
    }
    expect(store.getStatus().ok).toBe(true);
    expect(store.get().indexer?.cycleInterval).toBe("60m");
  });
});
