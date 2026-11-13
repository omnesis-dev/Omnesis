// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagePeople } from "../../../providers/google/src/gmail-message.js";
import { gmailLabelFacts } from "../../../providers/google/src/gmail-scope-labels.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import { pushScopeUpdates } from "./source-scope-fixtures.js";
import { closeScoped } from "./source-scope-external-helpers.js";
import {
  createFilterAccount,
  expectDirectBoundary,
  expectFilterBoundary,
  filterPolicy,
  closeFilterContext,
  nextDirect,
  openFilterConnection,
  openFilterContext,
  pickPerson,
  pushFilterRecords,
  readyFilterAccounts,
  saveFilters,
  type FilterAccount,
  type FilterContext,
  type FilterCorpus,
  type FilterRecordInput,
} from "./source-filter-corpus.js";
import type { ScopeRef } from "@omnesis/types";

const CAPABILITIES = ["direct", "answer"] as const;
const OWNER = "owner@example.com";
const PROJECT_LABEL = "Label_17";

const address = (typed: string, type: "email" | "domain" = "email"): ScopeRef => ({
  kind: "participant",
  label: typed,
  identifiers: [{ type, value: typed }],
});
const label = (id: string): ScopeRef => ({ kind: "label", id });
const folder = (id: string): ScopeRef => ({ kind: "folder", id });

function email(
  key: string,
  headers: { from: string; to: string; cc?: string; bcc?: string },
  labels: string[],
  body = "",
): FilterRecordInput {
  return {
    key,
    documentType: "email",
    metadata: {
      // The provider's own header parsing and label projection, so the test
      // never spells an address or a label the way it hopes the gateway does.
      people: messagePeople(headers, body),
      scopeFacts: gmailLabelFacts(labels),
    },
  };
}
const file = (key: string, parentIds: string[]): FilterRecordInput => ({
  key,
  documentType: "file",
  metadata: { scopeHierarchy: [{ kind: "folder", parentIds, complete: true }] },
});

const WITH_MAYA = ["from-maya", "from-maya-pdf", "cc-maya", "bcc-maya"];
const WITHOUT_MAYA = [
  "quotes-maya",
  "same-domain",
  "subdomain",
  "lookalike",
  "from-sarah",
  "from-sarah-pdf",
  "draft",
];

