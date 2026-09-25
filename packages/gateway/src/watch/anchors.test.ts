// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The delivery anchor, against a real store.
 *
 * A watch that wakes an agent does it through a subscription record, and every
 * property that makes that safe or useful is a property of the record rather
 * than of any code path in isolation: whether it is live enough to carry a
 * firing, whether an operator can find it on a screen they did not put it on,
 * what it is allowed to hand the agent, and what happens to it when the watch
 * that owns it changes its mind.
 *
 * So this runs the real `SubscriptionService` over a real schema. A mocked
 * anchor set can only prove the calls were made; the questions here are about
 * the rows those calls leave behind.
 *
 * Fixture data is invented — no corpus content.
 */

import { createHash } from "node:crypto";

import SqliteDatabase from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDevice } from "../data/repositories/DeviceRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { directWriteGate } from "../write-gate.js";
import { SubscriptionService } from "../subscriptions/service.js";
import { ANCHOR_DEVICE_GONE_NOTE, ANCHOR_UNMINTED_NOTE, holdUnarmed } from "./health.js";
import {
  createWakeAnchors,
  lastAnchorOf,
  readAnchors,
  standingAnchorsOf,
  wakesAnAgent,
  watchAnchorBreaches,
  type WakeAnchors,
} from "./anchors.js";
import type { StoredWatch } from "./definitions.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const WATCH_ID = "w_shipped";

/**
 * The watch as the definition store holds it.
 *
 * The anchor is a reading of this document, not of the request that asks for
 * it — so a case that changes whom the watch wakes, or with what instruction,
 * changes the stored watch and asks again.
 */
function watchWith(
  overrides: {
    id?: string;
    integration?: string;
    instruction?: string;
    compileRunId?: string;
    /** The referents the instruction names, when it names any. */
    bindings?: Record<string, string>;
    /** What its firings may hand the agent — read from the shape of the watch. */
    evidence?: "documents" | "condition-only";
  } = {},
): StoredWatch {
  // A real document, because what a firing may carry is read from the nodes the
  // sink can reach: a watch armed by a document event may offer documents, and
  // one armed by a clock has none to offer.
  const source =
    overrides.evidence === "condition-only"
      ? { id: "tick", type: "source.time", recurring: "0 9 * * *", output_map: {} }
      : {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          output_map: { doc_id: "$e.docId" },
        };
  return {
    id: overrides.id ?? WATCH_ID,
    name: "an-order-shipped",
    status: "active",
    dsl: {
      watch: {
        name: "an-order-shipped",
        nl_query: "Tell me when an order I was told about ships.",
        firing_policy: "stays_active",
        nodes: [source],
        sink: { input: source.id, output_map: {} },
        delivery: {
          kind: "agent-wake",
          integration: overrides.integration ?? "openclaw",
          instruction: overrides.instruction ?? "Draft a reply.",
          ...(overrides.bindings === undefined ? {} : { bindings: overrides.bindings }),
        },
      },
    },
    addedAt: "2026-03-01T09:00:00.000Z",
    fromSeq: 0,
    note: null,
    compileRunId: overrides.compileRunId ?? null,
    requestKey: null,
  };
}

/** The same watch with no delivery block: it wakes nobody. */
function watchWakingNobody(): StoredWatch {
  return { ...watchWith(), dsl: { watch: { name: "an-order-shipped" } } };
}

interface Harness {
  db: Db;
  service: SubscriptionService;
  anchors: WakeAnchors;
  /** What the definition store would return; the anchor reads this. */
  watches: Map<string, StoredWatch>;
  deviceId: string;
  /** A second agent device, for the cases about waking the wrong one. */
  secondDeviceId: string;
  /**
   * Whether the module can see the subscription service at all.
   *
   * The gateway hands it over partway through boot, so a caller that starts too
   * early asks a module that has nothing to write through. Flipping this is how
   * the cases below reach that window without booting a gateway.
   */
  serviceWired: boolean;
  /** Every watch id the module has read a definition for, in order. */
  definitionReads: string[];
  /** Every watch the module stopped, and the note it stopped it with. */
  holds: { watchId: string; note: string }[];
  now: number;
  cleanup: () => void;
}

function setup(): Harness {
  const db = new SqliteDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  const deviceId = createDevice(db, {
    name: "Fictional agent integration",
    kind: "agent",
    capabilities: {
      agentIntegration: {
        harness: "openclaw",
        deliveryProtocolMin: 3,
        deliveryProtocolMax: 3,
        maxConcurrentRuns: 1,
      },
    },
  }).id;
  const secondDeviceId = createDevice(db, {
    name: "Fictional second harness",
    kind: "agent",
    capabilities: {
      agentIntegration: {
        harness: "hermes",
        deliveryProtocolMin: 3,
        deliveryProtocolMax: 3,
        maxConcurrentRuns: 1,
      },
    },
  }).id;
  let sequence = 0;
  const harness: Harness = {
    db,
    deviceId,
    secondDeviceId,
    serviceWired: true,
    definitionReads: [],
    holds: [],
    now: 5_000,
    watches: new Map([[WATCH_ID, watchWith()]]),
    service: undefined as unknown as SubscriptionService,
    anchors: undefined as unknown as WakeAnchors,
    cleanup: () => db.close(),
  };
  harness.service = new SubscriptionService({
    db,
    writeGate: directWriteGate(db),
    policyStore: {
      get: () => Promise.resolve({ policy: "# Fictional", revision: "policy-a", updatedAt: 1 }),
    },
    now: () => harness.now,
    id: () => `fictional-${++sequence}`,
    getEmbedder: () => ({ embedQuery: async () => [0.1, 0.2, 0.3] }),
  });
  harness.anchors = createWakeAnchors({
    db,
    subscriptions: () => (harness.serviceWired ? harness.service : null),
    definition: (watchId) => {
      harness.definitionReads.push(watchId);
      return harness.watches.get(watchId) ?? null;
    },
    // Through `holdUnarmed`, as the gateway wires it. A double that wrote the
    // status and note unconditionally would let a general hold write over the
    // note naming the specific cause, and no test here would see it.
    hold: (watchId, note) => {
      harness.holds.push({ watchId, note });
      holdUnarmed(
        {
          get: (id) => harness.watches.get(id) ?? null,
          setStatus: (id, status, setNote) => {
            const held = harness.watches.get(id);
            if (held) harness.watches.set(id, { ...held, status, note: setNote });
          },
        },
        watchId,
        note,
      );
      return Promise.resolve();
    },
  });
  return harness;
}

