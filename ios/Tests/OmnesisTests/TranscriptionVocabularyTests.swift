// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest
#if canImport(Speech)
import Speech
#endif

@MainActor
final class TranscriptionVocabularyTests: XCTestCase {
    private var date = Date(timeIntervalSince1970: 1_800_000_000)
    private var uptime: TimeInterval = 100
    private func pairing(token: String = "fixture-token") -> Pairing {
        Pairing(
            url: URL(string: "https://gateway.example.com")!,
            token: token,
            accountId: "fixture-account",
            deviceId: "fixture-device",
            gatewayName: "Fixture gateway"
        )
    }

    private func snapshot(enabled: Bool = true, texts: [String] = ["Zuvrento", "Oriel Vale"]) throws -> TranscriptionVocabularySnapshot {
        let data = try JSONSerialization.data(withJSONObject: [
            "enabled": enabled,
            "entries": texts.map { ["text": $0, "score": 2] },
            "refreshAfterSeconds": 1800,
            "expiresAfterSeconds": 86400,
        ])
        return try JSONDecoder().decode(TranscriptionVocabularySnapshot.self, from: data)
    }

    func testOfflineExpiryRefreshAndRetryThrottle() async throws {
        let cache = TranscriptionVocabularyCache(now: { self.date })
        let value = try snapshot()
        cache.configure(pairing: pairing(), enabled: true)
        await cache.refreshIfDue { _ in value }
        XCTAssertEqual(cache.terms(onDevice: true), ["Zuvrento", "Oriel Vale"])
        XCTAssertTrue(cache.terms(onDevice: false).isEmpty)
        date.addTimeInterval(1799)
        await cache.refreshIfDue { _ in XCTFail("Fresh snapshot must not fetch")
            return value
        }
        date.addTimeInterval(1)
        await cache.refreshIfDue { _ in throw URLError(.notConnectedToInternet) }
        XCTAssertEqual(cache.terms(onDevice: true).count, 2)
        await cache.refreshIfDue { _ in XCTFail("Transient failure must throttle retry")
            return value
        }
        date.addTimeInterval(300)
        await cache.refreshIfDue { _ in throw URLError(.notConnectedToInternet) }
        date.addTimeInterval(86400 - 2100)
        XCTAssertTrue(cache.terms(onDevice: true).isEmpty)
    }

    func testDisabledAbsentAndAuthorizationFailuresClearHints() async throws {
        let cache = TranscriptionVocabularyCache()
        let value = try snapshot()
        cache.configure(pairing: pairing(), enabled: false)
        await cache.refreshIfDue { _ in XCTFail("Disabled gateway must not fetch")
            return value
        }
        cache.configure(pairing: pairing(), enabled: true)
        await cache.refreshIfDue { _ in value }
        cache.configure(pairing: pairing(), enabled: false)
        XCTAssertTrue(cache.terms(onDevice: true).isEmpty)
        for error in [GatewayClient.Error.unauthorized, .forbidden] {
            cache.configure(pairing: pairing(), enabled: true)
            await cache.refreshIfDue { _ in throw error }
            XCTAssertTrue(cache.terms(onDevice: true).isEmpty)
        }
        cache.configure(pairing: pairing(), enabled: true)
        let disabled = try snapshot(enabled: false)
        await cache.refreshIfDue { _ in disabled }
        XCTAssertTrue(cache.terms(onDevice: true).isEmpty)
    }

    func testAuthorizationDenialRemainsLatchedUntilCredentialRotation() async throws {
        let cache = TranscriptionVocabularyCache()
        let value = try snapshot()
        cache.configure(pairing: pairing(), enabled: true)
        await cache.refreshIfDue { _ in throw GatewayClient.Error.forbidden }
        cache.configure(pairing: pairing(), enabled: true)
        await cache.refreshIfDue { _ in XCTFail("Same denied credential must not retry")
            return value
        }
        cache.configure(pairing: pairing(), enabled: false)
        cache.configure(pairing: pairing(), enabled: true)
        await cache.refreshIfDue { _ in XCTFail("Status toggles cannot reset credential denial")
            return value
        }
        cache.configure(pairing: pairing(token: "rotated-token"), enabled: true)
        await cache.refreshIfDue { _ in value }
        XCTAssertEqual(cache.terms(onDevice: true).count, 2)
    }

