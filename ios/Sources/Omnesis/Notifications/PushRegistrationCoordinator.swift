// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Serialises direct/relay selection and keeps a relay rotation recoverable
/// across app suspension. The gateway's old credential is never replaced until
/// a newly verified credential has been stored successfully.
public actor PushRegistrationCoordinator {
    public typealias GatewayRequest = @Sendable (Pairing, URLRequest) async throws
        -> (Data, URLResponse)
    public typealias RelayRequest = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    public typealias Clock = @Sendable () -> Date
    private typealias Plan = PushRegistrationModel.Plan
    private typealias State = PushRegistrationModel.State
    private typealias ActiveRegistration = PushRegistrationModel.ActiveRegistration
    private typealias ActiveChallenge = PushRegistrationModel.ActiveChallenge
    private typealias RegistrationKey = PushRegistrationModel.RegistrationKey
    private typealias Identity = PushRegistrationModel.Identity
    private typealias Pending = PushRegistrationModel.Pending
    private typealias ChallengeOwnership = PushRegistrationModel.ChallengeOwnership
    private typealias Completed = PushRegistrationModel.Completed
    private typealias PushPlanResponse = PushRegistrationModel.PushPlanResponse
    private typealias DirectBody = PushRegistrationModel.DirectBody
    private typealias LegacyBody = PushRegistrationModel.LegacyBody
    private typealias RelayBody = PushRegistrationModel.RelayBody
    private typealias RelayConsentBody = PushRegistrationModel.RelayConsentBody
    private typealias EnrolBody = PushRegistrationModel.EnrolBody
    private typealias VerifyBody = PushRegistrationModel.VerifyBody

    public static let relayRotationInterval: TimeInterval = 90 * 24 * 60 * 60
    public static let relayChallengeTTL: TimeInterval = 10 * 60

    private let store: PairingStore
    private let gatewayRequest: GatewayRequest
    private let relayRequest: RelayRequest
    private let now: Clock
    private let stateKey = "push.registration.state.v1"
    private let challengeNonceKey = "push.registration.challenge-nonce.v1"
    private var operationGeneration: UInt64 = 0
    private var activeRegistration: ActiveRegistration?
    private var activeChallenge: ActiveChallenge?
    private var registrationWriteTail: Task<Void, Error>?

    public init(
        store: PairingStore = Keychain(service: "dev.omnesis.ios.push-registration"),
        gatewayRequest: @escaping GatewayRequest = { _, request in
            try await OmnesisURLSession.shared.data(for: request)
        },
        relayRequest: @escaping RelayRequest = { request in
            try await URLSession.shared.data(for: request)
        },
        now: @escaping Clock = Date.init
    ) {
        self.store = store
        self.gatewayRequest = gatewayRequest
        self.relayRequest = relayRequest
        self.now = now
    }

    public func register(
        pairing: Pairing,
        tokenData: Data,
        bundleId: String,
        environment: String
    ) async throws {
        try await register(
            pairing: pairing,
            tokenHex: PushRegistrar.hexEncode(tokenData),
            bundleId: bundleId,
            environment: environment
        )
    }

    public func register(
        pairing: Pairing,
        tokenHex: String,
        bundleId: String,
        environment: String
    ) async throws {
        let identity = Identity(
            gatewayURL: pairing.url.absoluteString,
            deviceId: pairing.deviceId,
            pairingGeneration: pairing.pairingGeneration,
            carrierToken: tokenHex,
            appId: bundleId,
            environment: environment
        )

        let registrationKey = RegistrationKey(identity: identity, pairingToken: pairing.token)
        if let activeRegistration, activeRegistration.key == registrationKey {
            try await activeRegistration.task.value
            return
        }
        if try await awaitMatchingChallenge(identity: identity, pairingToken: pairing.token) == true {
            return
        }

        let generation = beginOperation()
        let task = Task {
            try await self.performRegistration(
                pairing: pairing,
                identity: identity,
                generation: generation
            )
        }
        activeRegistration = ActiveRegistration(
            key: registrationKey,
            generation: generation,
            task: task
        )
        do {
            try await task.value
            finishRegistration(generation)
        } catch {
            finishRegistration(generation)
            throw error
        }
    }

    private func performRegistration(
        pairing: Pairing,
        identity: Identity,
        generation: UInt64
    ) async throws {
        var state = try load()

        let selectedPlan: Plan
        do {
            selectedPlan = try await plan(pairing: pairing, appId: identity.appId)
        } catch PushRegistrationError.serverError(let status, _) where status == 404 {
            selectedPlan = .legacy
        }
        try ensureCurrent(generation)

        if let pending = state.pending,
           pending.identity == identity,
           selectedPlan.matchesRelay(url: pending.relayURL) {
            if let credential = pending.verifiedCredential {
                try ensureCurrent(generation)
                try await storeRelayRegistration(pairing, pending: pending, credential: credential)
                try ensureCurrent(generation)
                state.completed = Completed(
                    identity: identity,
                    transport: "relay",
                    relayURL: pending.relayURL,
                    registeredAt: now()
                )
                state.pending = nil
                try save(state)
                return
            } else if isFresh(pending.startedAt, interval: Self.relayChallengeTTL) {
                return
            } else {
                // The relay rejects challenges at ten minutes. Drop only the
                // expired attempt; a completed credential remains untouched
                // while we request a fresh proof.
                state.pending = nil
                try save(state)
            }
        } else if state.pending != nil {
            // A carrier challenge belongs to the plan that created it. A
            // gateway policy or relay-origin change invalidates that proof.
            state.pending = nil
            try save(state)
        }
        try clearCompletedRelayIfPlanChanged(&state, selectedPlan)
        if let completed = state.completed,
           registrationIsCurrent(completed, identity: identity, plan: selectedPlan) {
            return
        }

        try await apply(
            selectedPlan,
            pairing: pairing,
            identity: identity,
            state: &state,
            generation: generation
        )
    }

    /// Compatibility probe used only when minting the private-wake claim
    /// credential failed. It mutates registration exclusively when push-plan
    /// is absent (or returns an unknown legacy transport), so a modern direct
    /// or relay gateway is never registered for content-free wakes without a
    /// usable claim credential.
    @discardableResult
    public func registerLegacyIfPushPlanUnavailable(
        pairing: Pairing,
        tokenData: Data,
        bundleId: String,
        environment: String
    ) async throws
        -> Bool {
        let identity = Identity(
            gatewayURL: pairing.url.absoluteString,
            deviceId: pairing.deviceId,
            pairingGeneration: pairing.pairingGeneration,
            carrierToken: PushRegistrar.hexEncode(tokenData),
            appId: bundleId,
            environment: environment
        )
        if try await awaitMatchingChallenge(identity: identity, pairingToken: pairing.token) == true {
            return false
        }
        let generation = beginOperation()
        let selectedPlan: Plan
        do {
            selectedPlan = try await plan(pairing: pairing, appId: bundleId)
        } catch PushRegistrationError.serverError(let status, _) where status == 404 {
            selectedPlan = .legacy
        }
        try ensureCurrent(generation)
        guard case .legacy = selectedPlan else { return false }
        try ensureCurrent(generation)
        try await storeLegacyRegistration(pairing, identity)
        try ensureCurrent(generation)
        var state = try load()
        state.completed = Completed(
            identity: identity,
            transport: "legacy-apns",
            relayURL: nil,
            registeredAt: now()
        )
        state.pending = nil
        try save(state)
        return true
    }

    /// Handles the carrier-delivered nonce. Verification is one-shot, so the
    /// credential is durably committed before the gateway registration call.
    @discardableResult
    public func receiveRelayChallenge(nonce: String, pairing: Pairing) async throws -> Bool {
        guard !nonce.isEmpty, nonce.count <= 4096,
              let pending = try load().pending
        else { return false }
        guard pending.identity.matches(pairing) else {
            try discardStoredChallenge(nonce)
            return false
        }

        let ownership = ChallengeOwnership(pending: pending)
        if let registration = activeRegistration {
            guard registration.key.identity == pending.identity,
                  registration.key.pairingToken == pairing.token
            else {
                try discardStoredChallenge(nonce)
                return false
            }

            _ = await registration.task.result
            finishRegistration(registration.generation)

            if completedRelayMatches(ownership) { return true }
            guard registration.generation == operationGeneration,
                  let current = try load().pending,
                  ChallengeOwnership(pending: current) == ownership
            else { return false }
        }

        return try await runChallenge(
            nonce: nonce,
            pairing: pairing,
            ownership: ownership,
            generation: operationGeneration
        )
    }

    private func runChallenge(
        nonce: String,
        pairing: Pairing,
        ownership: ChallengeOwnership,
        generation: UInt64
    ) async throws
        -> Bool {
        if let activeChallenge {
            guard activeChallenge.ownership == ownership else { return false }
            return try await activeChallenge.task.value
        }

        let task = Task {
            try await self.finishRelayChallenge(
                nonce: nonce,
                pairing: pairing,
                revalidatePlan: true,
                generation: generation
            )
        }
        activeChallenge = ActiveChallenge(
            ownership: ownership,
            pairingToken: pairing.token,
            generation: generation,
            task: task
        )
        do {
            let accepted = try await task.value
            finishChallenge(generation)
            return accepted
        } catch {
            finishChallenge(generation)
            throw error
        }
    }

    private func finishRelayChallenge(
        nonce: String,
        pairing: Pairing,
        revalidatePlan: Bool,
        generation: UInt64
    ) async throws
        -> Bool {
        guard !nonce.isEmpty, nonce.count <= 4096 else { return false }
        var state = try load()
        guard var pending = state.pending,
              pending.identity.matches(pairing)
        else { return false }

        if revalidatePlan {
            let selectedPlan: Plan
            do {
                selectedPlan = try await plan(pairing: pairing, appId: pending.identity.appId)
            } catch PushRegistrationError.serverError(let status, _) where status == 404 {
                selectedPlan = .legacy
            }
            try ensureCurrent(generation)
            guard selectedPlan.matchesRelay(url: pending.relayURL) else {
                state.pending = nil
                try save(state)
                return false
            }
        }

        if pending.verifiedCredential == nil {
            let credential = try await relayVerify(
                relayURL: pending.relayURL,
                challengeId: pending.challengeId,
                nonce: nonce
            )
            try ensureCurrent(generation)
            pending.verifiedCredential = credential
            state.pending = pending
            try save(state)
        }
        guard let credential = pending.verifiedCredential else { return false }
        try ensureCurrent(generation)
        try await storeRelayRegistration(
            pairing,
            pending.relayURL,
            credential
        )
        try ensureCurrent(generation)
        state.completed = Completed(
            identity: pending.identity,
            transport: "relay",
            relayURL: pending.relayURL,
            registeredAt: now()
        )
        state.pending = nil
        try save(state)
        return true
    }

    public func clear() throws {
        invalidateOperations()
        try store.delete(stateKey)
        try store.delete(challengeNonceKey)
    }

    private func request(url: URL, method: String) -> URLRequest {
        var value = URLRequest(url: url)
        value.httpMethod = method
        value.setValue("application/json", forHTTPHeaderField: "Accept")
        return value
    }

    private func request(url: URL, method: String, body: some Encodable) -> URLRequest {
        var value = request(url: url, method: method)
        value.setValue("application/json", forHTTPHeaderField: "Content-Type")
        value.httpBody = try? JSONEncoder().encode(body)
        return value
    }

    private func gateway<Output: Decodable>(
        _ pairing: Pairing,
        _ input: URLRequest
    ) async throws
        -> Output {
        let (data, response) = try await gatewayRequest(pairing, authorised(input, pairing.token))
        try validate(data, response)
        return try decode(Output.self, data)
    }

    private func gatewayVoid(_ pairing: Pairing, _ input: URLRequest) async throws {
        let (data, response) = try await gatewayRequest(pairing, authorised(input, pairing.token))
        try validate(data, response)
    }

    private func relay<Output: Decodable>(_ input: URLRequest) async throws -> Output {
        let (data, response) = try await relayRequest(input)
        try validate(data, response)
        return try decode(Output.self, data)
    }

    private func authorised(_ input: URLRequest, _ token: String) -> URLRequest {
        var value = input
        value.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return value
    }

    private func validate(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw PushRegistrationError.invalidResponse
        }
        guard (200 ... 299).contains(http.statusCode) else {
            throw PushRegistrationError.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
    }

    private func decode<Output: Decodable>(_ type: Output.Type, _ data: Data) throws -> Output {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw PushRegistrationError.invalidResponse }
    }

    private func load() throws -> State {
        guard let raw = try store.get(stateKey), let data = raw.data(using: .utf8) else {
            return State()
        }
        return (try? JSONDecoder().decode(State.self, from: data)) ?? State()
    }

    private func save(_ state: State) throws {
        let data = try JSONEncoder().encode(state)
        guard let raw = String(data: data, encoding: .utf8) else {
            throw PushRegistrationError.invalidResponse
        }
        try store.set(raw, forKey: stateKey)
    }

    private func isFresh(_ date: Date, interval: TimeInterval) -> Bool {
        let age = now().timeIntervalSince(date)
        return age >= 0 && age < interval
    }
}