/**
 * One settled compile run in the ledger.
 *
 * The revision's link is projected through `cognition_runs`, so a record can
 * only report a compile the ledger still holds.
 */
function seedCompileRun(db: Db, id: string): void {
  db.prepare<[string]>(
    `INSERT INTO cognition_runs (
       id, kind, payload_json, dedupe_key, status, attempts, last_error, failure_code,
       next_attempt_at, enqueued_at, cycle_anchor_at, last_attempt_at, completed_at, usage_json
     ) VALUES (?, 'subscription_compile', '{}', NULL, 'completed', 1, NULL, NULL, 1, 1, 1, 1, 2, NULL)`,
  ).run(id);
}

/**
 * The key the record was minted under.
 *
 * Read from the store rather than recomputed, because what is being checked is
 * the string an install already has on disk: a derived key is how a re-install
 * of an unchanged watch finds the record it already made.
 */
function clientRequestId(h: Harness, subscriptionId: string): string | null {
  return (
    h.db
      .prepare<
        [string],
        { client_request_id: string | null }
      >(`SELECT client_request_id FROM subscriptions WHERE id = ?`)
      .get(subscriptionId)?.client_request_id ?? null
  );
}

/** Install the watch's anchor exactly as the delivery route does. */
async function install(
  h: Harness,
  overrides: {
    integration?: string;
    instruction?: string;
    authoredBy?: "operator" | "integration";
    compileRunId?: string;
    bindings?: Record<string, string>;
    evidence?: "documents" | "condition-only";
  } = {},
): Promise<string | null> {
  // Whom it wakes and what it says are the watch's, so they are written into
  // the stored definition before the anchor is asked for.
  h.watches.set(WATCH_ID, watchWith(overrides));
  return h.anchors.set(WATCH_ID, {
    ...(overrides.authoredBy === undefined ? {} : { authoredBy: overrides.authoredBy }),
  });
}

