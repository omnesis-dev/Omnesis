// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Wire types for the gateway's `/admin/*` surface, decoded by `AdminClient`
// and shared with every view that renders sources, devices, models and
// inference backends. Mirrors the TypeScript shapes in `@omnesis/core`.

/// Generic pagination envelope. Every gateway list endpoint
/// returns `{ items, pageInfo }`. Lives in `@omnesis/core` on the TS
/// side; mirrored here so `AdminClient`, `GatewayClient`, etc. can all
/// share one decoding pass.
public struct Page<T: Decodable & Sendable>: Decodable, Sendable {
    public let items: [T]
    public let pageInfo: PageInfo

    public init(items: [T], pageInfo: PageInfo) {
        self.items = items
        self.pageInfo = pageInfo
    }
}

public struct PageInfo: Decodable, Equatable, Sendable {
    public let hasMore: Bool
    public let limit: Int
    /// Opaque — clients pass it back as `?cursor=...`. Present iff `hasMore`.
    public let nextCursor: String?

    public init(hasMore: Bool, limit: Int, nextCursor: String? = nil) {
        self.hasMore = hasMore
        self.limit = limit
        self.nextCursor = hasMore ? nextCursor : nil
    }

    static func exhausted(limit: Int) -> PageInfo {
        PageInfo(hasMore: false, limit: limit)
    }
}

/// Active registrations, internal datasets and retained removal state.
public struct SourceInventory: Sendable {
    public let sources: [SourceRecord]
    public let internalSources: [InternalSource]
    public let removedSourceIds: [String]
    public let pendingRemovals: [PendingSourceRemoval]
}

/// A deleted source whose managed gateway cleanup has not completed.
public struct PendingSourceRemoval: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let type: String
    public let accountId: String

    public init(id: String, type: String, accountId: String) {
        self.id = id
        self.type = type
        self.accountId = accountId
    }
}

/// One row of `/admin/sources`. Mirrors `packages/gateway/src/sources.ts::SourceRecord`.
public struct SourceRecord: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let type: String
    public let accountId: String
    public let deviceId: String
    public let config: [String: JSONValue]
    public let enabled: Bool
    public let createdAt: Int64
    public let updatedAt: Int64
    /// Every device hosting the source, the owner first. A gateway that
    /// predates membership omits the field, leaving `deviceId` the sole host.
    public let members: [String]
    /// How the source's type shares its row across devices — `exclusive`,
    /// `handoff`, `replicated`, `partitioned`. Nil on a gateway that
    /// predates multi-device modes.
    public let multiDeviceMode: String?

    /// Whether `deviceId` contributes to this source, on gateways with and
    /// without membership.
    public func hosts(_ deviceId: String) -> Bool {
        deviceId == self.deviceId || members.contains(deviceId)
    }

    /// Every device hosting this source, owner first. Older gateways omit
    /// `members`, so the source's owner remains the sole host in that case.
    public var hostDeviceIds: [String] {
        let advertised = members.isEmpty ? [deviceId] : members
        return advertised.reduce(into: [String]()) { result, id in
            guard !id.isEmpty, !result.contains(id) else { return }
            result.append(id)
        }
    }

    public init(
        id: String,
        type: String,
        accountId: String,
        deviceId: String,
        config: [String: JSONValue] = [:],
        enabled: Bool = true,
        createdAt: Int64 = 0,
        updatedAt: Int64 = 0,
        members: [String] = [],
        multiDeviceMode: String? = nil
    ) {
        self.id = id
        self.type = type
        self.accountId = accountId
        self.deviceId = deviceId
        self.config = config
        self.enabled = enabled
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.members = members
        self.multiDeviceMode = multiDeviceMode
    }

    private enum CodingKeys: String, CodingKey {
        case id, type, accountId, deviceId, config, enabled, createdAt, updatedAt
        case members, multiDeviceMode
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(String.self, forKey: .type)
        accountId = try container.decode(String.self, forKey: .accountId)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        config = try container.decode([String: JSONValue].self, forKey: .config)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        createdAt = try container.decode(Int64.self, forKey: .createdAt)
        updatedAt = try container.decode(Int64.self, forKey: .updatedAt)
        members = try container.decodeIfPresent([String].self, forKey: .members) ?? []
        multiDeviceMode = try container.decodeIfPresent(String.self, forKey: .multiDeviceMode)
    }
}

/// One gateway-internal source from `GET /admin/sources`' `internalSources`
/// array — a dataset the gateway hosts itself (a dataset the gateway hosts itself)
/// with no collector, no sync engine and no `sources`-table row. Only the
/// id travels on the wire: counts and activity come from `/status`, and
/// display identity (label, icon, colors) from the source-meta feed, all
/// keyed by the same id.
public struct InternalSource: Decodable, Hashable, Sendable {
    public let id: String

