// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { type DeviceId, SourceId, type SourceScopes } from "@omnesis/types";
import { runSchemaSetup } from "../data/schema.js";
import { createDevice, updateDeviceCapabilities } from "../data/repositories/DeviceRepository.js";
import { addSourceMember, removeSourceMember } from "../data/repositories/SourceRepository.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { applySourceScopeUpdates } from "./scope-updates.js";
import {
  requireScopeRefreshForHost,
  requireScopeRefreshForStoredHosts,
  recordNativeScopeKind,
  sourceScopeRefreshEpochs,
} from "./scope-refresh-requirements.js";

let db: SqliteDatabase.Database;
let actor: DeviceId;
const sourceId = SourceId("fictional:one");
const scopes: SourceScopes = {
  items: [
    { kind: "label", noun: { one: "label", many: "labels" }, picker: "search", link: "changes" },
    { kind: "folder", noun: { one: "folder", many: "folders" }, picker: "tree", link: "hierarchy" },
    { kind: "participant", identifiers: ["email"], link: "changes" },
  ],
};
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  db = new SqliteDatabase(":memory:");
  runSchemaSetup(db);
  actor = createDevice(db, {
    kind: "collector",
    name: "Fictional collector",
    capabilities: { sourceScopes: { min: 1, max: 2 } },
  }).id;
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?,'fictional','one',?,1,1)",
  ).run(sourceId, actor);
  upsertSourceScopes(db, [{ sourceType: "fictional", scopes }], 1);
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});
const context = () => ({
  sourceId,
  providerId: "fictional",
  streamId: "",
  authorityId: actor,
  snapshotAuthority: true,
});
function gate(kind: string): number | undefined {
  return db
    .prepare<[string, string], { active: number }>(
      "SELECT active FROM source_scope_refreshes WHERE source_id=? AND kind=?",
    )
    .get(sourceId, kind)?.active;
}

it("fences actual native metadata on collector downgrade, keeps the epoch sticky, and requires a matching catchup echo", () => {
  recordNativeScopeKind(db, sourceId, "label");
  updateDeviceCapabilities(db, actor, {});
  const epoch = sourceScopeRefreshEpochs(db, sourceId).label!;
  expect(epoch).toBeTruthy();
  expect(gate("label")).toBe(1);
  updateDeviceCapabilities(db, actor, {});
  requireScopeRefreshForHost(db, actor, sourceId);
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(epoch);
  // Reporting the kind again closes the fence with one new cut: a scan made
  // while the host could not report it proves nothing about what it wrote since.
  updateDeviceCapabilities(db, actor, { sourceScopes: { min: 1, max: 2 } });
  const upgraded = sourceScopeRefreshEpochs(db, sourceId).label!;
  expect(upgraded).not.toBe(epoch);
  updateDeviceCapabilities(db, actor, { sourceScopes: { min: 1, max: 2 } });
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(upgraded);
  applySourceScopeUpdates(db, context(), {
    refreshes: [{ kind: "label", active: false }],
    readiness: [{ kind: "label", complete: true }],
  });
  expect(gate("label")).toBe(1);
  for (const stale of ["older-cut", epoch]) {
    applySourceScopeUpdates(db, context(), {
      refreshes: [{ kind: "label", active: false, epoch: stale }],
    });
    expect(gate("label")).toBe(1);
  }
  applySourceScopeUpdates(db, context(), {
    refreshes: [{ kind: "label", active: false, epoch: upgraded }],
    readiness: [{ kind: "label", complete: true }],
  });
  expect(gate("label")).toBe(0);
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(upgraded);
  updateDeviceCapabilities(db, actor, {});
  expect(sourceScopeRefreshEpochs(db, sourceId).label).not.toBe(upgraded);
});
it("does not fence ever-legacy observed conversation derivation or a source without native metadata", () => {
  db.prepare(
    "INSERT INTO scope_conversations(subject_document_id,source_id,provider_id,stream_id,conversation_id) VALUES('legacy',?,'fictional','','chat')",
  ).run(sourceId);
  updateDeviceCapabilities(db, actor, {});
  expect(sourceScopeRefreshEpochs(db, sourceId)).toEqual({});
  db.prepare("UPDATE scope_conversations SET mode='snapshot'").run();
  requireScopeRefreshForHost(db, actor, sourceId);
  expect(sourceScopeRefreshEpochs(db, sourceId).participant).toBeTruthy();
});
it("requires hierarchy protocol2 while labels continue using protocol1", () => {
  recordNativeScopeKind(db, sourceId, "folder");
  recordNativeScopeKind(db, sourceId, "label");
  updateDeviceCapabilities(db, actor, { sourceScopes: { min: 1, max: 1 } });
  expect(sourceScopeRefreshEpochs(db, sourceId).folder).toBeTruthy();
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBeUndefined();
});
it("fences a newly joined unsupported host after native authority exists", () => {
  recordNativeScopeKind(db, sourceId, "label");
  const older = createDevice(db, { kind: "collector", name: "Fictional legacy peer" }).id;
  expect(addSourceMember(db, sourceId, older)).toBe(true);
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBeTruthy();
});
it("recognizes prior native refresh records on migration without scanning every document", () => {
  db.prepare("INSERT INTO source_scope_refreshes VALUES(?,'label',0)").run(sourceId);
  updateDeviceCapabilities(db, actor, {});
  expect(gate("label")).toBe(1);
});
it("refuses a nonholder catchup acknowledgement even with the correct epoch", () => {
  recordNativeScopeKind(db, sourceId, "label");
  updateDeviceCapabilities(db, actor, {});
  const epoch = sourceScopeRefreshEpochs(db, sourceId).label!;
  applySourceScopeUpdates(
    db,
    { ...context(), snapshotAuthority: false },
    {
      refreshes: [{ kind: "label", active: false, epoch }],
      readiness: [{ kind: "label", complete: true }],
    },
  );
  expect(gate("label")).toBe(1);
});