describe("the record a watch wakes through", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it("is live the moment it is minted", async () => {
    // The property everything else rests on. An anchor that stopped at
    // `pending_approval` would be invisible to the firing path, and a watch
    // would go on evaluating perfectly while waking nobody — silence that
    // reads exactly like an agent that got the wake and did nothing.
    await install(h);

    const anchor = h.anchors.anchorFor(WATCH_ID);
    expect(anchor, "the watch has no anchor to fire through").not.toBeNull();
    expect(h.service.getTrusted(anchor!.subscriptionId).status).toBe("active");
  });

  it("carries what the watch may hand the agent", async () => {
    await install(h, { evidence: "condition-only" });
    expect(h.anchors.anchorFor(WATCH_ID)?.evidence).toBe("condition-only");
  });

  it("points at the compile the watch came out of", async () => {
    // Provenance runs both directions. The plan this record is the front of
    // was written by one compile, and its transcript is the only account of
    // what the compiler read before deciding what the watch means.
    seedCompileRun(h.db, "run_the_compile");

    const id = await install(h, { compileRunId: "run_the_compile" });

    expect(h.service.getTrusted(id!).compileRunId).toBe("run_the_compile");
  });

  it("reads back nothing once the compile has aged out of the ledger", async () => {
    // The link is projected THROUGH `cognition_runs`, so a revision pointing
    // at a run retention has since pruned reads as null rather than as a link
    // to a transcript nobody can open.
    const id = await install(h, { compileRunId: "run_since_pruned" });

    expect(h.service.getTrusted(id!).compileRunId).toBe(null);
  });

  it("never appears among the records an integration asked for", async () => {
    // Nobody authored the anchor — they authored the watch. An operator who
    // found one on the list of what an agent has requested would be reading a
    // request that was never made.
    await install(h);

    expect(h.service.list({ deviceId: h.deviceId, tokenId: null })).toEqual([]);
    expect(h.service.listAll().subscriptions).toEqual([]);
  });

  it("never asks the operator to decide something already decided", async () => {
    // The delivery block IS the decision: a person wrote which agent to wake
    // and what to tell it. A pending approval on top of that would sit on the
    // portal and both phones forever, since nothing else would ever resolve it.
    await install(h);

    expect(h.service.listApprovals(), "an anchor asked to be approved").toEqual([]);
    const page = h.service.listApprovalPage(undefined, 50);
    expect(page.approvals).toEqual([]);
    // The count is read by its own query, so a page that merely looked empty
    // would still put a badge on the portal's privacy tab.
    expect(page.totalCount).toBe(0);
  });

  it("shows an integration the watch it asked for itself", async () => {
    // The mirror of the two tests above, and the reason they test authorship
    // rather than the engine. An agent that asked for a watch and then could
    // not see it in its own listing has no way to revise or revoke the thing
    // it created — and the operator has nothing to approve.
    await install(h, { authoredBy: "integration" });

    const listed = h.service.list({ deviceId: h.deviceId, tokenId: null });
    expect(listed, "the agent cannot see the watch it asked for").toHaveLength(1);
    expect(h.service.listAll().subscriptions).toHaveLength(1);
  });

  it("asks the operator to decide on a watch an integration asked for", async () => {
    // Nobody has agreed to this one. Self-approving it would let an agent mint
    // a record that wakes it, on the strength of having asked.
    const id = await install(h, { authoredBy: "integration" });

    expect(h.service.getTrusted(id!).status).not.toBe("active");
    expect(h.service.listApprovals()).toHaveLength(1);
    expect(h.service.listApprovalPage(undefined, 50).totalCount).toBe(1);
  });

  it("does not confuse the two authors' records for the same watch", async () => {
    // The anchor key folds the author in, so a watch that changed hands mints
    // a fresh record rather than converging on one approved under different
    // terms — the same reason a changed instruction does.
    const operators = await install(h);
    const integrations = await install(h, { authoredBy: "integration" });

    expect(integrations).not.toBe(operators);
  });

  it("keeps one record when two compiles of one request race", async () => {
    // The pre-check on the create path returns the record an earlier call
    // made, which covers the ordinary retry. It cannot cover two calls that
    // both read "nothing yet" before either wrote: each compiles a watch with
    // its own id, so a key derived from the watch would deduplicate against
    // nothing and the operator would be asked to approve the same request
    // twice. Keying on what the asker sent is what collapses them.
    const asked = "one-request-two-attempts";
    h.watches.set("w_attempt_one", watchWith({ id: "w_attempt_one" }));
    h.watches.set("w_attempt_two", watchWith({ id: "w_attempt_two" }));
    const first = await h.anchors.set("w_attempt_one", {
      authoredBy: "integration",
      idempotencyKey: asked,
    });
    const second = await h.anchors.set("w_attempt_two", {
      authoredBy: "integration",
      idempotencyKey: asked,
    });

    expect(second).toBe(first);
    expect(h.service.listApprovals(), "the operator was asked twice").toHaveLength(1);
  });

  it("refuses to rewrite the condition of a record a watch is behind", async () => {
    // The condition here is a compiled watch evaluated in another runtime.
    // Recompiling it through this engine would replace that plan with one this
    // engine wrote, leaving the watch still running and the record no longer
    // describing it — and the instruction a wake goes out under is what was
    // approved, so an in-place rewrite has the ledger claiming a wake was sent
    // under words nobody agreed to.
    const id = (await install(h, { authoredBy: "integration" }))!;
    const before = h.service.getTrusted(id);

    await expect(
      h.service.update(
        { deviceId: h.deviceId, tokenId: null },
        id,
        {
          expectedRevision: before.revision,
          condition: { kind: "natural-language", description: "something else entirely" },
        },
        undefined,
      ),
    ).rejects.toThrow(/cannot be revised/);
  });

  it("still lets an operator hold a record a watch is behind", async () => {
    // Status is not the definition. Refusing it too would leave an agent's
    // watch with no way to be paused short of revoking it — and a record only
    // becomes pausable once someone has approved it, which is the state this
    // walks through to reach.
    const id = (await install(h, { authoredBy: "integration" }))!;
    const approval = h.service.listApprovals()[0]!;
    await h.service.resolveApproval(
      { deviceId: h.deviceId, tokenId: null },
      approval.id,
      "approve",
    );
    const approved = h.service.getTrusted(id);
    expect(approved.status, "the approval did not take").toBe("active");

    await expect(
      h.service.update(
        { deviceId: h.deviceId, tokenId: null },
        id,
        { expectedRevision: approved.revision, status: "paused" },
        undefined,
      ),
    ).resolves.toBeDefined();
  });

  it("takes a firing that carries the documents behind it", async () => {
    await install(h);
    const anchor = h.anchors.anchorFor(WATCH_ID)!;
    h.db
      .prepare(
        `INSERT INTO documents
           (id, provider_id, source_id, external_id, title, content, content_hash,
            source_created_at, source_updated_at, ingested_at, updated_at)
         VALUES ('doc_a', 'fictional', 'fictional:source', 'ext-a', 'Fictional shipment',
                 'Invented content.', 'hash-a',
                 '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z',
                 '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z')`,
      )
      .run();

    const fired = await h.anchors.fire({
      subscriptionId: anchor.subscriptionId,
      revision: anchor.revision,
      eventKey: `${WATCH_ID}:41`,
      evidenceDocumentIds: ["doc_a"],
      firedAt: h.now,
    });

    expect(fired).toEqual({ fired: true });
  });

  it("takes a firing from a document watch that had nothing behind it", async () => {
    // A watch can be true for more than one reason — a message arriving, or a
    // deadline passing with nothing to cancel it. Refusing the second would
    // lose the firing at the moment it mattered, and it discloses strictly less
    // than the first.
    await install(h);
    const anchor = h.anchors.anchorFor(WATCH_ID)!;

    await expect(
      h.anchors.fire({
        subscriptionId: anchor.subscriptionId,
        revision: anchor.revision,
        eventKey: `${WATCH_ID}:42`,
        evidenceDocumentIds: [],
        firedAt: h.now,
      }),
    ).resolves.toEqual({ fired: true });
  });

  it("refuses documents against an anchor approved for the condition alone", async () => {
    await install(h, { evidence: "condition-only" });
    const anchor = h.anchors.anchorFor(WATCH_ID)!;

    await expect(
      h.anchors.fire({
        subscriptionId: anchor.subscriptionId,
        revision: anchor.revision,
        eventKey: `${WATCH_ID}:43`,
        evidenceDocumentIds: ["doc_a"],
        firedAt: h.now,
      }),
    ).rejects.toThrow();
  });

  it("counts the same firing once", async () => {
    await install(h);
    const anchor = h.anchors.anchorFor(WATCH_ID)!;
    const report = () =>
      h.anchors.fire({
        subscriptionId: anchor.subscriptionId,
        revision: anchor.revision,
        eventKey: `${WATCH_ID}:44`,
        evidenceDocumentIds: [],
        firedAt: h.now,
      });

    expect(await report()).toEqual({ fired: true });
    expect(await report(), "a replayed firing woke the agent twice").toEqual({ fired: false });
  });

  it("converges on the record it already has when nothing changed", async () => {
    await install(h);
    const first = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;
    await install(h);

    expect(h.anchors.anchorFor(WATCH_ID)?.subscriptionId).toBe(first);
  });

  it("mints a fresh record when the instruction changes", async () => {
    // An anchor is not edited into a different one. The instruction it carries
    // is what was approved, and rewriting an approved record in place would
    // leave the ledger claiming a wake was sent under words nobody agreed to.
    await install(h);
    const first = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    await install(h, { instruction: "Escalate to me instead." });
    const second = h.anchors.anchorFor(WATCH_ID)!;

    expect(second.subscriptionId).not.toBe(first);
    expect(h.service.getTrusted(second.subscriptionId).status).toBe("active");
    expect(
      h.service.getTrusted(first).status,
      "the superseded anchor stayed live and would wake the agent twice",
    ).toBe("revoked");
  });

  it("keys a wake that names no referents exactly as it did before they existed", async () => {
    // The property that decides whether this churns an install. Every anchor
    // already on disk was keyed on these four components; a key that folded in
    // an empty map would match none of them, and the next boot would retire
    // every waking watch's record and mint a replacement — losing the approval
    // each of them carries.
    await install(h);
    const minted = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    const digest = createHash("sha256")
      .update([h.deviceId, "Draft a reply.", "documents", "operator"].join("\u0000"))
      .digest("hex")
      .slice(0, 16);
    expect(clientRequestId(h, minted)).toBe(`watch2_${WATCH_ID}_${digest}`);
  });

  it("reads a wake that names an empty set of referents as one that names none", async () => {
    // The same watch written two ways. Treating them differently would retire
    // an approved record because a caller sent a field rather than omitting it.
    await install(h);
    const first = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    await install(h, { bindings: {} });

    expect(h.anchors.anchorFor(WATCH_ID)?.subscriptionId).toBe(first);
  });

  it("carries the referents the instruction names into the record", async () => {
    await install(h, { bindings: { conversation: "thread-8821", ticket: "RQ-4417" } });

    expect(readAnchors(h.db).get(WATCH_ID)?.bindings).toEqual({
      conversation: "thread-8821",
      ticket: "RQ-4417",
    });
  });

  it("mints a fresh record when the referents change", async () => {
    // An instruction whose words did not move still points somewhere else when
    // its referents do. A record left standing would go on handing the agent
    // the ones it was approved with, and nothing on any surface would say so.
    await install(h, { bindings: { conversation: "thread-8821" } });
    const first = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    await install(h, { bindings: { conversation: "thread-9004" } });
    const second = h.anchors.anchorFor(WATCH_ID)!;

    expect(second.subscriptionId).not.toBe(first);
    expect(readAnchors(h.db).get(WATCH_ID)?.bindings).toEqual({ conversation: "thread-9004" });
    expect(
      h.service.getTrusted(first).status,
      "the superseded anchor stayed live and would wake the agent with stale referents",
    ).toBe("revoked");
  });

  it("mints a fresh record when a referent is added to an instruction that had none", async () => {
    await install(h);
    const first = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    await install(h, { bindings: { conversation: "thread-8821" } });

    expect(h.anchors.anchorFor(WATCH_ID)?.subscriptionId).not.toBe(first);
  });

  it("converges when the same referents are written in a different order", async () => {
    // A map is unordered. Keying on the enumeration order would retire an
    // approved record for a rewrite that changed nothing about the wake.
    await install(h, { bindings: { conversation: "thread-8821", ticket: "RQ-4417" } });
    const first = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    await install(h, { bindings: { ticket: "RQ-4417", conversation: "thread-8821" } });

    expect(h.anchors.anchorFor(WATCH_ID)?.subscriptionId).toBe(first);
  });

  it("mints a fresh record when the watch changes whom it wakes", async () => {
    await install(h);
    const first = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    await install(h, { integration: "hermes" });
    const second = h.anchors.anchorFor(WATCH_ID)!;

    expect(second.subscriptionId).not.toBe(first);
    expect(h.service.getTrusted(second.subscriptionId).integrationDevice.name).toBe(
      "Fictional second harness",
    );
  });

  it("stops the watch when no device holds the integration it names", async () => {
    // Left running it evaluates, judges, spends its budget and wakes nobody,
    // and a watch that is silent because it has nowhere to speak looks exactly
    // like one whose condition has not happened. Nothing here can repair it —
    // a wake needs a device, and picking one is the sibling-waking mistake
    // anchoring must be incapable of — so the fact is written on the watch.
    h.watches.set(WATCH_ID, watchWith({ integration: "a-harness-nobody-runs" }));

    await h.anchors.set(WATCH_ID);

    expect(h.anchors.anchorFor(WATCH_ID)).toBeNull();
    expect(h.holds).toEqual([{ watchId: WATCH_ID, note: ANCHOR_DEVICE_GONE_NOTE }]);
    expect(h.watches.get(WATCH_ID)?.note).toBe(ANCHOR_DEVICE_GONE_NOTE);
  });

  it("stops a watch whose agent device was unpaired", async () => {
    // How that state is actually reached. The record naming the device is
    // deleted with the device — `subscriptions.integration_device_id` cascades
    // — so the watch is left declaring a wake with no record and no device.
    await install(h, { authoredBy: "integration" });
    h.db.prepare<[string]>(`DELETE FROM devices WHERE id = ?`).run(h.deviceId);
    expect(readAnchors(h.db).get(WATCH_ID), "the record outlived its device").toBe(undefined);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(readAnchors(h.db).get(WATCH_ID)).toBe(undefined);
    // The specific cause is asked for first, and it is the one that survives:
    // the repair's catch-all hold follows on this path and `holdUnarmed` stops
    // only a watch that is still running.
    expect(h.holds[0]).toEqual({ watchId: WATCH_ID, note: ANCHOR_DEVICE_GONE_NOTE });
    expect(h.watches.get(WATCH_ID)?.note).toBe(ANCHOR_DEVICE_GONE_NOTE);
  });

  it("keeps a record from outliving the device it wakes", async () => {
    // The invariant the repair above depends on, asserted rather than assumed:
    // an anchor pinned to a device can never name one that is gone, because
    // the row goes when the device does. Were that to stop holding — the
    // foreign key dropped, or the pragma that enforces it left off — a repair
    // would carry the dead id forward and mint an `active` record against it
    // on every boot, and the watch would wake nobody with nothing saying so.
    const minted = await install(h, { authoredBy: "integration" });
    expect(minted).not.toBeNull();

    h.db.prepare<[string]>(`DELETE FROM devices WHERE id = ?`).run(h.deviceId);

    expect(h.db.prepare("SELECT COUNT(*) AS n FROM subscriptions").get()).toEqual({ n: 0 });
    expect(lastAnchorOf(h.db, WATCH_ID)).toBeNull();
  });

  it("retires the anchor when the watch stops waking anyone", async () => {
    await install(h);
    const subscriptionId = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    h.watches.set(WATCH_ID, watchWakingNobody());
    await h.anchors.set(WATCH_ID);

    expect(h.anchors.anchorFor(WATCH_ID)).toBeNull();
    // Revoked rather than deleted: an egress-ledger entry points at this
    // record's firings, and erasing them would leave an account of a
    // disclosure with nothing to say what caused it.
    expect(h.service.getTrusted(subscriptionId).status).toBe("revoked");
    expect(readAnchors(h.db).size).toBe(0);
  });

  it("retires an anchor whose watch is gone", async () => {
    // The crash window. A watch and its anchor are written to two stores that
    // cannot share a transaction, so a failure between them can leave an anchor
    // nobody can account for — and nothing else would ever notice, because a
    // watch that does not exist never fires.
    await install(h);

    expect(await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set() })).toBe(1);
    expect(h.anchors.anchorFor(WATCH_ID)).toBeNull();
  });

  it("retires nothing when the live watch set is unknown", async () => {
    // The expensive half of the ambiguity an empty set used to carry. A
    // journal created on this boot lists no watches because it has never held
    // one — reading that as "the operator removed them" retires every anchor,
    // and an anchor carries a grant and an approval the watch it belonged to
    // cannot reconstruct.
    await install(h);
    const subscriptionId = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    const retired = await h.anchors.reconcile({
      kind: "unknown",
      why: "the watch journal was created on this boot",
    });

    expect(retired).toBe(0);
    expect(h.anchors.anchorFor(WATCH_ID)?.subscriptionId, "an anchor was retired on a guess").toBe(
      subscriptionId,
    );
  });

  it("leaves a live watch's anchor alone when it reconciles", async () => {
    await install(h);
    const subscriptionId = h.anchors.anchorFor(WATCH_ID)!.subscriptionId;

    expect(await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) })).toBe(
      0,
    );
    expect(h.anchors.anchorFor(WATCH_ID)?.subscriptionId).toBe(subscriptionId);
  });
});

