// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Label, person and folder filters on Gmail and Google Drive, through real MCP
 * Direct and Answer connections and a spawned gateway.
 *
 * The `label-filters` universe holds one invented Gmail account, whose
 * messages from two senders carry a work label, a personal label, both or
 * neither, and one invented Drive, whose files sit in a tree of folders, in
 * two folders at once, or in none. The doubles of both run the real sources'
 * label and folder code: every record carries the ids of its labels or
 * folders, and each account publishes its list of labels or folders at the
 * end of a sync. Nothing is pushed or written by hand; the doubles' mailbox
 * and Drive are changed between syncs the way Gmail and Drive change.
 *
 * Asserted, for Direct (search, fetch by id, URL lookup) and Answer:
 *   - a label covers the labels nested inside it by name: hiding "Work" hides
 *     a message filed only under "Work/Clients";
 *   - a built-in label is matched by its id;
 *   - a person picked from the editor's list, or typed with other capitals,
 *     shares or hides the mail they sent or received;
 *   - a folder covers every folder beneath it; a file filed both inside and
 *     outside a hidden folder is hidden, a file in no folder is shared by a
 *     hide filter and hidden by a share-only one;
 *   - renaming a nested label so that it sits under another one, and moving
 *     a Drive folder under another parent, change what a saved filter reads
 *     at the next sync, with no record sent again.
 *
 * The doubles are reached through a dynamic import: a static one would load
 * the synth package, and cache the active universe, before the harness sets
 * `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  closeFilterContext,
  expectFilterBoundary,
  filterEditor,
  filterOptions,
  filterPolicy,
  filterPreview,
  openFilterContext,
  pickPerson,
  pickTreePath,
  readFilterCorpus,
  startFilterHarness,
  typedIdentifier,
  typedPerson,
  type FilterAccess,
  type FilterContext,
  type FilterCorpus,
} from "./source-filter-corpus.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";
import type { FilterRef } from "@omnesis/types";

const GMAIL = "gmail:maya.reeves@example.org";
const DRIVE = "google-drive:maya.reeves@example.org";
const LABELS = "extra.labelIds";
const FOLDERS = "extra.folderIds";
const ACCESSES: FilterAccess[] = ["direct", "answer"];

const label = (id: string): FilterRef => ({ capability: "tree", field: LABELS, id });
const folder = (id: string): FilterRef => ({ capability: "tree", field: FOLDERS, id });
const WORK = label("Label_work");
const PERSONAL = label("Label_personal");
const CLIENTS = folder("lf-drive-clients");
const NORTHSTAR = folder("lf-drive-northstar");
const PERSONAL_FOLDER = folder("lf-drive-personal");

/**
 * The messages, by the label they carry once the test has filed "plain"
 * under a label nested in Work: atlas [Inbox, Work], billing [Work], garden
 * [Inbox, Personal], both [Work, Personal], plain [Work/Clients]. Jamie sent
 * atlas, billing and both; David sent garden and plain.
 */
const MAIL = ["atlas", "billing", "garden", "both", "plain"];
const FILES = ["contract", "brief", "roster", "recipe", "shared", "loose"];

describe("label, person and folder filters over MCP, from Gmail and Drive to what an agent reads", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let context: FilterContext;
  let mail: FilterCorpus;
  let files: FilterCorpus;
  /** The document count each completed sync reported, per source, in order. */
  const synced: Record<string, number[]> = { [GMAIL]: [], [DRIVE]: [] };
  const failures: string[] = [];

  async function doubles() {
    const mod = await import("@omnesis/provider-google-synth");
    const mailbox = mod.getGmailTwin(GMAIL);
    const drive = mod.getDriveTwin(DRIVE);
    if (!mailbox || !drive)
      throw new Error("Neither double of the mailbox and the drive is registered");
    return { mailbox, drive };
  }
  const sync = (sourceId: string) => harness.triggerSyncAndWait(sourceId, 60_000);

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = startFilterHarness("label-filters", model);
    await harness.start();
    harness.onStatusChange((change) => {
      const sourceId = String(change.sourceId);
      if (!(sourceId in synced)) return;
      if (change.event === "sync.completed")
        synced[sourceId]!.push(change.status.lastSyncStats?.documents ?? -1);
      if (change.event === "sync.error")
        failures.push(`${sourceId}: ${change.status.lastError ?? "unknown error"}`);
    });
    const { mailbox } = await doubles();
    // Gmail nests a label inside another by its name alone.
    mailbox.createLabel("Label_clients", "Work/Clients");
    mailbox.addLabel("lf-gmail-plain", "Label_clients");
    mailbox.removeLabel("lf-gmail-plain", "INBOX");
    await sync(GMAIL);
    await sync(DRIVE);
    mail = readFilterCorpus(harness, GMAIL);
    files = readFilterCorpus(harness, DRIVE);
    context = await openFilterContext(harness, model);
  }, 300_000);

  afterAll(async () => {
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("each source holds every invented record", () => {
    expect(failures).toEqual([]);
    expect([...mail.records.keys()].sort()).toEqual([...MAIL].sort());
    expect([...files.records.keys()].sort()).toEqual([...FILES].sort());
  });

  test("the editor shows labels as a tree whose nesting comes from the names, and Drive's folders as a tree", async () => {
    const editor = await filterEditor(harness, context.portal, GMAIL);
    expect(editor.fields.map((field) => [field.field, field.capability, field.state])).toEqual([
      [LABELS, "tree", { status: "ready" }],
      ["$people", "person", { status: "ready" }],
    ]);
    expect(editor.fields.find((field) => field.field === "$people")).toMatchObject({
      identifiers: ["email", "domain"],
      counts: { status: "ready", tooOld: 0, unmatched: 0 },
    });
    const clients = await pickTreePath(harness, context.portal, GMAIL, LABELS, [
      "Work",
      "Work/Clients",
    ]);
    expect(clients).toMatchObject({ ref: label("Label_clients"), shortLabel: "Clients", count: 1 });
    const roots = await filterOptions(harness, context.portal, GMAIL, { field: LABELS });
    expect(
      Object.fromEntries(roots.items.map((item) => [item.label, [item.count, item.hasChildren]])),
    ).toMatchObject({ Inbox: [2, false], Personal: [2, false], Work: [4, true] });

    const contracts = await pickTreePath(harness, context.portal, DRIVE, FOLDERS, [
      "Clients",
      "Northstar",
      "Contracts",
    ]);
    expect(contracts).toMatchObject({ ref: folder("lf-drive-contracts"), count: 1 });
    const top = await filterOptions(harness, context.portal, DRIVE, { field: FOLDERS });
    expect(Object.fromEntries(top.items.map((item) => [item.label, item.count]))).toEqual({
      Clients: 4,
      Personal: 2,
    });
  });

  test("a typed address or domain is read into the spelling a filter matches", async () => {
    expect(
      await typedIdentifier(harness, context.portal, "email", " David.Lin@Example.org "),
    ).toEqual({ identifier: { type: "email", value: "david.lin@example.org" } });
    expect(await typedIdentifier(harness, context.portal, "domain", "@Example.org")).toEqual({
      identifier: { type: "domain", value: "example.org" },
    });
    expect(await typedIdentifier(harness, context.portal, "email", "david.lin")).toHaveProperty(
      "error",
    );
  });

  for (const access of ACCESSES) {
    test(`Gmail ${access}: share only a label — and the labels nested in it by name`, async () => {
      await expectFilterBoundary(
        context,
        mail,
        access,
        "share",
        [WORK],
        ["atlas", "billing", "both", "plain"],
      );
    });

    test(`Gmail ${access}: hide a label — a message filed only under a label nested in it goes too`, async () => {
      await expectFilterBoundary(context, mail, access, "hide", [WORK], ["garden"]);
    });

    test(`Gmail ${access}: share only a built-in label, by its id`, async () => {
      await expectFilterBoundary(
        context,
        mail,
        access,
        "share",
        [label("INBOX")],
        ["atlas", "garden"],
      );
    });

    test(`Gmail ${access}: share only a person picked from the editor — the mail they sent`, async () => {
      const jamie = await pickPerson(
        harness,
        context.portal,
        GMAIL,
        "Jamie",
        "jamie.lopez@example.org",
      );
      expect(jamie.ref).toMatchObject({
        capability: "person",
        identifiers: [{ type: "email", value: "jamie.lopez@example.org" }],
      });
      await expectFilterBoundary(
        context,
        mail,
        access,
        "share",
        [jamie.ref],
        ["atlas", "billing", "both"],
      );
    });

    test(`Gmail ${access}: hide a person typed with capitals, together with a label — their union`, async () => {
      const david = await typedPerson(harness, context.portal, "David", [
        ["email", "David.Lin@Example.org"],
      ]);
      await expectFilterBoundary(context, mail, access, "hide", [david, label("Label_work")], []);
      await expectFilterBoundary(
        context,
        mail,
        access,
        "hide",
        [david],
        ["atlas", "billing", "both"],
      );
    });

    test(`Drive ${access}: share only a folder — everything beneath it, a file also filed elsewhere included`, async () => {
      await expectFilterBoundary(
        context,
        files,
        access,
        "share",
        [CLIENTS],
        ["contract", "brief", "roster", "shared"],
      );
    });

    test(`Drive ${access}: hide a folder — a file filed inside and outside it goes, a file in no folder stays`, async () => {
      await expectFilterBoundary(
        context,
        files,
        access,
        "hide",
        [NORTHSTAR],
        ["roster", "recipe", "loose"],
      );
    });

    test(`Drive ${access}: share two folders — their union, and never a file in no folder`, async () => {
      await expectFilterBoundary(
        context,
        files,
        access,
        "share",
        [NORTHSTAR, PERSONAL_FOLDER],
        ["contract", "brief", "recipe", "shared"],
      );
    });
  }

  test("a label renamed under another one and a folder moved under another parent change a saved filter at the next sync, with no record sent again", async () => {
    const { mailbox, drive } = await doubles();
    mailbox.renameLabel("Label_clients", "Personal/Clients");
    drive.moveFolder("lf-drive-contracts", "lf-drive-personal");
    drive.renameFolder("lf-drive-northstar", "Northstar clients");
    await sync(GMAIL);
    await sync(DRIVE);
    expect(failures).toEqual([]);
    expect(synced[GMAIL]!.at(-1)).toBe(0);
    expect(synced[DRIVE]!.at(-1)).toBe(0);

    for (const access of ACCESSES) {
      await expectFilterBoundary(context, mail, access, "hide", [WORK], ["garden", "plain"]);
      await expectFilterBoundary(
        context,
        mail,
        access,
        "share",
        [PERSONAL],
        ["garden", "both", "plain"],
      );
      await expectFilterBoundary(
        context,
        files,
        access,
        "share",
        [CLIENTS],
        ["brief", "roster", "shared"],
      );
      await expectFilterBoundary(
        context,
        files,
        access,
        "hide",
        [PERSONAL_FOLDER],
        ["brief", "roster", "loose"],
      );
    }
    const preview = await filterPreview(
      harness,
      context.portal,
      filterPolicy(DRIVE, "direct", "share", [NORTHSTAR]),
    );
    expect(preview).toMatchObject({
      total: FILES.length,
      visible: 2,
      items: [{ ref: NORTHSTAR, label: "Northstar clients", count: 2 }],
    });
  });
});
