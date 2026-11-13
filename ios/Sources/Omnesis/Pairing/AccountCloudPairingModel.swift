// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

#if canImport(AuthenticationServices)

struct AccountCloudPairingConfiguration: Sendable {
    let relayOrigin: URL
    let google: GoogleCloudPairingConfiguration?
    let passkeysEnabled: Bool
    var checksPublicCertificate = true

    static func configured(bundle: Bundle = .main) -> AccountCloudPairingConfiguration? {
        guard bundle.object(forInfoDictionaryKey: "OmnesisCloudRelayEnabled") as? String == "1",
              let value = bundle.object(forInfoDictionaryKey: "OmnesisCloudRelayURL") as? String,
              let parts = URLComponents(string: value), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              ["", "/"].contains(parts.path), parts.port == nil || parts.port == 443, let origin = parts.url else { return nil }
        let google = GoogleCloudPairingConfiguration.configured(bundle: bundle)
        let passkeysEnabled = bundle.object(forInfoDictionaryKey: "OmnesisCloudRelayPasskeysEnabled") as? String == "1"
        guard google != nil || passkeysEnabled else { return nil }
        return AccountCloudPairingConfiguration(
            relayOrigin: origin,
            google: google,
            passkeysEnabled: passkeysEnabled,
            checksPublicCertificate: checksPublicCertificate(bundle: bundle)
        )
    }
}

extension AccountCloudPairingConfiguration {
    /// Test gateways have private certificates. Release builds always check.
    fileprivate static func checksPublicCertificate(bundle: Bundle) -> Bool {
        #if DEBUG
        bundle.object(forInfoDictionaryKey: "OmnesisCloudRelaySkipPublicCertificateCheck") as? String != "1"
        #else
        true
        #endif
    }
}

protocol AccountPairingSession: Sendable {
    func begin(challenge: CloudPairingChallenge) async throws -> String
    func google(idToken: String) async throws -> [AccountGatewayChoice]
    func passkeyOptions() async throws -> AccountCloudPairingClient.PasskeyOptions
    func passkey(options: AccountCloudPairingClient.PasskeyOptions, assertion: Data) async throws -> [AccountGatewayChoice]
    func select(gatewayId: String) async throws -> CloudPairingConfirmation
    func retryEnrollment() async throws -> CloudPairingConfirmation
    func poll() async throws -> CloudPairingProgress
    func close() async
}

extension AccountCloudPairingClient: AccountPairingSession {}

/// Sign-in commits to this device's key and finds its gateways. With one gateway there is nothing to choose.
/// The gateway then either joins the device, or holds it for approval and comparison.
@MainActor @Observable final class AccountCloudPairingCoordinator {
    enum Phase: Equatable { case idle, connecting, signingIn, finding, choosing, waitingForGateway, joining, comparing, pairing, failed }
    enum Method { case google, passkey }
    private(set) var phase: Phase = .idle
    private(set) var gateways: [AccountGatewayChoice] = []
    private(set) var verificationCode: String?
    private(set) var gatewayHost: String?
    private(set) var error: Error?
    private(set) var gatewayApproved = false
    @ObservationIgnored private let googleBrowser: any GooglePairingBrowser
    @ObservationIgnored private let passkeyProvider: any AccountPasskeyProvider
    @ObservationIgnored private let makeClient: (AccountCloudPairingConfiguration) throws -> any AccountPairingSession
    @ObservationIgnored private let makeTransport: () -> any CloudPairingTransport
    @ObservationIgnored private let sleep: () async throws -> Void
    @ObservationIgnored private let retryWait: (Int) async throws -> Void
    @ObservationIgnored private let recordEnrollment: (CloudPairingConfirmation) -> Void
    @ObservationIgnored private let now: () -> TimeInterval
    @ObservationIgnored private var client: (any AccountPairingSession)?
    @ObservationIgnored private var confirmation: CloudPairingConfirmation?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?

    convenience init() {
        self.init(
            googleBrowser: GoogleSystemBrowser(),
            passkeyProvider: AccountPasskeyBrowser(),
            recordEnrollment: { DeviceEnrollmentRecord.begin(origin: $0.origin, spkiFingerprint: $0.spkiFingerprint) }
        )
    }

    init(
        googleBrowser: any GooglePairingBrowser,
        passkeyProvider: any AccountPasskeyProvider,
        makeClient: @escaping (AccountCloudPairingConfiguration) throws -> any AccountPairingSession = {
            try AccountCloudPairingClient(
                relayOrigin: $0.relayOrigin,
                clientId: $0.google?.clientId ?? "",
                checksPublicCertificate: $0.checksPublicCertificate
            )
        },
        makeTransport: @escaping () -> any CloudPairingTransport = { CloudPairingHTTP() },
        sleep: @escaping () async throws -> Void = { try await Task.sleep(for: .seconds(2)) },
        retryWait: @escaping (Int) async throws -> Void = { try await Task.sleep(for: .seconds(min(30, 2 << min($0, 4)))) },
        recordEnrollment: @escaping (CloudPairingConfirmation) -> Void = { _ in },
        now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) {
        self.googleBrowser = googleBrowser
        self.passkeyProvider = passkeyProvider
        self.makeClient = makeClient
        self.makeTransport = makeTransport
        self.sleep = sleep
        self.retryWait = retryWait
        self.recordEnrollment = recordEnrollment
        self.now = now
    }