describe("which watches own an anchor", () => {
  it("reads the delivery block, and nothing else", () => {
    expect(wakesAnAgent(watchWith().dsl)).toBe(true);
    // Both spellings of the notify kind, because the check is a positive test
    // on `agent-wake` and must stay one: a watch that notifies must never
    // acquire an anchor, whichever era its document was written in.
    expect(wakesAnAgent({ watch: { name: "n", delivery: { kind: "omnesis-notify" } } })).toBe(
      false,
    );
    expect(wakesAnAgent({ watch: { name: "n", delivery: { kind: "ios-push" } } })).toBe(false);
    expect(wakesAnAgent({ watch: { name: "n" } })).toBe(false);
  });

  it("answers for a definition with no delivery block at all", () => {
    expect(wakesAnAgent({ nonsense: true })).toBe(false);
    expect(wakesAnAgent(null)).toBe(false);
  });

  it("does not need the rest of the definition to be readable", () => {
    // A watch whose nodes a newer build wrote still wakes an agent. Answering
    // from a full validation would retire its anchor over a node type this
    // build happens not to know.
    expect(
      wakesAnAgent({
        watch: {
          name: "n",
          nodes: [{ type: "source.something_this_build_has_never_heard_of" }],
          delivery: { kind: "agent-wake", integration: "openclaw", instruction: "Reply." },
        },
      }),
    ).toBe(true);
  });
});