extension PushRegistrationCoordinator {
    /// Read the gateway's push selection independently of APNs registration.
    /// A missing device token or claim credential must not hide a configuration
    /// problem from Settings.
    public func configuration(pairing: Pairing, appId: String) async throws -> PushGatewayConfiguration {
        let selectedPlan: Plan
        do {
            selectedPlan = try await plan(pairing: pairing, appId: appId)
        } catch PushRegistrationError.serverError(let status, _) where status == 404 {
            // Both an older gateway without this route and a removed device
            // can return 404. Neither proves that legacy push is configured.
            return .planUnavailable
        }
        switch selectedPlan {
        case .direct: return .direct
        case .relay: return .relay
        case .unavailable(let reasonCode, let reason):
            switch reasonCode {
            case "no-direct-credential": return .noDirectCredential
            case "relay-disabled": return .relayConsentRequired
            default: return .unavailable(reason)
            }
        case .legacy: return .legacyGateway
        }
    }

    /// Records device-scoped permission at the gateway. No carrier token is
    /// included; the caller must request a fresh plan before relay enrollment.
    public func allowRelay(pairing: Pairing, appId: String) async throws {
        try await gatewayVoid(
            pairing,
            request(
                url: pairing.url.appendingPathComponent(
                    "admin/devices/\(pairing.deviceId)/push-relay-consent"
                ),
                method: "POST",
                body: RelayConsentBody(platform: "ios", appId: appId)
            )
        )
    }
}

