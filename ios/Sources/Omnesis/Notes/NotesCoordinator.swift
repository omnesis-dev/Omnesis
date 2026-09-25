// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Serializes queue mutations across network suspension points. The
/// coordinator is MainActor-isolated, but actor reentrancy still allows a
/// discard or refresh to interleave while `drainPending()` awaits HTTP; this
/// gate makes every queue mutation and published snapshot linear from the
/// user's perspective.
private actor NoteQueueOperationGate {
    private var held = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !held {
            held = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty {
            held = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

/// Owns the quick-capture notes state for the UI: the transient
/// `NotesClient` (rebuilt on pairing changes, like the other transport
/// clients), the durable `PendingNoteStore`, and the drain policy.
/// Deliberately UIKit-free so the drain/save
/// logic is testable in the SwiftPM logic lane.
///
/// Drain cadence: on pairing rebuild, on every app foreground
/// (`AppStore.onActive`), and after each save — no timer. Notes are
/// rare, tiny, and user-visible; the foreground moments are exactly
/// when the user cares whether they've landed.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
@Observable
public final class NotesCoordinator {
    /// Queued-not-yet-delivered notes, oldest first.
    public private(set) var pending: [PendingNote] = []

    @ObservationIgnored
    private var client: NotesClient?
    @ObservationIgnored
    private var deviceId: String?
    @ObservationIgnored
    private let store: PendingNoteStore
    /// Resolves the device's location for a fresh in-app capture. Nil in
    /// the logic lane / tests (no location attached); the app injects the
    /// real `NoteLocationProvider`. Only fresh captures resolve — a drain
    /// replays the location snapshotted on the queued note.
    @ObservationIgnored
    private let locationProvider: NoteLocationProviding?
    @ObservationIgnored
    private let queueGate = NoteQueueOperationGate()
    @ObservationIgnored
    private var draining = false
    @ObservationIgnored
    private let log = AppLog.make(category: "notes")
    #if DEBUG
    /// Set by `installPreviewState` so previews / snapshot renders keep
    /// their stamped fixtures — a view lifecycle hook firing `refresh*`
    /// or `drainPending` must not overwrite them from disk / network.
    @ObservationIgnored
    private var previewPinned = false
    #endif

    public init(
        store: PendingNoteStore = PendingNoteStore(),
        locationProvider: NoteLocationProviding? = nil
    ) {
        self.store = store
        self.locationProvider = locationProvider
    }

    // MARK: - Lifecycle (driven by AppStore)

    /// Install a client for the current pairing. Pure state swap — the
    /// caller (`AppStore`) kicks the follow-up drain, keeping this
    /// deterministic for tests.
    public func rebuild(baseURL: URL, token: String, deviceId: String, session: URLSessionLike? = nil) {
        if let session {
            client = NotesClient(baseURL: baseURL, token: token, session: session)
        } else {
            client = NotesClient(baseURL: baseURL, token: token)
        }
        self.deviceId = deviceId
    }

    /// Drop the client (unpair / re-pair gap). The pending queue stays
    /// on disk — see `PendingNoteStore` for why it survives re-pairs.
    public func teardown() {
        client = nil
        deviceId = nil
    }

    /// Full unpair: also discard queued notes along with the rest of
    /// the device's Omnesis state.
    public func teardownAndWipeQueue() {
        teardown()
        pending = []
        Task {
            await queueGate.acquire()
            await store.removeAll()
            // A refresh that began before unpair may have briefly published
            // its snapshot before this wipe acquired the gate. Reassert the
            // empty state after the serialized disk mutation completes.
            pending = []
            await queueGate.release()
        }
    }

    // MARK: - Capture / edit / delete

    /// Save a note (POST, falling back to the durable queue).
    public func save(
        text: String,
        surface: NoteSurface,
        captureTime: NoteCaptureTime = .now()
    ) async
        -> NoteCaptureService.Outcome {
        // Best-effort location for this fresh capture. Resolved before the
        // POST so it rides the note (and the queued fallback) — nil when
        // there's no provider, no permission, or no fix in the budget.
        // This is the foreground surface, so it may prompt for permission
        // the first time.
        let location = await locationProvider?.current(promptIfNeeded: true)
        let outcome = await NoteCaptureService.capture(
            text: text,
            surface: surface,
            client: client,
            deviceId: deviceId,
            store: store,
            captureTime: captureTime,
            location: location
        )
        switch outcome {
        case .saved:
            // A successful POST proves the gateway is reachable and
            // accepting notes — the moment to deliver anything queued
            // from earlier.
            await drainPending()
        case .queued:
            // Publish through the same serialization boundary as a drawer
            // refresh, so a capture finishing during a retry cannot expose
            // an out-of-order disk snapshot.
            await refreshPending()
        case .rejected(let reason):
            // Deterministic per-note refusal — nothing queued; the
            // caller keeps the text in the editor.
            log.warning("Note capture rejected: \(reason, privacy: .public)")
        case .failed(let reason):
            log.error("Note capture failed outright: \(reason, privacy: .private)")
        }
        return outcome
    }

    /// Discard a queued note before it delivers.
    public func deletePending(id: String) async {
        await queueGate.acquire()
        try? await store.remove(id: id)
        pending = await store.list()
        await queueGate.release()
    }

    // MARK: - Fetch / drain

    /// Re-read the pending queue from disk when the drawer warning or
    /// diagnostics surface appears, including notes that the Siri intent
    /// may have enqueued through a separate store instance.
    public func refreshPending() async {
        #if DEBUG
        guard !previewPinned else { return }
        #endif
        await queueGate.acquire()
        pending = await store.list()
        await queueGate.release()
    }

    /// Queued notes old enough to deserve attention. A normal first
    /// failure gets a five-minute grace period; a failed redelivery is
    /// visible immediately.
    public func warnedPending(now: Date = Date()) -> [PendingNote] {
        pending.filter { $0.warrantsDeliveryWarning(now: now) }
    }

    /// Earliest future instant at which a quiet queued note becomes old
    /// enough to warn. Nil when the queue is empty or a warning is already
    /// warranted (including a failed redelivery).
    public func nextWarningDeadline(now: Date = Date()) -> Date? {
        guard warnedPending(now: now).isEmpty else { return nil }
        return pending
            .map { $0.capturedAt.addingTimeInterval(PendingNote.warningAgeSeconds) }
            .filter { $0 > now }
            .min()
    }

    /// Deliver queued notes oldest-first with their original
    /// `capturedAt`. A deterministic per-note rejection (400/413/422 —
    /// the gateway will refuse that exact note every time) is skipped
    /// so one bad row can't wedge the whole queue; the row stays visible
    /// in delivery diagnostics until the user discards it. Any other
    /// failure stops the pass — the queue shares one endpoint, so
    /// whatever failed (gateway down, sealed files on a locked device,
    /// or an older gateway without `/notes`) will fail for every
    /// later note too; the next drain retries.
    public func drainPending() async {
        #if DEBUG
        guard !previewPinned else { return }
        #endif
        guard let client, !draining else { return }
        draining = true
        defer { draining = false }
        await queueGate.acquire()
        var delivered = 0
        for note in await store.list() {
            do {
                _ = try await client.createNote(
                    id: note.noteId,
                    text: note.text,
                    capturedAt: note.capturedAt,
                    capturedTimeZoneId: note.capturedTimeZoneId,
                    capturedUtcOffsetSeconds: note.capturedUtcOffsetSeconds,
                    surface: note.surface,
                    deviceId: deviceId,
                    location: note.location
                )
                try await store.remove(id: note.id)
                delivered += 1
            } catch {
                if let rejection = NoteCaptureService.deterministicRejection(error) {
                    log.warning("Skipping queued note the gateway rejects: \(rejection, privacy: .public)")
                    try? await store.recordFailedRedelivery(
                        id: note.id,
                        failure: PendingNoteDeliveryFailure(kind: .rejected),
                        attemptedAt: Date()
                    )
                    continue
                }
                try? await store.recordFailedRedelivery(
                    id: note.id,
                    failure: NoteCaptureService.deliveryFailure(for: error),
                    attemptedAt: Date()
                )
                break
            }
        }
        pending = await store.list()
        await queueGate.release()
        if delivered > 0 {
            log.info("Drained \(delivered, privacy: .public) queued notes to the gateway")
        }
    }
}

#if DEBUG
@available(iOS 17.0, macOS 14.0, *)
extension NotesCoordinator {
    /// Stamp fixture state for SwiftUI previews + snapshot tests. Also
    /// pins the coordinator so view lifecycle hooks (`.task` refresh /
    /// drain) can't overwrite the fixtures from disk or network.
    public func installPreviewState(
        pending: [PendingNote] = []
    ) {
        previewPinned = true
        self.pending = pending
    }
}
#endif