    public init(id: String) {
        self.id = id
    }
}

/// The source and its host list a membership mutation returns
/// (`POST /admin/sources/:id/members`, `DELETE …/members/:deviceId`).
public struct SourceMembership: Decodable, Equatable, Sendable {
    public let source: SourceRecord
    /// Device ids hosting the source, owner first.
    public let members: [String]

    public init(source: SourceRecord, members: [String]) {
        self.source = source
        self.members = members
    }
}

/// One row of `/admin/devices`. Mirrors `DeviceRecord` from `@omnesis/core`.
/// Only the fields the iOS device-management surface renders are decoded;
/// `capabilities` is decoded just far enough to surface a host name or
/// external-agent integration identity; the rest of the blob is ignored.
public struct DeviceRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let kind: String
    public let pairedAt: Int64
    public let lastSeenAt: Int64?
    /// Unix ms at which the device's access was revoked; nil while paired.
    /// A revoked device keeps its row, its sources and their data until it
    /// is re-paired (which adopts the row) or forgotten.
    public let revokedAt: Int64?
    public let capabilities: DeviceCapabilities?
    /// Not part of the stored record — appended by `/admin/devices` based
    /// on current WS connection state.
    public let online: Bool?

    /// Whether the gateway has revoked this device's access.
    public var isRevoked: Bool {
        revokedAt != nil
    }

    public init(
        id: String,
        name: String,
        kind: String,
        pairedAt: Int64,
        lastSeenAt: Int64? = nil,
        revokedAt: Int64? = nil,
        capabilities: DeviceCapabilities? = nil,
        online: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.pairedAt = pairedAt
        self.lastSeenAt = lastSeenAt
        self.revokedAt = revokedAt
        self.capabilities = capabilities
        self.online = online
    }
}

/// Subset of a device's `capabilities` blob the device list surfaces:
/// the software-side `hostname` and an external-agent integration identity.
public struct DeviceCapabilities: Decodable, Equatable, Sendable {
    public let hostname: String?
    public let agentIntegration: AgentIntegrationCapability?

    public init(
        hostname: String? = nil,
        agentIntegration: AgentIntegrationCapability? = nil
    ) {
        self.hostname = hostname
        self.agentIntegration = agentIntegration
    }
}

/// Display-safe portion of `capabilities.agentIntegration`.
public struct AgentIntegrationCapability: Decodable, Equatable, Sendable {
    public let harness: String
    public let deliveryProtocolMin: Int
    public let deliveryProtocolMax: Int
    public let maxConcurrentRuns: Int

    public init(
        harness: String,
        deliveryProtocolMin: Int = 2,
        deliveryProtocolMax: Int = 2,
        maxConcurrentRuns: Int = 1
    ) {
        self.harness = harness
        self.deliveryProtocolMin = deliveryProtocolMin
        self.deliveryProtocolMax = deliveryProtocolMax
        self.maxConcurrentRuns = maxConcurrentRuns
    }
}

/// One row of `/admin/tokens`. Mirrors `TokenInfo` in
/// `packages/gateway/src/data/repositories/TokenRepository.ts` — the
/// shape `listTokens` returns. Revoked tokens are deleted (not flagged),
/// so there is no `revokedAt`; `lastUsedAt` is null until the token has
/// authenticated a request at least once.
public struct TokenRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let deviceId: String
    public let name: String?
    public let scopes: [String]
    public let createdAt: Int64
    public let lastUsedAt: Int64?

    public init(
        id: String,
        deviceId: String,
        name: String? = nil,
        scopes: [String] = [],
        createdAt: Int64 = 0,
        lastUsedAt: Int64? = nil
    ) {
        self.id = id
        self.deviceId = deviceId
        self.name = name
        self.scopes = scopes
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
    }
}

/// Response of `POST /admin/devices/pair`. Mirrors `PendingPairing` in the
/// gateway's `DeviceRepository.ts`. Only the fields the pairing UI renders
/// are decoded — the one-time `pairingCode` and its `expiresAt` (unix ms).
public struct PendingPairing: Decodable, Equatable, Sendable {
    public let pairingCode: String
    public let expiresAt: Int64

    public init(pairingCode: String, expiresAt: Int64) {
        self.pairingCode = pairingCode
        self.expiresAt = expiresAt
    }
}

/// One row of `/admin/network-identities`. Mirrors `NetworkIdentity` in
/// `@omnesis/core/network-discovery.ts` — an address the gateway is
/// reachable at, with a human label and an off-LAN flag the pairing UI
/// flags as the recommended pick when the user is traveling.
public struct NetworkIdentity: Decodable, Equatable, Sendable, Identifiable {
    public var id: String {
        address
    }

