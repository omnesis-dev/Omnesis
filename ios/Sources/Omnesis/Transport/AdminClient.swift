// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A successful HTTP response is insufficient when an older gateway ignores
/// the requested storage mode. Never begin writing under an unconfirmed mode.
public struct SourceModeTransitionNotConfirmed: LocalizedError, CustomStringConvertible, Sendable {
    public let mode: SourceMultiDeviceMode

    public var description: String {
        "The gateway did not confirm \(mode.rawValue) mode. Update the gateway, then try again."
    }

    public var errorDescription: String? {
        description
    }
}

/// HTTP client for the gateway's `/admin/*` admin surface — source list,
/// device list, sync status, sync-now, enable/disable, remove.
///
/// Separate from `GatewayClient` (which handles write-scoped ingest) so
/// tests and views can inject focused mocks. All methods require a token
/// carrying the `admin` scope — the gateway's canonical grant for a paired
/// phone includes it.
public final class AdminClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let pairingGeneration: String?
    private let session: URLSessionLike
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(
        baseURL: URL,
        token: String,
        pairingGeneration: String? = nil,
        session: URLSessionLike = OmnesisURLSession.shared
    ) {
        self.baseURL = baseURL
        self.token = token
        self.pairingGeneration = pairingGeneration
        self.session = session
        decoder = JSONDecoder()
        encoder = JSONEncoder()
    }

    // MARK: - Source registry

    public func listSources() async throws -> [SourceRecord] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/sources", body: nil)
        return try decodeOrThrow(Page<SourceRecord>.self, from: data).items
    }

    /// Registered sources plus the gateway-internal ones (`internalSources`
    /// on the same envelope) in a single fetch. A gateway that predates the
    /// field decodes to no internal sources.
    public func listSourcesAndInternal() async throws -> SourceInventory {
        struct Envelope: Decodable {
            let items: [SourceRecord]?
            let internalSources: [InternalSource]?
            let removedSourceIds: [String]?
            let pendingRemovals: [PendingSourceRemoval]?
        }
        let (data, _) = try await dispatch(method: "GET", path: "/admin/sources", body: nil)
        let envelope = try decodeOrThrow(Envelope.self, from: data)
        return SourceInventory(
            sources: envelope.items ?? [],
            internalSources: envelope.internalSources ?? [],
            removedSourceIds: envelope.removedSourceIds ?? [],
            pendingRemovals: envelope.pendingRemovals ?? []
        )
    }

    /// Register a source row on the gateway so it shows up in the portal.
    /// iOS uses this for locally-hosted sources like Apple
    /// Health because there's no Mac collector calling bulk-upsert on its
    /// behalf. Idempotent: `createSource` on the gateway re-uses an
    /// existing row if one already matches.
    @discardableResult
    public func createSource(
        type: String,
        accountId: String,
        deviceId: String,
        enabled: Bool = true
    ) async throws
        -> SourceRecord {
        struct Body: Encodable {
            let type: String
            let accountId: String
            let deviceId: String
            let enabled: Bool
        }
        let body = try encoder.encode(
            Body(type: type, accountId: accountId, deviceId: deviceId, enabled: enabled)
        )
        let (data, _) = try await dispatch(method: "POST", path: "/admin/sources", body: body)
        struct Wrap: Decodable { let source: SourceRecord }
        return try decodeOrThrow(Wrap.self, from: data).source
    }

    public func listDevices() async throws -> [DeviceRecord] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/devices", body: nil)
        return try decodeOrThrow(Page<DeviceRecord>.self, from: data).items
    }

    /// Report the OS-observed notification delivery state for this paired
    /// device. This is best-effort at the AppStore call site; keeping the wire
    /// operation here makes its exact path, authorization, and JSON body
    /// independently testable.
    public func reportPushHealth(deviceId: String, status: String) async throws {
        struct Body: Encodable { let status: String }
        let body = try encoder.encode(Body(status: status))
        _ = try await dispatch(
            method: "POST",
            path: "/admin/devices/\(percentEncode(deviceId))/push-health",
            body: body
        )
    }

    /// Replace one device-hosted source's current OS capability snapshot.
    /// The source id in the path is the ownership boundary; the body mirrors
    /// the shared gateway contract exactly.
    public func reportPermissionHealth(_ report: SourcePermissionHealthReport) async throws {
        struct Body: Encodable {
            let checkedAt: Int64
            let validForMs: Int
            let capabilities: [SourcePermissionCapability]
        }
        let body = try encoder.encode(Body(
            checkedAt: Int64(report.checkedAt.timeIntervalSince1970 * 1000),
            validForMs: report.validForMs,
            capabilities: report.capabilities
        ))
        _ = try await dispatch(
            method: "PUT",
            path: "/admin/sources/\(percentEncode(report.sourceId))/permission-health",
            body: body
        )
    }

    // MARK: - Tokens

    /// GET `/admin/tokens?deviceId=` — the credentials minted for one
    /// device. Mirrors the token child-rows nested under each device in
    /// the portal's devices page. Requires `admin` scope, which paired
    /// apps hold.
    public func listTokens(deviceId: String) async throws -> [TokenRecord] {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/admin/tokens?deviceId=\(percentEncode(deviceId))",
            body: nil
        )
        return try decodeOrThrow(Page<TokenRecord>.self, from: data).items
    }

    /// DELETE `/admin/tokens/:id` — revoke one credential. Any process still
    /// using it starts getting 401s on its next request. Idempotent-ish: a
    /// 404 means it was already gone.
    public func revokeToken(id: String) async throws {
        _ = try await dispatch(
            method: "DELETE",
            path: "/admin/tokens/\(percentEncode(id))",
            body: nil
        )
    }

    // MARK: - Device mutations

    /// DELETE `/admin/devices/:id` — revoke a device and every token it
    /// holds. The device row, its sources and their data stay; pairing the
    /// same device again adopts the row.
    public func revokeDevice(id: String) async throws {
        _ = try await dispatch(
            method: "DELETE",
            path: "/admin/devices/\(percentEncode(id))",
            body: nil
        )
    }

    /// DELETE `/admin/devices/:id?forget=true` — delete a device row for
    /// good. The gateway refuses with 409 `DEVICE_STILL_HOSTS_SOURCES` while
    /// any source still points at the device, so forgetting can never take a
    /// corpus with it. Its message names those sources by id and points at a
    /// CLI remedy, so a phone surface renders the code rather than the prose.
    public func forgetDevice(id: String) async throws {
        _ = try await dispatch(
            method: "DELETE",
            path: "/admin/devices/\(percentEncode(id))?forget=true",
            body: nil
        )
    }

    /// POST `/admin/devices/pair` — mint a one-time pairing code (default
    /// 10-min TTL) for a device kind; the gateway grants that kind's
    /// canonical scopes. The new device exchanges the code for a real token
    /// via the public `POST /devices/pair`. Returns the code + its expiry.
    public func createPairing(kind: String, repairDeviceId: String? = nil) async throws -> PendingPairing {
        struct Body: Encodable {
            let kind: String
            let repairDeviceId: String?
        }
        let body = try encoder.encode(Body(kind: kind, repairDeviceId: repairDeviceId))
        let (data, _) = try await dispatch(method: "POST", path: "/admin/devices/pair", body: body)
        return try decodeOrThrow(PendingPairing.self, from: data)
    }

    /// POST `/admin/devices/pair-qr` — encode the pairing payload server-side
    /// so every client shares the versioned pairing contract. Automatic policy
    /// uses system trust for configured public origins and leaf pinning elsewhere.
    /// `gatewayUrl` is which network identity the new phone should reach.
    /// Returns the JSON string ready for QR rendering.
    public func buildPairQr(pairingCode: String, gatewayUrl: String) async throws -> String {
        struct Body: Encodable {
            let pairingCode: String
            let gatewayUrl: String
            let trustMode: String?
        }
        struct Wrap: Decodable { let qrPayload: String }
        func request(trustMode: String?) async throws -> String {
            let body = try encoder.encode(
                Body(pairingCode: pairingCode, gatewayUrl: gatewayUrl, trustMode: trustMode)
            )
            let (data, _) = try await dispatch(
                method: "POST",
                path: "/admin/devices/pair-qr",
                body: body
            )
            return try decodeOrThrow(Wrap.self, from: data).qrPayload
        }
        do {
            return try await request(trustMode: "auto")
        } catch let error as GatewayClient.Error {
            guard case .serverError(let status, _) = error,
                  status == 400,
                  error.gatewayCode == "VALIDATION_ERROR" else { throw error }
            // Older gateways predate the auto policy. Their omitted request
            // retains the V2/V3 leaf-pinned compatibility path.
            return try await request(trustMode: nil)
        }
    }

    /// GET `/admin/network-identities` — the addresses this gateway is
    /// reachable at (LAN, mDNS, Tailscale). The pairing flow lets the user
    /// pick which one bakes into the QR's `gatewayUrl` so the new phone can
    /// reach the gateway from whatever network it's on.
    public func listNetworkIdentities() async throws -> [NetworkIdentity] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/network-identities", body: nil)
        return try decodeOrThrow(Page<NetworkIdentity>.self, from: data).items
    }

    public func listSyncStatuses() async throws -> [SourceSyncStatus] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/sync/status", body: nil)
        return try decodeOrThrow(Page<SourceSyncStatus>.self, from: data).items
    }

    /// The source-descriptor registry: the union across every online
    /// collector, so it is the same whether one host or several are
    /// connected. (`/admin/sources/descriptors` is one collector's registry
    /// and refuses to pick when more than one is online.)
    public func listDescriptors() async throws -> [SerializedDescriptor] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/source-descriptors", body: nil)
        // Page<SerializedDescriptor>; each item also carries the `devices`
        // hosting it, which the registry has no use for and leaves undecoded.
        return try decodeOrThrow(Page<SerializedDescriptor>.self, from: data).items
    }

    /// Fetch the portal's icon+label map (keyed by source type). This endpoint
    /// is auth-exempt (it's served under `/portal/*`), matching what the
    /// web portal consumes.
    public func fetchSourceMeta() async throws -> [String: SourceMeta] {
        let (data, _) = try await dispatch(method: "GET", path: "/portal/source-meta.json", body: nil)
        return try decodeOrThrow([String: SourceMeta].self, from: data)
    }

    // MARK: - Models

    /// `GET /admin/models` — assignments, model controls and saved behavior.
    public func modelOverview() async throws -> ModelsOverview {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/models", body: nil)
        return try decodeOrThrow(ModelsOverview.self, from: data)
    }

    /// `GET /admin/models/recent/:capability` — the "Recently used" picker
    /// entries for the capability being configured. Older gateways answer 404,
    /// which callers treat as "no recent models" so the section hides.
    public func recentModels(capability: String) async throws -> RecentModelsResponse {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/models/recent/\(percentEncode(capability))", body: nil)
        return try decodeOrThrow(RecentModelsResponse.self, from: data)
    }

    /// `POST /admin/models/activate` — assign a catalog model (an installed local
    /// GGUF, or an Anthropic API model) to a capability. `role` is the CATALOG
    /// role (`embed`/`agent`/`transcribe`), matching the portal.
    /// `capability` explicitly targets an independent capability when several
    /// capabilities share a catalog model class, such as Agent and Privacy reviewer.
    public func activateModel(
        catalogId: String,
        role: String,
        capability: String? = nil
    ) async throws {
        struct Body: Encodable {
            let id: String
            let role: String
            let capability: String?
        }
        let body = try encoder.encode(Body(id: catalogId, role: role, capability: capability))
        _ = try await dispatch(method: "POST", path: "/admin/models/activate", body: body)
    }

    /// `PATCH /admin/config` — assign or clear a capability via the generic config
    /// patch the portal uses (`assignCapability`). `assignment` is the wire value
    /// (`"<backendKey>/<model>"` for an HTTP-backend model, or `nil` to disable);
    /// catalog models go through `activateModel` instead, matching the portal.
    public func assignCapability(role: String, assignment: String?) async throws {
        // The clear case must serialize as an explicit `{"<role>": null}` (a
        // missing key is a no-op patch, not a clear), so the assignments map is
        // encoded by hand into a dynamic-key container.
        struct Body: Encodable {
            let role: String
            let assignment: String?
            func encode(to encoder: Encoder) throws {
                var root = encoder.container(keyedBy: AnyKey.self)
                var inference = root.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("inference"))
                var assignments = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("assignments"))
                if let assignment {
                    try assignments.encode(assignment, forKey: AnyKey(role))
                } else {
                    try assignments.encodeNil(forKey: AnyKey(role))
                }
            }
        }
        let body = try encoder.encode(Body(role: role, assignment: assignment))
        _ = try await dispatch(method: "PATCH", path: "/admin/config", body: body)
    }

    // MARK: - Inference backends

    /// `PATCH /admin/config` — add (or replace) a named HTTP inference backend,
    /// exactly like the portal's `addHttpBackend`. The body is
    /// `{inference:{backends:{<key>:{type:"http",url,apiKey?,apiPathPrefix?}}}}`.
    /// `apiKey` is write-only: it's sent here but never read back (the gateway
    /// only ever surfaces a `hasApiKey` bool), so it's never rendered or logged.
    /// The caller validates the key against `ModelManagement.validateBackendName`
    /// first (reserved names / no slash); the gateway re-validates.
    public func addHttpBackend(
        key: String,
        url: String,
        apiKey: String? = nil,
        apiPathPrefix: String? = nil
    ) async throws {
        struct Config: Encodable {
            let type = "http"
            let url: String
            let apiKey: String?
            let apiPathPrefix: String?
        }
        // The backends map has a dynamic key (the backend name), so the
        // `inference.backends` object is encoded by hand the same way the
        // capability-assignment patch is.
        struct Body: Encodable {
            let key: String
            let config: Config
            func encode(to encoder: Encoder) throws {
                var root = encoder.container(keyedBy: AnyKey.self)
                var inference = root.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("inference"))
                var backends = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("backends"))
                try backends.encode(config, forKey: AnyKey(key))
            }
        }
        let cfg = Config(
            url: url,
            apiKey: (apiKey?.isEmpty == false) ? apiKey : nil,
            apiPathPrefix: (apiPathPrefix?.isEmpty == false) ? apiPathPrefix : nil
        )
        let body = try encoder.encode(Body(key: key, config: cfg))
        _ = try await dispatch(method: "PATCH", path: "/admin/config", body: body)
    }

    /// `PATCH /admin/config` — remove an HTTP backend by setting its key to an
    /// explicit `null` (mirrors the portal's `removeHttpBackend`). Like the
    /// capability clear, the null must be serialized explicitly (a missing key
    /// is a no-op patch), so the backends map is hand-encoded.
    public func removeHttpBackend(key: String) async throws {
        struct Body: Encodable {
            let key: String
            func encode(to encoder: Encoder) throws {
                var root = encoder.container(keyedBy: AnyKey.self)
                var inference = root.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("inference"))
                var backends = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("backends"))
                try backends.encodeNil(forKey: AnyKey(key))
            }
        }
        let body = try encoder.encode(Body(key: key))
        _ = try await dispatch(method: "PATCH", path: "/admin/config", body: body)
    }

    /// `POST /admin/inference/backends/:key/probe` — re-probe a configured HTTP
    /// backend. Reachability + the served-model list are refreshed server-side
    /// (the cached status the next overview reads is updated in the same pass).
    public func probeBackend(key: String) async throws -> ProbeResult {
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/admin/inference/backends/\(percentEncode(key))/probe",
            body: Data("{}".utf8)
        )
        return try decodeOrThrow(ProbeResult.self, from: data)
    }

    /// `POST /admin/inference/backends/:key/verify` — behaviorally confirm that
    /// one of a backend's models can actually serve `role` (one of
    /// embedder/agent). Unlike the reachability probe, this
    /// issues the role's minimal capability call (an embedding, a chat
    /// completion, …) and reports the authoritative verdict. On-demand only —
    /// never auto-issued per model on page load. `force` bypasses the gateway's
    /// per-(backend, model, role) verdict cache. Returns the `CapabilityVerdict`.
    public func verifyModel(
        key: String,
        model: String,
        role: String,
        force: Bool = false
    ) async throws
        -> CapabilityVerdict {
        struct Body: Encodable {
            let model: String
            let role: String
            let force: Bool
        }
        let body = try encoder.encode(Body(model: model, role: role, force: force))
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/admin/inference/backends/\(percentEncode(key))/verify",
            body: body
        )
        return try decodeOrThrow(CapabilityVerdict.self, from: data)
    }

    /// `POST /admin/inference/codex/refresh` — refresh the experimental Codex
    /// backend's login/model-catalog status. Codex is not an HTTP backend: it is
    /// backed by the gateway host's Codex CLI and dedicated Codex home.
    public func refreshCodexBackend() async throws -> CodexBackendStatus {
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/admin/inference/codex/refresh",
            body: Data("{}".utf8)
        )
        return try decodeOrThrow(CodexBackendStatus.self, from: data)
    }

    /// `POST /admin/inference/codex/login` — start Codex's device-login flow.
    /// The response contains the OpenAI device URL + one-time code once the CLI
    /// emits them; the user completes auth in a browser.
    public func startCodexLogin() async throws -> CodexLoginFlow {
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/admin/inference/codex/login",
            body: Data("{}".utf8)
        )
        return try decodeOrThrow(CodexLoginFlow.self, from: data)
    }

    /// `GET /admin/inference/codex/login` — read the active Codex device-login
    /// flow, if one is still pending/completing on the gateway host.
    public func getCodexLogin() async throws -> CodexLoginFlow? {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/inference/codex/login", body: nil)
        struct Wrap: Decodable { let flow: CodexLoginFlow? }
        return try decodeOrThrow(Wrap.self, from: data).flow
    }

    /// `DELETE /admin/inference/codex/login` — cancel any active Codex
    /// device-login process.
    public func cancelCodexLogin() async throws -> CodexCancelLoginResult {
        let (data, _) = try await dispatch(method: "DELETE", path: "/admin/inference/codex/login", body: nil)
        return try decodeOrThrow(CodexCancelLoginResult.self, from: data)
    }

    /// `DELETE /admin/inference/codex` — log out the dedicated Codex home,
    /// remove the stored auth file if needed, and clear `codex/...`
    /// assignments. This makes Codex disappear from the backend list until it
    /// is added/logged in again.
    public func removeCodexBackend() async throws -> CodexRemoveResult {
        let (data, _) = try await dispatch(method: "DELETE", path: "/admin/inference/codex", body: nil)
        return try decodeOrThrow(CodexRemoveResult.self, from: data)
    }

    // MARK: - Model-provider credentials

    /// `GET /admin/model-credentials` — the gateway-host model-provider
    /// credential registry (Anthropic API key today, more providers later).
    /// One row per provider, each carrying its field spec + a `configured`
    /// bool. The secret values themselves are never returned (the gateway
    /// only ever surfaces `configured`), so nothing sensitive is decoded.
    public func listModelCredentials() async throws -> [ModelCredentialEntry] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/model-credentials", body: nil)
        // The route returns Page<ModelCredentialEntry> with a sibling
        // `hostname`; we only need the entries.
        return try decodeOrThrow(Page<ModelCredentialEntry>.self, from: data).items
    }

    /// `POST /admin/model-credentials/:fileKey` — write a provider's
    /// credentials. `fields` maps each spec field name to its value (e.g.
    /// `["apiKey": "sk-ant-…"]`). The values are write-only: sent here, never
    /// read back or rendered (the registry only surfaces a `configured` bool),
    /// so they're never logged. The gateway validates required fields + the
    /// per-field pattern and re-evaluates model availability on success.
    public func setModelCredentials(fileKey: String, fields: [String: String]) async throws {
        struct Body: Encodable { let fields: [String: String] }
        let body = try encoder.encode(Body(fields: fields))
        _ = try await dispatch(
            method: "POST",
            path: "/admin/model-credentials/\(percentEncode(fileKey))",
            body: body
        )
    }

    /// `DELETE /admin/model-credentials/:fileKey` — clear a provider's
    /// credentials (removes the credentials file). Idempotent.
    public func clearModelCredentials(fileKey: String) async throws {
        _ = try await dispatch(
            method: "DELETE",
            path: "/admin/model-credentials/\(percentEncode(fileKey))",
            body: nil
        )
    }

    // MARK: - Local model lifecycle

    /// `GET /admin/system-info` — host capacity snapshot used for the local-model
    /// "fit" badge (free RAM + free model-dir disk).
    public func systemInfo() async throws -> SystemInfo {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/system-info", body: nil)
        return try decodeOrThrow(SystemInfo.self, from: data)
    }

    /// `POST /admin/models/install` — start a GATEWAY-side GGUF download for the
    /// catalog `id`. The file is downloaded on the gateway host (not the phone);
    /// progress then shows up in the overview's `activeDownloads`, which the
    /// local-model list polls while a download is in flight. Returns the
    /// server-assigned `downloadId`.
    @discardableResult
    public func installModel(id: String) async throws -> String {
        struct Body: Encodable { let id: String }
        struct Reply: Decodable { let downloadId: String }
        let body = try encoder.encode(Body(id: id))
        let (data, _) = try await dispatch(method: "POST", path: "/admin/models/install", body: body)
        return try decodeOrThrow(Reply.self, from: data).downloadId
    }

    /// `POST /admin/models/cancel-download` — cancel the in-flight download for
    /// the catalog `id` (the route keys by model id, not download id). Returns
    /// whether a download was actually cancelled.
    @discardableResult
    public func cancelModelDownload(id: String) async throws -> Bool {
        struct Body: Encodable { let id: String }
        struct Reply: Decodable { let cancelled: Bool }
        let body = try encoder.encode(Body(id: id))
        let (data, _) = try await dispatch(method: "POST", path: "/admin/models/cancel-download", body: body)
        return try decodeOrThrow(Reply.self, from: data).cancelled
    }

    /// `DELETE /admin/models/:id` — uninstall a downloaded local GGUF (the file
    /// is deleted from the gateway host's models directory). The gateway rejects
    /// removing a model currently assigned to a capability.
    public func uninstallModel(id: String) async throws {
        _ = try await dispatch(
            method: "DELETE",
            path: "/admin/models/\(percentEncode(id))",
            body: nil
        )
    }

    // MARK: - Source actions

    /// Trigger a sync on the device hosting the given source.
    public func syncSource(sourceId: String) async throws {
        _ = try await dispatch(
            method: "POST",
            path: "/admin/sources/\(percentEncode(sourceId))/sync",
            body: Data("{}".utf8)
        )
    }

    /// Toggle enabled/disabled and/or patch config.
    @discardableResult
    public func patchSource(
        sourceId: String,
        enabled: Bool? = nil,
        config: [String: JSONValue]? = nil,
        deviceId: String? = nil,
        multiDeviceMode: SourceMultiDeviceMode? = nil
    ) async throws
        -> SourceRecord {
        struct Body: Encodable {
            let enabled: Bool?
            let config: [String: JSONValue]?
            let deviceId: String?
            let multiDeviceMode: SourceMultiDeviceMode?
        }
        let body = try encoder.encode(Body(
            enabled: enabled,
            config: config,
            deviceId: deviceId,
            multiDeviceMode: multiDeviceMode
        ))
        let (data, _) = try await dispatch(
            method: "PATCH",
            path: "/admin/sources/\(percentEncode(sourceId))",
            body: body
        )
        struct Wrap: Decodable { let source: SourceRecord }
        let source = try decodeOrThrow(Wrap.self, from: data).source
        if let multiDeviceMode, source.multiDeviceMode != multiDeviceMode.rawValue {
            throw SourceModeTransitionNotConfirmed(mode: multiDeviceMode)
        }
        return source
    }

    /// Remove a source (gateway then routes to the hosting collector).
    public func removeSource(sourceId: String) async throws {
        _ = try await dispatch(
            method: "DELETE",
            path: "/admin/sources/\(percentEncode(sourceId))",
            body: nil
        )
    }

    // MARK: - Source membership

    /// POST `/admin/sources/:id/members` — add a device as a host of a
    /// source. Idempotent for a device that already hosts it. Refused with
    /// 409 `SOURCE_ALREADY_HOSTED` for a type only one device may host that
    /// another device already does, and 400 `DEVICE_CANNOT_HOST_TYPE` when
    /// the device's kind cannot run the type.
    @discardableResult
    public func joinSource(sourceId: String, deviceId: String) async throws -> SourceMembership {
        struct Body: Encodable { let deviceId: String }
        let body = try encoder.encode(Body(deviceId: deviceId))
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/admin/sources/\(percentEncode(sourceId))/members",
            body: body
        )
        return try decodeOrThrow(SourceMembership.self, from: data)
    }

    /// DELETE `/admin/sources/:id/members/:deviceId` — stop one device from
    /// hosting a source; what it already contributed stays. Refused with
    /// 409 `LAST_MEMBER` when the device is the source's only host (pause
    /// or remove the source instead) and 409 `DEVICE_NOT_MEMBER` when the
    /// device does not host it. 404 `SOURCE_NOT_FOUND` surfaces as `.notFound`.
    @discardableResult
    public func detachSourceMember(sourceId: String, deviceId: String) async throws -> SourceMembership {
        let (data, _) = try await dispatch(
            method: "DELETE",
            path: "/admin/sources/\(percentEncode(sourceId))/members/\(percentEncode(deviceId))",
            body: nil
        )
        return try decodeOrThrow(SourceMembership.self, from: data)
    }

    /// GET `/admin/sources/:id/debug` — collector-side debug snapshot.
    /// The gateway proxies this to the device that owns the source via
    /// the WS `source.debug` command, so the response shape is whatever
    /// the source returns. We expose it as a free-form JSONValue so the
    /// debug view can pretty-print it without per-source decoders.
    public func sourceDebug(sourceId: String) async throws -> JSONValue {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/admin/sources/\(percentEncode(sourceId))/debug",
            body: nil
        )
        return try decodeOrThrow(JSONValue.self, from: data)
    }

    /// Delete all ingested documents (and analytics rows) for a source.
    /// The first step of the mobile clients' two-step Resync — followed by
    /// `syncSource(...)` to re-fetch from scratch. The portal and CLI resync
    /// in one request through `POST /admin/sources/:id/resync` instead.
    @discardableResult
    public func deleteAllForSource(sourceId: String) async throws -> DeleteAllResponse {
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/documents/delete-all/source/\(percentEncode(sourceId))",
            body: Data("{}".utf8)
        )
        return try decodeOrThrow(DeleteAllResponse.self, from: data)
    }

    // MARK: - Core request machinery

    private func dispatch(
        method: String,
        path: String,
        body: Data?
    ) async throws
        -> (Data, HTTPURLResponse) {
        guard let requestURL = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let pairingGeneration {
            request.setValue(
                pairingGeneration,
                forHTTPHeaderField: "Omnesis-Pairing-Generation"
            )
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299:
            return (data, http)
        case 401:
            throw GatewayClient.Error.unauthorized
        case 403:
            throw GatewayClient.Error.forbidden
        case 404:
            throw GatewayClient.Error.notFound
        default:
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GatewayClient.Error.serverError(status: http.statusCode, body: text)
        }
    }

    private func decodeOrThrow<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw GatewayClient.Error.decoding("\(error)")
        }
    }

    private func percentEncode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}

