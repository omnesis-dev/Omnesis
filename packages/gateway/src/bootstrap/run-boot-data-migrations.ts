// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD,
  DEFAULT_SHARED_ADDRESS_MAX_EMAILS,
} from "../domain/SharedAddressDemotion.js";
import { listSelfIdentitySources } from "../self-identity-sources.js";
import type { Logger } from "@omnesis/core";
import type { WriteGate } from "../write-gate.js";
import type { IoGate } from "../scheduler/io-ops.js";

/**
 * Boot-time data migrations / safety-nets that the gateway runs once after
 * server start. Idempotent — repeated boots see no-ops on already-applied
 * state. Extracted out of `index.ts` so the entrypoint
 * stays a composer.
 *
 * The passes run sequentially because they share writer-worker contention;
 * serializing keeps the writer-queue depth low at boot:
 *
 *  1. **Seed-from-contacts.** Compute the plan on the read handle
 *     (full-table scan + JSON.parse) then apply on the writer
 *     (per-contact `findOrCreatePerson` + `document_people` inserts +
 *     self dedupe).
 *  2. **Bootstrap-self-from-config.** `config.self` (the operator's own
 *     name / emails / phones) creates the canonical self person, or enriches
 *     an already-elected one — the install-level home for who you are.
 *  3. **Bootstrap-self-from-devices** (#282, legacy). Per-device
 *     annotation becomes a canonical self person when nothing above
 *     elected one. Pre-dates `config.self`; kept for back-compat.
 *  4. **Self-from-source-ids.** Every registered source account is paired
 *     against the collector-declared self-identity hooks and the resulting
 *     LID aliases are attached to the self person elected above.
 *  5. **Shared-alias physical dedup.** Sweep clusters of people sharing
 *     a strong identifier (email/phone/lid) and merge into a single
 *     canonical. Same op runs every 5 min via auto-detect; this boot
 *     pass front-runs the next tick so the invariant holds from the
 *     moment the gateway is up.
 *
 * A handful of further people-graph safety nets follow (shared-address
 * demotion, no-reply alias prune, placeholder-headline upgrade); see the
 * body for the full sequence.
 */
export async function runBootDataMigrations(deps: {
  writeGate: WriteGate;
  ioGate: IoGate;
  log: Logger;
  /** Operator identity (`config.self`) — the canonical install-level home for who you are. */
  selfConfig?: { name?: string; emails?: readonly string[]; phones?: readonly string[] };
  /** Shared-address demotion thresholds; fall back to module defaults when unset. */
  sharedAddressDemotion?: { nameThreshold?: number; maxEmails?: number };
}): Promise<void> {
  const { writeGate, ioGate, log } = deps;

  // --- People identity resolution: seed from contact documents ---
  // Split: compute the plan on the read handle (full-table scan +
  // JSON.parse), then apply on the writer (per-contact findOrCreatePerson +
  // document_people inserts + self dedupe).
  const plan = await ioGate.seedFromContactsPlan();
  await writeGate.upsertSeedFromContacts(plan);

  // `config.self` — the canonical, install-level home for operator identity.
  // Create the self person from it (or enrich an already-elected one with any
  // identifiers it doesn't yet carry) before the legacy device-annotation
  // fallback below. Runs after the contacts pass so a richer contacts-derived
  // self keeps the headline; config only fills the gaps.
  // reconcileSelfFromConfig logs its own create/enrich events.
  await writeGate.bootstrapSelfFromConfig(deps.selfConfig);

  // #282 — legacy fallback self bootstrap from per-device annotation. Pre-dates
  // `config.self`; kept for installs still carrying `omnesis devices set-self`
  // annotations. Materializes a self person from the earliest-annotated device
  // when nothing above elected one. Idempotent / no-op when a self already
  // exists.
  const bootstrapped = await writeGate.bootstrapSelfFromDevices();
  if (bootstrapped) {
    log.info(`bootstrapped canonical self person ${bootstrapped} from device annotation`);
  }

  // Pair every registered source against whatever hooks the registry holds.
  // Runs after self is elected so a fresh install pairs on its first boot.
  // The gateway listens before these migrations run, so a collector that
  // reconnects quickly has often pushed already; otherwise the registry is
  // empty here and the push after connect is the pass that pairs.
  const paired = await writeGate.detectSelfFromSourceIds(listSelfIdentitySources());
  if (paired > 0) log.info(`self-detection pass attached ${paired} source LID alias(es) to self`);

  // Boot-time safety net: sweep any clusters of people that share a
  // strong-identifier alias (email/phone/lid) and physical-merge them
  // into one canonical. Same op auto-detect runs every 5 min — the
  // boot pass just front-runs the next tick so the invariant holds
  // from the moment the gateway is up. Idempotent; usually a no-op.
  const result = await writeGate.physicalDedupSharedAliases();
  if (result.peopleMerged > 0) {
    log.info(
      `shared-alias dedup: clustersProcessed=${result.clustersProcessed} peopleMerged=${result.peopleMerged}`,
    );
  }

  // Demote shared-address people (one ordinary-looking email, many distinct
  // name aliases — a ticket queue or notification relay). Blocklists the
  // email (if the static heuristic can't already name it) and deletes the
  // whole bucket. Runs BEFORE the prune below so that a bucket the prune
  // would otherwise touch is removed whole, rather than left as a husk of
  // name aliases once the prune strips its email row. Idempotent after the
  // first run.
  const demoted = await writeGate.demoteSharedAddresses(
    deps.sharedAddressDemotion?.nameThreshold ?? DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD,
    deps.sharedAddressDemotion?.maxEmails ?? DEFAULT_SHARED_ADDRESS_MAX_EMAILS,
  );
  if (demoted.demoted > 0) {
    log.info(
      `shared-address demotion: peopleDemoted=${demoted.demoted} emailsBlocked=${demoted.emailsBlocked}`,
    );
  }

  // Purge shared no-reply email aliases left in the table by pre-fix
  // ingestion, and mark linked documents for re-resolution so
  // the people backfill re-attributes Google Docs / LinkedIn / similar
  // notifications correctly (or drops them, if the noreply was the
  // mention's only identifier). Idempotent after the first run.
  const pruned = await writeGate.pruneNoreplyAliases();
  if (pruned.aliasesRemoved > 0) {
    log.info(
      `noreply alias prune: aliasesRemoved=${pruned.aliasesRemoved} documentsToRebackfill=${pruned.documentsToRebackfill}`,
    );
  }

  // Self-heal phone/email-shaped headlines (#583). Runs last so it operates
  // on the settled people graph: the contacts seed above already promoted
  // real names onto every contact-matched person (via the resolution-time
  // upgrade), so this backstop only touches the remainder — placeholder
  // people whose sole trusted name came from a non-contact source. Mark
  // any survivors by promoting their best trusted `name` alias. Idempotent.
  const renamed = await writeGate.upgradePlaceholderCanonicalNames();
  if (renamed.upgraded > 0) {
    log.info(`placeholder canonical_name upgrade: upgraded=${renamed.upgraded}`);
  }
}