extension PushRegistrationCoordinator {
    private func storeLegacyRegistration(_ pairing: Pairing, _ identity: Identity) async throws {
        try await serialisedRegistrationWrite(
            pairing,
            request(
                url: pairing.url.appendingPathComponent(
                    "admin/devices/\(pairing.deviceId)/apns-token"
                ),
                method: "POST",
                body: LegacyBody(
                    deviceToken: identity.carrierToken,
                    environment: identity.environment,
                    bundleId: identity.appId
                )
            )
        )
    }

    private func storeDirectRegistration(_ pairing: Pairing, _ identity: Identity) async throws {
        try await serialisedRegistrationWrite(
            pairing,
            request(
                url: pairing.url.appendingPathComponent(
                    "admin/devices/\(pairing.deviceId)/push-registration"
                ),
                method: "POST",
                body: DirectBody(
                    transport: "direct-apns",
                    deviceToken: identity.carrierToken,
                    environment: identity.environment,
                    bundleId: identity.appId
                )
            )
        )
    }

    private func storeRelayRegistration(
        _ pairing: Pairing,
        _ relayURL: String,
        _ credential: String
    ) async throws {
        try await serialisedRegistrationWrite(
            pairing,
            request(
                url: pairing.url.appendingPathComponent(
                    "admin/devices/\(pairing.deviceId)/push-registration"
                ),
                method: "POST",
                body: RelayBody(
                    transport: "relay",
                    relayUrl: relayURL,
                    credential: credential
                )
            )
        )
    }

