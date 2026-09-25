// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Offline-first note delivery, shared by every capture path: the
/// in-app capture sheet (via `NotesCoordinator`), the Siri
/// `CaptureNoteIntent` (which runs in the background with no UI and no
/// `AppStore`), and the queue drain. One POST attempt; transient
/// failures — gateway down, 404 (older gateway), auth
/// trouble, 5xx — fall back to the durable `PendingNoteStore` so a
/// spoken note is never dropped on the floor. Deterministic per-note
/// rejections (the gateway saying "this exact note will never be
/// accepted": 400/413/422, or the client-side length cap) do NOT
/// queue — retrying an invalid note forever would wedge the queue —
/// and instead hand the text back to the caller.
public enum NoteCaptureService {
    /// Client-side mirror of the gateway's per-note text cap. Enforced
    /// before the POST so an over-long dictation surfaces immediately
    /// (with the text kept for shortening) instead of being rejected
    /// server-side or silently truncated.
    public static let maxTextLength = 8192

    /// Why a note went to the durable queue instead of the gateway.
    /// Drives the honest per-cause confirmation copy in the capture UI.
    public enum QueueReason: Equatable, Sendable {
        /// Network failure, 5xx, 429, or no pairing yet — delivers when
        /// the gateway is reachable again.
        case unreachable
        /// The gateway 404s the `/notes` routes (older version) —
        /// delivers after the gateway is upgraded.
        case featureOff
        /// 401/403 — the pairing token is no longer accepted; delivers
        /// after a re-pair.
        case unauthorized
    }

    public enum Outcome: Equatable, Sendable {
        /// Delivered to the gateway.
        case saved
        /// Persisted locally; a later drain delivers it.
        case queued(QueueReason)
        /// The note itself was refused (over-long, or a deterministic
        /// gateway 400/413/422). NOT queued — the caller keeps the text
        /// in the editor so the user can fix it.
        case rejected(String)
        /// No delivery and the queue write failed — the note is lost.
        /// Callers surface this loudly.
        case failed(String)
    }

    /// Try the gateway, fall back to the queue. `captureTime` is supplied
    /// by the entry point before any location or network wait so a queued
    /// note keeps its true instant and local-calendar interpretation.
    /// A UUID idempotency key is minted per note and sent as the POST
    /// `id` — and persisted with the queued fallback — so a retry of a
    /// note whose first POST landed (but whose response was lost) can't
    /// create a duplicate.
    public static func capture(
        text: String,
        surface: NoteSurface,
        client: NotesClient?,
        deviceId: String?,
        store: PendingNoteStore,
        captureTime: NoteCaptureTime = .now(),
        location: NoteLocation? = nil
    ) async
        -> Outcome {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed("empty note") }
        guard trimmed.count <= maxTextLength else {
            return .rejected("Too long — notes are capped at \(maxTextLength) characters. Shorten it and try again.")
        }
        let noteId = UUID().uuidString.lowercased()
        var reason: QueueReason = .unreachable
        var diagnostics = PendingNoteDeliveryDiagnostics(
            attemptCount: 0,
            lastAttemptAt: nil,
            lastFailure: PendingNoteDeliveryFailure(kind: .unpaired)
        )
        if let client {
            do {
                _ = try await client.createNote(
                    id: noteId,
                    text: trimmed,
                    capturedAt: captureTime.capturedAt,
                    capturedTimeZoneId: captureTime.timeZoneId,
                    capturedUtcOffsetSeconds: captureTime.utcOffsetSeconds,
                    surface: surface.rawValue,
                    deviceId: deviceId,
                    location: location
                )
                return .saved
            } catch {
                if let rejection = deterministicRejection(error) {
                    return .rejected(rejection)
                }
                reason = queueReason(for: error)
                diagnostics = PendingNoteDeliveryDiagnostics(
                    attemptCount: 1,
                    lastAttemptAt: Date(),
                    lastFailure: deliveryFailure(for: error)
                )
                // Fall through to the queue for everything transient.
            }
        }
        do {
            try await store.enqueue(
                PendingNote(
                    noteId: noteId,
                    text: trimmed,
                    capturedAt: captureTime.capturedAt,
                    capturedTimeZoneId: captureTime.timeZoneId,
                    capturedUtcOffsetSeconds: captureTime.utcOffsetSeconds,
                    surface: surface.rawValue,
                    location: location,
                    deliveryDiagnostics: diagnostics
                )
            )
            return .queued(reason)
        } catch {
            return .failed(String(describing: error))
        }
    }

    /// Self-contained variant for App Intents running without the app
    /// UI: loads the pairing from the Keychain and builds a transient
    /// client. Unpaired devices queue the note. The caller resolves the
    /// capture location (an iOS-only concern) and passes it through, so
    /// this stays free of CoreLocation.
    public static func captureStandalone(
        text: String,
        surface: NoteSurface,
        captureTime: NoteCaptureTime = .now(),
        location: NoteLocation? = nil
    ) async
        -> Outcome {
        let pairing = (try? PairingService().current()).flatMap { $0 }
        let client = pairing.map { NotesClient(baseURL: $0.url, token: $0.token) }
        return await capture(
            text: text,
            surface: surface,
            client: client,
            deviceId: pairing?.deviceId,
            store: PendingNoteStore(),
            captureTime: captureTime,
            location: location
        )
    }

    /// A deterministic per-note rejection: the gateway will refuse this
    /// exact note on every retry, so queueing it would wedge the drain.
    /// Returns the user-facing reason, or nil for transient errors.
    static func deterministicRejection(_ error: Error) -> String? {
        guard case GatewayClient.Error.serverError(let status, _) = error,
              status == 400 || status == 413 || status == 422 else {
            return nil
        }
        return "The gateway rejected this note (\(status)). Edit it and try again."
    }

    private static func queueReason(for error: Error) -> QueueReason {
        switch error {
        case GatewayClient.Error.notFound: .featureOff
        case GatewayClient.Error.unauthorized, GatewayClient.Error.forbidden: .unauthorized
        default: .unreachable
        }
    }

    /// Coarse, persistence-safe failure classification for the local
    /// diagnostic queue. Never stores an HTTP response body or URL.
    static func deliveryFailure(for error: Error) -> PendingNoteDeliveryFailure {
        switch error {
        case GatewayClient.Error.notFound:
            PendingNoteDeliveryFailure(kind: .featureOff, code: 404)
        case GatewayClient.Error.unauthorized:
            PendingNoteDeliveryFailure(kind: .unauthorized, code: 401)
        case GatewayClient.Error.forbidden:
            PendingNoteDeliveryFailure(kind: .unauthorized, code: 403)
        case GatewayClient.Error.serverError(let status, _):
            PendingNoteDeliveryFailure(kind: .unreachable, code: status)
        case let error as URLError:
            PendingNoteDeliveryFailure(kind: .unreachable, code: error.code.rawValue)
        default:
            PendingNoteDeliveryFailure(kind: .unreachable)
        }
    }
}
