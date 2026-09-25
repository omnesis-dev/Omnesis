// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Identity resolution and merge-class canonicality, end to end.
 *
 * Boots one real gateway with an operator identity in `config.self` and no
 * synced sources, then drives `findOrCreatePerson` and the merge-rules
 * evaluator through their real seams: documents arrive over `POST /documents`,
 * resolution happens on the writer worker via the `backfill.peopleBatch` drip,
 * and every merge decision is made by `backfill.mergeRulesEval`.
 *
 * The algorithms are well covered in memory. What an in-memory test
 * structurally cannot reach is what this file exists for:
 *
 *   1. **Arrival order.** The conflict branch's outcome is decided by which
 *      document the resolver saw first, and that is a property of the drip,
 *      not of the function. The same three facts in the opposite order produce
 *      one person instead of two. Both orders run here against the real
 *      scheduler, with each document drained to completion before the next is
 *      pushed, so the order is the test's and not storage order over random
 *      UUIDs (`backfillOnePerson` selects `LIMIT 1` with no ORDER BY).
 *
 *   2. **The split is permanent.** The conflict branch deliberately does not
 *      create a shared alias, and both arms of `fetchAutoDetectData` read one:
 *      an alias owned by more than one person, or two `source='contacts'`
 *      people with the same headline. Neither exists here, which is why the
 *      safety net that heals almost every other split in the graph cannot
 *      reach this one. The test asserts those two inputs are empty rather than
 *      running a pass that had nothing to do and calling the no-op a result.
 *
 *   3. **The self person.** No prior synthetic E2E has had one, so the branch
 *      that decides whether the operator's own identity survives a merge has
 *      only ever run in memory. `config.self` is bootstrapped by a boot data
 *      migration that runs *after* the HTTP server starts listening, so the
 *      barrier is a route that only answers once the whole boot chain is past.
 *
 *   4. **A restart.** `demoteSharedAddresses` is a boot migration. Proving the
 *      learned blocklist closes its loop — a bucket accretes, a boot collapses
 *      it, and the address never mints a person again — needs a second boot
 *      against the same database, which only a spawned-gateway harness has.
 *
 *   5. **A dormant rule.** A rule bridging an alias that does not exist yet is
 *      skipped by `fetchMergeEquivalencesData` (`sideB.length === 0`). It can
 *      only wake once ingest bumps the merge-rules dirty version, because the
 *      alias arrives with no rule mutation and therefore no fast lane.
 *
 * Determinism. The gateway syncs nothing, so the only documents in the corpus
 * are this file's and `SELECT COUNT(*) FROM documents WHERE people_resolved_at
 * IS NULL` is a clean, file-wide drain gate. Every wait reads observable state
 * — a row from a read-only handle on `harness.getDbPath()`, or a status code —
 * through `waitForCondition`; there are no sleeps.
 *
 * Three background passes could otherwise write under these assertions, so
 * each is disarmed by name rather than out-waited:
 *
 *   - `backfill.mergeRulesEval` and `backfill.autoDetect` are configured to a
 *     24h cadence AND consumed once in `beforeAll`. Freezing the cadence only
 *     suppresses recurrence; the hardcoded start delays (15s / 30s) still fire
 *     one tick each. `PeriodicScheduler.kick` clears the pending timer and
 *     re-arms at `periodMs`, so driving each task once through
 *     `POST /admin/background/run` spends that free tick under the test's
 *     control instead of under a later assertion. `backfill.peopleBatch`
 *     re-kicks auto-detect whenever it drains, which is why every later
 *     assertion is written to survive an eval tick landing beside it.
 *   - `backfill.mergeCandidatesDetect` is frozen the same way but cannot be
 *     consumed (it is not in the run-now allowlist), so its 90s start delay
 *     lands somewhere in this file. What keeps it inert is the cast: the fuzzy
 *     scorer only pairs people sharing a name token, and the first test pins
 *     that no two fixture identities share one — under the smart-split and
 *     substring-shadow expansions the scorer applies, not just literally.
 *
 * `backfill.people.idleDelay` is dropped to 500ms so a per-document drain
 * costs about a second rather than the 30s default backoff.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { tokenizeEmail, tokenizeName } from "@omnesis/gateway/src/domain/MergeCandidateDetector.js";
import { SyntheticE2EHarness, type PushDocumentInput } from "./synth-harness.js";
import { waitForCondition } from "./multi-collector-harness.js";

const SELF_NAME = "Nadia Okonkwo";
const SELF_EMAIL = "nadia.okonkwo@example.com";

const MAYA_EMAIL = "maya.reeves@example.com";
const DAVID_PHONE = "+15550100142";
const JAMIE_EMAIL = "jamie.lopez@example.org";
const JAMIE_PHONE = "+15550100177";
const NOREPLY_EMAIL = "comments-noreply@docs.example.com";
const TESSA_EMAIL = "tessa.moreau@example.org";
const BRAM_EMAIL = "bram.halvorsen@example.net";
const INES_EMAIL = "ines.vidal@example.com";
const QUENTIN_EMAIL = "quentin.arbogast@example.net";
const MAILBOX_EMAIL = "queue@example.org";
const AVERY_EMAIL = "avery.quinn@example.net";

/**
 * Sixteen invented humans writing through one shared mailbox. One over the
 * configured `nameThreshold` of 15, so the fixture is asserted at its exact
 * size: a name silently dropped by `cleanPersonName` or by the role guard
 * would put the bucket under the bar and read as a regression in the demotion
 * rather than as a broken fixture.
 */
const MAILBOX_SENDERS = [
  "Talia Brentwood",
  "Marcus Fennimore",
  "Priya Oduya",
  "Soren Whitlock",
  "Camila Ashgrove",
  "Dmitri Larkspur",
  "Yasmin Trell",
  "Kofi Marchetti",
  "Elena Duskwood",
  "Hugo Pemberly",
  "Ingrid Vasquez",
  "Otis Kanagawa",
  "Freya Bellinger",
  "Rashid Colvin",
  "Noor Steadman",
  "Lucian Farrow",
] as const;

/**
 * Every identity this file can put in the people graph, as the token bag the
 * fuzzy merge-candidate detector would build for it. The sixteen mailbox
 * senders share one bucket person, so they are one bag; the name-only mentions
 * are listed even though they never become people, because a regression that
 * made them people must not also manufacture a candidate pair.
 */
const CAST: ReadonlyArray<{ who: string; names: readonly string[]; emails: readonly string[] }> = [
  { who: "self", names: [SELF_NAME], emails: [SELF_EMAIL] },
  { who: "maya", names: ["Maya Reeves"], emails: [MAYA_EMAIL] },
  { who: "david", names: ["David Lin"], emails: [] },
  { who: "jamie", names: ["Jamie Lopez"], emails: [JAMIE_EMAIL] },
  { who: "tessa", names: ["Tessa Moreau"], emails: [TESSA_EMAIL] },
  { who: "marisol", names: ["Marisol Feng"], emails: [] },
  { who: "rowan", names: ["Rowan Salter"], emails: [] },
  { who: "bram", names: ["Bram Halvorsen"], emails: [BRAM_EMAIL] },
  { who: "ines", names: ["Ines Vidal"], emails: [INES_EMAIL] },
  { who: "quentin", names: ["Quentin Arbogast"], emails: [QUENTIN_EMAIL] },
  { who: "wren", names: ["Wren Castellanos"], emails: [] },
  { who: "avery", names: ["Avery Quinn"], emails: [AVERY_EMAIL] },
  { who: "mailbox-bucket", names: [...MAILBOX_SENDERS], emails: [MAILBOX_EMAIL] },
];

const SRC_CONFLICT = "synthetic-identity:conflict";
const SRC_PAIR = "synthetic-identity:pair";
const SRC_NOREPLY = "synthetic-identity:noreply";
const SRC_DORMANT = "synthetic-identity:dormant";
const SRC_SELF = "synthetic-identity:self";
const SRC_MAILBOX = "synthetic-identity:mailbox";

interface PersonDetail {
  id: string;
  canonicalName: string;
  isSelf: boolean;
}

interface PeoplePage {
  items: Array<{ id: string; canonicalName: string }>;
}

interface MergeRuleResp {
  rule: {
    id: string;
    winnerSide: "a" | "b";
    sideA: { aliasType: string; alias: string };
    sideB: { aliasType: string; alias: string };
    active: boolean;
  };
  created: boolean;
}

describe("Identity resolution and merge-class canonicality (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  let selfId: string;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      extraGatewayConfig: {
        // The install-level operator identity. `runBootDataMigrations` turns
        // this into the canonical `is_self` person, with `first_seen` = boot
        // time — later than every dated fixture below, which is what makes
        // test 3's canonicality assertion mean something.
        self: { name: SELF_NAME, emails: [SELF_EMAIL] },
        gateway: {
          // Pinned rather than defaulted so the sixteen-name fixture and the
          // bar it has to clear move together.
          sharedAddressDemotion: { nameThreshold: 15, maxEmails: 5 },
          backfill: {
            // A per-document drain must not wait out the 30s idle backoff.
            people: { interval: "200ms", idleDelay: "500ms", batchSize: 500 },
            mergeRulesEval: { interval: "24h", idleDelay: "24h" },
            autoDetect: { interval: "24h" },
            mergeCandidates: { interval: "24h", idleDelay: "24h" },
          },
        },
      },
    });
    await harness.start();

    // The whole boot chain, not just the self bootstrap: the background-jobs
    // registry is populated at the very end of the entrypoint, after
    // `await runBootDataMigrations` and after the backfill tasks are
    // scheduled. A job id appearing here therefore proves both that the
    // migrations finished and that the run-now route has something to drive.
    await waitForCondition(
      async () => {
        const snapshot = await harness.gatewayJson<{ jobs: Array<{ id: string }> }>(
          "/admin/background-jobs",
        );
        const ids = new Set(snapshot.jobs.map((job) => job.id));
        return (
          ids.has("backfill.peopleBatch") &&
          ids.has("backfill.mergeRulesEval") &&
          ids.has("backfill.autoDetect")
        );
      },
      120_000,
      "the gateway's backfill jobs to register (boot data migrations complete)",
    );

    const self = await harness.gatewayJson<PersonDetail>("/people/self");
    selfId = self.id;

    // Spend the two free start-delay ticks now. `kick` consumes the pending
    // timer and re-arms at `periodMs` (24h here), so after this neither task
    // fires again unless something asks it to. The trailing eval absorbs the
    // kick auto-detect issues at the end of every one of its own ticks.
    await runTask("backfill.mergeRulesEval");
    await runTask("backfill.autoDetect");
    await runTask("backfill.mergeRulesEval");

    // --- conflict island: card arrives LAST, so its two identifiers already
    // belong to two different people. Each push is drained before the next so
    // arrival order is the test's, not `backfillOnePerson`'s unordered LIMIT 1.
    await push({
      sourceId: SRC_CONFLICT,
      externalId: "conflict-email",
      title: "Rehearsal times",
      sourceCreatedAt: "2021-01-04T09:00:00.000Z",
      metadata: { people: [{ role: "sender", emails: [MAYA_EMAIL], name: "Maya Reeves" }] },
    });
    await push({
      sourceId: SRC_CONFLICT,
      externalId: "conflict-call",
      title: "Missed call",
      sourceCreatedAt: "2022-06-11T18:30:00.000Z",
      metadata: { people: [{ role: "participant", phones: [DAVID_PHONE], name: "David Lin" }] },
    });
    await push({
      sourceId: SRC_CONFLICT,
      externalId: "conflict-card",
      title: "Address book entry",
      sourceCreatedAt: "2023-02-20T11:00:00.000Z",
      metadata: {
        people: [
          { role: "contact", emails: [MAYA_EMAIL], phones: [DAVID_PHONE], name: "Maya Reeves" },
        ],
      },
    });

    // --- mirror island: the same three facts, card FIRST.
    await push({
      sourceId: SRC_PAIR,
      externalId: "pair-card",
      title: "Address book entry",
      sourceCreatedAt: "2021-01-04T09:00:00.000Z",
      metadata: {
        people: [
          { role: "contact", emails: [JAMIE_EMAIL], phones: [JAMIE_PHONE], name: "Jamie Lopez" },
        ],
      },
    });
    await push({
      sourceId: SRC_PAIR,
      externalId: "pair-email",
      title: "Quote for the rebuild",
      sourceCreatedAt: "2022-06-11T18:30:00.000Z",
      metadata: { people: [{ role: "sender", emails: [JAMIE_EMAIL], name: "Jamie Lopez" }] },
    });
    await push({
      sourceId: SRC_PAIR,
      externalId: "pair-call",
      title: "Missed call",
      sourceCreatedAt: "2023-02-20T11:00:00.000Z",
      metadata: { people: [{ role: "participant", phones: [JAMIE_PHONE] }] },
    });

    // --- no-reply island: two authors behind one notification relay, then a
    // third message that carries the relay AND a real address.
    await push({
      sourceId: SRC_NOREPLY,
      externalId: "noreply-a",
      title: "A comment on a shared document",
      sourceCreatedAt: "2021-03-02T08:00:00.000Z",
      metadata: { people: [{ role: "sender", emails: [NOREPLY_EMAIL], name: "Marisol Feng" }] },
    });
    await push({
      sourceId: SRC_NOREPLY,
      externalId: "noreply-b",
      title: "Another comment on the same document",
      sourceCreatedAt: "2021-03-03T08:00:00.000Z",
      metadata: { people: [{ role: "sender", emails: [NOREPLY_EMAIL], name: "Rowan Salter" }] },
    });
    await push({
      sourceId: SRC_NOREPLY,
      externalId: "noreply-mixed",
      title: "A comment forwarded by its author",
      sourceCreatedAt: "2021-03-04T08:00:00.000Z",
      metadata: {
        people: [{ role: "sender", emails: [NOREPLY_EMAIL, TESSA_EMAIL], name: "Tessa Moreau" }],
      },
    });

    // --- dormant island: only the rule's A side exists for now.
    await push({
      sourceId: SRC_DORMANT,
      externalId: "dormant-anchor",
      title: "Season tickets",
      sourceCreatedAt: "2020-05-02T10:00:00.000Z",
      metadata: { people: [{ role: "sender", emails: [INES_EMAIL], name: "Ines Vidal" }] },
    });
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("no two fixture identities share a merge-candidate token", () => {
    // The fuzzy detector pairs people only through a shared token, and it can
    // manufacture one two ways beyond a literal match: it splits a unique
    // token of eight characters or more when both halves exist elsewhere in
    // the corpus, and it folds a token of six characters or more into every
    // token of ten or more that contains it. Pinning all three here is what
    // lets the rest of the file treat `backfill.mergeCandidatesDetect` — whose
    // 90s start delay lands somewhere in this run and cannot be consumed
    // through the run-now route — as structurally inert rather than as a race.
    const bags = CAST.map((member) => ({
      who: member.who,
      tokens: new Set([
        ...member.names.flatMap((name) => tokenizeName(name)),
        ...member.emails.flatMap((email) => tokenizeEmail(email)),
      ]),
    }));

    for (const bag of bags) expect(bag.tokens.size, `${bag.who} has no tokens`).toBeGreaterThan(0);

    for (let i = 0; i < bags.length; i++) {
      for (let j = i + 1; j < bags.length; j++) {
        const shared = [...bags[i].tokens].filter((t) => bags[j].tokens.has(t));
        expect(shared, `${bags[i].who} and ${bags[j].who} share a token`).toEqual([]);
      }
    }

    const corpus = new Set(bags.flatMap((bag) => [...bag.tokens]));
    for (const token of corpus) {
      if (token.length >= 8) {
        for (let i = 3; i <= token.length - 3; i++) {
          const halves = [token.slice(0, i), token.slice(i)];
          expect(
            halves.every((half) => corpus.has(half)),
            `"${token}" smart-splits into two corpus tokens`,
          ).toBe(false);
        }
      }
      if (token.length >= 10) {
        for (const other of corpus) {
          if (other === token || other.length < 6) continue;
          expect(token.includes(other), `"${other}" shadow-expands into "${token}"`).toBe(false);
        }
      }
    }
  });

  test("a mention carrying two people's identifiers links to the earlier person and leaves the other's identifier where it is", () => {
    assertResolved(["conflict-email", "conflict-call", "conflict-card"]);

    const graph = withDb((db) => {
      const mayaId = personIdForAlias(db, "email", MAYA_EMAIL);
      const davidId = personIdForAlias(db, "phone", DAVID_PHONE);
      return {
        mayaId,
        davidId,
        phoneOwners: db
          .prepare<[string], { person_id: string }>(
            "SELECT person_id FROM person_aliases WHERE alias_type = 'phone' AND alias = ?",
          )
          .all(DAVID_PHONE)
          .map((row) => row.person_id),
        mayaAliases: mayaId ? aliasSet(db, mayaId) : [],
        cardLinks: peopleForDocument(db, "conflict-card"),
        merged: db
          .prepare<
            [],
            { id: string; merged_into: string | null }
          >("SELECT id, merged_into FROM people WHERE merged_into IS NOT NULL")
          .all(),
      };
    });

    expect(graph.mayaId).toBeDefined();
    expect(graph.davidId).toBeDefined();
    expect(graph.mayaId).not.toBe(graph.davidId);

    // The conflicting identifier stays where it was. Annexing it would fold a
    // second person's phone onto whoever the mis-transcribed card names.
    expect(graph.phoneOwners).toEqual([graph.davidId]);
    expect(graph.mayaAliases).toEqual(["email:" + MAYA_EMAIL, "name:Maya Reeves"]);

    // 2021 beats 2022, and both `first_seen` values are the document dates the
    // test supplied — so the winner does not depend on ingestion time.
    expect(graph.cardLinks).toEqual([graph.mayaId]);
    expect(graph.merged).toEqual([]);

    // The split is permanent because auto-detect has no input to heal it: it
    // reads exactly these two queries, and both are empty on this corpus.
    const autoDetectInputs = withDb((db) => ({
      sharedAliases: db
        .prepare<[], { alias_type: string; alias: string }>(
          `SELECT alias_type, alias FROM person_aliases
            WHERE alias_type IN ('email', 'phone', 'lid')
            GROUP BY alias_type, alias
           HAVING COUNT(DISTINCT person_id) > 1`,
        )
        .all(),
      contactPeople: db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM people WHERE source = 'contacts'")
        .get()!.n,
    }));
    expect(autoDetectInputs.sharedAliases).toEqual([]);
    expect(autoDetectInputs.contactPeople).toBe(0);

    // The mirror island: the same three facts with the card FIRST legitimately
    // land both identifiers on one person, so the split above is the arrival
    // order's doing and not a blanket refusal to fuse identifiers.
    assertResolved(["pair-card", "pair-email", "pair-call"]);
    const mirror = withDb((db) => ({
      byEmail: personIdForAlias(db, "email", JAMIE_EMAIL),
      byPhone: personIdForAlias(db, "phone", JAMIE_PHONE),
      card: peopleForDocument(db, "pair-card"),
      email: peopleForDocument(db, "pair-email"),
      call: peopleForDocument(db, "pair-call"),
    }));
    expect(mirror.byEmail).toBeDefined();
    expect(mirror.byPhone).toBe(mirror.byEmail);
    expect(mirror.card).toEqual([mirror.byEmail]);
    expect(mirror.email).toEqual([mirror.byEmail]);
    expect(mirror.call).toEqual([mirror.byEmail]);
  }, 120_000);

  test("a shared no-reply address is never an identity key, and shedding it falls through to the name-only branch instead of minting a bucket", () => {
    // `pushDocument` discards the ingest response, and a document that never
    // landed produces byte-identical rows to one that landed and was correctly
    // shed — so every absence below is only meaningful behind this control.
    assertResolved(["noreply-a", "noreply-b", "noreply-mixed"]);

    const state = withDb((db) => ({
      noreplyAliases: db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM person_aliases WHERE alias_type = 'email' AND alias LIKE '%noreply%'")
        .get()!.n,
      noreplyHeadlines: db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM people WHERE canonical_name LIKE '%noreply%'")
        .get()!.n,
      relayAuthors: db
        .prepare<
          [string, string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM people WHERE canonical_name IN (?, ?)")
        .get("Marisol Feng", "Rowan Salter")!.n,
      linksA: peopleForDocument(db, "noreply-a"),
      linksB: peopleForDocument(db, "noreply-b"),
      tessaId: personIdForAlias(db, "email", TESSA_EMAIL),
      mixedLinks: peopleForDocument(db, "noreply-mixed"),
    }));

    // If the relay is never an alias it can never be a lookup key, and the
    // accreting bucket is structurally impossible.
    expect(state.noreplyAliases).toBe(0);
    expect(state.noreplyHeadlines).toBe(0);

    // The fall-through half: a shed that returned early instead of continuing
    // to the name-only branch would satisfy the assertions above while minting
    // one person per notification.
    expect(state.relayAuthors).toBe(0);
    expect(state.linksA).toEqual([]);
    expect(state.linksB).toEqual([]);

    // Shedding is per-identifier, not per-mention: the real address in the same
    // mention still resolves, and does not drag the shed one onto it.
    expect(state.tessaId).toBeDefined();
    expect(withDb((db) => aliasSet(db, state.tessaId!))).toEqual([
      "email:" + TESSA_EMAIL,
      "name:Tessa Moreau",
    ]);
    expect(state.mixedLinks).toEqual([state.tessaId]);
  }, 60_000);

  test("the operator's own person wins canonicality against both the rule's vote and the earlier first_seen, and stays reachable at /people/self", async () => {
    const self = await harness.gatewayJson<PersonDetail>("/people/self");
    expect(self.id).toBe(selfId);
    expect(self.canonicalName).toBe(SELF_NAME);
    expect(self.isSelf).toBe(true);

    await push({
      sourceId: SRC_SELF,
      externalId: "self-rival",
      title: "An old thread",
      sourceCreatedAt: "2019-03-04T09:00:00.000Z",
      metadata: { people: [{ role: "sender", emails: [BRAM_EMAIL], name: "Bram Halvorsen" }] },
    });
    assertResolved(["self-rival"]);

    const bramId = withDb((db) => personIdForAlias(db, "email", BRAM_EMAIL));
    expect(bramId).toBeDefined();

    // Self was bootstrapped at boot; the rival's `first_seen` is the 2019
    // document date. Without this the merge could pick self for the boring
    // reason and the test would prove nothing.
    const firstSeen = withDb((db) => ({
      bram: personRow(db, bramId!).first_seen,
      self: personRow(db, selfId).first_seen,
    }));
    expect(firstSeen.bram < firstSeen.self).toBe(true);

    // Before the merge the rival is a first-class person in the people reads —
    // the control that makes its disappearance below a real observation.
    const beforeSearch = await harness.gatewayJson<PeoplePage>(
      "/people/search?q=Bram%20Halvorsen&limit=5",
    );
    expect(beforeSearch.items.map((p) => p.id)).toContain(bramId);

    // `canonicalizeRuleSides` orders the two sides lexicographically, and
    // "bram…" sorts before "nadia…", so no swap occurs and the vote stays on
    // the rival. Assert that, or a future canonicalization change would move
    // the vote and quietly make the test trivial.
    const created = await harness.gatewayJson<MergeRuleResp>("/people/merge-rules", {
      method: "POST",
      body: JSON.stringify({
        sideA: { aliasType: "email", alias: BRAM_EMAIL },
        sideB: { aliasType: "email", alias: SELF_EMAIL },
        winnerSide: "a",
        kind: "user",
        reason: "identity-resolution.e2e: vote deliberately against self",
      }),
    });
    expect(created.created).toBe(true);
    expect(created.rule.sideA.alias).toBe(BRAM_EMAIL);
    expect(created.rule.winnerSide).toBe("a");

    await runTask("backfill.mergeRulesEval");
    // The user-mutation fast lane may already have applied the rule before the
    // kick; both paths converge on the same row, so gate on the row.
    await waitForDb(
      (db) => equivalenceFor(db, bramId!)?.to_id === selfId,
      60_000,
      "the rival to merge into the operator's own person",
    );

    // Votes point at the rival and so does `first_seen`; the only term left
    // that can put self at `to_id` is `is_self`.
    const after = withDb((db) => ({
      selfMergedInto: personRow(db, selfId).merged_into,
      bramMergedInto: personRow(db, bramId!).merged_into,
      selfAsFrom: equivalenceFor(db, selfId),
    }));
    expect(after.selfMergedInto).toBeNull();
    expect(after.bramMergedInto).toBe(selfId);
    expect(after.selfAsFrom).toBeUndefined();

    // The operator-visible consequence: `getSelfPersonId` and `searchPeople`
    // both filter `merged_into IS NULL`, so a self that lost canonicality 404s
    // here and drops out of `/people` entirely.
    const stillSelf = await harness.gatewayJson<PersonDetail>("/people/self");
    expect(stillSelf.id).toBe(selfId);
    const selfSearch = await harness.gatewayJson<PeoplePage>(
      "/people/search?q=Nadia%20Okonkwo&limit=5",
    );
    expect(selfSearch.items.map((p) => p.id)).toContain(selfId);
    const rivalSearch = await harness.gatewayJson<PeoplePage>(
      "/people/search?q=Bram%20Halvorsen&limit=5",
    );
    expect(rivalSearch.items.map((p) => p.id)).not.toContain(bramId);
  }, 120_000);

  test("a merge rule bridging an alias that does not exist yet stays dormant, then wakes on the first periodic tick after the alias arrives", async () => {
    const inesId = withDb((db) => personIdForAlias(db, "email", INES_EMAIL));
    expect(inesId).toBeDefined();
    expect(withDb((db) => personIdForAlias(db, "email", QUENTIN_EMAIL))).toBeUndefined();

    const created = await harness.gatewayJson<MergeRuleResp>("/people/merge-rules", {
      method: "POST",
      body: JSON.stringify({
        sideA: { aliasType: "email", alias: INES_EMAIL },
        sideB: { aliasType: "email", alias: QUENTIN_EMAIL },
        winnerSide: "a",
        kind: "user",
        reason: "identity-resolution.e2e: rule created before its second side exists",
      }),
    });
    expect(created.created).toBe(true);
    const ruleId = created.rule.id;

    // Dormant, expressed as rows: an active rule that has produced nothing.
    // `fetchMergeEquivalencesData` skips it at `sideB.length === 0`.
    await runTask("backfill.mergeRulesEval");
    const dormant = withDb((db) => ({
      active: db
        .prepare<[string], { active: number }>("SELECT active FROM merge_rules WHERE id = ?")
        .get(ruleId)?.active,
      inesEquivalence: equivalenceFor(db, inesId!),
      equivalencesNamingInes: db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM person_equivalences WHERE to_id = ?")
        .get(inesId!)!.n,
    }));
    expect(dormant.active).toBe(1);
    expect(dormant.inesEquivalence).toBeUndefined();
    expect(dormant.equivalencesNamingInes).toBe(0);

    const dirtyBefore = withDb((db) => refreshMeta(db, "merge_rules").dirty_version);

    await push({
      sourceId: SRC_DORMANT,
      externalId: "dormant-counterpart",
      title: "Renewal notice",
      sourceCreatedAt: "2022-08-15T12:00:00.000Z",
      metadata: { people: [{ role: "sender", emails: [QUENTIN_EMAIL], name: "Quentin Arbogast" }] },
    });
    assertResolved(["dormant-counterpart"]);
    const quentinId = withDb((db) => personIdForAlias(db, "email", QUENTIN_EMAIL));
    expect(quentinId).toBeDefined();

    // The mechanism, isolated. `resolveDocumentPeople` bumps the merge-rules
    // dirty counter whenever it resolved or deleted anything, and that bump is
    // the only thing that can wake a rule whose second side arrived without a
    // rule mutation. Asserted as a monotonic advance rather than as a gap: an
    // eval tick landing beside this read erases the gap but never the advance.
    const dirtyAfter = withDb((db) => refreshMeta(db, "merge_rules").dirty_version);
    expect(dirtyAfter).toBeGreaterThan(dirtyBefore);

    await runTask("backfill.mergeRulesEval");
    await waitForDb(
      (db) => equivalenceFor(db, quentinId!)?.to_id === inesId,
      60_000,
      "the woken rule to merge the counterpart into its anchor",
    );

    // `winnerSide: "a"` votes Ines and her 2020 `first_seen` agrees, so the
    // direction is over-determined rather than a coin flip.
    const woken = withDb((db) => ({
      quentinMergedInto: personRow(db, quentinId!).merged_into,
      inesMergedInto: personRow(db, inesId!).merged_into,
      inesAsFrom: equivalenceFor(db, inesId!),
      appliedAt: equivalenceFor(db, quentinId!)!.applied_at,
    }));
    expect(woken.quentinMergedInto).toBe(inesId);
    expect(woken.inesMergedInto).toBeNull();
    expect(woken.inesAsFrom).toBeUndefined();

    // Termination. The apply unconditionally kicks the two refreshes below, so
    // drive them and then re-evaluate: if either fed merge-rules dirty back,
    // the watermark would still be behind and the eval would keep re-firing on
    // a corpus nothing is writing to.
    await runTask("backfill.interactionScoresRefresh");
    await runTask("backfill.peopleCountsRefresh");
    await runTask("backfill.mergeRulesEval");
    const settled = withDb((db) => ({
      meta: refreshMeta(db, "merge_rules"),
      appliedAt: equivalenceFor(db, quentinId!)?.applied_at,
      toId: equivalenceFor(db, quentinId!)?.to_id,
    }));
    expect(settled.meta.dirty_version).toBe(settled.meta.last_computed_version);
    expect(settled.toId).toBe(inesId);
    // `upsertMergeEquivalences` only writes `applied_at` on an add or a change,
    // so an unchanged value proves the second tick's diff was empty rather than
    // merely idempotent.
    expect(settled.appliedAt).toBe(woken.appliedAt);
  }, 120_000);

  test("a shared mailbox the static heuristic cannot name accretes one bucket, a boot collapses it, and the learned blocklist stops it re-forming", async () => {
    const mailboxDocs = MAILBOX_SENDERS.map((name, i) => ({
      sourceId: SRC_MAILBOX,
      externalId: `mailbox-${i}`,
      title: "Ticket update",
      content: `Ticket update ${i}`,
      sourceCreatedAt: new Date(Date.UTC(2022, 0, i + 1, 9)).toISOString(),
      metadata: { people: [{ role: "sender", emails: [MAILBOX_EMAIL], name }] },
    }));
    await harness.pushDocuments(mailboxDocs);
    await drain();
    assertResolved(mailboxDocs.map((d) => d.externalId));

    // The accretion is real, at the thresholds the config pinned: one email,
    // sixteen humans — the exact shape `demoteSharedAddresses` looks for. The
    // count is asserted exactly so a fixture that lost a name fails here
    // rather than looking like a regression in the demotion.
    const before = withDb((db) => {
      const bucketId = personIdForAlias(db, "email", MAILBOX_EMAIL);
      return {
        bucketId,
        nameCount: bucketId
          ? db
              .prepare<
                [string],
                { n: number }
              >("SELECT COUNT(DISTINCT alias) AS n FROM person_aliases WHERE person_id = ? AND alias_type = 'name'")
              .get(bucketId)!.n
          : 0,
        source: bucketId ? personRow(db, bucketId).source : null,
        blocklisted: blocklistRow(db, MAILBOX_EMAIL),
        links: db
          .prepare<
            [string],
            { n: number }
          >("SELECT COUNT(*) AS n FROM document_people WHERE person_id = ?")
          .get(bucketId ?? "")!.n,
      };
    });
    expect(before.bucketId).toBeDefined();
    expect(before.nameCount).toBe(MAILBOX_SENDERS.length);
    expect(before.source).toBe("extracted");
    expect(before.links).toBe(MAILBOX_SENDERS.length);
    // The static heuristic cannot name `queue` from its local part, so nothing
    // has learned this address yet.
    expect(before.blocklisted).toBeUndefined();

    const bucketId = before.bucketId!;

    // The demotion is a boot migration, so the second boot is the whole point.
    await harness.restartGateway();

    // Its own product is the only sound barrier: `runBootDataMigrations` is
    // awaited AFTER the HTTPS listener binds, and the self row already exists
    // on disk, so `/people/self` answers the instant the port is up — before
    // the migration chain has begun. Both halves of this predicate were false
    // before the restart.
    await waitForDb(
      (db) => blocklistRow(db, MAILBOX_EMAIL) !== undefined && !personExists(db, bucketId),
      120_000,
      "the boot demotion to blocklist the mailbox and delete its bucket",
    );

    // The collapse is total: `person_aliases.person_id` and
    // `document_people.person_id` both cascade on delete, so the end state
    // matches what we would have had if the address had been recognised as
    // non-identifying from the first message.
    const collapsed = withDb((db) => ({
      aliases: db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM person_aliases WHERE alias = ?")
        .get(MAILBOX_EMAIL)!.n,
      bucketAliases: db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM person_aliases WHERE person_id = ?")
        .get(bucketId)!.n,
      links: db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM document_people WHERE person_id = ?")
        .get(bucketId)!.n,
      blocklisted: blocklistRow(db, MAILBOX_EMAIL),
    }));
    expect(collapsed.aliases).toBe(0);
    expect(collapsed.bucketAliases).toBe(0);
    expect(collapsed.links).toBe(0);
    expect(collapsed.blocklisted?.reason).toBe("shared_address_cardinality");
    expect(collapsed.blocklisted?.name_count).toBe(MAILBOX_SENDERS.length);

    // The payoff: the learned list is consulted by a LATER boot's resolution.
    await harness.pushDocuments([
      {
        sourceId: SRC_MAILBOX,
        externalId: "mailbox-after",
        title: "Ticket update",
        content: "Ticket update after the demotion",
        sourceCreatedAt: "2022-03-01T09:00:00.000Z",
        metadata: {
          people: [{ role: "sender", emails: [MAILBOX_EMAIL], name: "Wren Castellanos" }],
        },
      },
      {
        sourceId: SRC_MAILBOX,
        externalId: "mailbox-mixed",
        title: "Ticket update, forwarded by its author",
        content: "Ticket update forwarded after the demotion",
        sourceCreatedAt: "2022-03-02T09:00:00.000Z",
        metadata: {
          people: [{ role: "sender", emails: [MAILBOX_EMAIL, AVERY_EMAIL], name: "Avery Quinn" }],
        },
      },
    ]);
    await drain();
    assertResolved(["mailbox-after", "mailbox-mixed"]);

    const reformed = withDb((db) => ({
      mailboxAliases: db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM person_aliases WHERE alias = ?")
        .get(MAILBOX_EMAIL)!.n,
      wren: db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM people WHERE canonical_name = ?")
        .get("Wren Castellanos")!.n,
      afterLinks: peopleForDocument(db, "mailbox-after"),
      averyId: personIdForAlias(db, "email", AVERY_EMAIL),
      mixedLinks: peopleForDocument(db, "mailbox-mixed"),
    }));
    expect(reformed.mailboxAliases).toBe(0);
    expect(reformed.wren).toBe(0);
    expect(reformed.afterLinks).toEqual([]);

    // And the learned shed is per-identifier too, so a real sender CC'd
    // alongside a demoted mailbox still resolves.
    expect(reformed.averyId).toBeDefined();
    expect(withDb((db) => aliasSet(db, reformed.averyId!))).toEqual([
      "email:" + AVERY_EMAIL,
      "name:Avery Quinn",
    ]);
    expect(reformed.mixedLinks).toEqual([reformed.averyId]);
  }, 180_000);

  // ── helpers ────────────────────────────────────────────────────────

  function withDb<T>(read: (db: Database.Database) => T): T {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  }

  async function waitForDb(
    predicate: (db: Database.Database) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    await waitForCondition(() => withDb(predicate), timeoutMs, label);
  }

  /**
   * Wait until every document in the corpus has been through people
   * resolution. Nothing syncs here, so the only rows in `documents` are this
   * file's and reaching zero means "the document just pushed is resolved" —
   * which is what makes arrival order the test's rather than the unordered
   * `LIMIT 1` in `backfillOnePerson`.
   */
  async function drain(timeoutMs = 60_000): Promise<void> {
    await waitForDb(
      (db) =>
        db
          .prepare<
            [],
            { n: number }
          >("SELECT COUNT(*) AS n FROM documents WHERE people_resolved_at IS NULL")
          .get()!.n === 0,
      timeoutMs,
      "the people backfill to drain",
    );
  }

  async function push(doc: PushDocumentInput): Promise<void> {
    await harness.pushDocument({ content: `synthetic ${doc.externalId}`, ...doc });
    await drain();
  }

  /**
   * The positive control every absence assertion in this file rests on:
   * `pushDocument` discards the ingest response and the max-age cutoff filters
   * silently, so a document that never landed leaves exactly the rows a
   * document that landed and was correctly shed leaves.
   */
  function assertResolved(externalIds: readonly string[]): void {
    const rows = withDb((db) =>
      db
        .prepare<
          [],
          { external_id: string; people_resolved_at: string | null }
        >("SELECT external_id, people_resolved_at FROM documents")
        .all(),
    );
    const resolved = new Set(
      rows.filter((r) => r.people_resolved_at !== null).map((r) => r.external_id),
    );
    for (const id of externalIds) {
      expect(resolved.has(id), `${id} should be ingested and people-resolved`).toBe(true);
    }
  }

  async function runTask(name: string): Promise<{ idle?: boolean }> {
    const response = await harness.gatewayJson<{ result: { idle?: boolean } }>(
      `/admin/background/run/${encodeURIComponent(name)}?timeoutMs=60000`,
      { method: "POST" },
    );
    return response.result;
  }
});

function personIdForAlias(
  db: Database.Database,
  aliasType: "email" | "phone" | "lid",
  alias: string,
): string | undefined {
  return db
    .prepare<
      [string, string],
      { person_id: string }
    >("SELECT person_id FROM person_aliases WHERE alias_type = ? AND alias = ? LIMIT 1")
    .get(aliasType, alias)?.person_id;
}

/** `"<type>:<value>"` for every alias a person owns, sorted for comparison. */
function aliasSet(db: Database.Database, personId: string): string[] {
  return db
    .prepare<[string], { alias_type: string; alias: string }>(
      "SELECT alias_type, alias FROM person_aliases WHERE person_id = ?",
    )
    .all(personId)
    .map((row) => `${row.alias_type}:${row.alias}`)
    .sort();
}

function peopleForDocument(db: Database.Database, externalId: string): string[] {
  return db
    .prepare<[string], { person_id: string }>(
      `SELECT dp.person_id FROM document_people dp
         JOIN documents d ON d.id = dp.document_id
        WHERE d.external_id = ?
        ORDER BY dp.person_id`,
    )
    .all(externalId)
    .map((row) => row.person_id);
}

function personRow(
  db: Database.Database,
  personId: string,
): { first_seen: string; merged_into: string | null; source: string | null } {
  const row = db
    .prepare<
      [string],
      { first_seen: string; merged_into: string | null; source: string | null }
    >("SELECT first_seen, merged_into, source FROM people WHERE id = ?")
    .get(personId);
  if (!row) throw new Error(`no person row for ${personId}`);
  return row;
}

function personExists(db: Database.Database, personId: string): boolean {
  return (
    db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM people WHERE id = ?")
      .get(personId)!.n > 0
  );
}

function equivalenceFor(
  db: Database.Database,
  fromId: string,
): { to_id: string; applied_at: string } | undefined {
  return db
    .prepare<
      [string],
      { to_id: string; applied_at: string }
    >("SELECT to_id, applied_at FROM person_equivalences WHERE from_id = ?")
    .get(fromId);
}

function refreshMeta(
  db: Database.Database,
  job: string,
): { dirty_version: number; last_computed_version: number } {
  const row = db
    .prepare<
      [string],
      { dirty_version: number; last_computed_version: number }
    >("SELECT dirty_version, last_computed_version FROM refresh_meta WHERE job = ?")
    .get(job);
  if (!row) throw new Error(`no refresh_meta row for ${job}`);
  return row;
}

function blocklistRow(
  db: Database.Database,
  email: string,
): { reason: string; name_count: number | null } | undefined {
  return db
    .prepare<
      [string],
      { reason: string; name_count: number | null }
    >("SELECT reason, name_count FROM non_identifying_emails WHERE email = ?")
    .get(email);
}
