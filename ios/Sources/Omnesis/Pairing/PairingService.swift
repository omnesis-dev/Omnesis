// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Why the app is showing onboarding after previously appearing paired.
///
/// Only the gateway URL is retained, as an untrusted convenience hint for
/// manual entry. The inherited token and device identity are always removed.
public struct PairingRecovery: Equatable, Sendable {
    public let gatewayURL: URL?

    public init(gatewayURL: URL?) {
        self.gatewayURL = gatewayURL
    }
}

/// Result of loading the device's pairing state.
public enum PairingLoadState: Equatable, Sendable {
    case unpaired
    case paired(Pairing)
    case legacyPairingRequiresRepair(PairingRecovery)
}

/// A paired gateway, materialized from Keychain.
///
/// `accountId` is the per-source-instance suffix in source ids like
/// `apple-health:<accountId>`. Hardcoded to `"local"`: Omnesis is
/// single-user / single-iPhone, so a constant suffices and survives
/// re-pair, reinstall, and full device wipe. The field stays a
/// string so a future multi-persona world can route via
/// `<persona-id>` from this same site.
///
/// `deviceId` is the gateway-issued device row UUID, used for the
/// device registry / source ownership. Under V1 pairings (legacy)
/// this falls back to the V1 payload's `accountId` field.
///
/// `fingerprint` is the lowercase-hex SHA-256 of the gateway's
/// self-signed leaf cert when the pairing came from a V3 QR. Nil for
/// V1/V2 legacy pairings (no TLS pinning was negotiated). Downstream
/// `URLSession` users should plumb this through `PinnedSession` to
/// pin the gateway cert on every connection.
public struct Pairing: Equatable, Sendable {
    public let url: URL
    public let token: String
    /// Gateway-issued token id. Unlike `deviceId`, this changes on every
    /// successful pair and therefore fences durable work from an older pairing.
    public let pairingGeneration: String?
    public let accountId: String
    public let deviceId: String
    public let gatewayName: String
    /// Granted scopes as returned by the gateway at pair time. Empty for
    /// V1 pairings that predate scoped tokens.
    public let scopes: [String]
    /// Pinned-cert fingerprint (lowercase hex SHA-256) for V3 pairings;
    /// nil for V1/V2 legacy pairings.
    public let fingerprint: String?
    public let tlsMode: PairingTlsMode

    public init(
        url: URL,
        token: String,
        pairingGeneration: String? = nil,
        accountId: String,
        deviceId: String,
        gatewayName: String,
        scopes: [String] = [],
        fingerprint: String? = nil,
        tlsMode: PairingTlsMode? = nil
    ) {
        self.url = url
        self.token = token
        self.pairingGeneration = pairingGeneration
        self.accountId = accountId
        self.deviceId = deviceId
        self.gatewayName = gatewayName
        self.scopes = scopes
        self.fingerprint = fingerprint
        self.tlsMode = tlsMode ?? (fingerprint == nil ? .legacy : .pinnedLeaf)
    }
}

/// Response from `POST /devices/pair`. Decoded verbatim from the gateway.
public struct DevicePairResponse: Decodable, Sendable {
    public struct Device: Decodable, Sendable {
        public let id: String
        public let name: String
        public let kind: String
    }

    public let device: Device
    public let tokenId: String
    public let token: String
    public let scopes: [String]
}

/// Thin HTTP wrapper used by PairingService to exchange a pairing code
/// for a device token. Mockable in tests.
public protocol PairingExchangeHTTP: Sendable {
    /// POST `{gatewayUrl}/devices/pair` with `{pairingCode, capabilities}`.
    /// Throws on non-2xx or decoding failure.
    func exchange(
        gatewayUrl: URL,
        pairingCode: String,
        capabilities: PairingCapabilities
    ) async throws
        -> DevicePairResponse
}