    public let address: String
    public let label: String
    public let kind: String
    public let offLan: Bool

    public init(address: String, label: String, kind: String, offLan: Bool) {
        self.address = address
        self.label = label
        self.kind = kind
        self.offLan = offLan
    }
}

/// One row of `/admin/sync/status`. Mirrors `DisplaySyncStatus` in
/// packages/gateway/src/sync-status.ts — the gateway pre-maps state into
/// idle / syncing / synced / error / disabled, and `lastSyncAt` is an
/// ISO timestamp (persisted, survives gateway restart).
public struct SourceSyncStatus: Decodable, Equatable, Sendable, Identifiable {
    public var id: String {
        sourceId
    }

    public let sourceId: String
    public let deviceId: String?
    /// Per-device status rows for a multi-device source. The enclosing row is
    /// the fleet aggregate; a phone-local surface selects its own member.
    public let members: [SourceSyncStatus]?
    public let state: String
    public let unitName: String?
    public let progress: Progress?
    public let startedAt: Int64?
    public let lastSyncAt: String?
    public let errorMessage: String?
    public let erroredAt: String?
    public let lastUpdated: Int64?

    /// Forward-looking consent / authorization deadline (ISO 8601) the source
    /// last reported, when known (#927). Mirrors `DisplaySyncStatus.consentExpiresAt`
    /// in packages/gateway/src/sync-status.ts. Present whenever a deadline is
    /// stored — independent of `state`, so a healthy `synced` source can still
    /// surface "your connection expires on <date>". When `state ==
    /// "auth-expiring"` it is the deadline driving the non-terminal warning.
    /// `nil` means no known deadline.
    public let consentExpiresAt: String?

    /// The source's own remediation sentence when `state == "stale"` — its
    /// local data feed has stopped delivering, typically because the app that
    /// maintains the file isn't running. Authored by the provider package that
    /// knows what actually feeds the source and rendered verbatim, so no shared
    /// UI code has to map sources to programs. Mirrors
    /// `DisplaySyncStatus.staleHint` in packages/gateway/src/sync-status.ts.
    /// `nil` in every other state.
    public let staleHint: String?

    /// What a person should be told about this status, most severe first,
    /// composed by the gateway (`buildSourceNotices` in
    /// packages/gateway/src/source-notices.ts). Rendered verbatim as icons
    /// beside the device they belong to. On a source several devices
    /// contribute to, each member carries its own and the aggregate carries
    /// none. `nil` means the gateway predates the field — read
    /// `displayNotices`, which covers that case.
    public let notices: [SourceNotice]?

    /// Memberwise init for the WS merge and for previews. The fields a status
    /// often lacks are defaulted; the `Decodable` path reads them from the
    /// wire.
    public init(
        sourceId: String,
        deviceId: String?,
        members: [SourceSyncStatus]? = nil,
        state: String,
        unitName: String?,
        progress: Progress?,
        startedAt: Int64?,
        lastSyncAt: String?,
        errorMessage: String?,
        erroredAt: String?,
        lastUpdated: Int64?,
        consentExpiresAt: String? = nil,
        staleHint: String? = nil,
        notices: [SourceNotice]? = nil
    ) {
        self.sourceId = sourceId
        self.deviceId = deviceId
        self.members = members
        self.state = state
        self.unitName = unitName
        self.progress = progress
        self.startedAt = startedAt
        self.lastSyncAt = lastSyncAt
        self.errorMessage = errorMessage
        self.erroredAt = erroredAt
        self.lastUpdated = lastUpdated
        self.consentExpiresAt = consentExpiresAt
        self.staleHint = staleHint
        self.notices = notices
    }

