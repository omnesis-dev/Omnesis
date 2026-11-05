// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Discovery transports hold no gateway access credential. Only the explicit confirmation gate can mint a pairing payload.
public actor GoogleCloudPairingClient {
    private let relayOrigin: URL
    private let clientId: String
    private let direct: any CloudPairingTransport
    private let gatewayFactory: any CloudPairingLeafTransportFactory
    private let now: @Sendable () -> TimeInterval
    private var gateway: (any CloudPairingTransport)?
    private var pending: CloudPairingConfirmation?
    private var started = false
    private var closed = false

    public init(
        relayOrigin: URL,
        clientId: String,
        direct: any CloudPairingTransport = CloudPairingHTTP(),
        gatewayFactory: any CloudPairingLeafTransportFactory = CloudPairingHTTPFactory(),
        now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) throws {
        guard let parts = URLComponents(url: relayOrigin, resolvingAgainstBaseURL: false), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil, ["", "/"].contains(parts.path),
              clientId.hasSuffix(".apps.googleusercontent.com") else { throw CloudPairingError.configuration }
        self.relayOrigin = relayOrigin
        self.clientId = clientId
        self.direct = direct
        self.gatewayFactory = gatewayFactory
        self.now = now
    }

    public init(
        relayOrigin: URL,
        clientId: String,
        direct: any CloudPairingTransport = CloudPairingHTTP(),
        createGateway: @escaping @Sendable (String) -> any CloudPairingTransport,
        now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) throws {
        try self.init(
            relayOrigin: relayOrigin,
            clientId: clientId,
            direct: direct,
            gatewayFactory: ClosureLeafTransportFactory(make: createGateway),
            now: now
        )
    }

    public func start(challenge: CloudPairingChallenge, idToken: String) async throws -> CloudPairingConfirmation {
        guard !closed, !started else { throw CloudPairingError.cancelled }
        started = true
        let keys = try await direct.requestData(
            url: URL(string: "https://www.googleapis.com/oauth2/v3/certs")!,
            method: "GET",
            body: nil,
            bearer: nil,
            form: false
        )
        let owner = try GoogleIdentityVerifier(jwks: keys, clientIds: [clientId]).verify(idToken, nonce: challenge.nonce, now: now())
        try checkOpen()
        struct Login: Encodable { let idToken: String }
        struct Session: Decodable { let token: String
            let accountId: String
        }
        let session: Session = try await decode(
            direct,
            url: relayOrigin.appendingPathComponent("_relay/v1/login"),
            method: "POST",
            body: JSONEncoder().encode(Login(idToken: idToken))
        )
        guard session.accountId == owner.accountId, !session.token.isEmpty,
              session.token.utf8.count <= 4096 else { throw CloudPairingError.response }
        try checkOpen()
        let binding: GoogleGatewayBinding = try await decode(
            direct,
            url: relayOrigin.appendingPathComponent("_relay/v2/gateway"),
            bearer: session.token
        )
        try checkOpen()
        var value = try CloudPairingConfirmation(challenge: challenge, candidate: binding, now: now())
        let pinned = gatewayFactory.pinnedLeaf(value.fingerprint)
        gateway = pinned
        struct Request: Encodable {
            let requestId: String
            let kind: String
            let name: String
            let secret: String
            let identityToken: String
        }
        let request = Request(
            requestId: challenge.requestId,
            kind: challenge.kind,
            name: challenge.name,
            secret: challenge.secret,
            identityToken: idToken
        )
        let progress: CloudPairingProgress = try await decode(
            pinned,
            url: value.origin.appendingPathComponent("devices/google/request"),
            method: "POST",
            body: JSONEncoder().encode(request)
        )
        try checkOpen()
        try value.receive(progress, now: now())
        pending = value
        return value
    }

    public func poll() async throws -> CloudPairingProgress {
        try checkOpen()
        guard var value = pending, let gateway else { throw CloudPairingError.response }
        struct Poll: Encodable { let requestId: String
            let secret: String
        }
        let progress: CloudPairingProgress = try await decode(
            gateway,
            url: value.origin.appendingPathComponent("devices/google/poll"),
            method: "POST",
            body: JSONEncoder().encode(Poll(
                requestId: value.challenge.requestId,
                secret: value.challenge.secret
            ))
        )
        try checkOpen()
        try value.receive(progress, now: now())
        pending = value
        return progress
    }

    public func close() {
        closed = true
        pending = nil
        gateway?.close()
        gateway = nil
        direct.close()
    }

    private func checkOpen() throws {
        if closed { throw CloudPairingError.cancelled }
    }

    private func decode<T: Decodable>(
        _ transport: any CloudPairingTransport,
        url: URL,
        method: String = "GET",
        body: Data? = nil,
        bearer: String? = nil
    ) async throws
        -> T {
        try await JSONDecoder().decode(
            T.self,
            from: transport.requestData(url: url, method: method, body: body, bearer: bearer, form: false)
        )
    }
}

private struct ClosureLeafTransportFactory: CloudPairingLeafTransportFactory {
    let make: @Sendable (String) -> any CloudPairingTransport
    func pinnedLeaf(_ fingerprint: String) -> any CloudPairingTransport {
        make(fingerprint)
    }
}
