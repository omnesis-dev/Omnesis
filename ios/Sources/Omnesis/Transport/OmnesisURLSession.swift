// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Shared `URLSession` used by every iOS transport client (`GatewayClient`,
/// `AdminClient`, `SearchClient`, `DeviceSocket`).
///
/// The persisted pairing trust mode is authoritative: system trust uses
/// `URLSession.shared`, pinned-leaf trust requires a valid fingerprint, and
/// malformed pinned state gets a session that rejects every TLS challenge.
/// Pairings written before the explicit mode key infer pinned trust when a
/// fingerprint exists and legacy trust otherwise.
///
/// Without this plumbing the pin would only be enforced during the pairing
/// exchange itself — every other call (Apple Health upload, search, sync
/// poll, WebSocket events) would fall back to system trust, which can't
/// validate the gateway's auto-generated self-signed cert. The result
/// would be a paired-but-mute iPhone after the gateway flips to HTTPS.
public enum OmnesisURLSession {
    /// Split-key names used only when reading pairings written before the
    /// atomic `PairingCredentialBundle` representation.
    public static let fingerprintKeychainKey = "gateway.fingerprint"
    public static let tlsModeKeychainKey = "gateway.tlsMode"

    /// Lowercase-hex SHA-256 of the leaf cert. 64 hex chars exactly.
    private static let fingerprintPattern = "^[0-9a-fA-F]{64}$"

    private static let lock = NSLock()
    private static var cached: URLSession?

    /// The session handed out for every access made while the store is
    /// unreadable. Held apart from ``cached`` so a later successful read still
    /// wins, and a `let` so reuse is structural: a `URLSession` retains its
    /// delegate until it is invalidated, and minting one per failed read would
    /// accumulate them. Nothing about a rejecting session goes stale, so it
    /// never needs replacing.
    private static let unreadableFallback: URLSession = RejectingTrustSession.make()

    /// Where the persisted trust contract is read from. Production reads the
    /// pairing Keychain; tests substitute a fake via ``_setStore(_:)``.
    private static var store: PairingStore = Keychain()

    /// Resolved session for transport clients. Lazy + thread-safe; the
    /// first call reads the stored trust contract, subsequent calls return
    /// the cached instance. Call ``reset()`` after re-pair / unpair so the
    /// next access re-reads the (possibly new) fingerprint.
    ///
    /// Only a contract that was actually read becomes the cached session.
    /// An unreadable store still yields a session that rejects every TLS
    /// challenge — an unavailable contract must never downgrade a pinned
    /// pairing to WebPKI — but that session is never adopted as the contract,
    /// so the next access reads the store again. Pairing values are stored
    /// `AfterFirstUnlockThisDeviceOnly` (see `Keychain.addQuery`), so a
    /// process launched by push or a background task before the first unlock
    /// after a reboot reads them as unavailable; adopting that would keep
    /// every later access rejecting for the life of the process, long after
    /// the item became readable.
    ///
    /// While the store is unreadable each access costs one local `securityd`
    /// lookup, and the retrying stops as soon as a read succeeds. Most callers
    /// resolve this once, when they build a transport client;
    /// `PushRegistrationCoordinator` resolves it per request, so during that
    /// window each of its requests pays a lookup — cheap next to the network
    /// call it is about to fail.
    public static var shared: URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        // The store is read under the lock so a concurrent `reset()` cannot be
        // overtaken: a resolve that read pre-change state would otherwise
        // install it after the reset meant to discard it.
        switch resolve(from: store) {
        case .contract(let session):
            cached = session
            return session
        case .unreadable:
            return unreadableFallback
        }
    }

    /// Discard the cached session so the next access re-reads the store.
    /// Call from `PairingService` after the pairing bundle changes.
    ///
    /// See #2131 — the dropped session is not invalidated; live clients may
    /// still hold it.
    public static func reset() {
        lock.lock()
        defer { lock.unlock() }
        cached = nil
    }

    /// Pure routing helper extracted so unit tests can drive the persisted
    /// trust contract without spinning up a Keychain.
    static func _resolveSession(tlsMode rawMode: String?, fingerprint: String?) -> URLSession {
        let mode = PairingTlsMode(rawValue: rawMode ?? "") ??
            (fingerprint == nil ? .legacy : .pinnedLeaf)
        switch mode {
        case .system, .legacy:
            return URLSession.shared
        case .pinnedLeaf:
            guard let fp = fingerprint,
                  !fp.isEmpty,
                  fp.range(of: fingerprintPattern, options: .regularExpression) != nil
            else {
                return RejectingTrustSession.make()
            }
            return PinnedSession(fingerprintHex: fp).session
        }
    }

    /// What reading the persisted trust contract produced.
    private enum Resolution {
        /// The stored contract was read. Authoritative, and it stands until
        /// the pairing changes and `reset()` clears it.
        case contract(URLSession)
        /// The store could not be read, so no contract is known yet.
        case unreadable
    }

    private static func resolve(from store: PairingStore) -> Resolution {
        do {
            if let raw = try store.get(PairingCredentialBundle.key) {
                guard let credential = try? PairingCredentialBundle.decode(raw) else {
                    // The bundle was read and is unusable. Only a re-pair
                    // changes that, and a re-pair calls `reset()`, so rejecting
                    // trust is this pairing's contract rather than a transient
                    // verdict.
                    return .contract(RejectingTrustSession.make())
                }
                return .contract(_resolveSession(
                    tlsMode: credential.tlsMode,
                    fingerprint: credential.fingerprint
                ))
            }
            let session = try _resolveSession(
                tlsMode: store.get(tlsModeKeychainKey),
                fingerprint: store.get(fingerprintKeychainKey)
            )
            return .contract(session)
        } catch {
            return .unreadable
        }
    }
}

#if DEBUG
extension OmnesisURLSession {
    /// Test-only override: drop in a fixed session so unit tests can assert
    /// which delegate fired without touching Keychain. Pass `nil` to fall back
    /// to the production resolution path.
    static func _setCached(_ session: URLSession?) {
        lock.lock()
        defer { lock.unlock() }
        cached = session
    }

    /// Test-only override: read the trust contract from a substitute store, so
    /// a test can drive an unreadable store without a Keychain. Pass `nil` to
    /// restore the production Keychain. Drops the cached session, which belongs
    /// to the store that produced it.
    static func _setStore(_ substitute: PairingStore?) {
        lock.lock()
        defer { lock.unlock() }
        store = substitute ?? Keychain()
        cached = nil
    }
}
#endif

final class RejectingTrustSession: NSObject, URLSessionDelegate, @unchecked Sendable {
    static func make() -> URLSession {
        URLSession(configuration: .ephemeral, delegate: RejectingTrustSession(), delegateQueue: nil)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}
