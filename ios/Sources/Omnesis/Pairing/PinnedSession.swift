// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation

public protocol GatewayRoutingProxyCreating: Sendable {
    func create(route: GatewayDirectRoute, verifyTrust: @escaping GatewayDirectProbe.TrustVerifier) throws -> GatewayRoutingProxy
}

public struct GatewayRoutingProxyFactory: GatewayRoutingProxyCreating {
    public init() {}
    public func create(route: GatewayDirectRoute, verifyTrust: @escaping GatewayDirectProbe.TrustVerifier) throws -> GatewayRoutingProxy {
        try GatewayRoutingProxy(route: route, verifyTrust: verifyTrust)
    }
}

public protocol GatewaySocketRouting: Sendable {
    var session: URLSession { get }
    var connectionPath: GatewayConnectionPath? { get }
    func observeRoutePath(_ callback: @escaping @Sendable (GatewayConnectionPath) -> Void) -> UUID?
    func removeRoutePathObserver(_ id: UUID)
    func directPathAvailable() async -> Bool
    func updateCandidates(_ candidates: [GatewayDirectCandidate]) throws
    func retireRouting()
    /// Proves the session's local route still accepts connections, repairing it in place if not.
    func verifyRouting() async -> Bool
}

/// `URLSession` that pins the gateway's TLS leaf certificate by SHA-256
/// fingerprint. Built once per `Pairing` so re-pair refreshes the pin.
///
/// The fingerprint is `<lowercase-hex-64-chars>` matching the gateway's
/// certificate (see `packages/gateway/src/tls.ts`). When the
/// `URLSessionDelegate` server-trust challenge fires, the leaf's DER bytes
/// are hashed and compared to the pinned fingerprint. A match is accepted
/// without system evaluation, because a self-signed gateway certificate
/// chains to no public root.
///
/// A gateway whose certificate is publicly trusted renews it, and the renewed
/// leaf no longer matches the pin. When the paired host is a DNS name
/// (``GatewayTrustPolicy``) and the challenge is for that host, the served
/// chain is therefore also evaluated under the system roots for that exact
/// name. A chain that verifies is accepted even after the leaf changed, and
/// `onSystemTrustVerified` tells the app it can persist system trust in place
/// of the pin. The callback names the host and pin it verified, so the app can
/// refuse an upgrade for a pairing that has since changed, and fires at most
/// once per instance.
public final class PinnedSession: NSObject, URLSessionDelegate, GatewaySocketRouting, @unchecked Sendable {
    /// What a server-trust challenge resolves to.
    public enum Verdict: Equatable, Sendable {
        /// The leaf matches the pin. `systemTrusted` is true when the
        /// challenge is for the paired host and the chain also verifies under
        /// the system roots for it.
        case pinned(systemTrusted: Bool)
        /// The leaf does not match the pin, but the challenge is for the
        /// paired host and the chain verifies under the system roots for it.
        case systemOnly
        case rejected
    }

    /// Decides whether a served chain verifies under the system roots for a
    /// host. Injected so tests can anchor a private root and fix the clock.
    public typealias SystemTrustEvaluator = @Sendable (SecTrust, String) -> Bool

    /// Told the paired host and the pin (lowercase hex) of a session whose
    /// served chain verified under the system roots for that host.
    public typealias SystemTrustVerified = @Sendable (_ host: String, _ fingerprintHex: String) -> Void

    /// The production evaluator: the system root store at the current time.
    public static let systemRoots: SystemTrustEvaluator = { trust, host in
        evaluateSystemTrust(trust, host: host)
    }

    /// Lowercased hex form of the expected SHA-256 leaf-cert digest.
    private let fingerprintHex: String
    private let spkiFingerprint: String?
    /// Legacy leaf pins may use this host for public trust fallback; stable key pins only bind the canonical host and never fall back.
    private let host: String?
    private let onSystemTrustVerified: SystemTrustVerified?
    private let systemTrust: SystemTrustEvaluator
    private let requireCertificateValidity: Bool
    private let verificationDate: Date?
    private let directRoute: GatewayDirectRoute?
    private var currentDirectRoute: GatewayDirectRoute?
    private let proxyFactory: any GatewayRoutingProxyCreating
    private let sessionLock = NSLock()
    private weak var cachedSession: URLSession?
    private var routingProxy: GatewayRoutingProxy?
    private var routeRetired = false
    private var routeFailed = false
    private let notifyLock = NSLock()
    private var notified = false

