// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
@testable import Omnesis
import XCTest

/// A device that joined by signing in renews its token every thirty days, signed with its
/// enrollment key; a QR pairing has no enrollment and never rotates.
final class DeviceTokenRotationTests: XCTestCase {
    private let clock = 1_800_000_000.0
    private let spki = String(repeating: "c", count: 64)

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
        let service = PairingService(store: store)
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
