// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Drains the offline buffer into the gateway, one batch at a time,
/// oldest first. Errors are handled per-batch so one bad batch doesn't
/// stall the queue behind it:
///   - 401 → rethrow immediately. The token is no longer valid at all,
///     so nothing in the queue can be delivered; the UI prompts a re-pair.
///   - 403 → this source's writes are unauthorized (the token lacks
///     `write:<source-type>`). Scoped to that source, not to the link, so
///     the batch is skipped and recorded in `Stats.blocked` and the drain
///     continues. Skipping matters: the buffer is strict FIFO, so
///     rethrowing here would strand every healthy source's batches behind
///     one unauthorized source indefinitely, while cursors kept advancing.
///   - 4xx (400 / 404 / 422 …) → persistent, not retryable on this
///     end. Skip past this batch; it stays on disk. The next drain cycle
///     will try it again if the server-side situation has changed.
///   - Network / 5xx / batch-file read failures → transient. After
///     `maxConsecutiveFailures` in a row we conclude the link is down
///     (or the buffer is sealed by file protection during a
///     locked-device wake) and stop early — next drain cycle picks up
///     where we left off.
///
/// "Skip and retry next cycle" has no end on its own, so every outcome is
/// additionally classified as transient or permanent, and permanent ones
/// are recorded against the batch (`OfflineBuffer.recordPermanentFailure`).
/// A batch that collects enough of them is quarantined out of the queue.
/// Without that, one batch the gateway will never accept is retried and
/// skipped for the life of the install while its age — the signal behind
/// the delivery-health warning — climbs forever.
///
/// Permanent means "repeating this cannot change the outcome", which is
/// narrower than "it failed":
///
///   - A 4xx the gateway means as a verdict on the payload. Not every 4xx
///     is: 401 and 403 are about the token, and `retryableStatuses` are
///     explicit "ask again later" answers that a proxy in front of the
///     gateway can emit under nothing worse than load or a slow uplink.
///   - A `DecodingError` from the batch file is bytes on disk that do not
///     parse. Distinct from a *read* failure, which is routine while the
///     device is locked and stays transient.
///   - A delivered batch that cannot be deleted afterwards would be
///     re-sent on every drain forever.
///
/// Everything else stays transient however long it persists — no network,
/// 5xx, a sealed buffer, a 403 waiting on a scope grant, a paused source,
/// and a reply this app cannot decode (which a captive portal or a proxy
/// error page produces just as readily as a genuine protocol mismatch).
/// Those are states the world resolves on its own, and dropping data
/// because a gateway was unreachable for a week would be a far worse bug
/// than the one quarantine fixes.
/// What a drain pass amounted to, in the terms a person asking "did my data
/// get through?" can act on.
///
/// A drain reports counts, which answer a different question: `skipped: 1`
/// and `failed: 1` are both "one batch didn't make it" but call for opposite
/// responses — wait for the link to come back, versus stop waiting, because
/// the gateway is refusing this payload and will refuse it again.
public enum DrainOutcome: Hashable, Sendable {
    /// Batches went through and none failed.
    case delivered
    /// The gateway answered, and refused. Retrying reproduces it.
    case refused
    /// The phone retained the batches because the gateway says their source is paused.
    case paused
    /// The gateway refused this phone's write scope for at least one source.
    case blocked
    /// The gateway could not be reached. Retrying later is the fix.
    case unreachable
    /// Batches remain without a specific failure explaining why they are still queued.
    case stalled
    /// Another drain already owns the buffer; this pass observed nothing.
    case busy
    /// Nothing was pending.
    case idle
    /// The drain itself failed — most commonly a dead token (401).
    case failed

    /// Classify a finished pass. `nil` stats mean the drain threw.
    ///
    /// Precedence is by what the user can act on: a transport failure
    /// outranks a refusal, because "Omnesis is unreachable" is both the more
    /// likely cause when both appear and the one with an obvious remedy.
    public init(_ stats: Uploader.Stats?) {
        guard let stats else {
            self = .failed
            return
        }
        // `blocked == nil` is the drain's marker for "this pass never walked
        // the buffer" — reporting its zeroed counts as success would claim a
        // delivery that never happened.
        if stats.blocked == nil {
            self = .busy
        } else if stats.failed > 0 {
            self = .unreachable
        } else if stats.blocked?.isEmpty == false {
            self = .blocked
        } else if stats.skipped > 0 {
            self = .refused
        } else if stats.remaining > 0,
                  stats.rejected.contains(where: { $0.reason == "paused" }) {
            self = .paused
        } else if stats.remaining > 0,
                  !stats.rejected.isEmpty {
            self = .stalled
        } else if stats.uploaded > 0 {
            self = .delivered
        } else if stats.remaining > 0 {
            self = .stalled
        } else {
            self = .idle
        }
    }
}

