// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
@testable import Omnesis
import XCTest

/// With `OMNESIS_CLOUD_RELAY_ENABLED` off nothing about sign-in enrollment runs, and a QR
/// pairing behaves as it does without cloud connectivity. Rotation is covered here too,
/// because its gate and its behaviour are the same few lines.
final class CloudRelayGateTests: XCTestCase {
    private let clock = 1_800_000_000.0
    private let spki = String(repeating: "c", count: 64)

    private func bundle(_ info: [String: Any]) throws -> Bundle {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("bundle")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: folder.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(Bundle(url: folder))
    }

    func testTheFlagIsOnOnlyWhenTheBuildSaysOne() throws {
        XCTAssertTrue(try CloudRelayFeature.isEnabled(in: bundle(["OmnesisCloudRelayEnabled": "1"])))
        for value: Any in ["0", "", "true", "$(OMNESIS_CLOUD_RELAY_ENABLED)", true] {
            XCTAssertFalse(try CloudRelayFeature.isEnabled(in: bundle(["OmnesisCloudRelayEnabled": value])))
        }
        XCTAssertFalse(try CloudRelayFeature.isEnabled(in: bundle([:])))
    }

    func testNotificationsAreIgnoredWithTheFlagOff() {
        let joined: [AnyHashable: Any] = ["omnesis": ["kind": "device-joined", "targetId": "dev-1"]]
        let pairing: [AnyHashable: Any] = ["omnesis": ["kind": "device-pairing", "targetId": "pairing"]]
        XCTAssertNil(PushTarget.fromUserInfo(joined, cloudRelayEnabled: false))
        XCTAssertNil(PushTarget.fromUserInfo(pairing, cloudRelayEnabled: false))
        XCTAssertEqual(PushTarget.fromUserInfo(joined, cloudRelayEnabled: true), .deviceJoined)
        XCTAssertEqual(PushTarget.fromUserInfo(["omnesis": ["kind": "device-joined"]], cloudRelayEnabled: true), .deviceJoined)
        XCTAssertEqual(PushTarget.deviceJoined.kindName, "device-joined")
        XCTAssertTrue(PushTarget.deviceJoined.opensDevices)
        XCTAssertTrue(PushTarget.pairingRequests.opensDevices)
        XCTAssertFalse(PushTarget.accessAuthorization.opensDevices)
    }