it("acknowledges only the accepted restart nonce and rejects a superseded cut", () => {
  applySourceScopeUpdates(db, context(), {
    refreshes: [
      { kind: "folder", active: true, requestId: "11111111-1111-4111-8111-111111111111" },
    ],
  });
  const first = sourceScopeRefreshEpochs(db, sourceId).folder!;
  applySourceScopeUpdates(db, context(), {
    refreshes: [
      {
        kind: "folder",
        active: true,
        epoch: first,
        restart: true,
        requestId: "22222222-2222-4222-8222-222222222222",
      },
    ],
  });
  const second = sourceScopeRefreshEpochs(db, sourceId).folder!;
  expect(second).not.toBe(first);
  applySourceScopeUpdates(db, context(), {
    refreshes: [
      {
        kind: "folder",
        active: true,
        epoch: first,
        restart: true,
        requestId: "33333333-3333-4333-8333-333333333333",
      },
    ],
  });
  expect(sourceScopeRefreshEpochs(db, sourceId).folder).toBe(second);
  expect(
    db
      .prepare(
        "SELECT request_id FROM source_scope_refresh_requirements WHERE source_id=? AND kind='folder'",
      )
      .get(sourceId),
  ).toEqual({ request_id: "22222222-2222-4222-8222-222222222222" });
  applySourceScopeUpdates(db, context(), {
    refreshes: [{ kind: "folder", active: false, epoch: second }],
  });
  applySourceScopeUpdates(db, context(), {
    refreshes: [{ kind: "folder", active: true, epoch: second }],
  });
  expect(sourceScopeRefreshEpochs(db, sourceId).folder).not.toBe(second);
});

it("fences a stored unsupported host at startup even when an old gateway bypassed capability hooks", () => {
  recordNativeScopeKind(db, sourceId, "folder");
  db.prepare("UPDATE devices SET capabilities='{}' WHERE id=?").run(actor);
  expect(sourceScopeRefreshEpochs(db, sourceId)).toEqual({});
  requireScopeRefreshForStoredHosts(db);
  const epoch = sourceScopeRefreshEpochs(db, sourceId).folder;
  expect(epoch).toBeTruthy();
  expect(gate("folder")).toBe(1);
  requireScopeRefreshForStoredHosts(db);
  expect(sourceScopeRefreshEpochs(db, sourceId).folder).toBe(epoch);
});

