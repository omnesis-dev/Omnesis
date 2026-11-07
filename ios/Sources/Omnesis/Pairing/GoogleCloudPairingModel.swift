// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

struct GoogleCloudPairingConfiguration: Sendable {
    let clientId: String
    let relayOrigin: URL

    static func configured(bundle: Bundle = .main) -> GoogleCloudPairingConfiguration? {
        guard let id = bundle.object(forInfoDictionaryKey: "OmnesisGoogleClientID") as? String,
              id.hasSuffix(".apps.googleusercontent.com"), !id.contains("$("),
              let origin = bundle.object(forInfoDictionaryKey: "OmnesisCloudRelayURL") as? String,
              let parts = URLComponents(string: origin), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              ["", "/"].contains(parts.path) else { return nil }
        let scheme = id.split(separator: ".").reversed().joined(separator: ".")
        let entries = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        guard entries.contains(where: { ($0["CFBundleURLSchemes"] as? [String])?.contains(scheme) == true }) else { return nil }
        // These components were parsed from a valid absolute HTTPS URL.
        return GoogleCloudPairingConfiguration(clientId: id, relayOrigin: parts.url!)
    }
}

@MainActor
protocol GooglePairingBrowser: AnyObject {
    func signIn(_ authorization: GoogleNativeAuthorization) async throws -> URL
    func cancel()
}

protocol GooglePairingSession: Sendable {
    func start(challenge: CloudPairingChallenge, idToken: String) async throws -> CloudPairingConfirmation
    func poll() async throws -> CloudPairingProgress
    func close() async
}

extension GoogleCloudPairingClient: GooglePairingSession {}

/// Portable orchestration. Browser/provider SDKs only supply callbacks; the verified client and explicit comparison remain separate gates.
@MainActor @Observable
final class GoogleCloudPairingCoordinator {
    enum Phase: Equatable { case idle, signingIn, findingGateway, comparing, waiting, ready, pairing, failed }
    private(set) var phase: Phase = .idle
    private(set) var verificationCode: String?
    private(set) var gatewayHost: String?
    private(set) var error: Error?
    private(set) var compared = false
    @ObservationIgnored private let browser: any GooglePairingBrowser
    @ObservationIgnored private let makeChallenge: () throws -> CloudPairingChallenge
    @ObservationIgnored private let makeTransport: () -> any CloudPairingTransport
    @ObservationIgnored private let makeClient: (GoogleCloudPairingConfiguration, any CloudPairingTransport) throws
        -> any GooglePairingSession
    @ObservationIgnored private let sleep: () async throws -> Void
    @ObservationIgnored private let now: () -> TimeInterval
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var confirmation: CloudPairingConfirmation?
    @ObservationIgnored private var cloudClient: (any GooglePairingSession)?

    init(
        browser: any GooglePairingBrowser,
        makeChallenge: @escaping () throws -> CloudPairingChallenge,
        makeTransport: @escaping () -> any CloudPairingTransport,
        makeClient: @escaping (GoogleCloudPairingConfiguration, any CloudPairingTransport) throws -> any GooglePairingSession,
        sleep: @escaping () async throws -> Void,
        now: @escaping () -> TimeInterval
    ) {
        self.browser = browser
        self.makeChallenge = makeChallenge
        self.makeTransport = makeTransport
        self.makeClient = makeClient
        self.sleep = sleep
        self.now = now
    }

    @discardableResult
    func start(configuration: GoogleCloudPairingConfiguration) -> Task<Void, Never>? {
        guard phase == .idle || phase == .failed else { return nil }
        cancel()
        let operation = generation
        phase = .signingIn
        task = Task {
            let direct = makeTransport()
            defer { direct.close() }
            do {
                let challenge = try makeChallenge()
                let authorization = try GoogleNativeAuthorization(clientId: configuration.clientId, nonce: challenge.nonce, now: now())
                let callback = try await browser.signIn(authorization)
                try checkCurrent(operation)
                let idToken = try await authorization.exchange(callback: callback, transport: direct, now: now())
                try checkCurrent(operation)
                phase = .findingGateway
                let client = try makeClient(configuration, direct)
                cloudClient = client
                let pending = try await client.start(challenge: challenge, idToken: idToken)
                try checkCurrent(operation)
                confirmation = pending
                verificationCode = pending.verificationCode
                gatewayHost = pending.origin.host
                phase = .comparing
                // Cancellation is checked after every suspension; this generation owns a non-nil confirmation.
                while !confirmation!.approved {
                    try await sleep()
                    try checkCurrent(operation)
                    let progress = try await client.poll()
                    try checkCurrent(operation)
                    try confirmation!.receive(progress, now: now())
                    if confirmation!.approved { phase = compared ? .ready : .comparing }
                }
            } catch {
                guard generation == operation else { return }
                if Task.isCancelled { cancel()
                    return
                }
                await cloudClient?.close()
                // Closing an injected transport may suspend; a newer operation must keep its state.
                guard generation == operation else { return }
                if Task.isCancelled { cancel()
                    return
                }
                cloudClient = nil
                confirmation = nil
                phase = .failed
                self.error = error
            }
        }
        return task
    }

    func confirmComparison() {
        guard phase == .comparing || phase == .waiting else { return }
        var value = confirmation!
        value.confirmComparison()
        confirmation = value
        compared = true
        phase = value.approved ? .ready : .waiting
    }

    func complete(pair: @escaping (String) async -> Bool) async {
        guard phase == .ready else { return }
        let confirmation = confirmation!
        let operation = generation
        do {
            let payload = try confirmation.pairingPayload(now: now())
            phase = .pairing
            let applied = await pair(payload)
            try checkCurrent(operation)
            guard applied else { throw CloudPairingError.response }
            cancel()
        } catch {
            guard generation == operation, !Task.isCancelled else { return }
            phase = .failed
            self.error = error
            self.confirmation = nil
        }
    }

    func acceptsCompletedPairing(_ pairing: Pairing?, previousGeneration: String?) -> Bool {
        confirmation?.acceptsCompletedPairing(pairing, previousGeneration: previousGeneration) ?? false
    }

    func cancel() {
        generation = UUID()
        task?.cancel()
        task = nil
        browser.cancel()
        let previous = cloudClient
        cloudClient = nil
        Task { await previous?.close() }
        confirmation = nil
        verificationCode = nil
        gatewayHost = nil
        error = nil
        compared = false
        phase = .idle
    }

    private func checkCurrent(_ operation: UUID) throws {
        guard generation == operation, !Task.isCancelled else { throw CancellationError() }
    }
}
