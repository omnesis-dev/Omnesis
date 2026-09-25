// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * GitHub source end-to-end coverage — the `github` (issue / pull-request /
 * discussion threads) and `github-commits` (per-commit documents) source
 * entries, driven through a real gateway by the synthetic twin.
 *
 * The twin reads the universe's GitHub-shaped fixtures and hands them to the
 * REAL provider normalizer, so every rendered body, external id, people
 * mention, `metadata.extra.links` entry and declared edge asserted here is
 * produced by the code the live source runs. Nothing below asserts a fixture
 * echo: each expectation is read back out of the gateway — the `documents`,
 * `document_links`, `document_people` and `person_aliases` tables it wrote,
 * or `POST /documents/by-url` served by its canonicalizer registry.
 *
 * Why the `default` universe: it is the only in-tree universe whose GitHub
 * threads fixture carries a bot comment, which the bot-filtering assertions
 * need. Its GitHub corpus is a superset of `e2e-minimal`'s, and only the two
 * GitHub sources are synced, so the ingested corpus stays small either way —
 * the extra cost is the universe's boot, not its documents.
 *
 * Cadence note: only the sync itself is synchronous. Convention-derived
 * `references` edges arrive with the async `linkBackfill` task, their
 * `target_doc_id` with the periodic link-resolution pass, and people
 * resolution with its own writer-handler — so the readiness gate in
 * `beforeAll` polls for each rather than reading once after the sync returns.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

const REPO = "northstar-labs/atlas";
const ACCOUNT = "john-smith";
const THREADS_SOURCE = `github:${ACCOUNT}`;
const COMMITS_SOURCE = `github-commits:${ACCOUNT}`;

/** Every thread the universe fixture carries, as `kind` + number. */
const EXPECTED_THREADS: ReadonlyArray<{ kind: "issues" | "pull" | "discussions"; number: number }> =
  [
    { kind: "issues", number: 1 },
    { kind: "issues", number: 2 },
    { kind: "pull", number: 3 },
    { kind: "issues", number: 4 },
    { kind: "pull", number: 5 },
    { kind: "discussions", number: 6 },
    { kind: "issues", number: 7 },
    { kind: "pull", number: 8 },
    { kind: "issues", number: 9 },
    { kind: "pull", number: 10 },
    { kind: "discussions", number: 11 },
    { kind: "issues", number: 12 },
  ];

const EXPECTED_COMMIT_COUNT = 8;

/** The merged PR and the sha it landed as — the cross-source `accompanies` pair. */
const MERGED_PR = `${REPO}/pull/3`;
const MERGE_COMMIT_SHA = "cc24947363923ca2b79eb6e9cd441ed5072e3eaa";

/** The bot's comment on issue 7 — must never reach a rendered document. */
const BOT_COMMENT_TEXT = "Docs preview built for this branch.";
/** The human comment on the same thread — proves only the bot block was dropped. */
const HUMAN_COMMENT_ON_BOT_THREAD = "The teardown ordering is the part people get wrong";

interface DocRow {
  id: string;
  source_id: string;
  external_id: string;
  title: string;
  content: string;
  metadata: string;
  source_url: string | null;
}

interface DocMetadata {
  documentType?: string;
  sourceUrl?: string;
  status?: string;
  extra?: Record<string, unknown>;
}

interface ByUrlResp {
  matches: Record<string, string[]>;
}