public actor Uploader {
    private final class GatewayRoute: @unchecked Sendable {
        private let lock = NSLock()
        private var gateway: GatewayClient

        init(gateway: GatewayClient) {
            self.gateway = gateway
        }

        func current() -> GatewayClient {
            lock.lock()
            defer { lock.unlock() }
            return gateway
        }

        func update(_ gateway: GatewayClient) {
            lock.lock()
            defer { lock.unlock() }
            self.gateway = gateway
        }
    }

    private nonisolated let gatewayRoute: GatewayRoute
    private let buffer: OfflineBuffer
    private let log = AppLog.make(category: "collector.uploader")
    private var draining = false

    /// After this many transient failures back-to-back with no successful
    /// upload in between, give up the drain pass. Keeps us from burning
    /// battery hammering an offline gateway.
    private let maxConsecutiveFailures = 3

    /// 4xx codes that mean "later", not "no". They arrive from the gateway's
    /// own backpressure and from anything sitting in front of it — a reverse
    /// proxy timing out a slow request body on a weak uplink returns 408, a
    /// rate limiter returns 429 — so treating them as a verdict on the
    /// payload would put the largest batches, uploaded over the worst
    /// connections, first in line to be discarded. A 409 also occurs while
    /// source storage is being migrated; retain the original batch for retry.
    private static let retryableStatuses: Set<Int> = [408, 409, 425, 429]

    public struct Stats: Equatable, Sendable {
        public var uploaded: Int
        public var failed: Int
        public var skipped: Int
        public var remaining: Int
        /// Sources the gateway rejected this pass (removed/paused in Omnesis),
        /// deduped and sorted. The caller (CollectorCore → AppStore) reacts:
        /// a `removed` source is disabled locally; a `paused` one is surfaced.
        public var rejected: [PushRejection] = []
        /// Sources whose batches the gateway refused with 403 this pass,
        /// deduped and sorted — or `nil` when this pass never got as far as
        /// walking the buffer, so it observed nothing either way.
        ///
        /// The distinction matters: a caller that treats "no observation" as
        /// "nothing blocked" clears the warning the moment a concurrent drain
        /// short-circuits, making the banner flicker off while the source is
        /// still refused. The device's token is missing `write:<source-type>`;
        /// the data stays buffered and delivers once the scope is granted.
        public var blocked: [String]?
    }

    public init(gateway: GatewayClient, buffer: OfflineBuffer) {
        gatewayRoute = GatewayRoute(gateway: gateway)
        self.buffer = buffer
    }

    /// Route future drain passes to updated pairing credentials without
    /// replacing this actor's one-drain lock. A pass already in flight keeps
    /// one gateway snapshot for all of its requests.
    public nonisolated func updateGateway(_ gateway: GatewayClient) {
        gatewayRoute.update(gateway)
    }

    /// Drain the buffer. Returns counts of batches uploaded / failed /
    /// skipped this pass, plus the sources rejected (removed/paused) and
    /// blocked (403) along the way. Rethrows only on 401 — the token itself
    /// is dead, so the UI must prompt for a re-pair.
    @discardableResult
    public func drain() async throws -> Stats {
        if draining {
            log.debug("Drain already in progress, skipping")
            // Another drain owns the buffer — this pass observed nothing.
            return try await Stats(uploaded: 0, failed: 0, skipped: 0, remaining: buffer.count(), blocked: nil)
        }
        draining = true
        defer { draining = false }

        var uploaded = 0
        var failed = 0
        var skipped = 0
        var quarantined = 0
        var consecutiveFailures = 0
        // sourceId → reason for any source the gateway rejected this pass.
        var rejections: [String: String] = [:]
        // Sources the gateway refused with 403 this pass.
        var blocked: Set<String> = []
        let gateway = gatewayRoute.current()

        let ids = try await buffer.listIds()
        drainPass: for id in ids {
            let effect = try await deliver(id: id, blockedSources: blocked, gateway: gateway).effect
            uploaded += effect.uploaded
            failed += effect.failed
            skipped += effect.skipped
            if effect.resetsConsecutiveFailures {
                consecutiveFailures = 0
            } else {
                consecutiveFailures += effect.failed
            }
            if let rejection = effect.rejection {
                rejections[rejection.sourceId] = rejection.reason
            }
            if let sourceId = effect.blockedSourceId {
                blocked.insert(sourceId)
            }
            if effect.isPermanentFailure, await notePermanentFailure(id: id) {
                quarantined += 1
            }
            if consecutiveFailures >= maxConsecutiveFailures {
                log.notice(
                    "Stopping drain after \(consecutiveFailures, privacy: .public) consecutive transient failures"
                )
                break drainPass
            }
        }

        let remaining = try await buffer.count()
        if uploaded > 0 || failed > 0 || skipped > 0 {
            let counts = "\(uploaded) uploaded, \(skipped) skipped, \(failed) failed, "
                + "\(quarantined) quarantined, \(remaining) remaining"
            log.notice("Drain pass: \(counts, privacy: .public)")
        }
        let rejected = rejections
            .map { PushRejection(sourceId: $0.key, reason: $0.value) }
            .sorted { $0.sourceId < $1.sourceId }
        return Stats(
            uploaded: uploaded,
            failed: failed,
            skipped: skipped,
            remaining: remaining,
            rejected: rejected,
            blocked: blocked.sorted()
        )
    }

    private struct BatchEffect {
        var uploaded = 0
        var failed = 0
        var skipped = 0
        var resetsConsecutiveFailures = false
        var isPermanentFailure = false
        var rejection: PushRejection?
        var blockedSourceId: String?
    }

    /// What one batch amounted to. Each result projects a small, declarative
    /// effect that the drain loop folds into its pass-wide state.
    private enum BatchResult {
        case uploaded
        /// Delivered, but the queued file could not be deleted afterwards.
        case deliveredButRetained
        /// The gateway declined the source itself (removed / paused).
        case sourceRejected(sourceId: String, reason: String)
        /// 403 — this device's token lacks the source's write scope. The
        /// source id is absent when the batch file could not be read.
        case sourceBlocked(sourceId: String?)
        /// Repeating cannot change the result; counts against the batch's
        /// quarantine budget.
        case permanentlyRefused
        /// The world may fix this on its own; never costs the batch data.
        case transientFailure
        /// Replicated deletion was deliberately refused to this non-holder.
        case replicaDeletionDeferred
        /// The file went away between listing and loading it.
        case vanished
        /// An earlier batch of the same source was refused with 403 this
        /// pass, so this one was not attempted.
        case skippedBlockedSource

        var effect: BatchEffect {
            switch self {
            case .uploaded:
                BatchEffect(uploaded: 1, resetsConsecutiveFailures: true)
            case .deliveredButRetained:
                BatchEffect(uploaded: 1, resetsConsecutiveFailures: true, isPermanentFailure: true)
            case .sourceRejected(let sourceId, let reason):
                BatchEffect(
                    resetsConsecutiveFailures: true,
                    rejection: PushRejection(sourceId: sourceId, reason: reason)
                )
            case .sourceBlocked(let sourceId):
                BatchEffect(skipped: 1, resetsConsecutiveFailures: true, blockedSourceId: sourceId)
            case .permanentlyRefused:
                BatchEffect(skipped: 1, resetsConsecutiveFailures: true, isPermanentFailure: true)
            case .transientFailure:
                BatchEffect(failed: 1)
            case .replicaDeletionDeferred:
                // Another healthy replica owns deletion authority. Retaining
                // the batch is expected coordination, not a failure.
                BatchEffect(resetsConsecutiveFailures: true)
            case .vanished:
                BatchEffect()
            case .skippedBlockedSource:
                BatchEffect(skipped: 1)
            }
        }
    }

    /// Attempt one batch. Throws only on 401 — the token itself is dead, so
    /// there is no point continuing the pass.
    private func deliver(
        id: String,
        blockedSources: Set<String>,
        gateway: GatewayClient
    ) async throws
        -> BatchResult {
        // Set once the batch file is readable, so the 403 case can attribute
        // the rejection to a source without re-reading it.
        var batchSourceId: String?
        do {
            // Loaded inside the per-batch handling so a single unreadable
            // batch file — routine during a locked-device wake now that batch
            // files carry `.completeUnlessOpen`, or a corrupt file — counts as
            // one transient failure instead of aborting the whole drain pass.
            guard let batch = try await buffer.load(id: id) else { return .vanished }
            batchSourceId = batch.sourceId
            // One 403 settles the whole source for this pass. Re-probing every
            // remaining batch of it would cost a round-trip each, and `push`
            // sends analytics before documents — so a source whose analytics
            // rows are accepted but whose documents are refused would re-send
            // those rows on every batch.
            if blockedSources.contains(batch.sourceId) {
                return .skippedBlockedSource
            }

            let pushOutcome = try await pushWithReplicaLease(batch, gateway: gateway)
            if pushOutcome.deletionDeferred {
                return .replicaDeletionDeferred
            }
            if let reason = pushOutcome.rejectedReason {
                if reason == "removed" {
                    // The source is gone — discard the batch; there's nothing
                    // to deliver it to. A delete that fails must not swallow
                    // the rejection: it is the signal that disables the source
                    // locally, and without it the phone keeps buffering for a
                    // source that no longer exists.
                    try? await buffer.remove(id: batch.id)
                }
                // "paused" → leave the batch on disk so the data is not lost
                // and delivers when the source is resumed in Omnesis.
                return .sourceRejected(sourceId: batch.sourceId, reason: reason)
            }

            do {
                try await buffer.remove(id: batch.id)
                return .uploaded
            } catch {
                // Delivered, but the file survived. Every later drain re-sends
                // it — harmless (the ingest is an idempotent upsert) and
                // endless, since deleting will fail again for whatever reason
                // it failed now.
                log.error(
                    "Batch \(id, privacy: .public) delivered but not removed: \(String(describing: error), privacy: .private)"
                )
                return .deliveredButRetained
            }
        } catch GatewayClient.Error.unauthorized {
            log.error("Gateway returned 401 during drain — needs re-pair")
            throw GatewayClient.Error.unauthorized
        } catch GatewayClient.Error.forbidden {
            // Unauthorized for THIS source only — the token is otherwise
            // valid. Leave the batch on disk (it delivers once the scope is
            // granted) and keep draining so other sources aren't stranded
            // behind it. Logged once per source per pass; the drain loop's
            // blocked set is the dedupe.
            if let sourceId = batchSourceId {
                log.notice(
                    "Gateway returned 403 for source \(sourceId, privacy: .private); batches retained until write scope is restored"
                )
            } else {
                log.warning("Gateway returned 403 for an unreadable batch \(id, privacy: .public)")
            }
            return .sourceBlocked(sourceId: batchSourceId)
        } catch GatewayClient.Error.serverError(let status, let body) where (400 ..< 500).contains(status) {
            // Persistent client-side error — move on so the rest of the queue
            // can still drain. Batch stays on disk; a future drain retries it
            // (e.g. after the gateway schema catches up) until it runs out of
            // budget.
            log.warning(
                "Skipping batch \(id, privacy: .public) after \(status, privacy: .public): \(body, privacy: .private)"
            )
            return Self.retryableStatuses.contains(status) ? .transientFailure : .permanentlyRefused
        } catch let error as DecodingError {
            // The bytes were read and do not parse. Unlike a read failure —
            // routine while the device is locked — no amount of retrying turns
            // them back into a batch.
            log.warning(
                "Batch \(id, privacy: .public) is not decodable: \(String(describing: error), privacy: .private)"
            )
            return .permanentlyRefused
        } catch GatewayClient.Error.decoding(let detail) {
            // The gateway answered something this app can't read. Transient,
            // because the likeliest causes are: a captive portal returning an
            // HTML login page with a 200, a proxy error page, or a gateway
            // restarting behind one — all of which clear on their own. Only
            // a genuine protocol mismatch would repeat, and paying for that
            // with data is the worse trade.
            log.warning(
                "Batch \(id, privacy: .public) got an unreadable gateway response: \(detail, privacy: .private)"
            )
            return .transientFailure
        } catch {
            log.warning(
                "Batch \(id, privacy: .public) undeliverable: \(String(describing: error), privacy: .private)"
            )
            return .transientFailure
        }
    }

    /// Record a failure that repeating cannot fix. Returns true when the
    /// batch ran out of budget and was quarantined, so the caller can count
    /// it. A quarantine that itself fails is reported and otherwise ignored
    /// — the batch stays queued and the next pass tries again.
    private func notePermanentFailure(id: String) async -> Bool {
        do {
            let didQuarantine = try await buffer.recordPermanentFailure(id: id)
            if didQuarantine {
                log.notice(
                    "Batch \(id, privacy: .public) set aside as undeliverable after repeated permanent failures"
                )
            }
            return didQuarantine
        } catch {
            log.error(
                "Could not quarantine batch \(id, privacy: .public): \(String(describing: error), privacy: .private)"
            )
            return false
        }
    }

    private struct PushOutcome {
        var rejectedReason: String?
        var deletionDeferred = false
    }

    /// Claims deletion authority around every structured deletion batch.
    /// A 404 means an older gateway where the source is still exclusive.
    private func pushWithReplicaLease(_ batch: Batch, gateway: GatewayClient) async throws -> PushOutcome {
        // Claim for every analytics deletion, including legacy buffered batches
        // that predate the persisted mode field. A 404 is the compatibility
        // seam for an old exclusive gateway; a current replicated gateway must
        // never receive an unleased legacy deletion forever.
        let needsLease = batch.tableName != nil && !batch.deletedIds.isEmpty
        guard needsLease else { return try await push(batch, gateway: gateway) }

        let lease = try await gateway.claimSyncLease(sourceId: batch.sourceId)
        guard lease?.granted != false else {
            return PushOutcome(deletionDeferred: true)
        }
        do {
            let outcome = try await push(batch, gateway: gateway)
            if lease != nil { try? await gateway.releaseSyncLease(sourceId: batch.sourceId) }
            return outcome
        } catch {
            if lease != nil { try? await gateway.releaseSyncLease(sourceId: batch.sourceId) }
            throw error
        }
    }

    /// Pushes one batch's analytics rows, bound documents, and deletions
    /// (in that order), stopping at the first rejection. Returns the
    /// gateway's rejection reason for this source, if any.
    private func push(_ batch: Batch, gateway: GatewayClient) async throws -> PushOutcome {
        var rejectedReason: String?
        var deletionDeferred = false
        if let tableName = batch.tableName,
           !batch.records.isEmpty || batch.schema != nil || !batch.deletedIds.isEmpty {
            let resp = try await gateway.ingestAnalyticsRecords(
                tableName: tableName,
                records: batch.records,
                schema: batch.schema,
                sourceId: batch.sourceId,
                deletedIds: batch.deletedIds
            )
            rejectedReason = resp.rejected.first { $0.sourceId == batch.sourceId }?.reason
            deletionDeferred = resp.deletionDeferred
        }
        // Push the bound documents AFTER the analytics rows land so the
        // row a document binds to (via `boundDocument`) already exists
        // when the gateway synthesizes the same-entity edge (#640).
        // Idempotent upsert, so a retry can't double-write.
        if rejectedReason == nil, !batch.documents.isEmpty {
            let resp = try await gateway.ingestDocuments(batch.documents)
            rejectedReason = resp.rejected.first { $0.sourceId == batch.sourceId }?.reason
        }
        // A documents-only source (`tableName == nil`, e.g. Photos, #169)
        // has no analytics rows to delete-by-id, so its `deletedIds` mean
        // document external ids instead — route them to the
        // document-delete endpoint. A deletion-only batch (no documents
        // this cycle) has no other call site that would surface a
        // removed/paused rejection, so this response must be checked too
        // — otherwise a paused source's buffered deletions would apply
        // anyway.
        if rejectedReason == nil, batch.tableName == nil, !batch.deletedIds.isEmpty {
            let resp = try await gateway.deleteDocuments(
                providerId: batch.sourceId,
                sourceId: batch.sourceId,
                externalIds: batch.deletedIds
            )
            rejectedReason = resp.rejected.first { $0.sourceId == batch.sourceId }?.reason
        }
        return PushOutcome(rejectedReason: rejectedReason, deletionDeferred: deletionDeferred)
    }
}