/**
 * Two requests changing one watch at the same time.
 *
 * The walk from reading the record a watch holds to creating its replacement
 * spans several awaits, and neither caller holds anything across them. Two
 * delivery changes interleaving through it both read the same record, both
 * retire it, and both create — leaving two standing records for one watch, of
 * which every reader here sees only the first.
 */
describe("a watch whose delivery changes twice at once", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it("ends with one record, carrying what the definition ended up saying", async () => {
    await install(h);

    // Both write the definition first, as both callers do, and then both ask
    // for the anchor without waiting for the other.
    h.watches.set(WATCH_ID, watchWith({ instruction: "Draft a reply, briefly." }));
    const one = h.anchors.set(WATCH_ID, { authoredBy: "operator" });
    h.watches.set(WATCH_ID, watchWith({ instruction: "File it and say nothing." }));
    const two = h.anchors.set(WATCH_ID, { authoredBy: "operator" });
    await Promise.all([one, two]);

    expect(watchAnchorBreaches(h.db, [WATCH_ID]), "two records stand for one watch").toEqual([]);
    // And the record that survived carries the instruction the definition
    // ended up with, rather than the other request's words.
    const anchor = readAnchors(h.db).get(WATCH_ID)!;
    expect(anchor.instruction).toBe("File it and say nothing.");
  });
});

/**
 * The invariant, enforced rather than observed.
 *
 * Both departures from "one standing record per delivery-bearing watch" are
 * invisible from every other surface — a watch with none evaluates and judges
 * exactly as a healthy one does, and a watch with two wakes through whichever
 * the shared order ranks first while the other holds a grant no screen lists.
 * A log line about either is a fault nobody is going to read.
 */