describe("GitHub source (threads + commits, default universe)", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "default" });
    await harness.start();

    const githubSourceIds = harness
      .getSourceIds()
      .filter((id) => id === THREADS_SOURCE || id === COMMITS_SOURCE);
    expect(
      githubSourceIds.sort(),
      "the universe should declare both GitHub source entries",
    ).toEqual([COMMITS_SOURCE, THREADS_SOURCE]);
    await Promise.all(githubSourceIds.map((id) => harness.triggerSyncAndWait(id, 120_000)));

    db = new Database(harness.getDbPath(), { readonly: true });

    // 1. Every document landed.
    await waitFor(
      () =>
        countDocs(db, THREADS_SOURCE) >= EXPECTED_THREADS.length &&
        countDocs(db, COMMITS_SOURCE) >= EXPECTED_COMMIT_COUNT,
      60_000,
      () =>
        `documents ingested: ${countDocs(db, THREADS_SOURCE)} threads / ` +
        `${countDocs(db, COMMITS_SOURCE)} commits`,
    );

    // 2. People resolution ran over both sources — the login↔email bridge is
    //    the last of the three to settle, so gate on it.
    await waitFor(
      () => personIdForAlias(db, "lid", `github:${ACCOUNT}`) !== undefined,
      90_000,
      () => "no person carries the account's github lid yet",
    );

    // 3. linkBackfill extracted the `references` edges AND the resolution pass
    //    pointed them at their targets.
    await waitFor(
      () => {
        const prId = docByExternalId(db, MERGED_PR)?.id;
        if (!prId) return false;
        const rows = referencesOf(db, prId);
        return rows.length >= 2 && rows.every((r) => r.target_doc_id !== null);
      },
      120_000,
      () => "the merged PR's `references` edges are not resolved yet",
    );
  }, 300_000);

  afterAll(async () => {
    db?.close();
    await harness.destroy();
  }, 15_000);

  // ── 1. Threads ingest ───────────────────────────────────────────────

  test("every issue, pull request and discussion lands as a conversation document", () => {
    for (const { kind, number } of EXPECTED_THREADS) {
      const externalId = `${REPO}/${kind}/${number}`;
      const doc = docByExternalId(db, externalId);
      expect(doc, `document for ${externalId} should exist`).toBeDefined();
      expect(doc!.source_id).toBe(THREADS_SOURCE);

      const metadata = JSON.parse(doc!.metadata) as DocMetadata;
      expect(metadata.documentType, `${externalId} documentType`).toBe("conversation");
      // The external id IS the public URL path, so the two must agree —
      // that identity is what makes URL resolution work at all.
      expect(metadata.sourceUrl, `${externalId} sourceUrl`).toBe(
        `https://github.com/${externalId}`,
      );
      expect(doc!.source_url).toBe(`https://github.com/${externalId}`);
      expect(metadata.extra).toMatchObject({ repo: REPO, number });
    }
  });

  test("the threads source ingests exactly one document per thread", () => {
    expect(countDocs(db, THREADS_SOURCE)).toBe(EXPECTED_THREADS.length);
  });

  // ── 2. Comments live inside the thread document ─────────────────────

  test("a comment renders into its parent thread, not into a document of its own", () => {
    const issue = docByExternalId(db, `${REPO}/issues/1`);
    expect(issue).toBeDefined();
    // The commenter's text and their handle both render in the parent body.
    expect(issue!.content).toContain("Reproduced. The filter is applied after the page slice");
    expect(issue!.content).toContain("@john-smith");

    // No child document was minted for the comment: the only rows under this
    // thread's external-id prefix would be the thread itself.
    const descendants = db
      .prepare<
        [string],
        { external_id: string }
      >("SELECT external_id FROM documents WHERE external_id LIKE ? ESCAPE '\\'")
      .all(`${REPO}/issues/1/%`);
    expect(descendants, "no per-comment child documents").toEqual([]);
  });

  // ── 3. Bot filtering ────────────────────────────────────────────────

  test("a bot comment is dropped from the rendered thread and never becomes a person", () => {
    const issue = docByExternalId(db, `${REPO}/issues/7`);
    expect(issue).toBeDefined();
    expect(issue!.content).not.toContain(BOT_COMMENT_TEXT);
    expect(issue!.content).not.toContain("[bot]");
    // The rest of the thread survived — the filter removed one block, not the
    // conversation.
    expect(issue!.content).toContain(HUMAN_COMMENT_ON_BOT_THREAD);

    // SQLite has no bracket character classes in LIKE, so `[bot]` is literal.
    const botAliases = db
      .prepare<[], { alias: string }>("SELECT alias FROM person_aliases WHERE alias LIKE '%[bot]%'")
      .all();
    expect(botAliases, "no person should carry a bot alias").toEqual([]);
  });

  // ── 4. People graph ─────────────────────────────────────────────────

  test("`github:<login>` lids resolve to people attached to their documents with the right roles", () => {
    const selfId = personIdForAlias(db, "lid", `github:${ACCOUNT}`);
    expect(selfId, "the account's own login should resolve to a person").toBeDefined();
    const janeId = personIdForAlias(db, "lid", "github:jane-doe");
    expect(janeId, "a second cast member's login should resolve to a person").toBeDefined();
    expect(janeId).not.toBe(selfId);

    // The account holder authored the merged PR; Jane Doe only commented on
    // it, so she is a participant there and the author of the issue it fixes.
    expect(rolesOn(db, MERGED_PR, selfId!)).toContain("author");
    expect(rolesOn(db, MERGED_PR, janeId!)).toContain("participant");
    expect(rolesOn(db, `${REPO}/issues/1`, janeId!)).toContain("author");
  });

  test("the commit login↔email bridge lands both identifiers on one person", () => {
    const selfId = personIdForAlias(db, "lid", `github:${ACCOUNT}`);
    expect(selfId).toBeDefined();
    // The commits fixture carries the cast's real git author email; the same
    // PersonMention carries the login, so the two identities are one person.
    const emailPersonId = personIdForAlias(db, "email", "john.smith@example.com");
    expect(
      emailPersonId,
      "the git author email should resolve onto the same person as the login",
    ).toBe(selfId);
  });

  // ── 5. Reference links ──────────────────────────────────────────────

  test("`Closes #N` and `#N` shorthand resolve to `references` edges at the right documents", () => {
    const pr = docByExternalId(db, MERGED_PR)!;
    const refs = referencesOf(db, pr.id);
    // "Closes #1" plus the "#2" shorthand in the same body.
    expect(refs.map((r) => r.target_external_id).sort()).toEqual([
      `${REPO}/issues/1`,
      `${REPO}/issues/2`,
    ]);
    for (const ref of refs) {
      expect(ref.target_doc_id, `${ref.normalized_target} should be resolved`).not.toBeNull();
      expect(ref.target_source_id).toBe(THREADS_SOURCE);
    }

    // A second, independent pair: the open PR closing issue 4.
    const openPr = docByExternalId(db, `${REPO}/pull/5`)!;
    const openRefs = referencesOf(db, openPr.id);
    expect(openRefs.map((r) => r.target_external_id)).toContain(`${REPO}/issues/4`);
  });

  // ── 6. Merge-commit edge ────────────────────────────────────────────

  test("a merged PR declares an `accompanies` edge that resolves into the commits source", async () => {
    const pr = docByExternalId(db, MERGED_PR)!;
    const edge = () =>
      db
        .prepare<
          [string],
          {
            target_doc_id: string | null;
            target_source_id: string | null;
            metadata_json: string | null;
          }
        >(
          `SELECT dl.target_doc_id, d.source_id AS target_source_id, dl.metadata_json
             FROM document_links dl
             LEFT JOIN documents d ON d.id = dl.target_doc_id
            WHERE dl.source_doc_id = ? AND dl.link_type = 'accompanies'`,
        )
        .get(pr.id);

    // Cross-source declared edges park in `pending_edges` until the sibling
    // source ingests the target, so the resolution may trail the sync.
    await waitFor(
      () => edge()?.target_doc_id != null,
      60_000,
      () => "the PR's merge-commit edge has not resolved yet",
    );

    const resolved = edge()!;
    const commit = docByExternalId(db, `${REPO}/commit/${MERGE_COMMIT_SHA}`);
    expect(commit, "the merge commit's document should exist").toBeDefined();
    expect(resolved.target_doc_id).toBe(commit!.id);
    expect(resolved.target_source_id, "the edge crosses into the sibling source").toBe(
      COMMITS_SOURCE,
    );
    expect(JSON.parse(resolved.metadata_json ?? "{}")).toMatchObject({ relation: "merge-commit" });
  }, 90_000);

  // ── 7. Canonical URL resolution ─────────────────────────────────────

  test("every URL flavour of a thread resolves to the one document", async () => {
    const pr = docByExternalId(db, MERGED_PR)!;
    const urls = [
      `https://github.com/${MERGED_PR}`,
      `https://github.com/${MERGED_PR}/files`,
      `https://github.com/${MERGED_PR}/commits`,
      `https://www.github.com/${MERGED_PR}?w=1`,
      `https://api.github.com/repos/${REPO}/pulls/3`,
    ];
    const resp = await harness.gatewayJson<ByUrlResp>("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
    for (const url of urls) {
      expect(resp.matches[url], `${url} should resolve`).toEqual([pr.id]);
    }
  });

  test("a commit's URL flavours resolve to the commit document", async () => {
    const commit = docByExternalId(db, `${REPO}/commit/${MERGE_COMMIT_SHA}`)!;
    const urls = [
      `https://github.com/${REPO}/commit/${MERGE_COMMIT_SHA}`,
      `https://github.com/${REPO}/commit/${MERGE_COMMIT_SHA}.patch`,
      `https://api.github.com/repos/${REPO}/commits/${MERGE_COMMIT_SHA}`,
    ];
    const resp = await harness.gatewayJson<ByUrlResp>("/documents/by-url", {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
    for (const url of urls) {
      expect(resp.matches[url], `${url} should resolve`).toEqual([commit!.id]);
    }
  });

  // ── 8. Commits ingest ───────────────────────────────────────────────

  test("commits land one document per sha, carrying file paths but no diff", () => {
    const commits = db
      .prepare<
        [string],
        DocRow
      >("SELECT id, source_id, external_id, title, content, metadata, source_url FROM documents WHERE source_id = ?")
      .all(COMMITS_SOURCE);
    expect(commits.length).toBe(EXPECTED_COMMIT_COUNT);

    for (const commit of commits) {
      expect(commit.external_id, `${commit.external_id} shape`).toMatch(
        new RegExp(`^${REPO}/commit/[0-9a-f]{40}$`),
      );
      const metadata = JSON.parse(commit.metadata) as DocMetadata;
      expect(metadata.documentType).toBe("document");
      expect(metadata.sourceUrl).toBe(`https://github.com/${commit.external_id}`);
      // Changed-file paths are the point of the document; the code they
      // changed is deliberately never fetched.
      expect(commit.content).toContain("Files:");
      expect(commit.content).not.toContain("diff --git");
      expect(commit.content).not.toMatch(/^@@ /m);
      expect(commit.content).not.toMatch(/^\+\+\+ /m);
    }

    const mergeCommit = docByExternalId(db, `${REPO}/commit/${MERGE_COMMIT_SHA}`)!;
    expect(mergeCommit.content).toContain("src/search/cursor.ts");
    expect(mergeCommit.content).toContain("test/search/cursor.test.ts");
    expect(mergeCommit.title).toContain(`${REPO}@${MERGE_COMMIT_SHA.slice(0, 7)}`);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────

function countDocs(db: InstanceType<typeof Database>, sourceId: string): number {
  return (
    db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM documents WHERE source_id = ?")
      .get(sourceId)?.c ?? 0
  );
}

function docByExternalId(
  db: InstanceType<typeof Database>,
  externalId: string,
): DocRow | undefined {
  return db
    .prepare<
      [string],
      DocRow
    >("SELECT id, source_id, external_id, title, content, metadata, source_url FROM documents WHERE external_id = ?")
    .get(externalId);
}

/** The unmerged person carrying `alias` of `aliasType`, if any. */
function personIdForAlias(
  db: InstanceType<typeof Database>,
  aliasType: string,
  alias: string,
): string | undefined {
  return db
    .prepare<[string, string], { person_id: string }>(
      `SELECT COALESCE(p.merged_into, p.id) AS person_id
         FROM person_aliases a JOIN people p ON p.id = a.person_id
        WHERE a.alias_type = ? AND a.alias = ?`,
    )
    .get(aliasType, alias)?.person_id;
}

/** Roles a person holds on the document with `externalId`. */
function rolesOn(
  db: InstanceType<typeof Database>,
  externalId: string,
  personId: string,
): string[] {
  return db
    .prepare<[string, string, string], { role: string }>(
      `SELECT dp.role
         FROM document_people dp
         JOIN documents d ON d.id = dp.document_id
         JOIN people p ON p.id = dp.person_id
        WHERE d.external_id = ? AND (p.id = ? OR p.merged_into = ?)`,
    )
    .all(externalId, personId, personId)
    .map((r) => r.role);
}

interface ReferenceRow {
  normalized_target: string;
  target_doc_id: string | null;
  target_external_id: string | null;
  target_source_id: string | null;
}

function referencesOf(db: InstanceType<typeof Database>, docId: string): ReferenceRow[] {
  return db
    .prepare<[string], ReferenceRow>(
      `SELECT dl.normalized_target,
              dl.target_doc_id,
              d.external_id AS target_external_id,
              d.source_id AS target_source_id
         FROM document_links dl
         LEFT JOIN documents d ON d.id = dl.target_doc_id
        WHERE dl.source_doc_id = ? AND dl.link_type = 'references'
        ORDER BY dl.normalized_target`,
    )
    .all(docId);
}

/**
 * Poll `condition` until it holds. `describe` renders the current state into
 * the timeout message so a failure says what was still missing rather than
 * only that something was.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  describeState: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms — ${describeState()}`);
}