function labelReady(): number | undefined {
  return db
    .prepare<[string], { ready: number }>(
      "SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='label'",
    )
    .get(sourceId)?.ready;
}
/** The current collector reports that it finished the refresh it was asked for. */
function completeLabelRefresh(epoch: string): void {
  applySourceScopeUpdates(db, context(), {
    refreshes: [{ kind: "label", active: false, epoch }],
    readiness: [{ kind: "label", complete: true }],
  });
}

it("a collector that cannot report facts sharing the source costs one refresh, and readiness waits for it", () => {
  recordNativeScopeKind(db, sourceId, "label");
  const older = createDevice(db, { kind: "collector", name: "Fictional legacy peer" }).id;
  expect(addSourceMember(db, sourceId, older)).toBe(true);
  const attached = sourceScopeRefreshEpochs(db, sourceId).label!;
  expect(attached).toBeTruthy();
  expect(gate("label")).toBe(1);

  // Page after page from both collectors, with the current one finishing its
  // scan each round: the epoch never moves, so nothing asks for another scan,
  // and the kind stays unready rather than flipping ready and being re-fenced.
  for (let round = 0; round < 5; round++) {
    requireScopeRefreshForHost(db, older, sourceId);
    requireScopeRefreshForHost(db, actor, sourceId);
    completeLabelRefresh(attached);
    expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(attached);
    expect(gate("label")).toBe(1);
    expect(labelReady()).toBe(0);
  }
  requireScopeRefreshForStoredHosts(db);
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(attached);

  // The older collector is updated: one new cut, completed once, and ready.
  updateDeviceCapabilities(db, older, { sourceScopes: { min: 1, max: 2 } });
  const upgraded = sourceScopeRefreshEpochs(db, sourceId).label!;
  expect(upgraded).not.toBe(attached);
  completeLabelRefresh(attached);
  expect(gate("label")).toBe(1);
  completeLabelRefresh(upgraded);
  expect(gate("label")).toBe(0);
  expect(labelReady()).toBe(1);
  for (const host of [older, actor]) requireScopeRefreshForHost(db, host, sourceId);
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(upgraded);
  expect(gate("label")).toBe(0);
});

it("detaching the collector that cannot report facts asks for one more refresh before the kind is ready", () => {
  recordNativeScopeKind(db, sourceId, "label");
  const older = createDevice(db, { kind: "collector", name: "Fictional legacy peer" }).id;
  addSourceMember(db, sourceId, older);
  const attached = sourceScopeRefreshEpochs(db, sourceId).label!;
  completeLabelRefresh(attached);
  expect(gate("label")).toBe(1);

  removeSourceMember(db, sourceId, older);
  // The scan finished while it was attached does not count, and the collector
  // that made it will not report it again: its next page starts a new cut.
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(attached);
  requireScopeRefreshForHost(db, actor, sourceId);
  const detached = sourceScopeRefreshEpochs(db, sourceId).label!;
  expect(detached).not.toBe(attached);
  expect(gate("label")).toBe(1);
  completeLabelRefresh(attached);
  expect(gate("label")).toBe(1);
  requireScopeRefreshForHost(db, actor, sourceId);
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(detached);
  completeLabelRefresh(detached);
  expect(gate("label")).toBe(0);
  expect(labelReady()).toBe(1);
  completeLabelRefresh(detached);
  expect(sourceScopeRefreshEpochs(db, sourceId).label).toBe(detached);
});

it("records nothing about hosts while source filters are not in use", () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  recordNativeScopeKind(db, sourceId, "label");
  updateDeviceCapabilities(db, actor, {});
  const older = createDevice(db, { kind: "collector", name: "Fictional legacy peer" }).id;
  addSourceMember(db, sourceId, older);
  requireScopeRefreshForStoredHosts(db);
  expect(sourceScopeRefreshEpochs(db, sourceId)).toEqual({});
  expect(db.prepare("SELECT COUNT(*) AS n FROM source_scope_host_support").get()).toEqual({ n: 0 });
});