describe("reconciling a watch that does not hold exactly one record", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it("mints the missing record from the watch's own delivery block", async () => {
    // The state a crash between the two stores leaves, and the one a failed
    // mint leaves behind it: a watch that wakes an agent and holds nothing to
    // carry it. Everything needed to repair it is in the definition.
    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 0 }]);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([]);
    const anchor = h.anchors.anchorFor(WATCH_ID);
    expect(anchor, "nothing was minted").not.toBeNull();
    expect(readAnchors(h.db).get(WATCH_ID)?.instruction).toBe("Draft a reply.");
  });

  it("mints the replacement against the device the last record named", async () => {
    // The definition names a *harness*, and resolving one picks whichever
    // device holding that name paired most recently — which on a host running
    // two of them is not reliably the agent that asked to be woken. Waking a
    // sibling instead is the one mistake this has to be incapable of making,
    // and the record that went missing is what remembers which device it was.
    const asked = await h.anchors.set(WATCH_ID, {
      target: { kind: "device", deviceId: h.secondDeviceId, harness: "openclaw" },
      authoredBy: "integration",
    });
    expect(asked, "the fixture never minted a record to lose").not.toBeNull();
    h.db.prepare<[string]>(`UPDATE subscriptions SET status = 'expired' WHERE id = ?`).run(asked!);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    const repaired = readAnchors(h.db).get(WATCH_ID);
    expect(repaired?.deviceId, "the repair woke a sibling").toBe(h.secondDeviceId);
    // And it is still the integration's record, so it goes to the operator to
    // approve rather than self-approving on the way through.
    expect(repaired?.authoredBy).toBe("integration");
    expect(h.service.getTrusted(repaired!.subscriptionId).status).toBe("pending_approval");
  });

  it("leaves a denied record alone rather than putting it back", async () => {
    // A denial is the operator saying no. A repair has nobody to ask, so
    // minting a replacement would both overturn the decision and — because a
    // replacement it authored self-approves — hand out the grant they refused.
    const minted = await install(h, { authoredBy: "integration" });
    h.db.prepare<[string]>(`UPDATE subscriptions SET status = 'denied' WHERE id = ?`).run(minted!);
    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 0 }]);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(h.anchors.anchorFor(WATCH_ID), "a denial was overturned").toBeNull();
    expect(h.service.getTrusted(minted!).status).toBe("denied");
  });

  it("keeps the record it has rather than replacing it with one that says nothing", async () => {
    // A record carrying no instruction is one the store refuses when it reads
    // it back — and by then the record it replaced is revoked. Refusing before
    // anything is retired leaves the watch waking through what it already had.
    // The DSL requires an instruction, so this is only reachable by a
    // definition written by something that did not go through it.
    const minted = await install(h);
    const speechless = watchWith();
    (speechless.dsl as { watch: { delivery: Record<string, unknown> } }).watch.delivery = {
      kind: "agent-wake",
      integration: "openclaw",
    };
    h.watches.set(WATCH_ID, speechless);

    expect(await h.anchors.set(WATCH_ID)).toBeNull();

    expect(readAnchors(h.db).get(WATCH_ID)?.subscriptionId, "the watch was left mute").toBe(minted);
  });

  it("leaves a watch whose harness nobody holds reported rather than repaired", async () => {
    // Nothing to mint against: there is no device to wake. Saying so is all
    // that is available, and it is what `silent-risk` is reading.
    h.watches.set(WATCH_ID, watchWith({ integration: "a-harness-nobody-runs" }));

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 0 }]);
    // And the specific cause survives the general hold that follows it. Both
    // fire on this path — the device-gone branch first, then the repair's
    // catch-all — and telling the operator to resume a watch that resuming
    // cannot fix is the worse of the two sentences.
    expect(h.watches.get(WATCH_ID)?.note).toBe(ANCHOR_DEVICE_GONE_NOTE);
  });

  it("stops a watch it could not mint a record for, whatever the reason was", async () => {
    // Every way minting fails other than an unpaired device used to end in a
    // log line: no agent configured, a declaration with no instruction, a key
    // already taken, a race onto a spent record. The watch stayed active,
    // declaring a wake, evaluating and judging and spending its budget while
    // waking nobody — which is indistinguishable from a condition that has not
    // happened.
    // A declaration carrying no instruction: `wakeDelivery` reads a missing one
    // as the empty string and `apply` refuses to mint a record that says
    // nothing, which is one of the branches that only ever logged.
    const declared = watchWith();
    const dsl = JSON.parse(JSON.stringify(declared.dsl)) as {
      watch: { delivery: Record<string, unknown> };
    };
    delete dsl.watch.delivery["instruction"];
    h.watches.set(WATCH_ID, { ...declared, dsl });

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    const held = h.watches.get(WATCH_ID);
    expect(held?.status, "an unarmable watch was left running").toBe("paused");
    expect(held?.note).toBe(ANCHOR_UNMINTED_NOTE);
  });

  it("retires every record past the first, by the order every reader uses", async () => {
    // Two standing records for one watch. Which one stays is not a choice: it
    // is the one `readAnchors`, the disclosure page and the firing path are
    // all already reaching.
    // Two installs leave a retired record and a live one; putting the retired
    // one back on its feet is the state two concurrent installs would reach,
    // without having to race them.
    const first = await install(h);
    await install(h, { instruction: "Summarise the order instead." });
    h.db.prepare<[string]>(`UPDATE subscriptions SET status = 'active' WHERE id = ?`).run(first!);
    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 2 }]);
    const standing = standingAnchorsOf(h.db, WATCH_ID).map((row) => row.subscriptionId);
    const kept = standing[0]!;

    const retired = await h.anchors.reconcile({
      kind: "known",
      wakingWatchIds: new Set([WATCH_ID]),
    });

    expect(retired).toBe(1);
    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([]);
    expect(readAnchors(h.db).get(WATCH_ID)?.subscriptionId).toBe(kept);
    // Revoked rather than deleted, like every other retirement here.
    for (const id of standing.slice(1)) {
      expect(h.service.getTrusted(id).status).toBe("revoked");
    }
  });

  it("does not read the definition again while it is retiring a shadowed pair", async () => {
    // The retiring walk reads the standing set and then writes it, which is
    // exactly what the per-watch turn exists to make one step. Outside it, an
    // install arriving mid-walk reads a set the walk is halfway through
    // changing — and the record it converges on may be one this pass is about
    // to revoke. Observed through the definition read, because that is the
    // first thing an install does once it is inside.
    const first = await install(h);
    await install(h, { instruction: "Summarise the order instead." });
    h.db.prepare<[string]>(`UPDATE subscriptions SET status = 'active' WHERE id = ?`).run(first!);

    let readsDuringRetire: number | null = null;
    let queued: Promise<unknown> = Promise.resolve();
    const revoke = h.service.revokeTrusted.bind(h.service);
    h.service.revokeTrusted = async (id: string, reason?: string) => {
      const result = await revoke(id, reason);
      // An install arriving now. It must not get inside until this walk lets
      // go, so several turns of the microtask queue leave it still waiting.
      const before = h.definitionReads.length;
      // Held rather than dropped: it settles after the walk lets go, and a
      // rejection nobody is waiting on outlives the test and the database.
      queued = h.anchors.set(WATCH_ID).catch(() => null);
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      readsDuringRetire = h.definitionReads.length - before;
      return result;
    };

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(readsDuringRetire, "an install got inside the retiring walk").toBe(0);
    await queued;
  });
});

