// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct AccountGatewayChoice: Codable, Sendable, Equatable, Identifiable {
    public let gatewayId: String
    public let publicOrigin: String
    public let displayName: String?
    public var id: String {
        gatewayId
    }
}

public enum AccountPairingError: Error, Equatable {
    case noGateways, response, expired, cancelled
    /// The sign-in was verified and the relay has no Omnesis account for it.
    case noAccount
    /// The gateway has no enrollment challenge route, so it predates sign-in enrollment.
    case gatewayNeedsUpdate
    /// The gateway refused this request's device key or sign-in. Nothing is saved.
    case notYourGateway
    /// The gateway could not be reached; `retryEnrollment` may try again until the sign-in expires.
    case gatewayUnavailable
    /// Passkey sign-in ended without a passkey. The system reports a device that holds none
    /// and a dismissed prompt the same way, so this covers both.
    case noPasskey
}

extension AccountPairingError {
    /// An explanation that leaves the sign-in choices open, where nothing went wrong.
    var signInNotice: String? {
        guard self == .noPasskey else { return nil }
        return "No passkey was used. If this iPhone has no passkey for your Omnesis account, sign in with Google, "
            + "or add a passkey to your Omnesis account first."
    }
}

/// Why a sign-in ended, in words for the person pairing.
func accountPairingErrorMessage(_ error: Error) -> String {
    switch error as? AccountPairingError {
    case .noAccount:
        return "There is no Omnesis account for this sign-in yet. Create one from your gateway: open its portal, go to Settings, "
            + "then Account, and choose \"Create an Omnesis account\". You can also pair directly with a QR code."
    case .noGateways:
        return "This Omnesis account has no gateway yet. Connect your gateway to it first, or pair directly with a QR code."
    case .expired:
        return "Your sign-in expired. Sign in again to connect this device."
    case .gatewayNeedsUpdate:
        return "Your gateway needs an update before this device can sign in. Update Omnesis on your gateway, then try again."
    case .notYourGateway:
        return "This doesn't look like your gateway. Nothing was saved. Try again, or pair directly with a QR code."
    default:
        break
    }
    return "Couldn't connect with your Omnesis account. Check your internet connection and try again, "
        + "or pair directly with a QR code."
}