    /// The session retains its delegate; this weak cache avoids adding the reverse ownership edge.
    public var session: URLSession {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        if let cachedSession { return cachedSession }
        let configuration = URLSessionConfiguration.ephemeral
        if let currentDirectRoute, !routeRetired, !routeFailed {
            do {
                // The proxy checks a home-network address before it forwards to it: the direct path.
                let proxy = try proxyFactory.create(route: currentDirectRoute) { [weak self] trust, host in
                    self?.verdictForPeer(trust, challengeHost: host, expiredAccepted: true) == .pinned(systemTrusted: false)
                }
                proxy.configure(configuration)
                routingProxy = proxy
            } catch { routeFailed = true }
        }
        if routeRetired || routeFailed {
            GatewayUnavailableProxy.shared?.configure(configuration)
            configuration.protocolClasses = [GatewayRejectedURLProtocol.self]
        } else if directRoute != nil || spkiFingerprint != nil || requireCertificateValidity {
            configuration.protocolClasses = [GatewayHTTPSOnlyURLProtocol.self]
        }
        let created = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        cachedSession = created
        return created
    }

    public var connectionPath: GatewayConnectionPath? {
        sessionLock.lock()
        let proxy = routingProxy
        let unavailable = routeRetired || routeFailed
        sessionLock.unlock()
        guard directRoute != nil else { return nil }
        return unavailable ? .reconnecting : (proxy?.connectionPath ?? .reconnecting)
    }

    @discardableResult
    public func observeRoutePath(_ callback: @escaping @Sendable (GatewayConnectionPath) -> Void) -> UUID? {
        sessionLock.lock()
        let proxy = routingProxy
        sessionLock.unlock()
        return proxy?.observePath(callback)
    }

    public func removeRoutePathObserver(_ id: UUID) {
        sessionLock.lock()
        let proxy = routingProxy
        sessionLock.unlock()
        proxy?.removePathObserver(id)
    }

    public func directPathAvailable() async -> Bool {
        guard let current = routeSnapshot(), routingAvailable, !current.candidates.isEmpty else { return false }
        let verified = await GatewayDirectProbe.reachable(route: current) { [self] trust, host in
            resolve(trust, challengeHost: host, directPath: true) == .pinned(systemTrusted: false)
        }
        return verified && routingAvailable
    }

    private func routeSnapshot() -> GatewayDirectRoute? {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        return currentDirectRoute
    }

    public func updateCandidates(_ candidates: [GatewayDirectCandidate]) throws {
        guard let directRoute else { throw GatewayRoutingError.invalidRoute }
        let updated = try GatewayDirectRoute.maintained(origin: directRoute.origin, candidates: candidates)
        sessionLock.lock()
        defer { sessionLock.unlock() }
        guard !routeRetired, !routeFailed else { throw GatewayRoutingError.listenerUnavailable }
        try routingProxy?.updateCandidates(candidates)
        currentDirectRoute = updated
    }

    private var routingAvailable: Bool {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        return !routeRetired && !routeFailed
    }

    public var hasDirectRoute: Bool {
        directRoute != nil
    }

    /// Routed sessions belong to one pairing generation and cannot reopen after retirement.
    public func retireRouting() {
        guard directRoute != nil else { return }
        sessionLock.lock()
        routeRetired = true
        let proxy = routingProxy
        let session = cachedSession
        sessionLock.unlock()
        proxy?.close()
        session?.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
    }

    deinit { routingProxy?.close() }