/// Default URLSession-backed exchange client.
///
/// Accepts an optional `URLSessionLike` so the V3 path can hand it a
/// `PinnedSession.session` that pins the gateway's self-signed cert
/// fingerprint on every challenge. Defaults to `URLSession.shared`
/// for V1/V2 legacy paths where pinning isn't negotiated.
public struct URLSessionPairingExchange: PairingExchangeHTTP {
    private let session: URLSessionLike

    public init(session: URLSessionLike = URLSession.shared) {
        self.session = session
    }

    public func exchange(
        gatewayUrl: URL,
        pairingCode: String,
        capabilities: PairingCapabilities
    ) async throws
        -> DevicePairResponse {
        guard var components = URLComponents(url: gatewayUrl, resolvingAgainstBaseURL: false) else {
            throw PairingPayloadError.invalidURL
        }
        // Append `/devices/pair` to whatever path the base URL already has.
        let basePath = components.path.hasSuffix("/") ? components.path : (components.path + "/")
        components.path = basePath + "devices/pair"
        components.percentEncodedQuery = nil
        guard let requestURL = components.url else {
            throw PairingPayloadError.invalidURL
        }

        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        struct Body: Encodable {
            let pairingCode: String
            let capabilities: PairingCapabilities
        }
        let body = Body(pairingCode: pairingCode, capabilities: capabilities)
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        if !(200 ... 299).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GatewayClient.Error.serverError(status: http.statusCode, body: text)
        }
        do {
            return try JSONDecoder().decode(DevicePairResponse.self, from: data)
        } catch {
            throw GatewayClient.Error.decoding("\(error)")
        }
    }
}

/// Stores / retrieves / clears the active pairing.
///
/// A pairing is usable only when all required device-local values are present
/// (url, token, accountId, name). Partial state means a prior pairing was
/// interrupted; `current()` surfaces `nil`. Legacy iCloud-synchronizable
/// values are purged and require an explicit re-pair.
public final class PairingService: Sendable {
    private enum Keys {
        static let installId = "install.id"
        static let url = "gateway.url"
        static let token = "gateway.token"
        static let accountId = "gateway.accountId"
        static let deviceId = "gateway.deviceId"
        static let name = "gateway.name"
        static let scopes = "gateway.scopes"
        /// V3 pairings only — pinned-cert SHA-256 fingerprint.
        static let fingerprint = "gateway.fingerprint"
        static let tlsMode = "gateway.tlsMode"
        /// Device-local marker retained after legacy synchronized credentials
        /// are removed, so a later launch can still explain the repair.
        static let recoveryRequired = "gateway.recoveryRequired"
        /// Non-secret convenience hint used only to prefill manual pairing.
        static let recoveryGatewayURL = "gateway.recoveryGatewayURL"
    }

    private let store: PairingStore
    private let exchange: PairingExchangeHTTP
    private let revocationJournal: PairingRevocationJournal
    /// Builds the V3-path exchange given a fingerprint. Returns `nil`
    /// to indicate "fall back to the regular `exchange`" — used by
    /// tests where the stub already encapsulates the wire behaviour
    /// and a real `PinnedSession`-wrapped `URLSession` would just try
    /// to connect to a non-existent host. Default builds a
    /// `URLSessionPairingExchange` whose `URLSession` is pinned to the
    /// fingerprint via `PinnedSession`.
    private let pinnedExchangeBuilder: @Sendable (String) -> PairingExchangeHTTP?

    public init(
        store: PairingStore = Keychain(),
        exchange: PairingExchangeHTTP = URLSessionPairingExchange(),
        pinnedExchangeBuilder: @escaping @Sendable (String) -> PairingExchangeHTTP? = { fingerprint in
            let pinned = PinnedSession(fingerprintHex: fingerprint)
            return URLSessionPairingExchange(session: pinned.session)
        }
    ) {
        self.store = store
        self.exchange = exchange
        revocationJournal = PairingRevocationJournal(store: store)
        self.pinnedExchangeBuilder = pinnedExchangeBuilder
    }