    /// Orders issued writes so a superseding registration is the final server mutation.
    private func serialisedRegistrationWrite(
        _ pairing: Pairing,
        _ input: URLRequest
    ) async throws {
        let predecessor = registrationWriteTail
        let operation = Task {
            _ = await predecessor?.result
            try await self.gatewayVoid(pairing, input)
        }
        registrationWriteTail = operation
        try await operation.value
    }

    private func storeRelayRegistration(
        _ pairing: Pairing,
        pending: Pending,
        credential: String
    ) async throws {
        try await storeRelayRegistration(
            pairing,
            pending.relayURL,
            credential
        )
    }

    private func plan(pairing: Pairing, appId: String) async throws -> Plan {
        guard var components = URLComponents(
            url: pairing.url.appendingPathComponent("admin/devices/\(pairing.deviceId)/push-plan"),
            resolvingAgainstBaseURL: false
        ) else { throw PushRegistrationError.invalidURL }
        components.queryItems = [
            URLQueryItem(name: "appId", value: appId),
            URLQueryItem(name: "platform", value: "ios"),
        ]
        guard let url = components.url else { throw PushRegistrationError.invalidURL }
        let response: PushPlanResponse = try await gateway(pairing, request(url: url, method: "GET"))
        switch response.transport {
        case "direct-apns": return .direct
        case "relay":
            guard let raw = response.relayUrl, let url = URL(string: raw), url.scheme == "https" else {
                throw PushRegistrationError.invalidResponse
            }
            return .relay(url)
        case "unavailable":
            return .unavailable(
                reasonCode: response.reasonCode,
                reason: response.reason ?? "push is unavailable"
            )
        default: return .legacy
        }
    }