describe("mail and file filters over MCP, from native headers and folders to typed filters", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let mail: FilterAccount;
  let mailRecords: FilterCorpus;
  let drive: FilterAccount;
  let driveRecords: FilterCorpus;
  let context: FilterContext;

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "e2e-minimal",
      extraInference: {
        backends: { filterMail: { type: "http", url: model.url } },
        assignments: {
          agent: `filterMail/${model.modelId}`,
          "privacy-reviewer": `filterMail/${model.modelId}`,
        },
      },
    });
    await harness.start();

    mail = await createFilterAccount(harness, "gmail", OWNER);
    mailRecords = await pushFilterRecords(harness, mail, [
      email("from-maya", { from: "Maya Reeves <Maya.Reeves@Example.org>", to: OWNER }, [
        "INBOX",
        PROJECT_LABEL,
      ]),
      { key: "from-maya-pdf", documentType: "attachment", attachmentOf: "from-maya" },
      email(
        "cc-maya",
        { from: "jamie@example.net", to: OWNER, cc: '"Reeves, Maya" <maya.reeves@example.org>' },
        ["INBOX"],
      ),
      email("bcc-maya", { from: OWNER, to: "jamie@example.net", bcc: "MAYA.REEVES@EXAMPLE.ORG" }, [
        "SENT",
      ]),
      email(
        "quotes-maya",
        { from: "jamie@example.net", to: OWNER },
        ["INBOX"],
        "Forwarding what maya.reeves@example.org wrote last week.",
      ),
      email("same-domain", { from: "nora@example.org", to: OWNER }, ["INBOX"]),
      email("subdomain", { from: "david@mail.example.org", to: OWNER }, ["INBOX"]),
      email("lookalike", { from: "maya.reeves@example.org.example.net", to: OWNER }, ["SPAM"]),
      email("from-sarah", { from: "sarah@example.net", to: OWNER }, ["INBOX", PROJECT_LABEL]),
      { key: "from-sarah-pdf", documentType: "attachment", attachmentOf: "from-sarah" },
      email("draft", { from: OWNER, to: "" }, ["DRAFT"]),
      { key: "no-facts", documentType: "email", metadata: { people: [] } },
    ]);

    drive = await createFilterAccount(harness, "google-drive", OWNER);
    await pushScopeUpdates(harness, drive, {
      hierarchy: {
        kind: "folder",
        nodes: [
          { id: "fld-projects", label: "Invented projects", parentIds: [], complete: true },
          { id: "fld-cedar", label: "Invented cedar", parentIds: ["fld-projects"], complete: true },
          { id: "fld-drafts", label: "Invented drafts", parentIds: ["fld-cedar"], complete: true },
          { id: "fld-archive", label: "Invented archive", parentIds: [], complete: true },
          {
            id: "fld-moving",
            label: "Invented moving",
            parentIds: ["fld-projects"],
            complete: true,
          },
        ],
      },
    });
    driveRecords = await pushFilterRecords(harness, drive, [
      file("in-projects", ["fld-projects"]),
      file("in-cedar", ["fld-cedar"]),
      file("in-drafts", ["fld-drafts"]),
      { key: "in-drafts-preview", documentType: "attachment", attachmentOf: "in-drafts" },
      file("in-archive", ["fld-archive"]),
      file("two-parents", ["fld-cedar", "fld-archive"]),
      file("at-root", []),
      file("in-moving", ["fld-moving"]),
      file("moving-file", ["fld-projects"]),
      { key: "no-facts", documentType: "file" },
    ]);
    await readyFilterAccounts(harness, [mail, drive]);
    context = await openFilterContext(harness, model);
  }, 240_000);

  afterAll(async () => {
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  describe.each(CAPABILITIES)("Gmail, %s", (capability) => {
    const run = (action: "share" | "hide", match: ScopeRef[], shared: string[]) =>
      expectFilterBoundary(context, mail, mailRecords, capability, action, match, shared);
    test("share only a person: mail they sent or received in To, Cc or Bcc, with its attachments", async () => {
      await run("share", [address("MAYA.REEVES@example.org")], WITH_MAYA);
    }, 420_000);

    test("hide a person typed as a display name: a message that only quotes their address stays, a lookalike domain stays", async () => {
      await run("hide", [address("Maya Reeves <maya.reeves@example.org>")], WITHOUT_MAYA);
    }, 420_000);

    test("a person picked from the list carries the address the source declared, and counts the mail it governs", async () => {
      const picked = await pickPerson(
        harness,
        nextDirect(context),
        mail,
        "maya",
        "maya.reeves@example.org",
      );
      expect(picked.count).toBe(WITH_MAYA.length);
      await run("share", [picked.ref], WITH_MAYA);
      await run("hide", [picked.ref], WITHOUT_MAYA);
    }, 420_000);

    test("a domain is one exact host name, typed with or without the at sign", async () => {
      await run("share", [address("@Example.ORG", "domain")], [...WITH_MAYA, "same-domain"]);
      await run(
        "hide",
        [address("example.org", "domain")],
        WITHOUT_MAYA.filter((key) => key !== "same-domain"),
      );
    }, 420_000);

    test("share only a label: a user label by its id, with attachments", async () => {
      await run(
        "share",
        [label(PROJECT_LABEL)],
        ["from-maya", "from-maya-pdf", "from-sarah", "from-sarah-pdf"],
      );
    }, 420_000);

    test("hide system labels: drafts and spam are withheld by their ids", async () => {
      await run(
        "hide",
        [label("DRAFT"), label("SPAM")],
        [...WITH_MAYA, "quotes-maya", "same-domain", "subdomain", "from-sarah", "from-sarah-pdf"],
      );
    }, 420_000);

    test("a label that no longer exists shares nothing and hides nothing", async () => {
      await run("share", [label("Label_deleted")], []);
      await run("hide", [label("Label_deleted")], [...WITH_MAYA, ...WITHOUT_MAYA]);
    }, 420_000);

    test("a label and a person together share their union and hide their union", async () => {
      await run(
        "share",
        [label(PROJECT_LABEL), address("maya.reeves@example.org")],
        [...WITH_MAYA, "from-sarah", "from-sarah-pdf"],
      );
      await run(
        "hide",
        [label(PROJECT_LABEL), address("maya.reeves@example.org")],
        ["quotes-maya", "same-domain", "subdomain", "lookalike", "draft"],
      );
    }, 420_000);
  });

  describe.each(CAPABILITIES)("Google Drive, %s", (capability) => {
    const run = (action: "share" | "hide", match: ScopeRef[], shared: string[]) =>
      expectFilterBoundary(context, drive, driveRecords, capability, action, match, shared);

    test("share only a folder: everything beneath it, at any depth, and a file that is also filed elsewhere", async () => {
      await run(
        "share",
        [folder("fld-cedar")],
        ["in-cedar", "in-drafts", "in-drafts-preview", "two-parents"],
      );
    }, 420_000);

    test("hide a folder: a file filed both inside and outside it is withheld, a file in no folder stays", async () => {
      await run(
        "hide",
        [folder("fld-cedar")],
        ["in-projects", "in-archive", "at-root", "in-moving", "moving-file"],
      );
    }, 420_000);

    test("a folder that does not exist shares nothing and hides nothing", async () => {
      await run("share", [folder("fld-never")], []);
      await run(
        "hide",
        [folder("fld-never")],
        [
          "in-projects",
          "in-cedar",
          "in-drafts",
          "in-drafts-preview",
          "in-archive",
          "two-parents",
          "at-root",
          "in-moving",
          "moving-file",
        ],
      );
    }, 420_000);
  });

  test("a file or a folder moved after the filter was saved follows its new place on the next request", async () => {
    const shareProjects = nextDirect(context);
    const hideProjects = await openFilterConnection(harness, ["direct"]);
    const inside = [
      "in-projects",
      "in-cedar",
      "in-drafts",
      "in-drafts-preview",
      "two-parents",
      "in-moving",
      "moving-file",
    ];
    try {
      await saveFilters(harness, shareProjects, [
        {
          capability: "direct",
          policies: [filterPolicy(drive, "direct", "share", [folder("fld-projects")])],
        },
      ]);
      await saveFilters(harness, hideProjects, [
        {
          capability: "direct",
          policies: [filterPolicy(drive, "direct", "hide", [folder("fld-projects")])],
        },
      ]);
      await expectDirectBoundary(harness, shareProjects, drive, driveRecords, inside);
      await expectDirectBoundary(harness, hideProjects, drive, driveRecords, [
        "in-archive",
        "at-root",
      ]);
      await pushScopeUpdates(harness, drive, {
        hierarchy: {
          kind: "folder",
          nodes: [
            {
              id: "fld-moving",
              label: "Invented moving",
              parentIds: ["fld-archive"],
              complete: true,
            },
          ],
          documents: [
            {
              externalId: driveRecords.get("moving-file")!.externalId,
              parentIds: ["fld-archive"],
              complete: true,
            },
          ],
        },
      });
      await readyFilterAccounts(harness, [drive]);
      const moved = ["in-moving", "moving-file"];
      await expectDirectBoundary(
        harness,
        shareProjects,
        drive,
        driveRecords,
        inside.filter((key) => !moved.includes(key)),
      );
      await expectDirectBoundary(harness, hideProjects, drive, driveRecords, [
        "in-archive",
        "at-root",
        ...moved,
      ]);
    } finally {
      await closeScoped(hideProjects);
    }
  }, 420_000);

  test("an address a mail source cannot hold is refused when the filter is saved", async () => {
    for (const [typed, type] of [
      ["maya.reeves", "email"],
      ["*.example.org", "domain"],
      ["example.org/inbox", "domain"],
      ["+12025550123", "phone"],
    ] as const) {
      await expect(
        saveFilters(harness, nextDirect(context), [
          {
            capability: "direct",
            policies: [
              filterPolicy(mail, "direct", "hide", [
                { kind: "participant", label: typed, identifiers: [{ type, value: typed }] },
              ]),
            ],
          },
        ]),
        typed,
      ).rejects.toThrow(/HTTP 4(00|09)/);
    }
  }, 420_000);

  // Open product questions. Each names behaviour the suite deliberately does
  // not pin, because the intended rule has not been decided.
  test.todo(
    "should hiding a person also hide the other messages of a thread they took part in? Today a reply that quotes them but is not addressed to them stays readable.",
  );
  test.todo(
    "should a domain filter on the account owner's own domain be refused or warned about? Today it matches every message, because the owner is a participant of all of them.",
  );
});