    /// Pair from a raw QR payload.
    ///
    /// For V2/V3 payloads this performs the `/devices/pair` round trip
    /// and persists the returned device token. For V1 payloads it just
    /// persists the baked-in token verbatim (legacy behavior).
    ///
    /// Synchronous V1 is preserved via a separate helper `pair(raw:)` for
    /// callers that don't have an async context, while V2/V3 must go
    /// through `pairAsync(raw:)`. The synchronous call throws for
    /// non-V1 payloads.
    @discardableResult
    public func pair(raw: String) throws -> Pairing {
        let payload = try PairingPayload.decode(from: raw)
        switch payload {
        case .v4:
            throw PairingPayloadError.invalidShape(
                "V4 pairing requires async exchange; call pairAsync(raw:)"
            )
        case .v1(let v1):
            return try persistV1(v1)
        case .v2:
            // V2 requires a network round-trip; callers must use pairAsync.
            throw PairingPayloadError.invalidShape(
                "V2 pairing requires async exchange; call pairAsync(raw:)"
            )
        case .v3:
            throw PairingPayloadError.invalidShape(
                "V3 pairing requires async exchange; call pairAsync(raw:)"
            )
        }
    }

    /// Async pairing. Handles V1 (legacy, no network), V2 (exchange
    /// pairing code via `/devices/pair`, no TLS pinning), and V3
    /// (exchange + pinned `URLSession` for the cert fingerprint).
    @discardableResult
    public func pairAsync(raw: String) async throws -> Pairing {
        let payload = try PairingPayload.decode(from: raw)
        switch payload {
        case .v4(let v4):
            return try await exchangeAndPersist(v4)
        case .v1(let v1):
            return try persistV1(v1)
        case .v2(let v2):
            return try await exchangeAndPersist(v2)
        case .v3(let v3):
            return try await exchangeAndPersist(v3)
        }
    }

    private func persistV1(_ v1: PairingPayload.V1) throws -> Pairing {
        guard let url = URL(string: v1.url) else {
            throw PairingPayloadError.invalidURL
        }
        try commit(
            PairingCredentialBundle(
                url: v1.url,
                token: v1.token,
                pairingGeneration: nil,
                accountId: "local",
                // V1 has no gateway-issued deviceId — reuse its account id as
                // the opaque legacy device-row identifier.
                deviceId: v1.accountId,
                name: v1.name,
                scopes: [],
                tlsMode: PairingTlsMode.legacy.rawValue,
                fingerprint: nil
            )
        )
        try? clearRecovery()
        // Lifecycle hook — invalidate the cached `OmnesisURLSession.shared`
        // so the next transport-client construction re-reads the keychain
        // for the (now-empty-for-V1) TLS fingerprint. AppStore.rebuildAdmin()
        // reconstructs dependent transport clients after this returns.
        OmnesisURLSession.reset()
        return Pairing(
            url: url,
            token: v1.token,
            pairingGeneration: nil,
            accountId: "local",
            deviceId: v1.accountId,
            gatewayName: v1.name,
            scopes: [],
            fingerprint: nil,
            tlsMode: .legacy
        )
    }

    private func exchangeAndPersist(_ v2: PairingPayload.V2) async throws -> Pairing {
        guard let url = URL(string: v2.gatewayUrl) else {
            throw PairingPayloadError.invalidURL
        }
        let response = try await exchange.exchange(
            gatewayUrl: url,
            pairingCode: v2.pairingCode,
            capabilities: defaultCapabilities()
        )
        return try await persistExchanged(
            gatewayUrlString: v2.gatewayUrl,
            url: url,
            response: response,
            fingerprint: nil,
            tlsMode: .legacy
        )
    }