    @discardableResult func start(configuration: AccountCloudPairingConfiguration, method: Method) -> Task<Void, Never>? {
        guard phase == .idle || phase == .failed else { return nil }
        cancel()
        let operation = generation
        phase = .connecting
        task = Task {
            do {
                let client = try makeClient(configuration)
                self.client = client
                let nonce = try await client.begin(challenge: CloudPairingChallenge(name: "Omnesis iPhone"))
                try checkCurrent(operation)
                phase = .signingIn
                let choices: [AccountGatewayChoice]
                switch method {
                case .google:
                    guard let google = configuration.google else { throw CloudPairingError.configuration }
                    let authorization = try GoogleNativeAuthorization(clientId: google.clientId, nonce: nonce, now: now())
                    let callback = try await googleBrowser.signIn(authorization)
                    try checkCurrent(operation)
                    let transport = makeTransport()
                    defer { transport.close() }
                    let idToken = try await authorization.exchange(callback: callback, transport: transport, now: now())
                    try checkCurrent(operation)
                    phase = .finding
                    choices = try await client.google(idToken: idToken)
                case .passkey:
                    guard configuration.passkeysEnabled,
                          let rpId = configuration.relayOrigin.host else { throw CloudPairingError.configuration }
                    let options = try await client.passkeyOptions()
                    try checkCurrent(operation)
                    let assertion = try await passkeyProvider.assertion(options: options.options, rpId: rpId)
                    try checkCurrent(operation)
                    phase = .finding
                    choices = try await client.passkey(options: options, assertion: assertion)
                }
                try checkCurrent(operation)
                gateways = choices
                if choices.count == 1 {
                    phase = .connecting
                    await enroll(choices[0].gatewayId, client: client, operation: operation)
                } else {
                    phase = .choosing
                }
            } catch { fail(error, operation: operation) }
        }
        return task
    }

    @discardableResult func choose(_ gatewayId: String) -> Task<Void, Never>? {
        guard phase == .choosing, gateways.contains(where: { $0.gatewayId == gatewayId }), let client else { return nil }
        let operation = generation
        phase = .connecting
        task = Task { await enroll(gatewayId, client: client, operation: operation) }
        return task
    }

    private func enroll(_ gatewayId: String, client: any AccountPairingSession, operation: UUID) async {
        do {
            var value = try await reachGateway(gatewayId, client: client, operation: operation)
            try checkCurrent(operation)
            confirmation = value
            gatewayHost = value.origin.host
            gatewayApproved = value.approved
            if value.joinedAutomatically {
                phase = .joining
                return
            }
            verificationCode = value.verificationCode
            phase = .comparing
            while !value.approved {
                try await sleep()
                let progress = try await client.poll()
                try checkCurrent(operation)
                try value.receive(progress, now: now())
                confirmation = value
                gatewayApproved = value.approved
            }
        } catch { fail(error, operation: operation) }
    }

    /// A gateway that is offline right now is worth waiting for. The client ends the
    /// wait with `expired` once the sign-in can no longer be used.
    private func reachGateway(
        _ gatewayId: String,
        client: any AccountPairingSession,
        operation: UUID
    ) async throws
        -> CloudPairingConfirmation {
        do {
            return try await client.select(gatewayId: gatewayId)
        } catch AccountPairingError.gatewayUnavailable {}
        var attempt = 0
        while true {
            try checkCurrent(operation)
            phase = .waitingForGateway
            try await retryWait(attempt)
            attempt += 1
            try checkCurrent(operation)
            do {
                return try await client.retryEnrollment()
            } catch AccountPairingError.gatewayUnavailable {}
        }
    }

    func complete(pair: @escaping (String) async -> Bool) async {
        guard phase == .comparing || phase == .joining, var value = confirmation, value.approved else { return }
        let operation = generation
        do {
            if !value.joinedAutomatically { value.confirmComparison() }
            confirmation = value
            let payload = try value.pairingPayload(now: now())
            phase = .pairing
            let applied = await pair(payload)
            try checkCurrent(operation)
            guard applied else { throw CloudPairingError.response }
            recordEnrollment(value)
            cancel()
        } catch { fail(error, operation: operation) }
    }

    func acceptsCompletedPairing(_ pairing: Pairing?, previousGeneration: String?) -> Bool {
        confirmation?.acceptsCompletedPairing(
            pairing,
            previousGeneration: previousGeneration
        ) ?? false
    }

    func cancel() {
        generation = UUID()
        task?.cancel()
        task = nil
        googleBrowser.cancel()
        passkeyProvider.cancel()
        let previous = client
        client = nil
        Task { await previous?.close() }
        confirmation = nil
        verificationCode = nil
        gatewayHost = nil
        gatewayApproved = false
        gateways = []
        error = nil
        phase = .idle
    }

    private func checkCurrent(_ operation: UUID) throws {
        guard generation == operation,
              !Task.isCancelled else { throw CancellationError() }
    }

    private func fail(_ error: Error, operation: UUID) {
        guard generation == operation, !Task.isCancelled else { return }
        if error is CancellationError || error as? CloudPairingError == .cancelled || error as? AccountPairingError == .cancelled { cancel()
            return
        }
        self.error = error
        phase = .failed
        confirmation = nil
        // A reply that failed its checks leaves no code on screen.
        verificationCode = nil
        let previous = client
        client = nil
        Task { await previous?.close() }
    }
}
#endif
