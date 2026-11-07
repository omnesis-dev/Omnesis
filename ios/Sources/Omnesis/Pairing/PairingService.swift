// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

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

    private let mutations = PairingMutationFence()
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
    private let strictPinnedExchangeBuilder: @Sendable (String) -> PairingExchangeHTTP?
    private let keyPinnedExchangeBuilder: @Sendable (String, String) -> PairingExchangeHTTP?
    private let directDiscovery: any GatewayDirectDiscovering

    public init(
        store: PairingStore = Keychain(),
        exchange: PairingExchangeHTTP = URLSessionPairingExchange(),
        pinnedExchangeBuilder: @escaping @Sendable (String) -> PairingExchangeHTTP? = { fingerprint in
            let pinned = PinnedSession(fingerprintHex: fingerprint)
            return URLSessionPairingExchange(ownedSession: pinned.session)
        },
        strictPinnedExchangeBuilder: @escaping @Sendable (String) -> PairingExchangeHTTP? = { fingerprint in
            let pinned = PinnedSession(fingerprintHex: fingerprint, requireCertificateValidity: true)
            return URLSessionPairingExchange(ownedSession: pinned.session)
        },
        keyPinnedExchangeBuilder: @escaping @Sendable (String, String) -> PairingExchangeHTTP? = { spki, host in
            URLSessionPairingExchange(ownedSession: PinnedSession(spkiFingerprint: spki, host: host).session)
        },
        directDiscovery: any GatewayDirectDiscovering = GatewayDirectDiscovery()
    ) {
        self.store = store
        self.exchange = exchange
        revocationJournal = PairingRevocationJournal(store: store)
        self.pinnedExchangeBuilder = pinnedExchangeBuilder
        self.strictPinnedExchangeBuilder = strictPinnedExchangeBuilder
        self.keyPinnedExchangeBuilder = keyPinnedExchangeBuilder
        self.directDiscovery = directDiscovery
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
        let operation = mutations.begin()
        switch payload {
        case .v4:
            throw PairingPayloadError.invalidShape(
                "V4 pairing requires async exchange; call pairAsync(raw:)"
            )
        case .v1(let v1):
            return try persistV1(v1, operation: operation)
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
        let operation = mutations.begin()
        switch payload {
        case .v4(let v4):
            return try await exchangeAndPersist(v4, operation: operation)
        case .v1(let v1):
            return try persistV1(v1, operation: operation)
        case .v2(let v2):
            return try await exchangeAndPersist(v2, operation: operation)
        case .v3(let v3):
            return try await exchangeAndPersist(v3, operation: operation)
        }
    }

    private func persistV1(_ v1: PairingPayload.V1, operation: UUID) throws -> Pairing {
        try mutations.commit(operation) {
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
    }

    private func exchangeAndPersist(_ v2: PairingPayload.V2, operation: UUID) async throws -> Pairing {
        guard let url = URL(string: v2.gatewayUrl) else {
            throw PairingPayloadError.invalidURL
        }
        let response = try await exchange.exchange(
            gatewayUrl: url,
            pairingCode: v2.pairingCode,
            capabilities: defaultCapabilities()
        )
        return try await persistExchanged(
            operation: operation,
            gateway: (v2.gatewayUrl, url),
            response: response,
            fingerprint: nil,
            tlsMode: .legacy
        )
    }

    private func exchangeAndPersist(_ v3: PairingPayload.V3, operation: UUID) async throws -> Pairing {
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
            operation: operation,
            gateway: (v3.gatewayUrl, url),
            response: response,
            fingerprint: v3.fingerprint.lowercased(),
            tlsMode: .pinnedLeaf
        )
    }

    private func exchangeAndPersist(_ v4: PairingPayload.V4, operation: UUID) async throws -> Pairing {
        guard let url = URL(string: v4.gatewayUrl) else {
            throw PairingPayloadError.invalidURL
        }
        let fingerprint: String?
        var spkiFingerprint: String?
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
        case .pinnedKeyStrict(let value):
            fingerprint = nil
            spkiFingerprint = value.lowercased()
            tlsMode = .pinnedKeyStrict
            exchangeToUse = keyPinnedExchangeBuilder(value, url.host!) ?? exchange
        case .pinnedLeafStrict(let value):
            fingerprint = value.lowercased()
            tlsMode = .pinnedLeafStrict
            exchangeToUse = strictPinnedExchangeBuilder(value) ?? exchange
        }
        let response = try await exchangeToUse.exchange(
            gatewayUrl: url,
            pairingCode: v4.pairingCode,
            capabilities: defaultCapabilities()
        )
        return try await persistExchanged(
            operation: operation,
            gateway: (v4.gatewayUrl, url),
            response: response,
            fingerprint: fingerprint,
            tlsMode: tlsMode,
            spkiFingerprint: spkiFingerprint
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
        mutations.serialized {
            if let existing = try? store.get(Keys.installId), !existing.isEmpty {
                return existing
            }
            let fresh = UUID().uuidString.lowercased()
            try? store.set(fresh, forKey: Keys.installId)
            return fresh
        }
    }

    /// Common persistence path for exchanged pairings. Credentials and TLS
    /// trust are committed as one Keychain item so interrupted replacement
    /// cannot combine a new token with an older trust contract.
    private func persistExchanged(
        operation: UUID,
        gateway: (raw: String, url: URL),
        response: DevicePairResponse,
        fingerprint: String?,
        tlsMode: PairingTlsMode,
        spkiFingerprint: String? = nil
    ) async throws
        -> Pairing {
        let gatewayUrlString = gateway.raw
        let url = gateway.url
        let deviceId = response.device.id
        let name = response.device.name

        // Optional routing metadata cannot change the already authenticated TLS authority.
        var directCandidates: [GatewayDirectCandidate]?
        if tlsMode == .pinnedKeyStrict, let spkiFingerprint {
            do {
                let candidates = try await directDiscovery.fetch(origin: url, token: response.token, spkiFingerprint: spkiFingerprint)
                _ = try GatewayDirectRoute(origin: url, candidates: candidates)
                directCandidates = candidates.isEmpty ? nil : candidates
            } catch {
                guard GatewayDirectDiscovery.isTemporary(error) else { throw error }
                directCandidates = nil
            }
        }
        return try mutations.commit(operation) {
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
                    fingerprint: fingerprint,
                    spkiFingerprint: spkiFingerprint,
                    directCandidates: directCandidates
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
                spkiFingerprint: spkiFingerprint,
                directCandidates: directCandidates,
                tlsMode: tlsMode
            )
        }
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
        try mutations.serialized {
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
        if tlsMode == .pinnedKeyStrict { return nil }
        if tlsMode.requiresPin && !isValidFingerprint(fingerprint) {
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
        let pin = tlsMode == .pinnedKeyStrict ? credential.spkiFingerprint : credential.fingerprint
        if tlsMode.requiresPin, !isValidFingerprint(pin) {
            return nil
        }
        if tlsMode == .system, url.scheme?.lowercased() != "https" {
            return nil
        }
        let directCandidates: [GatewayDirectCandidate]? = if tlsMode.isStrict, let candidates = credential.directCandidates,
                                                             (try? GatewayDirectRoute(origin: url, candidates: candidates)) != nil {
            candidates
        } else { nil }
        return Pairing(
            url: url,
            token: credential.token,
            pairingGeneration: credential.pairingGeneration,
            accountId: credential.accountId,
            deviceId: credential.deviceId,
            gatewayName: credential.name,
            scopes: credential.scopes,
            fingerprint: tlsMode == .system ? nil : credential.fingerprint,
            spkiFingerprint: tlsMode == .pinnedKeyStrict ? credential.spkiFingerprint : nil,
            directCandidates: directCandidates,
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
        try mutations.replace {
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
    }

    /// Journal the credential required for remote revocation before removing
    /// it from active use. Network failure can then be retried after restart
    /// without leaving the app paired.
    @discardableResult
    public func stageUnpair() throws -> Pairing? {
        try mutations.replace {
            guard let pairing = try current() else { return nil }
            try revocationJournal.enqueue(pairing)
            try clear()
            return pairing
        }
    }

    public func pendingRevocation() throws -> Pairing? {
        try mutations.serialized {
            let active = try current()
            guard let credential = try revocationJournal.firstPending(excluding: active) else { return nil }
            return materialize(credential)
        }
    }

    /// Remove only the exact generation whose network request settled. This
    /// compare-and-delete prevents an older in-flight revoke from erasing a
    /// newly staged pairing (the revoke outbox is FIFO and survives restart).
    public func settlePendingRevocation(_ pairing: Pairing) throws {
        try mutations.serialized {
            try revocationJournal.settle(pairing)
        }
    }

    /// Update only the gateway URL — used when the user switches from LAN
    /// to Tailscale / tunnel without re-running the full pairing flow.
    /// Every other field of the pairing stays unchanged.
    public func updateGatewayURL(_ url: URL) throws {
        try mutations.replace {
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
            try commit(PairingCredentialBundle(pairing, url: next, tlsMode: pairing.tlsMode, fingerprint: pairing.fingerprint))
            OmnesisURLSession.reset()
        }
    }

    /// Replace a leaf pin with system trust once the gateway's chain was seen
    /// to verify under the system roots for `verifiedHost` by a session pinned
    /// to `pinnedFingerprint`. Only the current pairing, when it is still
    /// pinned to exactly that host and pin and its host is one
    /// ``GatewayTrustPolicy`` lets qualify, is rewritten; a report from a
    /// session built for an earlier pairing or address changes nothing. Every
    /// other field of the pairing is kept. Returns whether the stored pairing
    /// changed, in which case the caller rebuilds its clients.
    @discardableResult
    public func upgradeTrustToSystem(verifiedHost: String, pinnedFingerprint: String) throws -> Bool {
        try mutations.serialized {
            guard let pairing = try current(),
                  pairing.isPinned(to: verifiedHost, fingerprint: pinnedFingerprint),
                  GatewayTrustPolicy.systemTrustQualifies(host: pairing.url.host)
            else { return false }
            try commit(PairingCredentialBundle(pairing, url: pairing.url, tlsMode: .system, fingerprint: nil))
            OmnesisURLSession.reset()
            return true
        }
    }

    /// Refresh only authenticated routing facts for this exact stored authority.
    /// A route update never resets sessions or interrupts existing uploads.
    @discardableResult
    public func updateDirectCandidates(
        expected: Pairing,
        candidates: [GatewayDirectCandidate],
        onUpdated: () throws -> Void = {}
    ) throws
        -> Bool {
        try mutations.serialized {
            try Task.checkCancellation()
            guard expected.tlsMode.isStrict, let current = try current(),
                  current.sameAuthority(as: expected), let raw = try store.get(PairingCredentialBundle.key) else { return false }
            _ = try GatewayDirectRoute.maintained(origin: current.url, candidates: candidates)
            let normalized = candidates.isEmpty ? nil : candidates
            if current.directCandidates == normalized { try onUpdated()
                return true
            }
            let bundle = try PairingCredentialBundle.decode(raw).replacingDirectCandidates(normalized)
            try commit(bundle)
            try onUpdated()
            return true
        }
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
        guard let value else { return false }
        return value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
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