    private func exchangeAndPersist(_ v3: PairingPayload.V3) async throws -> Pairing {
        guard let url = URL(string: v3.gatewayUrl) else {
            throw PairingPayloadError.invalidURL
        }
        // Build a `URLSession` that pins the gateway's leaf cert by
        // SHA-256 fingerprint — this is the actual TLS pinning
        // counter-measure. The exchange itself uses an
        // ad-hoc `PinnedSession` built from the QR fingerprint; once
        // `persistExchanged` commits the fingerprint inside the authoritative
        // credential bundle, then `OmnesisURLSession.reset()`
        // method) flips the cached singleton over to the same pin so
        // every downstream transport client refuses to talk to anything
        // that doesn't present it.
        //
        // Tests pass a `pinnedExchangeBuilder` that returns nil so the
        // injected `exchange` stub is used as-is (no real network).
        let exchangeToUse: PairingExchangeHTTP = pinnedExchangeBuilder(v3.fingerprint) ?? exchange
        let response = try await exchangeToUse.exchange(
            gatewayUrl: url,
            pairingCode: v3.pairingCode,
            capabilities: defaultCapabilities()
        )
        return try await persistExchanged(
            gatewayUrlString: v3.gatewayUrl,
            url: url,
            response: response,
            fingerprint: v3.fingerprint.lowercased(),
            tlsMode: .pinnedLeaf
        )
    }

    private func exchangeAndPersist(_ v4: PairingPayload.V4) async throws -> Pairing {
        guard let url = URL(string: v4.gatewayUrl) else {
            throw PairingPayloadError.invalidURL
        }
        let fingerprint: String?
        let tlsMode: PairingTlsMode
        let exchangeToUse: PairingExchangeHTTP
        switch v4.tls {
        case .system:
            fingerprint = nil
            tlsMode = .system
            exchangeToUse = exchange
        case .pinnedLeaf(let value):
            fingerprint = value.lowercased()
            tlsMode = .pinnedLeaf
            exchangeToUse = pinnedExchangeBuilder(value) ?? exchange
        }
        let response = try await exchangeToUse.exchange(
            gatewayUrl: url,
            pairingCode: v4.pairingCode,
            capabilities: defaultCapabilities()
        )
        return try await persistExchanged(
            gatewayUrlString: v4.gatewayUrl,
            url: url,
            response: response,
            fingerprint: fingerprint,
            tlsMode: tlsMode
        )
    }

    /// Build the capability hints we send the gateway at pair time.
    /// `suggestedName` is the device's preferred display name when the
    /// pairing code was issued without an admin-supplied name; the install
    /// identity is what the gateway adopts the existing device row by, so a
    /// re-pair keeps this phone's identity however the row is named.
    private func defaultCapabilities() -> PairingCapabilities {
        let host = deviceHostname()
        let installId = installIdentity()
        var caps = PairingCapabilities.ios(
            hostname: host,
            // Unique per install: without the user-assigned-device-name
            // entitlement `UIDevice.name` is the generic model name, so two
            // iPhones would otherwise suggest the same name.
            suggestedName: "\(host)-\(installId.prefix(6))",
            installId: installId,
            previousDeviceId: nil
        )
        // A re-pair names the row this install was paired as before, so the
        // gateway adopts it even if the operator renamed it.
        if let previous = (try? current())??.deviceId, !previous.isEmpty {
            caps.previousDeviceId = previous
        }
        return caps
    }

    /// Stable per-install identity, minted once and kept in the Keychain (which
    /// survives an app reinstall). Falls back to a fresh value when the Keychain
    /// is unavailable — the pairing still works, it just can't be adopted later.
    private func installIdentity() -> String {
        if let existing = try? store.get(Keys.installId), !existing.isEmpty {
            return existing
        }
        let fresh = UUID().uuidString.lowercased()
        try? store.set(fresh, forKey: Keys.installId)
        return fresh
    }