    func testClaimsDoNotAskForPairingNotificationsWithTheFlagOff() async throws {
        let seen = RequestLog()
        for enabled in [false, true] {
            let claimer = try NotificationClaimer(
                baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")),
                token: "omn_device",
                claimsPairingNotifications: enabled
            ) { request in
                seen.append(request)
                let url = try XCTUnwrap(request.url)
                let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 204, httpVersion: nil, headerFields: nil))
                return (Data(), response)
            }
            _ = try await claimer.claim()
        }
        XCTAssertEqual(seen.all.map { $0.value(forHTTPHeaderField: "X-Omnesis-Pairing-Notifications") }, [nil, "1"])
    }

    func testRotationNeverTouchesTheKeychainOrNetworkWithTheFlagOff() async throws {
        let store = CountingStore()
        let transport = RotationTransport()
        var subject = rotator(store: store, transport: transport, replaced: Replacement())
        subject.enabled = false
        let rotated = try await subject.rotateIfDue(pairing: pairing())
        XCTAssertFalse(rotated)
        XCTAssertEqual(store.reads, 0)
        XCTAssertEqual(store.writes, 0)
        XCTAssertTrue(transport.paths.isEmpty)
    }

    func testAQrPairingHasNoRecordAndNeverRotates() async throws {
        let store = InMemoryStore()
        let transport = RotationTransport()
        let rotated = try await rotator(store: store, transport: transport, replaced: Replacement()).rotateIfDue(pairing: pairing())
        XCTAssertFalse(rotated)
        XCTAssertTrue(transport.paths.isEmpty)
        XCTAssertNil(try store.get("device.enrollment.key.v1"))
    }

    func testRotationIsDueAfterThirtyDaysAndSignsTheContractTranscript() async throws {
        let store = InMemoryStore()
        let pairing = try pairing()
        let notYet = clock - DeviceTokenRotator.interval + 60
        DeviceEnrollmentRecord.begin(origin: pairing.url, spkiFingerprint: spki, store: store, now: notYet)
        let transport = RotationTransport()
        let replaced = Replacement()
        let early = try await rotator(store: store, transport: transport, replaced: replaced).rotateIfDue(pairing: pairing)
        XCTAssertFalse(early)
        XCTAssertTrue(transport.paths.isEmpty)

        DeviceEnrollmentRecord.begin(origin: pairing.url, spkiFingerprint: spki, store: store, now: clock - DeviceTokenRotator.interval)
        let key = try DeviceEnrollmentKey.loadOrCreate(store: InMemoryStore(), enclaveAvailable: false)
        var due = rotator(store: store, transport: transport, replaced: replaced)
        due.deviceKey = { key }
        let rotated = await due.rotateIfDue(pairing: pairing)
        XCTAssertTrue(rotated)
        XCTAssertEqual(transport.paths, ["/devices/token/challenge", "/devices/token/rotate"])
        XCTAssertEqual(transport.bearers, ["omn_old", "omn_old"])
        XCTAssertEqual(replaced.value?.token, "omn_new")
        XCTAssertEqual(replaced.value?.tokenId, "tok_new")

        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(transport.lastBody)) as? [String: String])
        XCTAssertEqual(body["challenge"], RotationTransport.challenge)
        let transcript = try DeviceEnrollmentContract.tokenRotationTranscript(
            deviceId: pairing.deviceId,
            gatewaySpkiFingerprint: spki,
            challenge: RotationTransport.challenge,
            devicePublicKey: key.publicKey
        )
        let publicKey = try P256.Signing.PublicKey(derRepresentation: XCTUnwrap(cloudBase64URL(key.publicKey)))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: XCTUnwrap(cloudBase64URL(XCTUnwrap(body["signature"]))))
        XCTAssertTrue(publicKey.isValidSignature(signature, for: transcript))
        XCTAssertEqual(DeviceEnrollmentRecord.load(store)?.rotatedAt, clock)
    }

    func testAFailedRotationKeepsTheTokenAndWaitsADayBeforeTryingAgain() async throws {
        for failure in [CloudPairingError.httpStatus(404), .httpStatus(500), .response] {
            let store = InMemoryStore()
            let pairing = try pairing()
            DeviceEnrollmentRecord.begin(origin: pairing.url, spkiFingerprint: spki, store: store, now: clock - DeviceTokenRotator.interval)
            let transport = RotationTransport(failure: failure)
            let replaced = Replacement()
            let subject = rotator(store: store, transport: transport, replaced: replaced)
            let first = await subject.rotateIfDue(pairing: pairing)
            XCTAssertFalse(first)
            XCTAssertNil(replaced.value)
            let attempts = transport.paths.count
            let second = await subject.rotateIfDue(pairing: pairing)
            XCTAssertFalse(second)
            XCTAssertEqual(transport.paths.count, attempts, "A foreground soon after a failure must not retry")

            var nextDay = subject
            let tomorrow = clock + DeviceTokenRotator.retryInterval
            nextDay.now = { tomorrow }
            _ = await nextDay.rotateIfDue(pairing: pairing)
            XCTAssertGreaterThan(transport.paths.count, attempts)
        }
    }

    func testARecordForAnotherGatewayDoesNotRotateThisPairing() async throws {
        let store = InMemoryStore()
        let other = try XCTUnwrap(URL(string: "https://other.example.test"))
        DeviceEnrollmentRecord.begin(origin: other, spkiFingerprint: spki, store: store, now: clock - DeviceTokenRotator.interval)
        let transport = RotationTransport()
        let rotated = try await rotator(store: store, transport: transport, replaced: Replacement()).rotateIfDue(pairing: pairing())
        XCTAssertFalse(rotated)
        XCTAssertTrue(transport.paths.isEmpty)
    }

    func testReplacingATokenIsOneWriteAndRefusesAChangedPairing() throws {
        let store = InMemoryStore()
        let pairing = try pairing()
        try store.set(
            PairingCredentialBundle(
                url: pairing.url.absoluteString,
                token: pairing.token,
                pairingGeneration: "tok_old",
                accountId: pairing.accountId,
                deviceId: pairing.deviceId,
                name: pairing.gatewayName,
                scopes: pairing.scopes,
                tlsMode: pairing.tlsMode.rawValue,
                fingerprint: nil,
                spkiFingerprint: spki
            ).encoded(),
            forKey: PairingCredentialBundle.key
        )
        let service = PairingService(store: store, cloudRelayEnabled: true)
        let current = try XCTUnwrap(service.current())
        XCTAssertTrue(try service.replaceToken(expected: current, token: "omn_new", tokenId: "tok_new"))
        let updated = try XCTUnwrap(service.current())
        XCTAssertEqual(updated.token, "omn_new")
        XCTAssertEqual(updated.pairingGeneration, "tok_new")
        XCTAssertEqual(updated.deviceId, pairing.deviceId)
        XCTAssertEqual(updated.spkiFingerprint, spki)
        XCTAssertFalse(try service.replaceToken(expected: current, token: "omn_stale", tokenId: nil))
        XCTAssertEqual(try service.current()?.token, "omn_new")
    }

    func testJoinWords() {
        func info(_ method: String?, _ signIn: String? = nil) -> DeviceEnrollmentInfo {
            DeviceEnrollmentInfo(method: method, signIn: signIn)
        }
        // A device that joined by signing in reads the same whatever the sign-in was.
        for signIn in ["google", "passkey", "something-newer", nil] {
            XCTAssertEqual(DeviceJoinPresentation.joinLabel(info("automatic", signIn)), "Joined with Omnesis account")
        }
        XCTAssertEqual(DeviceJoinPresentation.joinLabel(info("approved", "google")), "Approved")
        XCTAssertNil(DeviceJoinPresentation.joinLabel(info(nil)))
        XCTAssertNil(DeviceJoinPresentation.joinLabel(info("qr")))
        XCTAssertEqual(DeviceJoinPresentation.signInMethod("google"), "Google")
        XCTAssertEqual(DeviceJoinPresentation.signInMethod("passkey"), "Passkey")
        XCTAssertNil(DeviceJoinPresentation.signInMethod(nil))
    }

    func testAnOlderDeviceRowStillDecodes() throws {
        let row = #"{"id":"d","name":"Phone","kind":"ios","pairedAt":1}"#
        XCTAssertNil(try JSONDecoder().decode(DeviceRecord.self, from: Data(row.utf8)).enrollment)
        let joined = #"{"id":"d","name":"Phone","kind":"ios","pairedAt":1,"#
            + #""enrollment":{"method":"automatic","signIn":"google","joinedAt":5}}"#
        XCTAssertEqual(
            try JSONDecoder().decode(DeviceRecord.self, from: Data(joined.utf8)).enrollment,
            DeviceEnrollmentInfo(method: "automatic", signIn: "google", joinedAt: 5)
        )
    }

    private func pairing() throws -> Pairing {
        try Pairing(
            url: XCTUnwrap(URL(string: "https://gateway.example.test")),
            token: "omn_old",
            pairingGeneration: "tok_old",
            accountId: "local",
            deviceId: "99999999-8888-4777-8666-555555555555",
            gatewayName: "Fictional phone",
            scopes: ["read"],
            spkiFingerprint: spki,
            tlsMode: .pinnedKeyStrict
        )
    }

    private func rotator(store: any PairingStore, transport: RotationTransport, replaced: Replacement) -> DeviceTokenRotator {
        let clock = clock
        return DeviceTokenRotator(
            enabled: true,
            store: store,
            deviceKey: { try DeviceEnrollmentKey.loadOrCreate(store: InMemoryStore(), enclaveAvailable: false) },
            makeTransport: { _, _ in transport },
            replaceToken: { token, tokenId in
                replaced.value = (token, tokenId)
                return true
            },
            now: { clock }
        )
    }
}