    private enum CodingKeys: String, CodingKey {
        case sourceId
        case deviceId
        case members
        case state
        case unitName
        case progress
        case startedAt
        case lastSyncAt
        case errorMessage
        case erroredAt
        case lastUpdated
        case consentExpiresAt
        case staleHint
        case notices
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sourceId = try container.decode(String.self, forKey: .sourceId)
        deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId)
        members = try container.decodeIfPresent([SourceSyncStatus].self, forKey: .members)
        state = try container.decode(String.self, forKey: .state)
        unitName = try container.decodeIfPresent(String.self, forKey: .unitName)
        progress = try container.decodeIfPresent(Progress.self, forKey: .progress)
        startedAt = try container.decodeIfPresent(Int64.self, forKey: .startedAt)
        lastSyncAt = try container.decodeIfPresent(String.self, forKey: .lastSyncAt)
        errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
        erroredAt = try container.decodeIfPresent(String.self, forKey: .erroredAt)
        lastUpdated = try container.decodeIfPresent(Int64.self, forKey: .lastUpdated)
        consentExpiresAt = try container.decodeIfPresent(String.self, forKey: .consentExpiresAt)
        staleHint = try container.decodeIfPresent(String.self, forKey: .staleHint)
        // One malformed notice must not cost the whole status page: entries
        // that do not decode are skipped, the rest are kept in order.
        notices = try container.decodeIfPresent([LossyNotice].self, forKey: .notices)?.compactMap(\.notice)
    }

    private struct LossyNotice: Decodable {
        let notice: SourceNotice?
        init(from decoder: Decoder) throws {
            notice = try? SourceNotice(from: decoder)
        }
    }

    /// Field names match `DisplaySyncStatus.progress` in
    /// packages/gateway/src/sync-status.ts and the canonical `SyncProgress`
    /// in @omnesis/core. The collector forwards them verbatim — no rename
    /// at any boundary.
    public struct Progress: Decodable, Equatable, Sendable {
        public let phase: String?
        public let total: Int?
        public let processed: Int?
        public let percentComplete: Double?
        public let message: String?
    }
}

extension SourceSyncStatus {
    /// Select one device's contribution from a multi-device aggregate.
    /// Single-device and older-gateway payloads have no member rows.
    public func status(forDeviceId deviceId: String) -> SourceSyncStatus? {
        guard let members else {
            return self.deviceId == nil || self.deviceId == deviceId ? self : nil
        }
        return members.first(where: { $0.deviceId == deviceId })
    }

    func replacingMembers(_ members: [SourceSyncStatus]?) -> SourceSyncStatus {
        SourceSyncStatus(
            sourceId: sourceId,
            deviceId: deviceId,
            members: members,
            state: state,
            unitName: unitName,
            progress: progress,
            startedAt: startedAt,
            lastSyncAt: lastSyncAt,
            errorMessage: errorMessage,
            erroredAt: erroredAt,
            lastUpdated: lastUpdated,
            consentExpiresAt: consentExpiresAt,
            staleHint: staleHint,
            notices: notices
        )
    }
}

/// Wire shape of `POST /documents/delete-all/source/:sourceId`. The
/// gateway reports the number of doc rows removed plus any analytics
/// tables it dropped. iOS surfaces the count in the inline status text.
public struct DeleteAllResponse: Decodable, Equatable, Sendable {
    public let deleted: Int
    public let analyticsDropped: [String]?
}

/// One entry of `/portal/source-meta.json` — base64 PNG icon + label
/// + optional brand color pair, keyed by source type or full sourceId.
/// Mirrors `SourceMetaEntry` in `@omnesis/source-sdk/source-meta.ts`.
public struct SourceMeta: Decodable, Equatable, Sendable {
    public let icon: String?
    public let label: String?
    /// Brand accent hex (e.g. "#EA4335"). Used as the sticky-tab border
    /// and citation-card left-bar tint.
    public let accentColor: String?
    /// Brand dark-mode background hex (e.g. "#2D1716"). Used as the
    /// sticky-tab fill and citation-card surface.
    public let bgColor: String?
}

/// Subset of `SerializedDescriptor` from @omnesis/core that the iOS app
/// cares about. We hide OAuth sources from the "add" flow, so decoding
/// only the fields we need keeps this forward-compatible with new fields
/// added on the gateway side.
public struct SerializedDescriptor: Decodable, Equatable, Sendable, Identifiable {
    public var id: String {
        typeId
    }

    public let typeId: String
    public let name: String
    public let description: String
    public let authType: String
    public let singleInstance: Bool
    public let hasAuthFlow: Bool
    public let hasDiscover: Bool
    public let provider: Provider
    /// Human-friendly name for the unit of data this source emits
    /// ("emails", "messages", "activities", "sessions", …). Provider-
    /// declared via `SourceDescriptor.unitName` so source-specific
    /// labels stay owned by the provider package — the agent UI and
    /// any other consumer reads from here rather than hardcoding a
    /// type → label map.
    public let unitName: String?
    /// The family's own art, as the source's definition declares it. The
    /// gateway rasterises a hosted URL into `imageDataUri` before serving
    /// this, so a consumer never has to fetch one.
    public let icon: Icon?
    public struct Provider: Decodable, Equatable, Sendable {
        public let id: String
        public let name: String
    }

    public struct Icon: Decodable, Equatable, Sendable {
        public let imageDataUri: String?
        public let url: String?
        public let color: String?
        public let bgColor: String?
    }

    enum CodingKeys: String, CodingKey {
        case typeId = "id"
        case name
        case description
        case authType
        case singleInstance
        case hasAuthFlow
        case hasDiscover
        case provider
        case unitName
        case icon
    }
}