    /// Common persistence path for exchanged pairings. Credentials and TLS
    /// trust are committed as one Keychain item so interrupted replacement
    /// cannot combine a new token with an older trust contract.
    private func persistExchanged(
        gatewayUrlString: String,
        url: URL,
        response: DevicePairResponse,
        fingerprint: String?,
        tlsMode: PairingTlsMode
    ) async throws
        -> Pairing {
        let deviceId = response.device.id
        let name = response.device.name

        // See the `Pairing` doc comment for why this is hardcoded.
        let accountId = "local"

        try commit(
            PairingCredentialBundle(
                url: gatewayUrlString,
                token: response.token,
                pairingGeneration: response.tokenId,
                accountId: accountId,
                deviceId: deviceId,
                name: name,
                scopes: response.scopes,
                tlsMode: tlsMode.rawValue,
                fingerprint: fingerprint
            )
        )
        // Recovery hints are non-authoritative. Once the credential bundle is
        // committed, cleanup failure must not make a redeemed code look failed.
        try? clearRecovery()
        // Lifecycle hook — invalidate the cached `OmnesisURLSession.shared`
        // so the next transport-client construction re-reads the (possibly
        // newly-set) TLS fingerprint and pins via PinnedSession. Legacy HTTPS
        // paths leave the key absent and the rebuilt session falls through to
        // URLSession.shared with normal system trust evaluation.
        OmnesisURLSession.reset()

        return Pairing(
            url: url,
            token: response.token,
            pairingGeneration: response.tokenId,
            accountId: accountId,
            deviceId: deviceId,
            gatewayName: name,
            scopes: response.scopes,
            fingerprint: fingerprint,
            tlsMode: tlsMode
        )
    }

    /// Loads the device pairing and removes credentials written by versions
    /// that synchronized them through iCloud Keychain.
    ///
    /// A complete modern device-local bundle always wins. Legacy rows are
    /// deleted but never copied into the local class, and fields from the two
    /// storage classes are never combined. If no complete local bundle exists,
    /// onboarding receives a durable repair reason and at most a validated
    /// non-secret gateway URL hint.
    public func load() throws -> PairingLoadState {
        let hadLegacyValues = try store.hasLegacySynchronizableValues()
        let legacyGatewayURL = try hadLegacyValues
            ? validatedGatewayURL(store.getLegacySynchronizable(Keys.url))
            : nil

        if hadLegacyValues {
            // Journal recovery locally before deleting the only record that
            // explains why re-pairing is required. If cleanup is interrupted,
            // a later load can retry without losing the user-facing reason.
            try store.set("1", forKey: Keys.recoveryRequired)
            if let legacyGatewayURL {
                try store.set(legacyGatewayURL.absoluteString, forKey: Keys.recoveryGatewayURL)
            } else {
                try store.delete(Keys.recoveryGatewayURL)
            }
            try store.deleteLegacySynchronizableValues()
            OmnesisURLSession.reset()
        }

        try purgePlaintextDeviceLocalPairing()

        if let pairing = try loadDeviceLocalPairing() {
            try? clearRecovery()
            return .paired(pairing)
        }

        if try store.get(Keys.recoveryRequired) == "1" {
            let hint = try validatedGatewayURL(store.get(Keys.recoveryGatewayURL))
            return .legacyPairingRequiresRepair(PairingRecovery(gatewayURL: hint))
        }
        return .unpaired
    }

    /// Safe convenience for background callers that only need a usable
    /// pairing. Recovery and ordinary unpaired states both return `nil`.
    public func current() throws -> Pairing? {
        if case .paired(let pairing) = try load() {
            return pairing
        }
        return nil
    }

    private func loadDeviceLocalPairing() throws -> Pairing? {
        if let raw = try store.get(PairingCredentialBundle.key) {
            guard let credential = try? PairingCredentialBundle.decode(raw) else {
                return nil
            }
            return materialize(credential)
        }

        guard let urlString = try store.get(Keys.url),
              let token = try store.get(Keys.token),
              let accountId = try store.get(Keys.accountId),
              let name = try store.get(Keys.name),
              let url = validatedGatewayURL(urlString)
        else {
            return nil
        }
        let scopes: [String] = if let json = try store.get(Keys.scopes),
                                  let data = json.data(using: .utf8),
                                  let parsed = try? JSONDecoder().decode([String].self, from: data) {
            parsed
        } else {
            []
        }
        // `deviceId` was added after some pairings were already saved;
        // fall back to accountId for legacy entries that match the old
        // invariant `accountId == gateway deviceId`.
        let deviceId = (try? store.get(Keys.deviceId)) ?? nil ?? accountId
        let fingerprint = try store.get(Keys.fingerprint)
        let tlsMode = try PairingTlsMode(
            rawValue: (store.get(Keys.tlsMode)) ?? ""
        ) ?? (fingerprint == nil ? .legacy : .pinnedLeaf)
        if tlsMode == .pinnedLeaf && !isValidFingerprint(fingerprint) {
            return nil
        }
        if tlsMode == .system && url.scheme?.lowercased() != "https" {
            return nil
        }
        let effectiveFingerprint = tlsMode == .system ? nil : fingerprint
        return Pairing(
            url: url,
            token: token,
            pairingGeneration: nil,
            accountId: accountId,
            deviceId: deviceId,
            gatewayName: name,
            scopes: scopes,
            fingerprint: effectiveFingerprint,
            tlsMode: tlsMode
        )
    }

