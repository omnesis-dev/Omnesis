// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Trail-graph end-to-end coverage.
 *
 * Boots a real gateway against the `default` universe, syncs WhatsApp and
 * Gmail, then asserts that the "Q4 Vendor Assessment" fixture cluster
 * produces the expected multi-edge-type document graph:
 *
 *   WA msg ──attachment──→ WA PDF att
 *                              │
 *                       duplicate-content
 *                              │
 *   Gmail email ──attachment──→ Gmail PDF att
 *       │
 *     email-thread
 *       │
 *   Gmail reply
 *
 * Then exercises `GET /documents/:id/trail` and the `omnesis trail --json`
 * CLI command to verify the trail walks the full graph.
 */

import "./synth-env.js";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { EventTrail } from "@omnesis/core";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const CLI_ENTRY = "packages/cli/src/index.ts";

describe("Trail graph — attachment + dedup + thread (default universe)", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;

  beforeAll(async () => {
    const universeDir = join(REPO_ROOT, "evals/universes/default");
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: universeDir });
    await harness.start();

    const sourceIds = harness.getSourceIds();
    const targets = sourceIds.filter(
      (id) => id.startsWith("whatsapp-messages:") || id.startsWith("gmail:"),
    );
    await Promise.all(targets.map((id) => harness.triggerSyncAndWait(id, 60_000)));

    db = new Database(harness.getDbPath(), { readonly: true });

    await waitForLinkCondition(
      db,
      () => {
        const attLinks = db
          .prepare("SELECT COUNT(*) as c FROM document_links WHERE link_type = 'contains'")
          .get() as { c: number };
        const dupLinks = db
          .prepare("SELECT COUNT(*) as c FROM document_links WHERE link_type = 'duplicate-content'")
          .get() as { c: number };
        const threadLinks = db
          .prepare("SELECT COUNT(*) as c FROM document_links WHERE link_type = 'part-of-thread'")
          .get() as { c: number };
        return attLinks.c >= 2 && dupLinks.c >= 1 && threadLinks.c >= 1;
      },
      90_000,
    );
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness.destroy();
  }, 15_000);

  // ── Document existence ──────────────────────────────────────────────

  test("WhatsApp message with attachment produces parent + child documents", () => {
    const parent = findDoc(db, "synth-whatsapp-015");
    expect(parent, "WA parent doc should exist").toBeTruthy();
    expect(parent!.title).toContain("Jane Doe");

    const children = db
      .prepare("SELECT id, title FROM documents WHERE external_id LIKE ?")
      .all("synth-whatsapp-015/att/%") as { id: string; title: string }[];
    expect(children.length, "WA attachment doc should exist").toBeGreaterThanOrEqual(1);
    expect(children[0]!.title).toBe("Q4-Vendor-Assessment.pdf");
  });

  test("Gmail email with attachment produces parent + child documents", () => {
    const parent = findDoc(db, "synth-gmail-023");
    expect(parent, "Gmail parent doc should exist").toBeTruthy();

    const children = db
      .prepare("SELECT id, title FROM documents WHERE external_id LIKE ?")
      .all("synth-gmail-023/att/%") as { id: string; title: string }[];
    expect(children.length, "Gmail attachment doc should exist").toBeGreaterThanOrEqual(1);
    expect(children[0]!.title).toBe("Q4-Vendor-Assessment.pdf");
  });

  // ── Link types ──────────────────────────────────────────────────────

  test("attachment links exist between parent emails and their PDFs", () => {
    const links = db
      .prepare("SELECT COUNT(*) as c FROM document_links WHERE link_type = 'contains'")
      .get() as { c: number };
    expect(links.c).toBeGreaterThanOrEqual(2);
  });

  test("duplicate-content link exists between the two identical PDF attachments", () => {
    const waAtt = db
      .prepare("SELECT id FROM documents WHERE external_id LIKE 'synth-whatsapp-015/att/%'")
      .get() as { id: string } | undefined;
    const gmailAtt = db
      .prepare("SELECT id FROM documents WHERE external_id LIKE 'synth-gmail-023/att/%'")
      .get() as { id: string } | undefined;
    expect(waAtt, "WA attachment should exist").toBeTruthy();
    expect(gmailAtt, "Gmail attachment should exist").toBeTruthy();

    const link = db
      .prepare(
        `SELECT COUNT(*) as c FROM document_links
         WHERE link_type = 'duplicate-content'
         AND ((source_doc_id = ? AND target_doc_id = ?) OR (source_doc_id = ? AND target_doc_id = ?))`,
      )
      .get(waAtt!.id, gmailAtt!.id, gmailAtt!.id, waAtt!.id) as { c: number };
    expect(link.c, "duplicate-content link between the two PDFs").toBeGreaterThanOrEqual(1);
  });

  test("email-thread link exists between synth-gmail-023 and synth-gmail-024", async () => {
    const email1 = findDoc(db, "synth-gmail-023");
    const email2 = findDoc(db, "synth-gmail-024");
    expect(email1).toBeTruthy();
    expect(email2).toBeTruthy();

    const linkCount = (): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM document_links
             WHERE link_type = 'part-of-thread'
             AND ((source_doc_id = ? AND target_doc_id = ?) OR (source_doc_id = ? AND target_doc_id = ?))`,
          )
          .get(email1!.id, email2!.id, email2!.id, email1!.id) as { c: number }
      ).c;

    // linkBackfill populates email-thread edges incrementally. The boot-time
    // readiness gate only waits for *some* email-thread link, so this specific
    // pair may land a beat later — poll for it rather than asserting on first
    // read (the assertion stays strict; this only removes a readiness race).
    await waitForLinkCondition(db, () => linkCount() >= 1, 30_000);
    expect(linkCount(), "email-thread link between gmail-023 and gmail-024").toBeGreaterThanOrEqual(
      1,
    );
  }, 35_000);

  // ── Trail traversal ────────────────────────────────────────────────

  test("trail from WA message traverses the full graph", async () => {
    const waDoc = findDoc(db, "synth-whatsapp-015");
    expect(waDoc).toBeTruthy();

    const trail = await harness.gatewayJson<EventTrail>(`/documents/${waDoc!.id}/trail?depth=6`);
    expect(trail.seeds.length).toBeGreaterThan(0);
    expect(trail.events.length).toBeGreaterThanOrEqual(3);
    expect(trail.stats.visited).toBeGreaterThanOrEqual(4);

    const seed = trail.events.find((e) => e.kind === "seed");
    expect(seed, "seed event should exist").toBeTruthy();
    expect(seed!.attachments.length, "seed should have attachment nested").toBeGreaterThanOrEqual(
      1,
    );
    expect(seed!.attachments[0]!.doc.title).toBe("Q4-Vendor-Assessment.pdf");

    const titles = trail.events.map((e) => e.doc.title);
    const allTitles = [
      ...titles,
      ...trail.events.flatMap((e) => e.attachments.map((a) => a.doc.title)),
    ];
    expect(
      allTitles.some((t) => t === "Q4-Vendor-Assessment.pdf"),
      "trail should contain the PDF attachment",
    ).toBe(true);
  });

  test("trail from Gmail email includes thread reply and attachment", async () => {
    const gmailDoc = findDoc(db, "synth-gmail-023");
    expect(gmailDoc).toBeTruthy();

    const trail = await harness.gatewayJson<EventTrail>(`/documents/${gmailDoc!.id}/trail?depth=4`);
    expect(trail.events.length).toBeGreaterThanOrEqual(2);

    const titles = trail.events.map((e) => e.doc.title);
    expect(
      titles.some((t) => t.includes("Re: Q4 Vendor Assessment")),
      "trail should include the thread reply",
    ).toBe(true);
  });

  // ── CLI command ────────────────────────────────────────────────────

  test("`omnesis trail <id> --json` produces a valid EventTrail", async () => {
    const waDoc = findDoc(db, "synth-whatsapp-015");
    expect(waDoc).toBeTruthy();

    const cliEnv = {
      ...process.env,
      OMNESIS_GATEWAY_URL: harness.gatewayUrl,
      OMNESIS_TOKEN: harness.apiKey,
      // Keep TLS trust isolated to this synthetic gateway. Falling back to
      // the operator's config can feed the CLI an unrelated certificate.
      OMNESIS_CONFIG_DIR: harness.getConfigDir(),
      NO_COLOR: "1",
      CI: "1",
    };
    delete cliEnv.NODE_TLS_REJECT_UNAUTHORIZED;
    delete cliEnv.NODE_EXTRA_CA_CERTS;
    delete cliEnv.OMNESIS_INSECURE_TLS;
    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", CLI_ENTRY, "trail", waDoc!.id, "--json"],
      {
        cwd: REPO_ROOT,
        env: cliEnv,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    const start = stdout.indexOf("{");
    expect(start, "JSON output should contain an object").not.toBe(-1);
    const trail = JSON.parse(stdout.slice(start)) as EventTrail;
    expect(trail.seeds.length).toBeGreaterThan(0);
    expect(trail.events.length).toBeGreaterThanOrEqual(1);
    expect(trail.events[0]!.kind).toBe("seed");
    expect(typeof trail.stats.elapsedMs).toBe("number");
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────

function findDoc(
  db: InstanceType<typeof Database>,
  externalId: string,
): { id: string; title: string } | undefined {
  return db.prepare("SELECT id, title FROM documents WHERE external_id = ?").get(externalId) as
    | { id: string; title: string }
    | undefined;
}

async function waitForLinkCondition(
  db: InstanceType<typeof Database>,
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Link condition not met within ${timeoutMs}ms`);
}