    private func clearCompletedRelayIfPlanChanged(_ state: inout State, _ plan: Plan) throws {
        guard state.completed?.transport == "relay", !plan.isRelay else { return }
        state.completed = nil
        try save(state)
    }

    private func apply(
        _ plan: Plan,
        pairing: Pairing,
        identity: Identity,
        state: inout State,
        generation: UInt64
    ) async throws {
        switch plan {
        case .direct:
            try ensureCurrent(generation)
            try await storeDirectRegistration(pairing, identity)
            try ensureCurrent(generation)
            state.completed = Completed(
                identity: identity,
                transport: "direct-apns",
                relayURL: nil,
                registeredAt: now()
            )
            state.pending = nil
            try save(state)
        case .relay(let relayURL):
            try ensureCurrent(generation)
            let challenge = try await relayEnrol(relayURL: relayURL, identity: identity)
            try ensureCurrent(generation)
            // Preserve `completed` while rotation is pending: a failed carrier
            // challenge must not disable the credential that already works.
            state.pending = Pending(
                identity: identity,
                relayURL: relayURL.absoluteString,
                challengeId: challenge,
                verifiedCredential: nil,
                startedAt: now()
            )
            try save(state)
            // A fast carrier can deliver its background challenge before the
            // enrol response has been persisted. AppDelegate stores that nonce
            // first; consume it now that the pending identity is durable.
            if let nonce = try store.get(challengeNonceKey),
               try await finishRelayChallenge(
                   nonce: nonce,
                   pairing: pairing,
                   revalidatePlan: false,
                   generation: generation
               ) {
                try ensureCurrent(generation)
                try store.delete(challengeNonceKey)
            }
        case .unavailable(let reasonCode, let reason):
            throw PushRegistrationError.unavailable(reasonCode: reasonCode, reason: reason)
        case .legacy:
            try ensureCurrent(generation)
            try await storeLegacyRegistration(pairing, identity)
            try ensureCurrent(generation)
            state.completed = Completed(
                identity: identity,
                transport: "legacy-apns",
                relayURL: nil,
                registeredAt: now()
            )
            state.pending = nil
            try save(state)
        }
    }
}