    private func materialize(_ credential: PairingCredentialBundle) -> Pairing? {
        guard let url = validatedGatewayURL(credential.url),
              !credential.token.isEmpty,
              let tlsMode = PairingTlsMode(rawValue: credential.tlsMode)
        else { return nil }
        if tlsMode == .pinnedLeaf, !isValidFingerprint(credential.fingerprint) {
            return nil
        }
        if tlsMode == .system, url.scheme?.lowercased() != "https" {
            return nil
        }
        return Pairing(
            url: url,
            token: credential.token,
            pairingGeneration: credential.pairingGeneration,
            accountId: credential.accountId,
            deviceId: credential.deviceId,
            gatewayName: credential.name,
            scopes: credential.scopes,
            fingerprint: tlsMode == .system ? nil : credential.fingerprint,
            tlsMode: tlsMode
        )
    }

    private func commit(_ credential: PairingCredentialBundle) throws {
        try store.set(credential.encoded(), forKey: PairingCredentialBundle.key)
        // The bundle is authoritative after the commit. Split keys are retained
        // only as a read fallback for upgrades from older app versions.
        for key in [
            Keys.url, Keys.token, Keys.accountId, Keys.deviceId, Keys.name,
            Keys.scopes, Keys.fingerprint, Keys.tlsMode,
        ] {
            try? store.delete(key)
        }
    }

    private func clearRecovery() throws {
        try store.delete(Keys.recoveryRequired)
        try store.delete(Keys.recoveryGatewayURL)
    }

    private func validatedGatewayURL(_ value: String?) -> URL? {
        guard let value,
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "https",
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              let url = components.url
        else {
            return nil
        }
        return url
    }

    /// Credentials written by older app versions may still point at a
    /// plaintext gateway. They must never become live authority after the
    /// HTTPS-only upgrade. Remove the complete credential set atomically from
    /// the app's point of view and leave onboarding a durable repair marker;
    /// an HTTP URL is deliberately not retained as a manual-entry hint.
    private func purgePlaintextDeviceLocalPairing() throws {
        var hasPlaintextAuthority = false
        if let raw = try store.get(PairingCredentialBundle.key),
           let credential = try? PairingCredentialBundle.decode(raw),
           URL(string: credential.url)?.scheme?.lowercased() == "http" {
            hasPlaintextAuthority = true
        }
        if let splitURL = try store.get(Keys.url),
           URL(string: splitURL)?.scheme?.lowercased() == "http",
           try store.get(Keys.token) != nil {
            hasPlaintextAuthority = true
        }
        guard hasPlaintextAuthority else { return }

        try store.set("1", forKey: Keys.recoveryRequired)
        try store.delete(Keys.recoveryGatewayURL)
        try store.delete(PairingCredentialBundle.key)
        for key in [
            Keys.url, Keys.token, Keys.accountId, Keys.deviceId, Keys.name,
            Keys.scopes, Keys.fingerprint, Keys.tlsMode,
        ] {
            try store.delete(key)
        }
        OmnesisURLSession.reset()
    }