    public init(
        fingerprintHex: String = "",
        spkiFingerprint: String? = nil,
        host: String? = nil,
        onSystemTrustVerified: SystemTrustVerified? = nil,
        systemTrust: @escaping SystemTrustEvaluator = PinnedSession.systemRoots,
        requireCertificateValidity: Bool = false,
        verificationDate: Date? = nil,
        directRoute: GatewayDirectRoute? = nil,
        proxyFactory: any GatewayRoutingProxyCreating = GatewayRoutingProxyFactory()
    ) {
        self.fingerprintHex = fingerprintHex.lowercased()
        self.spkiFingerprint = spkiFingerprint?.lowercased()
        self.host = spkiFingerprint == nil ? host : (host ?? directRoute?.host)
        self.onSystemTrustVerified = onSystemTrustVerified
        self.systemTrust = systemTrust
        self.requireCertificateValidity = requireCertificateValidity
        self.verificationDate = verificationDate
        self.directRoute = directRoute
        currentDirectRoute = directRoute
        self.proxyFactory = proxyFactory
        if let directRoute {
            let keyValid = spkiFingerprint?.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil
            let leafValid = requireCertificateValidity && host == nil &&
                fingerprintHex.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil
            let conflictingHost = spkiFingerprint != nil && host.map { $0.caseInsensitiveCompare(directRoute.host) != .orderedSame } == true
            routeFailed = !(keyValid || leafValid) || conflictingHost
        }
        super.init()
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        switch resolve(trust, challengeHost: challenge.protectionSpace.host) {
        case .pinned:
            // The leaf-cert SHA-256 is verified; tell iOS to skip its standard
            // re-evaluation of the SecTrust (which would still run hostname
            // matching, chain-to-CA, and revocation checks against the same
            // trust object handed back). Without this, self-signed certs whose
            // SAN doesn't include the URL host the iOS client connected to
            // surface as `NSURLErrorSecureConnectionFailed`: the gateway
            // auto-cert lists a small fixed set of SANs (localhost /
            // `<host>.local` / 127.0.0.1 / ::1), and a user reaching it over
            // another network identity (LAN, VPN overlay, tunnel, …) would
            // otherwise be refused.
            if let exceptions = SecTrustCopyExceptions(trust) {
                SecTrustSetExceptions(trust, exceptions)
            }
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .systemOnly:
            // No exceptions: the platform's own evaluation of this trust
            // must also pass for the connection to proceed.
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .rejected:
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// Computes the verdict for one challenge on `challengeHost` and reports a
    /// system-trusted chain to `onSystemTrustVerified`, once per instance.
    ///
    /// `directPath` says the peer was reached at one of the route's home-network
    /// addresses. A challenge from the session itself does not know which path its
    /// connection took, so it asks the routing proxy, which answers yes only while
    /// none of its connections goes through the relay.
    func resolve(_ trust: SecTrust, challengeHost: String, directPath: Bool? = nil) -> Verdict {
        sessionLock.lock()
        let unavailable = routeRetired || routeFailed
        let proxy = routingProxy
        sessionLock.unlock()
        if unavailable { return .rejected }
        if let directRoute, directRoute.host.caseInsensitiveCompare(challengeHost) != .orderedSame { return .rejected }
        let direct = directRoute != nil && (directPath ?? proxy?.carriesOnlyDirectStreams ?? false)
        let verdict = verdictForPeer(trust, challengeHost: challengeHost, expiredAccepted: direct)
        if let host, verdict == .systemOnly || verdict == .pinned(systemTrusted: true) {
            notifySystemTrustVerified(host: host)
        }
        return verdict
    }

    /// Preflight is advisory; the application TLS challenge also checks lease retirement.
    /// Immutable trust inputs avoid acquiring the session lock on the routing queue.
    private func verdictForPeer(_ trust: SecTrust, challengeHost: String, expiredAccepted: Bool) -> Verdict {
        Self.verdict(
            trust: trust,
            fingerprint: fingerprintHex,
            host: host,
            challengeHost: challengeHost,
            systemTrust: systemTrust,
            requireCertificateValidity: requireCertificateValidity,
            verificationDate: verificationDate,
            spkiFingerprint: spkiFingerprint,
            expiredAccepted: expiredAccepted
        )
    }

    /// Pure decision behind the challenge handler. The system evaluation runs
    /// only for a paired host that ``GatewayTrustPolicy`` lets qualify, and
    /// only when the challenge is for that host; any other challenge gets the
    /// strict pin verdict.
    ///
    /// `expiredAccepted` is set for a peer reached on the direct, home-network
    /// path. There a certificate whose key matches the key pin is accepted after
    /// it expired: the pinned key is what authenticates the gateway, and a gateway
    /// with remote access turned off can no longer renew the certificate it keeps
    /// serving at home. The name and every other check still apply, a certificate
    /// not valid yet is still refused, and the relay path always requires a
    /// current certificate.
    static func verdict(
        trust: SecTrust,
        fingerprint: String,
        host: String?,
        challengeHost: String,
        systemTrust: SystemTrustEvaluator,
        requireCertificateValidity: Bool = false,
        verificationDate: Date? = nil,
        spkiFingerprint: String? = nil,
        expiredAccepted: Bool = false
    )
        -> Verdict {
        let pinMatches: Bool
        if let spkiFingerprint {
            if let host, host.caseInsensitiveCompare(challengeHost) != .orderedSame { return .rejected }
            pinMatches = verifySPKI(trust: trust, against: spkiFingerprint)
            if !pinMatches { return .rejected }
        } else {
            pinMatches = verifyFingerprint(trust: trust, against: fingerprint)
        }
        if requireCertificateValidity || spkiFingerprint != nil, pinMatches {
            guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return .rejected }
            let current = evaluateSystemTrust(trust, host: challengeHost, anchors: [leaf], verifyDate: verificationDate)
            let lapsed = !current && expiredAccepted && spkiFingerprint != nil
                && expiredOnly(trust, leaf: leaf, host: challengeHost, now: verificationDate ?? Date())
            guard current || lapsed else { return .rejected }
        }
        if spkiFingerprint != nil { return .pinned(systemTrusted: false) }
        guard let host,
              host.caseInsensitiveCompare(challengeHost) == .orderedSame,
              GatewayTrustPolicy.systemTrustQualifies(host: host)
        else {
            return pinMatches ? .pinned(systemTrusted: false) : .rejected
        }
        let systemTrusted = systemTrust(trust, host)
        if pinMatches { return .pinned(systemTrusted: systemTrusted) }
        return systemTrusted ? .systemOnly : .rejected
    }

    /// Whether expiry is the only thing wrong with the served certificate: `now` is past
    /// its end, and it passes every check, the name included, a second before that end.
    private static func expiredOnly(_ trust: SecTrust, leaf: SecCertificate, host: String, now: Date) -> Bool {
        guard let expiry = try? GatewayKeyFingerprint.expiry(SecCertificateCopyData(leaf) as Data), now > expiry else { return false }
        return evaluateSystemTrust(trust, host: host, anchors: [leaf], verifyDate: expiry.addingTimeInterval(-1))
    }

    /// Whether the chain served in `trust` verifies under the system roots
    /// (or `anchors`, when given) as a TLS server certificate for `host`.
    ///
    /// The evaluation runs on a new `SecTrust` built from the served chain,
    /// never on the challenge's own trust, whose exceptions the pinned path
    /// sets and which must not leak into this verdict.
    public static func evaluateSystemTrust(
        _ trust: SecTrust,
        host: String,
        anchors: [SecCertificate]? = nil,
        verifyDate: Date? = nil
    )
        -> Bool {
        evaluateSystemTrust(trust, host: host, anchors: anchors, verifyDate: verifyDate, operations: .live)
    }

    static func evaluateSystemTrust(
        _ trust: SecTrust,
        host: String,
        anchors: [SecCertificate]?,
        verifyDate: Date?,
        operations: PinnedTrustPlatformOperations
    )
        -> Bool {
        guard let chain = operations.certificateChain(trust), !chain.isEmpty else { return false }
        let policy = SecPolicyCreateSSL(true, host as CFString)
        let result = operations.createTrust(chain, policy)
        guard result.status == errSecSuccess, let copy = result.trust else { return false }
        if let anchors {
            guard operations.setAnchors(copy, anchors) == errSecSuccess,
                  operations.setAnchorOnly(copy, true) == errSecSuccess,
                  operations.setNetworkFetch(copy, false) == errSecSuccess
            else { return false }
        }
        if let verifyDate, operations.setVerifyDate(copy, verifyDate) != errSecSuccess { return false }
        return SecTrustEvaluateWithError(copy, nil)
    }

    /// Pure helper exposed so unit tests can drive the comparison
    /// without spinning up a real TLS server. Returns `true` iff the
    /// trust's leaf certificate's SHA-256 DER digest matches the
    /// supplied fingerprint (case-insensitive on the input).
    static func verifyFingerprint(
        trust: SecTrust,
        against expected: String,
        operations: PinnedTrustPlatformOperations = .live
    )
        -> Bool {
        guard let leaf = operations.certificateChain(trust)?.first else {
            return false
        }
        let der = SecCertificateCopyData(leaf) as Data
        return der.sha256Hex == expected.lowercased()
    }

    static func verifySPKI(
        trust: SecTrust,
        against expected: String,
        operations: PinnedTrustPlatformOperations = .live
    )
        -> Bool {
        guard let leaf = operations.certificateChain(trust)?.first else { return false }
        let der = SecCertificateCopyData(leaf) as Data
        return (try? GatewayKeyFingerprint.spki(der)) == expected.lowercased()
    }

    private func notifySystemTrustVerified(host: String) {
        notifyLock.lock()
        let first = !notified
        notified = true
        notifyLock.unlock()
        if first { onSystemTrustVerified?(host, fingerprintHex) }
    }
}

extension PinnedSession {
    /// A session without a live routed proxy has nothing to verify and is never given one here.
    private var activeRoutingProxy: GatewayRoutingProxy? {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        return routeRetired || routeFailed ? nil : routingProxy
    }

    public func verifyRouting() async -> Bool {
        guard let proxy = activeRoutingProxy else { return false }
        return await proxy.verifyListener()
    }

    /// The same check for callers that cannot wait, such as an app-lifecycle signal.
    func verifyRoutingInBackground() {
        activeRoutingProxy?.verifyListener { _ in }
    }
}

extension Data {
    /// Lowercase hex SHA-256 digest of the receiver. Centralised here
    /// so other call sites (e.g. tests, future portal-facing code)
    /// don't reinvent it.
    var sha256Hex: String {
        let digest = SHA256.hash(data: self)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Owns newly created sessions; injected/shared sessions retain their caller's existing ownership.
final class GatewayOwnedSession: @unchecked Sendable {
    let session: URLSession
    init(_ session: URLSession) {
        self.session = session
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        defer { withExtendedLifetime(self) {} }
        return try await session.data(for: request)
    }

    deinit {
        (session.delegate as? PinnedSession)?.retireRouting()
        session.invalidateAndCancel()
    }
}