/// A sign-in commits to this device key and request. The gateway decides from its own checks whether
/// that joins the device or holds it for approval and code comparison.
public actor AccountCloudPairingClient {
    public struct PasskeyOptions: Sendable {
        public let ceremonyId: String
        public let options: Data
    }

    private enum Stage { case new, starting, authenticating, verifying, choosing, selecting, pairing, closed }
    private struct Operation: Decodable { let operationId: String
        let ticket: String
        let googleNonce: String
        let salt: String
        let expiresAt: Double
    }

    private struct Discovery: Decodable { let discoveryToken: String
        let accountId: String
        let expiresAt: Double
        let credentialPublicKey: String?
    }

    private struct Directory: Decodable { let gateways: [AccountGatewayChoice]
        let nextCursor: String?
    }

    private struct Selection: Decodable { let binding: GoogleGatewayBinding
        let accountId: String
        let identityToken: String
        let expiresAt: Double
    }

    private struct SentRequest {
        let challenge: String
        let requireApproval: Bool
        let body: Data
    }

    /// The retained sign-in, sent only to the gateway the device has pinned.
    private struct SignInProof: Encodable {
        let type: String
        var idToken: String?
        let salt: String
        var issuedAt: String?
        var credentialPublicKey: String?
        var credential: JSONValue?
    }

    private let origin: URL
    private let clientId: String
    private let direct: any CloudPairingTransport
    private let gatewayFactory: any CloudPairingLeafTransportFactory
    private let loadDeviceKey: @Sendable () throws -> any DeviceEnrollmentSigning
    private let checksPublicCertificate: Bool
    private let now: @Sendable () -> TimeInterval
    private let verifier: String
    private var stage = Stage.new
    private var challenge: CloudPairingChallenge?
    private var deviceKey: (any DeviceEnrollmentSigning)?
    private var nonce: String?
    private var operation: Operation?
    private var passkeyBinding: (salt: String, issuedAt: String)?
    private var proof: SignInProof?
    private var discovery: Discovery?
    private var choices: [AccountGatewayChoice] = []
    private var choice: AccountGatewayChoice?
    private var selection: Selection?
    private var gateway: (any CloudPairingTransport)?
    private var pending: CloudPairingConfirmation?
    /// The one request this sign-in sends: its challenge and its exact bytes. Once it may have
    /// reached a gateway the secret is no longer private, so a retry repeats these bytes and
    /// never answers a fresh challenge, whose nonce could have been picked knowing the secret.
    private var sent: SentRequest?

    public init(
        relayOrigin: URL,
        clientId: String,
        direct: any CloudPairingTransport = CloudPairingHTTP(),
        gatewayFactory: any CloudPairingLeafTransportFactory = CloudPairingHTTPFactory(),
        deviceKey: @escaping @Sendable () throws -> any DeviceEnrollmentSigning = { try DeviceEnrollmentKey.loadOrCreate() },
        checksPublicCertificate: Bool = true,
        now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) throws {
        origin = try Self.exactOrigin(relayOrigin.absoluteString)
        self.clientId = clientId
        self.direct = direct
        self.gatewayFactory = gatewayFactory
        loadDeviceKey = deviceKey
        self.checksPublicCertificate = checksPublicCertificate
        self.now = now
        let bytes = try cloudSecureRandomBytes()
        let base64 = bytes.base64EncodedString()
        let urlSafe = base64.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        verifier = urlSafe.replacingOccurrences(of: "=", with: "")
    }

    public func begin(challenge: CloudPairingChallenge) async throws -> String {
        try transition(.new, .starting)
        let key = try loadDeviceKey()
        let nonce = try DeviceEnrollmentContract.enrollmentNonce(
            requestId: challenge.requestId,
            kind: challenge.kind,
            name: challenge.name,
            secret: challenge.secret,
            devicePublicKey: key.publicKey
        )
        struct Start: Encodable { let kind: String
            let nonce: String
            let challenge: String
        }
        let value: Operation = try await request(
            "/_relay/v3/native/start",
            body: JSONEncoder().encode(Start(kind: "ios", nonce: nonce, challenge: cloudDigestURL(Data(verifier.utf8))))
        )
        guard Self.uuid(value.operationId), Self.opaque(value.ticket), Self.opaque(value.salt), value.expiresAt > now() * 1000,
              value.expiresAt <= now() * 1000 + 310_000,
              try value.googleNonce == DeviceEnrollmentContract.googleProofNonce(salt: value.salt, nonce: nonce)
        else { throw AccountPairingError.response }
        operation = value
        self.challenge = challenge
        deviceKey = key
        self.nonce = nonce
        stage = .authenticating
        return value.googleNonce
    }

    public func google(idToken: String) async throws -> [AccountGatewayChoice] {
        try transition(.authenticating, .verifying)
        let op = try currentOperation()
        guard clientId.hasSuffix(".apps.googleusercontent.com"), !idToken.isEmpty,
              idToken.utf8.count <= 16384 else { throw AccountPairingError.response }
        let keys = try await direct.requestData(
            url: URL(string: "https://www.googleapis.com/oauth2/v3/certs")!,
            method: "GET",
            body: nil,
            bearer: nil,
            form: false
        )
        try checkOpen()
        _ = try GoogleIdentityVerifier(jwks: keys, clientIds: [clientId]).verify(idToken, nonce: op.googleNonce, now: now())
        struct Google: Encodable { let operationId: String
            let ticket: String
            let verifier: String
            let idToken: String
        }
        let session: Discovery = try await signIn(
            "/_relay/v3/native/google",
            body: JSONEncoder().encode(Google(operationId: op.operationId, ticket: op.ticket, verifier: verifier, idToken: idToken))
        )
        proof = SignInProof(type: "google", idToken: idToken, salt: op.salt)
        return try await authenticated(session)
    }

    public func passkeyOptions() async throws -> PasskeyOptions {
        try checkOpen()
        guard stage == .authenticating, let nonce else { throw AccountPairingError.response }
        let op = try currentOperation()
        struct Input: Encodable { let operationId: String
            let ticket: String
        }
        struct Output: Decodable { let ceremonyId: String
            let options: JSONValue
            let salt: String
            let issuedAt: String
        }
        struct Options: Decodable { let rpId: String
            let challenge: String
            let userVerification: String
        }
        let value: Output = try await request(
            "/_relay/v3/native/passkeys/options",
            body: JSONEncoder().encode(Input(operationId: op.operationId, ticket: op.ticket))
        )
        let data = try JSONEncoder().encode(value.options), options = try JSONDecoder().decode(Options.self, from: data)
        guard Self.opaque(value.ceremonyId), options.rpId == origin.host, Self.opaque(options.challenge),
              options.userVerification == "required", Self.opaque(value.salt),
              value.issuedAt.range(of: "^[1-9][0-9]{9,10}$", options: .regularExpression) != nil,
              Self.fresh(value.issuedAt, now: now()),
              try options.challenge == DeviceEnrollmentContract.passkeyProofChallenge(
                  salt: value.salt,
                  issuedAt: value.issuedAt,
                  nonce: nonce
              ) else { throw AccountPairingError.response }
        passkeyBinding = (value.salt, value.issuedAt)
        return PasskeyOptions(ceremonyId: value.ceremonyId, options: data)
    }

    public func passkey(options: PasskeyOptions, assertion: Data) async throws -> [AccountGatewayChoice] {
        try transition(.authenticating, .verifying)
        guard assertion.count <= 65536, Self.opaque(options.ceremonyId), let passkeyBinding else { throw AccountPairingError.response }
        let op = try currentOperation()
        struct Input: Encodable { let operationId: String
            let ticket: String
            let verifier: String
            let ceremonyId: String
            let credential: JSONValue
        }
        let credential = try JSONDecoder().decode(JSONValue.self, from: assertion)
        let session: Discovery = try await signIn(
            "/_relay/v3/native/passkeys/complete",
            body: JSONEncoder().encode(Input(
                operationId: op.operationId,
                ticket: op.ticket,
                verifier: verifier,
                ceremonyId: options.ceremonyId,
                credential: credential
            ))
        )
        proof = SignInProof(
            type: "passkey",
            salt: passkeyBinding.salt,
            issuedAt: passkeyBinding.issuedAt,
            credentialPublicKey: session.credentialPublicKey.flatMap { Self.encodedField($0) ? $0 : nil },
            credential: credential
        )
        return try await authenticated(session)
    }

    private func authenticated(_ session: Discovery) async throws -> [AccountGatewayChoice] {
        try checkOpen()
        guard session.accountId.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, !session.discoveryToken.isEmpty,
              session.discoveryToken.utf8.count <= 4096, session.expiresAt > now(),
              try session.expiresAt <= currentOperation().expiresAt / 1000 else { throw AccountPairingError.response }
        discovery = session
        var all: [AccountGatewayChoice] = [], cursor: String?
        repeat {
            let page: Directory = try await request(
                "/_relay/v3/gateways" + (cursor.map { "?after=\($0)" } ?? ""),
                bearer: session.discoveryToken
            )
            guard page.gateways.count <= 50 else { throw AccountPairingError.response }
            for choice in page.gateways {
                guard Self.uuid(choice.gatewayId), try Self.exactOrigin(choice.publicOrigin).absoluteString == choice.publicOrigin,
                      !all.contains(where: { $0.gatewayId == choice.gatewayId }), all.count < 1000,
                      choice.displayName
                      .map({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 80 }) ?? true
                else { throw AccountPairingError.response }
                all.append(choice)
            }
            if let next = page.nextCursor {
                guard Self.uuid(next), next != cursor, page.gateways.last?.gatewayId == next else { throw AccountPairingError.response }
            }
            cursor = page.nextCursor
        } while cursor != nil
        guard !all.isEmpty else {
            throw AccountPairingError.noGateways
        }
        choices = all
        stage = .choosing
        return choices
    }

    public func select(gatewayId: String) async throws -> CloudPairingConfirmation {
        try transition(.choosing, .selecting)
        guard let selected = choices.first(where: { $0.gatewayId == gatewayId }) else { throw AccountPairingError.response }
        choice = selected
        return try await enroll()
    }

    /// Another attempt after `gatewayUnavailable`, until the sign-in expires. A request that was
    /// already sent is repeated byte for byte; only one that never left gets a new challenge.
    public func retryEnrollment() async throws -> CloudPairingConfirmation {
        try checkOpen()
        guard stage == .selecting, choice != nil else { throw AccountPairingError.response }
        return try await enroll()
    }

    public func poll() async throws -> CloudPairingProgress {
        try checkOpen()
        guard var value = pending, let gateway else { throw AccountPairingError.response }
        struct Input: Encodable { let requestId: String
            let secret: String
        }
        let data = try await gateway.requestData(
            url: value.origin.appendingPathComponent("devices/account/poll"),
            method: "POST",
            body: JSONEncoder().encode(Input(requestId: value.challenge.requestId, secret: value.challenge.secret)),
            bearer: nil,
            form: false
        )
        try checkOpen()
        guard data.count <= 65536 else { throw AccountPairingError.response }
        let progress = try JSONDecoder().decode(CloudPairingProgress.self, from: data)
        try value.receive(progress, now: now())
        pending = value
        return progress
    }

    public func close() {
        stage = .closed
        operation = nil
        discovery = nil
        challenge = nil
        deviceKey = nil
        nonce = nil
        passkeyBinding = nil
        proof = nil
        choices = []
        choice = nil
        selection = nil
        pending = nil
        sent = nil
        gateway?.close()
        gateway = nil
        direct.close()
    }

    private func currentOperation() throws -> Operation {
        try checkOpen()
        guard let operation else { throw AccountPairingError.response }
        guard operation.expiresAt > now() * 1000 else { throw AccountPairingError.expired }
        return operation
    }

    private func transition(_ from: Stage, _ to: Stage) throws {
        try checkOpen()
        guard stage == from else { throw AccountPairingError.response }
        stage = to
    }

    private func checkOpen() throws {
        if stage == .closed { throw AccountPairingError.cancelled }
    }

    private func request<T: Decodable>(_ path: String, body: Data? = nil, bearer: String? = nil) async throws -> T {
        try checkOpen()
        let data = try await direct.requestData(
            url: URL(string: path, relativeTo: origin)!.absoluteURL,
            method: body == nil ? "GET" : "POST",
            body: body,
            bearer: bearer,
            form: false
        )
        try checkOpen()
        guard data.count <= 65536 else { throw AccountPairingError.response }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The request that completes a sign-in. The relay names one refusal, `no-account`; any other 403 stays a status.
    private func signIn<T: Decodable>(_ path: String, body: Data) async throws -> T {
        try checkOpen()
        let data: Data
        do {
            data = try await direct.postReportingRefusal(url: URL(string: path, relativeTo: origin)!.absoluteURL, body: body)
        } catch let refusal as CloudPairingRefusal {
            try checkOpen()
            throw refusal.reason == "no-account" ? AccountPairingError.noAccount : CloudPairingError.httpStatus(403)
        }
        try checkOpen()
        guard data.count <= 65536 else { throw AccountPairingError.response }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The relay picks the time the passkey signs over. One far from this device's clock would let a
    /// signature made now pass as fresh later, so it must be within a minute either way.
    private static func fresh(_ issuedAt: String, now: TimeInterval) -> Bool {
        guard let seconds = TimeInterval(issuedAt) else { return false }
        return abs(seconds - now) <= passkeyClockSkew
    }

    static let passkeyClockSkew: TimeInterval = 60

    private static func opaque(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    private static func encodedField(_ value: String) -> Bool {
        value.utf8.count <= 65536 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }

    private static func uuid(_ value: String) -> Bool {
        UUID(uuidString: value)?.uuidString.lowercased() == value
    }

    private static func exactOrigin(_ value: String) throws -> URL {
        guard let parts = URLComponents(string: value), parts.scheme == "https", parts.host != nil, parts.user == nil,
              parts.password == nil,
              parts.query == nil, parts.fragment == nil, [
                  "",
                  "/"
              ].contains(parts.path), parts.port != 0, let url = parts.url else { throw AccountPairingError.response }
        return url
    }
}

// MARK: - Enrolling at the chosen gateway

extension AccountCloudPairingClient {
    private func enroll() async throws -> CloudPairingConfirmation {
        guard let session = discovery else { throw AccountPairingError.response }
        guard (selection?.expiresAt ?? session.expiresAt) > now() else { throw AccountPairingError.expired }
        do {
            let selected = try await currentSelection(session)
            return try await enroll(selected)
        } catch {
            throw Self.unavailable(error)
        }
    }

    private func currentSelection(_ session: Discovery) async throws -> Selection {
        if let selection { return selection }
        guard let choice else { throw AccountPairingError.response }
        let selected: Selection = try await request("/_relay/v3/gateway?gatewayId=\(choice.gatewayId)", bearer: session.discoveryToken)
        guard selected.accountId == session.accountId, selected.binding.gatewayId == choice.gatewayId,
              selected.binding.publicOrigin == choice.publicOrigin, !selected.identityToken.isEmpty,
              selected.identityToken.utf8.count <= 16384, selected.expiresAt > now(),
              selected.expiresAt <= session.expiresAt else { throw AccountPairingError.response }
        selection = selected
        return selected
    }

    private func enroll(_ selected: Selection) async throws -> CloudPairingConfirmation {
        guard let challenge else { throw AccountPairingError.response }
        var value = try CloudPairingConfirmation(challenge: challenge, candidate: selected.binding, now: now())
        let pinned = gateway ?? gatewayFactory.pinnedLeaf(value.fingerprint)
        gateway = pinned
        do {
            let outgoing: SentRequest = if let sent { sent } else {
                try await prepare(selected, value, pinned)
            }
            // The challenge is the gateway's commitment to its nonce, fixed before the secret leaves.
            try value.commit(to: outgoing.challenge)
            sent = outgoing
            let data = try await pinned.requestData(
                url: value.origin.appendingPathComponent("devices/account/request"),
                method: "POST",
                body: outgoing.body,
                bearer: nil,
                form: false
            )
            try checkOpen()
            guard data.count <= 65536 else { throw AccountPairingError.response }
            let progress = try JSONDecoder().decode(CloudPairingProgress.self, from: data)
            try value.receive(progress, now: now())
            if !outgoing.requireApproval { value.acceptAutomaticJoin() }
            pending = value
            stage = .pairing
            return value
        } catch CloudPairingError.httpStatus(403) {
            throw AccountPairingError.notYourGateway
        }
    }

    /// Fetches a challenge and builds the request that answers it. Nothing secret is sent here.
    private func prepare(
        _ selected: Selection,
        _ value: CloudPairingConfirmation,
        _ pinned: any CloudPairingTransport
    ) async throws
        -> SentRequest {
        guard let deviceKey, let proof else { throw AccountPairingError.response }
        let challenge = value.challenge
        let issued = try await gatewayChallenge(pinned, origin: value.origin)
        try checkOpen()
        let transcript = try DeviceEnrollmentContract.enrollmentSignatureTranscript(
            requestId: challenge.requestId,
            kind: challenge.kind,
            name: challenge.name,
            gatewaySpkiFingerprint: value.spkiFingerprint,
            challenge: issued,
            devicePublicKey: deviceKey.publicKey
        )
        let requireApproval = needsApproval(pinned, origin: value.origin)
        struct DeviceKey: Encodable { let publicKey: String
            let challenge: String
            let signature: String
        }
        struct Input: Encodable { let requestId: String
            let kind: String
            let name: String
            let secret: String
            let identityToken: String
            let deviceKey: DeviceKey
            let proof: SignInProof
            let requireApproval: Bool
        }
        let body = try JSONEncoder().encode(Input(
            requestId: challenge.requestId,
            kind: challenge.kind,
            name: challenge.name,
            secret: challenge.secret,
            identityToken: selected.identityToken,
            deviceKey: DeviceKey(publicKey: deviceKey.publicKey, challenge: issued, signature: deviceKey.sign(transcript)),
            proof: proof,
            requireApproval: requireApproval
        ))
        return SentRequest(challenge: issued, requireApproval: requireApproval, body: body)
    }

    private func gatewayChallenge(_ pinned: any CloudPairingTransport, origin: URL) async throws -> String {
        struct Issued: Decodable { let challenge: String }
        do {
            let data = try await pinned.requestData(
                url: origin.appendingPathComponent("devices/account/challenge"),
                method: "POST",
                body: Data("{}".utf8),
                bearer: nil,
                form: false
            )
            guard data.count <= 65536 else { throw AccountPairingError.response }
            let issued = try JSONDecoder().decode(Issued.self, from: data).challenge
            guard Self.opaque(issued) else { throw AccountPairingError.response }
            return issued
        } catch CloudPairingError.httpStatus(404) {
            throw AccountPairingError.gatewayNeedsUpdate
        }
    }

    /// Unverifiable first contact falls back to the human comparison; it never stops pairing.
    private func needsApproval(_ pinned: any CloudPairingTransport, origin: URL) -> Bool {
        guard checksPublicCertificate else { return false }
        guard let host = origin.host, let reporter = pinned as? any CloudPairingPublicCertificateReporting else { return true }
        return !reporter.publicCertificateVerified(host: host)
    }

    private static func unavailable(_ error: Error) -> Error {
        if let failure = error as? CloudPairingError, case .httpStatus(let status) = failure, [502, 503, 504].contains(status) {
            return AccountPairingError.gatewayUnavailable
        }
        if let failure = error as? URLError, unreachable.contains(failure.code) {
            return AccountPairingError.gatewayUnavailable
        }
        return error
    }

    /// `secureConnectionFailed` is included because a relay with no tunnel for a gateway drops the handshake.
    /// A refused pin is `cancelled`, which stays a failure.
    private static let unreachable: Set<URLError.Code> = [
        .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost,
        .cannotFindHost, .dnsLookupFailed, .secureConnectionFailed,
    ]
}

// MARK: - Approving a held request on the gateway's own page

extension AccountCloudPairingClient {
    /// The page on which the owner approves this held request with their passkey, when the gateway
    /// offers one. A sign-in made in this app presents the relay's own origin, so the gateway holds
    /// it; only an assertion made on the gateway's own page can approve it.
    ///
    /// The gateway says where that page is, over the connection pinned to its key. The page is used
    /// only when it is that same gateway's origin, under the relay's passkey domain and never the
    /// relay's own host; anything else leaves approval to a trusted device, as before. The poll
    /// still decides when the device is approved.
    public func approvalPage() async throws -> URL? {
        try checkOpen()
        guard stage == .pairing, let value = pending, !value.approved, !value.joinedAutomatically,
              let gateway else { return nil }
        struct Config: Decodable {
            struct Passkey: Decodable { let rpId: String
                let origin: String
            }

            let gatewayPasskey: Passkey?
        }
        let data = try await gateway.requestData(
            url: value.origin.appendingPathComponent("devices/account/config"),
            method: "GET",
            body: nil,
            bearer: nil,
            form: false
        )
        try checkOpen()
        guard data.count <= 65536 else { throw AccountPairingError.response }
        guard let advertised = try JSONDecoder().decode(Config.self, from: data).gatewayPasskey else { return nil }
        return Self.approvalPage(
            origin: advertised.origin,
            rpId: advertised.rpId,
            gateway: value.origin,
            relay: origin,
            requestId: value.challenge.requestId
        )
    }

    /// `${origin}/portal/approve#<requestId>`, when `origin` is the pinned gateway's own and a name
    /// under the relay's host, which is the RP ID the owner's passkey belongs to.
    static func approvalPage(origin advertised: String, rpId: String, gateway: URL, relay: URL, requestId: String) -> URL? {
        guard let page = try? exactOrigin(advertised), let host = page.host?.lowercased(),
              let relayHost = relay.host?.lowercased(), rpId.lowercased() == relayHost,
              host.hasSuffix("." + relayHost), host == gateway.host?.lowercased(),
              (page.port ?? 443) == (gateway.port ?? 443), gateway.scheme == "https", uuid(requestId)
        else { return nil }
        var parts = URLComponents()
        parts.scheme = "https"
        parts.host = host
        parts.port = page.port
        parts.path = "/portal/approve"
        parts.fragment = requestId
        return parts.url
    }
}