    /// Forget the current pairing. Used when the user unpairs in Settings.
    ///
    /// After this returns the cached `OmnesisURLSession.shared` is
    /// invalidated; the next transport-client construction re-reads the
    /// keychain (now empty) and falls through to `URLSession.shared`.
    /// The caller MUST reconstruct (or tear down) any dependent clients —
    /// the live `AdminClient` / `SearchClient` / `DeviceSocket` instances
    /// captured the previous session at init and will keep using it
    /// otherwise. AppStore.rebuildAdmin() handles that for the AppStore
    /// lifecycle.
    public func clear() throws {
        // Preserve install identity and the revocation outbox in place. Delete
        // legacy split credentials first and the authoritative bundle last:
        // every interruption therefore leaves either a usable active bundle
        // (whose matching outbox entry stays dormant) or no active credential
        // plus the durable revoke entry. There is no post-commit operation that
        // can lose the journal after the bundle disappears.
        for key in [
            Keys.url, Keys.token, Keys.accountId, Keys.deviceId, Keys.name,
            Keys.scopes, Keys.fingerprint, Keys.tlsMode,
            Keys.recoveryRequired, Keys.recoveryGatewayURL,
        ] {
            try store.delete(key)
        }
        try store.delete(PairingCredentialBundle.key)
        OmnesisURLSession.reset()
    }

    /// Journal the credential required for remote revocation before removing
    /// it from active use. Network failure can then be retried after restart
    /// without leaving the app paired.
    @discardableResult
    public func stageUnpair() throws -> Pairing? {
        guard let pairing = try current() else { return nil }
        try revocationJournal.enqueue(pairing)
        try clear()
        return pairing
    }

    public func pendingRevocation() throws -> Pairing? {
        let active = try current()
        guard let credential = try revocationJournal.firstPending(excluding: active) else { return nil }
        return materialize(credential)
    }

    /// Remove only the exact generation whose network request settled. This
    /// compare-and-delete prevents an older in-flight revoke from erasing a
    /// newly staged pairing (the revoke outbox is FIFO and survives restart).
    public func settlePendingRevocation(_ pairing: Pairing) throws {
        try revocationJournal.settle(pairing)
    }

    /// Update only the gateway URL — used when the user switches from LAN
    /// to Tailscale / tunnel without re-running the full pairing flow.
    /// Token and accountId stay unchanged.
    public func updateGatewayURL(_ url: URL) throws {
        guard let next = validatedGatewayURL(url.absoluteString) else {
            if url.scheme?.lowercased() != "https" {
                throw PairingPayloadError.invalidScheme(url.scheme ?? "(missing)")
            }
            throw PairingPayloadError.invalidURL
        }
        guard let pairing = try current() else {
            throw PairingPayloadError.invalidShape("no active pairing")
        }
        if pairing.tlsMode == .system {
            guard next.scheme?.lowercased() == "https",
                  next.path.isEmpty || next.path == "/",
                  canonicalOrigin(next) == canonicalOrigin(pairing.url)
            else {
                throw PairingPayloadError.invalidShape(
                    "system-trusted gateway authority cannot change without re-pairing"
                )
            }
        }
        try commit(
            PairingCredentialBundle(
                url: next.absoluteString,
                token: pairing.token,
                accountId: pairing.accountId,
                deviceId: pairing.deviceId,
                name: pairing.gatewayName,
                scopes: pairing.scopes,
                tlsMode: pairing.tlsMode.rawValue,
                fingerprint: pairing.fingerprint
            )
        )
    }

    // MARK: - Helpers

    private func deviceHostname() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return ProcessInfo.processInfo.hostName
        #endif
    }

    private func isValidFingerprint(_ value: String?) -> Bool {
        guard let value, value.count == 64 else { return false }
        return value.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    private func canonicalOrigin(_ url: URL) -> String? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased()
        else { return nil }
        components.scheme = scheme
        components.host = host
        components.port = components.port ?? (scheme == "https" ? 443 : 80)
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url?.absoluteString
    }
}

#if canImport(UIKit)
import UIKit
#endif