    func testWallClockRollbackFailsClosed() async throws {
        let cache = TranscriptionVocabularyCache(now: { self.date })
        let value = try snapshot()
        cache.configure(pairing: pairing(), enabled: true)
        await cache.refreshIfDue { _ in value }
        date.addTimeInterval(-1)
        XCTAssertTrue(cache.terms(onDevice: true).isEmpty)
    }

    func testMonotonicExpiryCannotBeExtendedByWallClockChanges() async throws {
        let cache = TranscriptionVocabularyCache(now: { self.date }, uptime: { self.uptime })
        let value = try snapshot()
        cache.configure(pairing: pairing(), enabled: true)
        await cache.refreshIfDue { _ in value }
        date.addTimeInterval(3600)
        uptime += 86400
        XCTAssertTrue(cache.terms(onDevice: true).isEmpty)
    }

    func testRotationAndDisableFenceInFlightResponsesAndCoalesce() async throws {
        let cache = TranscriptionVocabularyCache()
        let value = try snapshot()
        let pending = PendingVocabulary()
        cache.configure(pairing: pairing(), enabled: true)
        let first = Task { await cache.refreshIfDue { _ in await pending.wait() } }
        await pending.started()
        await cache.refreshIfDue { _ in XCTFail("Concurrent refresh must coalesce")
            return value
        }
        cache.configure(pairing: pairing(token: "rotated-token"), enabled: true)
        await cache.refreshIfDue { _ in value }
        try await pending.finish(snapshot(texts: ["Oldphrase"]))
        await first.value
        XCTAssertEqual(cache.terms(onDevice: true), ["Zuvrento", "Oriel Vale"])
        let secondPending = PendingVocabulary()
        cache.clear()
        cache.configure(pairing: pairing(), enabled: true)
        let second = Task { await cache.refreshIfDue { _ in await secondPending.wait() } }
        await secondPending.started()
        cache.configure(pairing: nil, enabled: false)
        await secondPending.finish(value)
        await second.value
        XCTAssertTrue(cache.terms(onDevice: true).isEmpty)
    }

    func testPhraseBoundsNormalizationAndSharedRecognitionSeam() async throws {
        let texts = [" Zuvrento ", "zuvrento", "bad\nphrase", "", String(repeating: "x", count: 257)] + (0 ..< 110).map { "Term\($0)" }
        let value = try snapshot(texts: texts)
        XCTAssertEqual(value.phrases.count, 100)
        XCTAssertEqual(value.phrases.first, "Zuvrento")
        let cache = TranscriptionVocabularyCache()
        cache.configure(pairing: pairing(), enabled: true)
        await cache.refreshIfDue { _ in value }
        #if canImport(Speech)
        let requests: [SFSpeechRecognitionRequest] = [
            SFSpeechAudioBufferRecognitionRequest(),
            SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: "/tmp/fixture-recording.m4a")),
        ]
        for request in requests {
            request.requiresOnDeviceRecognition = true
            cache.apply(to: request, supportsOnDeviceRecognition: true)
            XCTAssertEqual(request.contextualStrings, value.phrases)
            request.requiresOnDeviceRecognition = false
            cache.apply(to: request, supportsOnDeviceRecognition: true)
            XCTAssertTrue(request.contextualStrings.isEmpty)
            request.requiresOnDeviceRecognition = true
            cache.apply(to: request, supportsOnDeviceRecognition: false)
            XCTAssertTrue(request.contextualStrings.isEmpty)
        }
        #endif
    }
}

private actor PendingVocabulary {
    private var continuation: CheckedContinuation<TranscriptionVocabularySnapshot, Never>?
    private var began: CheckedContinuation<Void, Never>?

    func wait() async -> TranscriptionVocabularySnapshot {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            began?.resume()
            began = nil
        }
    }

    func started() async {
        if continuation != nil { return }
        await withCheckedContinuation { began = $0 }
    }

    func finish(_ value: TranscriptionVocabularySnapshot) {
        continuation?.resume(returning: value)
        continuation = nil
    }
}
