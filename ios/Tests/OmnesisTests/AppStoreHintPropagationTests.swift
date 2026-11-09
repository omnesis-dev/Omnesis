// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
@MainActor
final class AppStoreHintPropagationTests: XCTestCase {
    private let hints = [GatewayDirectCandidate(address: "10.0.0.42", port: 8443)]
    private let key = String(repeating: "ab", count: 32)

    func testFreshFactsReachTheCachedSessionWidgetAndNarrowNotificationCredentialWithoutChangingAuthority() throws {
        let vault = InMemoryStore(), widgets = InMemoryStore(), notifications = InMemoryStore()
        let original = pairing(), refreshed = pairing(facts: hints)
        try save(original, in: vault)
        OmnesisURLSession._setStore(vault)
        let session = OmnesisURLSession.shared
        defer { OmnesisURLSession._setStore(nil)
            OmnesisURLSession.reset()
            session.invalidateAndCancel()
        }
        XCTAssertTrue(session.delegate is PinnedSession)
        try TaskWidgetStorage.configure(widget(original), store: widgets)
        try NotificationClaimCredentials.commit(
            .init(
                url: original.url.absoluteString,
                token: "narrow-push-claim",
                deviceId: original.deviceId,
                tlsMode: original.tlsMode.rawValue,
                fingerprint: nil,
                spkiFingerprint: key
            ),
            keychain: notifications
        )
        try save(refreshed, in: vault)
        var published: [Pairing?] = []
        try AppStore.publishDirectHints(refreshed, currentPairing: refreshed, notificationStore: notifications) { current in
            published.append(current)
            do {
                try TaskWidgetStorage.configure(current.map(self.widget), store: widgets)
            } catch {
                XCTFail("Isolated widget publication failed: \(error)")
            }
        }
        XCTAssertEqual(published, [refreshed])
        XCTAssertTrue(OmnesisURLSession.shared === session, "Hint refresh must preserve ongoing uploads")
        let widget = try XCTUnwrap(TaskWidgetStorage.credential(store: widgets))
        XCTAssertEqual(widget.directCandidates, hints)
        XCTAssertEqual(widget.generation, original.pairingGeneration)
        XCTAssertEqual(widget.token, original.token)
        XCTAssertEqual(widget.spkiFingerprint, key)
        let narrow = try XCTUnwrap(NotificationClaimCredentials.stored(keychain: notifications))
        XCTAssertEqual(narrow.directCandidates, hints)
        XCTAssertEqual(narrow.token, "narrow-push-claim")
        XCTAssertEqual(narrow.deviceId, original.deviceId)
        XCTAssertEqual(narrow.spkiFingerprint, key)

        let cleared = pairing()
        try save(cleared, in: vault)
        try AppStore.publishDirectHints(cleared, currentPairing: cleared, notificationStore: notifications) { current in
            do {
                try TaskWidgetStorage.configure(current.map(self.widget), store: widgets)
            } catch {
                XCTFail("Isolated widget publication failed: \(error)")
            }
        }
        XCTAssertNil(try TaskWidgetStorage.credential(store: widgets)?.directCandidates)
        XCTAssertNil(try NotificationClaimCredentials.stored(keychain: notifications)?.directCandidates)
    }

    func testUnpairedReplacedAndSupersededFactsCannotReachAnyConsumer() throws {
        let notifications = InMemoryStore()
        let obsolete = pairing(facts: hints)
        let current = pairing(generation: "replacement-generation", facts: hints)
        for authority in [nil, current, pairing(facts: [])] {
            var publications = 0
            // Stale publications return before any consumer reads its credential store.
            XCTAssertNoThrow(try AppStore.publishDirectHints(obsolete, currentPairing: authority, notificationStore: notifications) { _ in
                publications += 1
            })
            XCTAssertEqual(publications, 0)
            XCTAssertNil(try NotificationClaimCredentials.stored(keychain: notifications))
        }
    }

    func testInvalidFactsFailBeforeWidgetPublicationAndNotificationStorageErrorsDoNotBreakSessionRecovery() throws {
        let vault = InMemoryStore(), notifications = InMemoryStore()
        let original = pairing()
        try save(original, in: vault)
        OmnesisURLSession._setStore(vault)
        let session = OmnesisURLSession.shared
        defer { OmnesisURLSession._setStore(nil)
            OmnesisURLSession.reset()
            session.invalidateAndCancel()
        }
        let invalid = pairing(facts: [.init(address: "8.8.8.8", port: 443)])
        var publications = 0
        XCTAssertThrowsError(try AppStore.publishDirectHints(invalid, currentPairing: invalid, notificationStore: notifications) { _ in
            publications += 1
        })
        XCTAssertEqual(publications, 0)
        let changed = pairing(facts: hints)
        try save(changed, in: vault)
        let locked = LockedStore()
        XCTAssertNoThrow(try AppStore.publishDirectHints(changed, currentPairing: changed, notificationStore: locked) { _ in
            publications += 1
        })
        XCTAssertEqual(publications, 1)
        XCTAssertTrue(OmnesisURLSession.shared === session)
    }

    private func pairing(generation: String = "current-generation", facts: [GatewayDirectCandidate]? = nil) -> Pairing {
        Pairing(
            url: URL(string: "https://gateway.example.test")!,
            token: "device-scope-token",
            pairingGeneration: generation,
            accountId: "local",
            deviceId: "test-phone",
            gatewayName: "Test gateway",
            scopes: ["read", "admin"],
            spkiFingerprint: key,
            directCandidates: facts,
            tlsMode: .pinnedKeyStrict
        )
    }

    private func save(_ pairing: Pairing, in store: PairingStore) throws {
        try store.set(
            PairingCredentialBundle(pairing, url: pairing.url, tlsMode: pairing.tlsMode, fingerprint: pairing.fingerprint).encoded(),
            forKey: PairingCredentialBundle.key
        )
    }

    private func widget(_ pairing: Pairing) -> TaskWidgetCredential {
        .init(
            url: pairing.url,
            token: pairing.token,
            deviceId: pairing.deviceId,
            generation: pairing.pairingGeneration,
            tlsMode: pairing.tlsMode.rawValue,
            fingerprint: pairing.fingerprint,
            spkiFingerprint: pairing.spkiFingerprint,
            directCandidates: pairing.directCandidates
        )
    }

    private final class LockedStore: PairingStore, @unchecked Sendable {
        func get(_ key: String) throws -> String? {
            throw Keychain.Error.unavailable
        }

        func set(_ value: String, forKey key: String) throws {
            throw Keychain.Error.unavailable
        }

        func getLegacySynchronizable(_ key: String) throws -> String? {
            nil
        }

        func hasLegacySynchronizableValues() throws -> Bool {
            false
        }

        func deleteLegacySynchronizableValues() throws {}
        func delete(_ key: String) throws {}
        func deleteAll() throws {}
    }
}
#endif
