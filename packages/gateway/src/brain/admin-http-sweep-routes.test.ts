// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP coverage for `/admin/brain/sweeps` — the only routes in the gateway
 * that write operator-authored text to the filesystem.
 *
 * Three things carry the weight here: an id can never reach a path it should
 * not (these routes turn a URL segment into a filename), the whole surface
 * stays behind admin scope and the live feature gate like the rest of
 * `/admin/brain/*`, and every mutation answers with the entire resolved list
 * so a client never has to guess what a save did to the rest of the set.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../db.js";
import { createServer } from "../server.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { recordSweepTally } from "./storage/sweep-tally.js";
import { SweepService } from "./sweeps/service.js";
import { SYSTEM_SWEEPS } from "./sweeps/system-sweeps.js";
import type { BriefsFeatureStatus } from "./feature-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let configDir: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let READ_TOKEN: string;
let status: BriefsFeatureStatus;

const ACTIVE: BriefsFeatureStatus = {
  visible: true,
  enabled: true,
  modelAssigned: true,
  active: true,
};

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${opts.token ?? ADMIN_TOKEN}`,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

const list = async (): Promise<{
  items: {
    id: string;
    origin: string;
    modified: boolean;
    hasSystemVersion: boolean;
    enabled: boolean;
    cadenceHours: number;
    at: string;
    anchorExplicit: boolean;
    steeringPrompt: string;
    stats: { runs: number; briefsCreated: number; briefsHeld: number };
  }[];
  issues: { id: string; message: string }[];
  directory: string;
  laneEnabled: boolean;
  digestWindowConflicts: { id: string; at: string }[];
}> => {
  const res = await req("GET", "/admin/brain/sweeps");
  expect(res.status).toBe(200);
  return res.json();
};

const byId = async (id: string) => (await list()).items.find((i) => i.id === id);

function sweepFile(id: string): string {
  return join(configDir, "sweeps", `${id}.md`);
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  configDir = mkdtempSync(join(tmpdir(), "omnesis-sweep-routes-"));
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  READ_TOKEN = mintToken([SCOPE_READ]);
  status = { ...ACTIVE };
  app = createServer(db, dbPath, {
    getBriefsStatus: () => status,
    configDir,
    getSweepsEnabled: () => true,
    sweeps: new SweepService({
      configDir,
      getScheduleContext: () => ({
        dailyRunHour: 5,
        digestEnabled: true,
        digestHour: 7,
        digestGraceMinutes: 45,
      }),
    }),
  });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
  rmSync(configDir, { recursive: true, force: true });
});

describe("inert-when-off + scopes", () => {
  test("every sweep route 404s when the feature is inactive — either prong", async () => {
    for (const prong of [
      { visible: true, enabled: true, modelAssigned: false, active: false },
      { visible: false, enabled: false, modelAssigned: true, active: false },
    ]) {
      status = prong;
      expect((await req("GET", "/admin/brain/sweeps")).status).toBe(404);
      expect(
        (await req("PUT", "/admin/brain/sweeps/x", { body: { cadenceHours: 24 } })).status,
      ).toBe(404);
      expect((await req("POST", "/admin/brain/sweeps/may-day/fork")).status).toBe(404);
      expect(
        (await req("POST", "/admin/brain/sweeps/may-day/enabled", { body: { enabled: false } }))
          .status,
      ).toBe(404);
      expect((await req("DELETE", "/admin/brain/sweeps/may-day")).status).toBe(404);
    }
  });

  test("a read-scope token cannot reach any of them", async () => {
    for (const [method, path] of [
      ["GET", "/admin/brain/sweeps"],
      ["PUT", "/admin/brain/sweeps/x"],
      ["POST", "/admin/brain/sweeps/may-day/fork"],
      ["POST", "/admin/brain/sweeps/may-day/enabled"],
      ["DELETE", "/admin/brain/sweeps/may-day"],
    ] as const) {
      const res = await req(method, path, {
        token: READ_TOKEN,
        ...(method === "GET" ? {} : { body: {} }),
      });
      expect([401, 403]).toContain(res.status);
      // Nothing was written on the way to the refusal.
      expect(existsSync(join(configDir, "sweeps"))).toBe(false);
    }
  });
});

describe("GET /admin/brain/sweeps", () => {
  test("lists the shipped sweeps with empty tallies and the sweep directory", async () => {
    const body = await list();
    expect(body.laneEnabled).toBe(true);
    expect(body.items.map((i) => i.id)).toEqual(SYSTEM_SWEEPS.map((s) => s.id));
    expect(body.items.every((i) => i.origin === "system" && i.hasSystemVersion)).toBe(true);
    expect(body.items[0].stats).toMatchObject({ runs: 0, briefsCreated: 0, briefsHeld: 0 });
    expect(body.directory).toBe(join(configDir, "sweeps"));
    expect(body.issues).toEqual([]);
  });

  test("joins each sweep to its durable tally", async () => {
    recordSweepTally(
      db,
      { sweepId: "weekly-finances", runs: 3, briefsCreated: 2, briefsHeld: 1, promptTokens: 900 },
      1_700_000_000_000,
    );
    const s = await byId("weekly-finances");
    expect(s!.stats).toMatchObject({ runs: 3, briefsCreated: 2, briefsHeld: 1 });
  });

  test("reports an unreadable file without dropping the rest of the set", async () => {
    mkdirSync(join(configDir, "sweeps"), { recursive: true });
    writeFileSync(sweepFile("broken"), "---\ncadence: whenever\n---\n\nProse.\n", "utf8");
    const body = await list();
    expect(body.items).toHaveLength(SYSTEM_SWEEPS.length);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].id).toBe("broken");
  });
});

describe("writes", () => {
  test("PUT creates a sweep and answers with the whole resolved list", async () => {
    const res = await req("PUT", "/admin/brain/sweeps/commitments-made", {
      body: {
        name: "Commitments",
        cadenceHours: 168,
        at: "06:30",
        steeringPrompt: "Promises the user made and has not kept.",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Awaited<ReturnType<typeof list>>;
    expect(body.items).toHaveLength(SYSTEM_SWEEPS.length + 1);
    const made = body.items.find((i) => i.id === "commitments-made")!;
    expect(made).toMatchObject({
      origin: "user",
      modified: false,
      hasSystemVersion: false,
      enabled: true,
      cadenceHours: 168,
      at: "06:30",
    });
    expect(existsSync(sweepFile("commitments-made"))).toBe(true);
  });

  test("a new sweep is refused without the two things it cannot inherit", async () => {
    expect(
      (await req("PUT", "/admin/brain/sweeps/no-cadence", { body: { steeringPrompt: "x" } }))
        .status,
    ).toBe(400);
    expect(
      (await req("PUT", "/admin/brain/sweeps/no-prose", { body: { cadenceHours: 24 } })).status,
    ).toBe(400);
    expect(existsSync(join(configDir, "sweeps", "no-cadence.md"))).toBe(false);
  });

  test("PUT is a partial edit: what the body omits survives", async () => {
    // The editor sends the fields it shows, so a full replace would make every
    // save destructive by omission.
    await req("POST", "/admin/brain/sweeps/waiting-on-others/enabled", {
      body: { enabled: false },
    });
    await req("PUT", "/admin/brain/sweeps/waiting-on-others", {
      body: { steeringPrompt: "Only the prose changed." },
    });
    expect(await byId("waiting-on-others")).toMatchObject({
      enabled: false,
      steeringPrompt: "Only the prose changed.",
    });

    // And on a sweep the operator invented, the cadence survives an edit that
    // does not mention it — otherwise the sweep would vanish into the issues.
    await req("PUT", "/admin/brain/sweeps/mine", {
      body: { cadenceHours: 336, steeringPrompt: "Original." },
    });
    await req("PUT", "/admin/brain/sweeps/mine", { body: { steeringPrompt: "Edited." } });
    const mine = await byId("mine");
    expect(mine).toMatchObject({ cadenceHours: 336, steeringPrompt: "Edited." });
    expect((await list()).issues).toEqual([]);
  });

  test("blanking the time hands the sweep back to the derived schedule", async () => {
    // The editor's "leave it blank and Omnesis picks one" affordance. A merge
    // cannot express this by omission, so `at: null` has to carry the intent —
    // otherwise a pinned time could never be un-pinned.
    await req("PUT", "/admin/brain/sweeps/mine", {
      body: { cadenceHours: 168, at: "06:30", steeringPrompt: "Prose." },
    });
    expect(await byId("mine")).toMatchObject({ at: "06:30", anchorExplicit: true });

    await req("PUT", "/admin/brain/sweeps/mine", { body: { at: null } });
    const after = (await byId("mine"))!;
    expect(after.anchorExplicit).toBe(false);
    // Everything else the body omitted survived the un-pinning.
    expect(after).toMatchObject({ cadenceHours: 168, steeringPrompt: "Prose." });

    // And omitting `at` entirely still means "leave it alone".
    await req("PUT", "/admin/brain/sweeps/mine", { body: { at: "07:15" } });
    await req("PUT", "/admin/brain/sweeps/mine", { body: { steeringPrompt: "Edited." } });
    expect(await byId("mine")).toMatchObject({ at: "07:15", anchorExplicit: true });
  });

  test("a body the file format cannot represent is refused, not written", async () => {
    // A name carrying a newline would land in the front matter as extra keys —
    // the file on disk would mean something the caller never asked for.
    for (const body of [
      { cadenceHours: 24, steeringPrompt: "x", name: "Harmless\nenabled: false" },
      { cadenceHours: 24, steeringPrompt: "x", name: "N".repeat(200) },
      { cadenceHours: 1e21, steeringPrompt: "x" },
      { cadenceHours: 6, steeringPrompt: "x" },
    ]) {
      expect((await req("PUT", "/admin/brain/sweeps/attempted", { body })).status).toBe(400);
    }
    expect(existsSync(sweepFile("attempted"))).toBe(false);
    expect((await list()).issues).toEqual([]);
  });

  test("a sweep's tally outlives the sweep — that history is the point of keeping one", async () => {
    recordSweepTally(db, { sweepId: "mine", runs: 5, briefsCreated: 2 }, 1_700_000_000_000);
    await req("PUT", "/admin/brain/sweeps/mine", {
      body: { cadenceHours: 168, steeringPrompt: "Prose." },
    });
    expect((await byId("mine"))!.stats.runs).toBe(5);
    expect((await req("DELETE", "/admin/brain/sweeps/mine")).status).toBe(200);
    // Re-created under the same id, it resumes the same record.
    await req("PUT", "/admin/brain/sweeps/mine", {
      body: { cadenceHours: 168, steeringPrompt: "Prose again." },
    });
    expect((await byId("mine"))!.stats).toMatchObject({ runs: 5, briefsCreated: 2 });
  });

  test("PUT on a system id layers over it — omitted fields keep tracking the shipped sweep", async () => {
    const before = (await byId("health-trends"))!;
    const res = await req("PUT", "/admin/brain/sweeps/health-trends", {
      body: { cadenceHours: 72 },
    });
    expect(res.status).toBe(200);
    const after = (await byId("health-trends"))!;
    expect(after.cadenceHours).toBe(72);
    expect(after.steeringPrompt).toBe(before.steeringPrompt);
    expect(after).toMatchObject({ origin: "user", modified: true, hasSystemVersion: true });
  });

  test("fork writes a file, and DELETE reverts to the shipped sweep exactly", async () => {
    const before = (await byId("weekly-finances"))!;
    expect((await req("POST", "/admin/brain/sweeps/weekly-finances/fork")).status).toBe(200);
    expect(existsSync(sweepFile("weekly-finances"))).toBe(true);
    expect((await byId("weekly-finances"))!.origin).toBe("user");

    expect((await req("DELETE", "/admin/brain/sweeps/weekly-finances")).status).toBe(200);
    expect(existsSync(sweepFile("weekly-finances"))).toBe(false);
    expect(await byId("weekly-finances")).toEqual(before);
  });

  test("DELETE with no file to remove is a 404, not a silent success", async () => {
    expect((await req("DELETE", "/admin/brain/sweeps/weekly-finances")).status).toBe(404);
  });

  test("enabled toggles a system sweep with a front-matter-only file", async () => {
    const res = await req("POST", "/admin/brain/sweeps/health-trends/enabled", {
      body: { enabled: false },
    });
    expect(res.status).toBe(200);
    const off = (await byId("health-trends"))!;
    expect(off.enabled).toBe(false);
    // Only switched off — the surfaces must not call this a fork.
    expect(off.modified).toBe(false);
    expect(
      (await req("POST", "/admin/brain/sweeps/health-trends/enabled", { body: { enabled: "no" } }))
        .status,
    ).toBe(400);
  });

  test("fork and enabled 404 on an id no sweep uses", async () => {
    expect((await req("POST", "/admin/brain/sweeps/nope/fork")).status).toBe(404);
    expect(
      (await req("POST", "/admin/brain/sweeps/nope/enabled", { body: { enabled: false } })).status,
    ).toBe(404);
  });
});

describe("id safety", () => {
  test("an id that is not a filename stem is refused before it reaches a path", async () => {
    // Encoded so the router hands the segment through rather than resolving it.
    for (const bad of ["..%2Fescape", "Upper", "with%20space", "a%2Fb"]) {
      for (const [method, suffix] of [
        ["PUT", ""],
        ["POST", "/fork"],
        ["POST", "/enabled"],
        ["DELETE", ""],
      ] as const) {
        const res = await req(method, `/admin/brain/sweeps/${bad}${suffix}`, {
          body: { enabled: false, cadenceHours: 24, steeringPrompt: "x" },
        });
        expect([400, 404]).toContain(res.status);
      }
    }
    // Nothing escaped the sweeps directory, and nothing was created inside it.
    expect(existsSync(join(configDir, "escape.md"))).toBe(false);
    expect(existsSync(join(configDir, "sweeps"))).toBe(false);
  });

  test("oversized prose is refused", async () => {
    const res = await req("PUT", "/admin/brain/sweeps/too-long", {
      body: { cadenceHours: 24, steeringPrompt: "x".repeat(8001) },
    });
    expect(res.status).toBe(400);
  });
});
