// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Speech)
import Speech
#endif

/// Personal hints are kept only in this process, fenced by the current pairing.
/// A cold capture reads immediately; it never waits for the gateway.
@MainActor
public final class TranscriptionVocabularyCache {
    public static let shared = TranscriptionVocabularyCache()
    private var pairing: Pairing?
    private var identity: Identity?
    private var enabled = false
    private var denied = false
    private var fetchedAt = Date.distantPast
    private var generation = 0
    private var inFlight: Int?
    private var phrases: [String] = []
    private var expiresAt = Date.distantPast
    private var refreshAt = Date.distantPast
    private var retryAt = Date.distantPast
    private let now: () -> Date
    private let uptime: () -> TimeInterval
    private var expiresUptime: TimeInterval = 0

    private struct Identity: Equatable {
        let url: URL
        let token: String
        let accountId: String
        let deviceId: String
        let generation: String?
        let fingerprint: String?

        init(_ pairing: Pairing) {
            url = pairing.url
            token = pairing.token
            accountId = pairing.accountId
            deviceId = pairing.deviceId
            generation = pairing.pairingGeneration
            fingerprint = pairing.fingerprint
        }
    }

    public init(now: @escaping () -> Date = Date.init, uptime: (() -> TimeInterval)? = nil) {
        self.now = now
        let origin = ContinuousClock().now
        self.uptime = uptime ?? {
            let duration = origin.duration(to: ContinuousClock().now).components
            return Double(duration.seconds) + Double(duration.attoseconds) / 1e18
        }
    }

    public func configure(pairing: Pairing?, enabled: Bool) {
        let identity = pairing.map(Identity.init)
        if self.identity != identity || self.enabled != enabled {
            let keepDenial = self.identity == identity && denied
            clear()
            denied = keepDenial
            self.identity = identity
            self.pairing = pairing
            self.enabled = enabled && pairing != nil
        }
    }

    public func clear() {
        generation += 1
        inFlight = nil
        phrases = []
        denied = false
        fetchedAt = .distantPast
        expiresUptime = 0
        expiresAt = .distantPast
        refreshAt = .distantPast
        retryAt = .distantPast
        pairing = nil
        identity = nil
        enabled = false
    }

    /// Only callers enforcing supported on-device recognition may obtain hints.
    public func terms(onDevice: Bool) -> [String] {
        guard onDevice, enabled, !denied, pairing != nil, now() >= fetchedAt, now() < expiresAt, uptime() < expiresUptime else { return [] }
        return phrases
    }

    #if canImport(Speech)
    /// Both streaming and file recognition use this same privacy boundary.
    func apply(to request: SFSpeechRecognitionRequest, supportsOnDeviceRecognition: Bool) {
        request.contextualStrings = terms(onDevice: supportsOnDeviceRecognition && request.requiresOnDeviceRecognition)
    }
    #endif

    public func refreshIfDue(fetch: (@Sendable (Pairing) async throws -> TranscriptionVocabularySnapshot)? = nil) async {
        guard enabled, !denied, let pairing, inFlight == nil, now() >= refreshAt, now() >= retryAt else { return }
        let current = generation
        inFlight = current
        do {
            let snapshot: TranscriptionVocabularySnapshot = if let fetch {
                try await fetch(pairing)
            } else {
                try await TranscriptionVocabularyClient(baseURL: pairing.url, token: pairing.token)
                    .fetch(locale: Locale.current.identifier)
            }
            guard current == generation else { return }
            inFlight = nil
            phrases = snapshot.phrases
            let fetchedAt = now()
            self.fetchedAt = fetchedAt
            let lifetime = min(86400, max(0, snapshot.expiresAfterSeconds))
            expiresAt = fetchedAt.addingTimeInterval(lifetime)
            expiresUptime = uptime() + lifetime
            refreshAt = fetchedAt.addingTimeInterval(min(86400, max(1800, snapshot.refreshAfterSeconds)))
            retryAt = .distantPast
        } catch {
            guard current == generation else { return }
            inFlight = nil
            if let error = error as? GatewayClient.Error,
               error == .unauthorized || error == .forbidden {
                generation += 1
                phrases = []
                expiresAt = .distantPast
                denied = true
            } else {
                retryAt = now().addingTimeInterval(300)
            }
        }
    }
}
