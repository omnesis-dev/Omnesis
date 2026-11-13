// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Person filters on mail that names more people than the Gmail source keeps,
 * through the real ingest path, the real filter check and an agent reading
 * over MCP.
 *
 * Gmail's person filter needs version 2, from which the source stores every
 * address it reads, `Bcc` included, in one form; its records are written
 * here by the source's own text and people readers at that version, beside
 * the `label-filters` universe's synced mailbox. The source keeps at most
 * 1,000 people per message, so a message that names more cannot say whether
 * someone left out was on it: it is hidden under every person filter, even
 * one sharing only its sender, and counted as one that can't be matched. An
 * attachment is decided by its message.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildAttachmentDocument } from "@omnesis/core";
import {
  messageContent,
  messagePeople,
  MAX_PEOPLE_PER_MESSAGE,
} from "@omnesis/provider-google/src/gmail-message.js";
import { ProviderId, SourceId, type DocumentInput, type FilterRef } from "@omnesis/types";
import {
  closeAgents,
  connectAgent,
  expectDirectReads,
  grantRule,
  markerKey,
  ownerPortal,
  previewFilter,
  providerIdOf,
  pushAtVersion,
  readRecords,
  saveFilters,
  sourceFilter,
  typedIdentifier,
  type RecordSet,
} from "./filter-e2e-reads.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { AuthorizedMcpClient, PortalSession } from "./mcp-oauth-helper.js";

const QUERY = "zqfilter";

const person = (label: string, identifier: { type: "phone" | "email" | "domain"; value: string }) =>
  ({ capability: "person", label, identifiers: [identifier] }) as FilterRef;

const GMAIL = "gmail:maya.reeves@example.org";
const MAYA_MAIL = "maya.reeves@example.org";
const GUESTS = Array.from(
  { length: MAX_PEOPLE_PER_MESSAGE + 200 },
  (_, index) => `guest${String(index + 1).padStart(4, "0")}@example.org`,
);
/** A guest past the people the source keeps for a message. */
const LATE_GUEST = GUESTS[MAX_PEOPLE_PER_MESSAGE + 150]!;

/** A message as the Gmail source writes it: its text and people from the source's own readers. */
function gmailMessage(
  providerId: string,
  key: string,
  headers: { from: string; to: string },
): DocumentInput {
  const subject = `zqfilter TITLE_${key}`;
  const body = `zqfilter invented record BODY_${key}`;
  const content = messageContent({
    subject,
    from: headers.from,
    to: headers.to,
    cc: "",
    bcc: "",
    date: "Thu, 2 Apr 2026 09:00:00 +0000",
    body,
  });
  return {
    providerId: ProviderId(providerId),
    sourceId: SourceId(GMAIL),
    externalId: `invented-${key.toLowerCase()}`,
    title: subject,
    content,
    contentHash: `sha256:${key}`,
    metadata: {
      documentType: "email",
      tags: ["INBOX"],
      people: messagePeople({ ...headers, cc: "", bcc: "" }, body),
      extra: { labelIds: ["INBOX"], threadId: `invented-thread-${key.toLowerCase()}` },
    },
    sourceCreatedAt: "2026-04-02T09:00:00.000Z",
    sourceUpdatedAt: "2026-04-02T09:00:00.000Z",
  };
}

describe("person filters on mail naming more people than the source keeps", () => {
  let harness: SyntheticE2EHarness;
  let portal: PortalSession;
  let agent: AuthorizedMcpClient;
  let mail: RecordSet;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "label-filters",
    });
    await harness.start();
    await harness.triggerSyncAndWait(GMAIL, 60_000);
    const providerId = providerIdOf(harness, GMAIL);
    const crowd = gmailMessage(providerId, "CROWD", {
      from: "Jamie Lopez <jamie.lopez@example.org>",
      to: [MAYA_MAIL, ...GUESTS].join(", "),
    });
    const small = gmailMessage(providerId, "SMALL", {
      from: "David Lin <david.lin@example.org>",
      to: [MAYA_MAIL, LATE_GUEST].join(", "),
    });
    const attachment = buildAttachmentDocument(
      small,
      "seating.txt",
      { text: "zqfilter invented record BODY_SMALL_ATTACHMENT", truncated: false },
      { mimeType: "text/plain", sizeBytes: 64 },
    );
    expect(crowd.metadata.people).toHaveLength(MAX_PEOPLE_PER_MESSAGE);
    await pushAtVersion(
      harness,
      { sourceId: GMAIL, providerId },
      [crowd, small, attachment] as unknown as Array<Record<string, unknown>>,
      2,
    );
    mail = readRecords(harness, [GMAIL], markerKey(/BODY_([A-Z_]+)/));
    await harness.reindexMissing();
    await harness.refreshSearchSnapshot();
    portal = await ownerPortal(harness);
    agent = await connectAgent(harness, "Invented mail reader", [grantRule("direct")]);
  }, 300_000);

  afterAll(async () => {
    await closeAgents([agent]);
    await harness?.destroy();
  }, 30_000);

  test("hiding someone left off a crowded message hides that message, and an attachment with its message", async () => {
    expect([...mail.keys()].sort()).toEqual(
      ["atlas", "billing", "both", "crowd", "garden", "plain", "small", "small-attachment"].sort(),
    );
    const guest = await typedIdentifier(harness, portal, "email", LATE_GUEST.toUpperCase());
    const filter = sourceFilter(GMAIL, "hide", [person("Invented guest", guest)]);
    await saveFilters(harness, agent, { direct: [filter] });
    await expectDirectReads(
      harness,
      agent,
      mail,
      ["atlas", "billing", "both", "garden", "plain"],
      QUERY,
    );
    expect(await previewFilter(harness, portal, filter)).toMatchObject({
      visible: 5,
      unmatched: 1,
    });
  }, 300_000);

  test("sharing only the sender of a crowded message still withholds it", async () => {
    const jamie = await typedIdentifier(harness, portal, "email", "Jamie.Lopez@Example.org");
    await saveFilters(harness, agent, {
      direct: [sourceFilter(GMAIL, "share", [person("Jamie Lopez", jamie)])],
    });
    await expectDirectReads(harness, agent, mail, ["atlas", "billing", "both"], QUERY);
  }, 300_000);
});