extension PushRegistrationCoordinator {
    private func relayEnrol(relayURL: URL, identity: Identity) async throws -> String {
        let response: RelayChallenge = try await relay(
            request(
                url: relayURL.appendingPathComponent("v1/enrol"),
                method: "POST",
                body: EnrolBody(
                    platform: "ios",
                    token: identity.carrierToken,
                    bundleId: identity.appId,
                    environment: identity.environment
                )
            )
        )
        guard !response.challengeId.isEmpty else { throw PushRegistrationError.invalidResponse }
        return response.challengeId
    }

    private func relayVerify(
        relayURL: String,
        challengeId: String,
        nonce: String
    ) async throws
        -> String {
        guard let baseURL = URL(string: relayURL), baseURL.scheme == "https" else {
            throw PushRegistrationError.invalidURL
        }
        let response: RelayCredential = try await relay(
            request(
                url: baseURL.appendingPathComponent("v1/enrol/verify"),
                method: "POST",
                body: VerifyBody(challengeId: challengeId, nonce: nonce)
            )
        )
        guard !response.credential.isEmpty else { throw PushRegistrationError.invalidResponse }
        return response.credential
    }

    private func registrationIsCurrent(
        _ completed: Completed,
        identity: Identity,
        plan: Plan
    )
        -> Bool {
        guard completed.identity == identity, completed.matches(plan) else { return false }
        return completed.transport != "relay" ||
            isFresh(completed.registeredAt, interval: Self.relayRotationInterval)
    }

    private func beginOperation() -> UInt64 {
        invalidateOperations()
        return operationGeneration
    }

    private func invalidateOperations() {
        operationGeneration &+= 1
        activeRegistration?.task.cancel()
        activeRegistration = nil
        activeChallenge?.task.cancel()
        activeChallenge = nil
    }

    private func ensureCurrent(_ generation: UInt64) throws {
        guard generation == operationGeneration, !Task.isCancelled else {
            throw CancellationError()
        }
    }

    private func finishRegistration(_ generation: UInt64) {
        guard activeRegistration?.generation == generation else { return }
        activeRegistration = nil
    }

    private func awaitMatchingChallenge(
        identity: Identity,
        pairingToken: String
    ) async throws
        -> Bool? {
        guard let challenge = activeChallenge,
              challenge.ownership.identity == identity,
              challenge.pairingToken == pairingToken
        else { return nil }
        let result = await challenge.task.result
        finishChallenge(challenge.generation)
        try ensureCurrent(challenge.generation)
        guard case .success(true) = result else { return false }
        return true
    }

    private func finishChallenge(_ generation: UInt64) {
        guard activeChallenge?.generation == generation else { return }
        activeChallenge = nil
    }

    private func completedRelayMatches(_ ownership: ChallengeOwnership) -> Bool {
        guard let completed = try? load().completed else { return false }
        return completed.identity == ownership.identity &&
            completed.transport == "relay" &&
            completed.relayURL == ownership.relayURL
    }

    private func discardStoredChallenge(_ nonce: String) throws {
        guard try store.get(challengeNonceKey) == nonce else { return }
        try store.delete(challengeNonceKey)
    }
}