/**
 * The boot window, and the two ways a repair can lie about what it did.
 *
 * Reconciliation runs once at start, and every repair it makes goes through the
 * subscription service — which the gateway hands over partway through the same
 * boot. A pass that runs before that has nothing to write through, and the
 * failure mode is not that it fails: it is that it walks the whole set, changes
 * nothing, and reports the number of records it would have retired.
 */
describe("reconciling before the gateway has finished wiring itself", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it("retires nothing, and says nothing was retired", async () => {
    // Two anchors for watches that no longer wake anyone. Both should go —
    // and neither can, because there is nothing to revoke them through.
    const other = "w_second";
    h.watches.set(other, watchWith({ id: other, instruction: "Do the other thing." }));
    await install(h);
    await h.anchors.set(other);
    h.watches.set(WATCH_ID, watchWakingNobody());
    h.watches.set(other, { ...watchWakingNobody(), id: other });
    const standingBefore = readAnchors(h.db).size;
    expect(standingBefore, "the fixture never minted the pair").toBe(2);

    h.serviceWired = false;
    const retired = await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set() });

    // The honest answer is zero, not two. A count that includes a retirement
    // that no-op'd is how the same record gets skipped on every boot while the
    // log says it was dealt with.
    expect(retired, "a repair was reported that did not happen").toBe(0);
    expect(readAnchors(h.db).size, "a record was retired with nothing to retire it").toBe(2);
  });

  it("keeps going past a watch whose repair throws", async () => {
    // Every repair is two writes through the subscription service, any of
    // which can throw. A pass that let one out would abandon every watch after
    // it — silently, and with the count it had reached discarded by its caller.
    const other = "w_second";
    h.watches.set(other, watchWith({ id: other, instruction: "Do the other thing." }));
    await install(h);
    await h.anchors.set(other);
    h.watches.set(WATCH_ID, watchWakingNobody());
    h.watches.set(other, { ...watchWakingNobody(), id: other });
    const revoke = h.service.revokeTrusted.bind(h.service);
    let thrown = false;
    h.service.revokeTrusted = (id: string, reason?: string) => {
      if (!thrown) {
        thrown = true;
        return Promise.reject(new Error("the write gate refused"));
      }
      return revoke(id, reason);
    };

    const retired = await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set() });

    // One of the two could not be retired; the other was, and is counted.
    expect(retired).toBe(1);
    expect(readAnchors(h.db).size).toBe(1);
  });

  it("retires both once the service is there", async () => {
    // The same pass, run where the boot sequence now runs it. Nothing about
    // the anchors changed in between; only whether anything could act on them.
    const other = "w_second";
    h.watches.set(other, watchWith({ id: other, instruction: "Do the other thing." }));
    await install(h);
    await h.anchors.set(other);
    h.watches.set(WATCH_ID, watchWakingNobody());
    h.watches.set(other, { ...watchWakingNobody(), id: other });

    const retired = await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set() });

    expect(retired).toBe(2);
    expect(readAnchors(h.db).size).toBe(0);
  });
});

/**
 * A change this host was in the middle of making, told from a decision somebody
 * made.
 *
 * Changing a watch's delivery retires the old record and mints a new one — an
 * approved instruction cannot be edited in place. Those are two writes, and a
 * crash between them leaves a live, waking, active watch whose only record is
 * revoked. Repair has to be able to finish that change, and must never touch a
 * record a person revoked or denied.
 */
describe("a crash between retiring an anchor and minting its replacement", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  /** Change the delivery, and die before the replacement is written. */
  async function crashMidChange(): Promise<void> {
    await install(h);
    const create = h.service.createWatchV2Anchor.bind(h.service);
    h.service.createWatchV2Anchor = () => Promise.reject(new Error("the gateway went away"));
    h.watches.set(WATCH_ID, watchWith({ instruction: "Summarise the order instead." }));
    await expect(h.anchors.set(WATCH_ID)).rejects.toThrow("the gateway went away");
    h.service.createWatchV2Anchor = create;
  }

  it("finishes the change on the next boot", async () => {
    await crashMidChange();
    // The state the crash left: the watch declares a wake, is active, and has
    // nothing standing to carry it. It evaluates, judges, spends its budget
    // and reaches nobody — with no hold and no note anywhere.
    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 0 }]);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    const repaired = readAnchors(h.db).get(WATCH_ID);
    expect(repaired, "the watch was left waking nobody, permanently").toBeDefined();
    // The instruction the definition ended up declaring, not the one the
    // interrupted change was replacing.
    expect(repaired?.instruction).toBe("Summarise the order instead.");
  });

  it("does not hand back a wake the operator paused", async () => {
    // The same crash, one status earlier. A paused record is a person saying
    // stop, and the replacement a repair mints would be active — an operator's
    // re-mint self-approves. So a retirement that supersedes a pause is not
    // marked as the machine's: repair reads it as somebody's decision and
    // holds, which is the only outcome that does not overturn one.
    const minted = await install(h);
    h.db.prepare<[string]>(`UPDATE subscriptions SET status = 'paused' WHERE id = ?`).run(minted!);
    const create = h.service.createWatchV2Anchor.bind(h.service);
    h.service.createWatchV2Anchor = () => Promise.reject(new Error("the gateway went away"));
    h.watches.set(WATCH_ID, watchWith({ instruction: "Summarise the order instead." }));
    await expect(h.anchors.set(WATCH_ID)).rejects.toThrow("the gateway went away");
    h.service.createWatchV2Anchor = create;

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(h.anchors.anchorFor(WATCH_ID), "a paused wake was handed back").toBeNull();
    expect(readAnchors(h.db).get(WATCH_ID)).toBeUndefined();
  });

  it("still leaves a record the operator revoked exactly where they left it", async () => {
    // The other side of the same reading, and the one that must not move. A
    // person taking a record back is a decision, and a repair has nobody to
    // ask — so it holds, and the watch stays silent until somebody installs it
    // again.
    const minted = await install(h);
    await h.service.revokeTrusted(minted!);
    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([{ watchId: WATCH_ID, standing: 0 }]);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(h.anchors.anchorFor(WATCH_ID), "a revocation was overturned").toBeNull();
    expect(h.service.getTrusted(minted!).status).toBe("revoked");
  });
});