private final class Replacement: @unchecked Sendable {
    var value: (token: String, tokenId: String?)?
}

private final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    var all: [URLRequest] {
        lock.withLock { requests }
    }

    func append(_ request: URLRequest) {
        lock.withLock { requests.append(request) }
    }
}

private final class RotationTransport: CloudPairingTransport, @unchecked Sendable {
    static let challenge = String(repeating: "r", count: 43)
    private let lock = NSLock()
    private let failure: CloudPairingError?
    private struct Call {
        let path: String
        let bearer: String?
        let body: Data?
    }

    private var log: [Call] = []
    init(failure: CloudPairingError? = nil) {
        self.failure = failure
    }

    var paths: [String] {
        lock.withLock { log.map(\.path) }
    }

    var bearers: [String?] {
        lock.withLock { log.map(\.bearer) }
    }

    var lastBody: Data? {
        lock.withLock { log.last?.body }
    }

    func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data {
        lock.withLock { log.append(Call(path: url.path, bearer: bearer, body: body)) }
        if let failure { throw failure }
        return url.path.hasSuffix("challenge")
            ? Data(#"{"challenge":"\#(Self.challenge)","expiresAt":1}"#.utf8)
            : Data(#"{"token":"omn_new","tokenId":"tok_new"}"#.utf8)
    }

    func close() {}
}

private final class CountingStore: PairingStore, @unchecked Sendable {
    var reads = 0
    var writes = 0
    func set(_ value: String, forKey key: String) throws {
        writes += 1
    }

    func get(_ key: String) throws -> String? {
        reads += 1
        return nil
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