extension AdminClient {
    /// Save overrides only for the role's currently assigned model.
    public func updateModelBehavior(
        role: String,
        assignment: String,
        values: ModelBehaviorValues,
        expectedValues: ModelBehaviorValues? = nil
    ) async throws {
        struct Body: Encodable {
            let assignment: String
            let values: ModelBehaviorValues
            let expectedValues: ModelBehaviorValues?
        }
        let body = try encoder.encode(Body(assignment: assignment, values: values, expectedValues: expectedValues))
        _ = try await dispatch(method: "PATCH", path: "/admin/models/behavior/\(percentEncode(role))", body: body)
    }

    /// Fetch a validated SVG from the paired gateway cache.
    public func modelProviderLogo(providerId: String) async throws -> Data {
        guard providerId.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil else {
            throw GatewayClient.Error.invalidURL
        }
        let (data, response) = try await dispatch(
            method: "GET",
            path: "/model-logos/\(percentEncode(providerId)).svg",
            body: nil
        )
        guard response.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("image/svg+xml") == true else {
            throw GatewayClient.Error.invalidResponse
        }
        return data
    }
}

/// A `CodingKey` whose value is supplied at runtime — for encoding maps with
/// dynamic string keys (e.g. the `inference.assignments` capability patch).
struct AnyKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init(_ stringValue: String) {
        self.stringValue = stringValue
    }

    init?(stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue _: Int) {
        nil
    }
}