/**
 * A record that stands, and says the wrong thing.
 *
 * The count is the cheap half of the invariant. A crash between writing a
 * rewritten definition and minting its anchor leaves exactly one standing
 * record — carrying the instruction the watch used to have. Nothing counts that
 * as a breach, and the agent is woken with words the definition no longer
 * contains, indefinitely.
 */
describe("an anchor that disagrees with the definition it belongs to", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it("is replaced with one that says what the watch now says", async () => {
    const stale = await install(h);
    // The rewrite lands in the definition store; the crash is between that
    // write and the anchor's. No count anywhere moves.
    h.watches.set(WATCH_ID, watchWith({ instruction: "Summarise the order instead." }));
    expect(watchAnchorBreaches(h.db, [WATCH_ID]), "the count noticed something").toEqual([]);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    const repaired = readAnchors(h.db).get(WATCH_ID);
    expect(repaired?.instruction).toBe("Summarise the order instead.");
    expect(repaired?.subscriptionId, "the stale record is still the live one").not.toBe(stale);
    expect(h.service.getTrusted(stale!).status).toBe("revoked");
    // One record, still: the repair replaced rather than added.
    expect(watchAnchorBreaches(h.db, [WATCH_ID])).toEqual([]);
  });

  it("is replaced when only the referents moved", async () => {
    // The drift a count cannot see and words cannot either: one standing
    // record, the same instruction, pointed at something the watch no longer
    // says. Left alone, the agent goes on being woken about the old one.
    const stale = await install(h, { bindings: { conversation: "thread-8821" } });
    h.watches.set(WATCH_ID, watchWith({ bindings: { conversation: "thread-9004" } }));
    expect(watchAnchorBreaches(h.db, [WATCH_ID]), "the count noticed something").toEqual([]);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    const repaired = readAnchors(h.db).get(WATCH_ID);
    expect(repaired?.bindings).toEqual({ conversation: "thread-9004" });
    expect(repaired?.subscriptionId, "the stale record is still the live one").not.toBe(stale);
    expect(h.service.getTrusted(stale!).status).toBe("revoked");
  });

  it("leaves a record whose referents still agree untouched", async () => {
    // The half that decides whether the check above is worth having: a
    // comparison that fired on agreement would revoke and re-mint every waking
    // watch on every boot.
    const minted = await install(h, { bindings: { conversation: "thread-8821" } });

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(readAnchors(h.db).get(WATCH_ID)?.subscriptionId).toBe(minted);
  });

  it("keeps the device the standing record named", async () => {
    // Same reasoning as the missing-record repair. The definition names a
    // harness, and resolving one picks whichever device holding that name
    // paired most recently — which on a host running two is not reliably the
    // agent that asked. Only the instruction is being repaired.
    await h.anchors.set(WATCH_ID, {
      target: { kind: "device", deviceId: h.secondDeviceId, harness: "openclaw" },
      authoredBy: "integration",
    });
    h.watches.set(WATCH_ID, watchWith({ instruction: "Summarise the order instead." }));

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    const repaired = readAnchors(h.db).get(WATCH_ID);
    // Asserted first, so the two below cannot pass on a repair that never ran:
    // the record this fixture starts from already names the right device.
    expect(repaired?.instruction, "nothing was repaired").toBe("Summarise the order instead.");
    expect(repaired?.deviceId, "the repair woke a sibling").toBe(h.secondDeviceId);
    expect(repaired?.authoredBy).toBe("integration");
  });

  it("leaves a definition this build cannot read alone", async () => {
    // The same reason `wakesAnAgent` and `wakeDelivery` read the delivery block
    // shallowly: a definition carrying a node type a newer build wrote fails to
    // parse, and what a firing may hand the agent is then read as the narrower
    // of the two. Repairing on that would revoke a working watch's record and
    // mint one that may carry less — on the first boot after a rollback, for
    // every watch the newer build touched.
    const minted = await install(h);
    const unreadable = watchWith({ instruction: "Summarise the order instead." });
    (unreadable.dsl as { watch: { nodes: unknown[] } }).watch.nodes = [
      { id: "future", type: "source.something_this_build_has_never_heard_of", output_map: {} },
    ];
    h.watches.set(WATCH_ID, unreadable);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(readAnchors(h.db).get(WATCH_ID)?.subscriptionId).toBe(minted);
  });

  it("counts the record it retired to make room", async () => {
    // A replacement retires the record it replaces, and that retirement is one
    // like any other. A pass that repaired it and returned zero would report
    // having done nothing to a watch it had just re-minted.
    await install(h);
    h.watches.set(WATCH_ID, watchWith({ instruction: "Summarise the order instead." }));

    const retired = await h.anchors.reconcile({
      kind: "known",
      wakingWatchIds: new Set([WATCH_ID]),
    });

    expect(retired).toBe(1);
  });

  it("leaves a record that still agrees with its definition untouched", async () => {
    // The healthy case, and the one that decides whether this check is worth
    // having: a repair that fires on agreement would revoke and re-mint every
    // waking watch on every boot, losing each one's approval as it went.
    const minted = await install(h);

    await h.anchors.reconcile({ kind: "known", wakingWatchIds: new Set([WATCH_ID]) });

    expect(readAnchors(h.db).get(WATCH_ID)?.subscriptionId).toBe(minted);
  });
});
