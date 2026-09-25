// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Reusable fixture data for SwiftUI `#Preview` blocks and for the
/// snapshot-test harness. Centralises every Decodable construction so
/// adding a new view with a preview is just `PreviewMocks.foo`.
///
/// Everything here is `#if DEBUG` only — never shipped in release.
@available(iOS 17.0, *)
enum PreviewMocks {
    static let modelReasoningControls = ModelControls(
        providerId: "openai",
        source: "models.dev",
        reasoning: true,
        controls: [
            ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning"),
            ModelControl(key: "reasoningEffort", type: "enum", label: "Reasoning effort", values: ["low", "medium", "high", "xhigh"]),
            ModelControl(key: "reasoningBudgetTokens", type: "integer", label: "Reasoning token budget", min: 1, max: 8192),
        ],
        logoUrl: "/model-logos/openai.svg"
    )

    static let modelReasoningValues = ModelBehaviorValues(
        reasoningEnabled: true,
        reasoningEffort: "medium",
        reasoningBudgetTokens: 2048
    )

    /// Fictional monochrome SVG used to preview the native gateway-logo
    /// renderer without bundling any provider trademark artwork.
    static let providerLogoSampleSVG = Data("""
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" stroke-width="7"/>
      <circle cx="32" cy="32" r="12" fill="currentColor"/>
    </svg>
    """.utf8)

    static let modelExclusiveReasoningControls = ModelControls(
        providerId: "openrouter",
        source: "models.dev",
        reasoning: true,
        controls: [
            ModelControl(
                key: "reasoningEffort", type: "enum", label: "Reasoning effort",
                values: ["low", "medium", "high"], exclusiveWith: ["reasoningBudgetTokens"]
            ),
            ModelControl(
                key: "reasoningBudgetTokens", type: "integer", label: "Reasoning token budget",
                min: 1, max: 8192, exclusiveWith: ["reasoningEffort"]
            ),
        ]
    )

    static let modelUnlimitedBudgetControls = ModelControls(
        providerId: "nvidia", source: "models.dev", reasoning: true,
        controls: [
            ModelControl(key: "reasoningBudgetTokens", type: "integer", label: "Reasoning token budget", min: -1, max: 32768),
        ],
        logoUrl: "/model-logos/nvidia.svg"
    )

    static let pendingSourceRemoval = PendingSourceRemoval(
        id: "notes-synth:retired@example.com", type: "notes-synth", accountId: "retired@example.com"
    )

    /// A version identity for previews and snapshots. The product version and
    /// build are invented and fixed, so a release bump does not change what a
    /// snapshot renders; the protocol number is the real one the socket
    /// speaks, because that is a number a reader may check against a gateway.
    static var appVersionInfo: AppVersionInfo {
        AppVersionInfo(version: "1.0.0", build: "100", wireProtocol: DeviceSocket.protocolVersion)
    }

    /// What a bundle declaring no version reads as, per `AppBuild`'s fallbacks.
    static var appVersionInfoUnknown: AppVersionInfo {
        AppVersionInfo(version: "0.0.0", build: "0", wireProtocol: DeviceSocket.protocolVersion)
    }

    static let relayPushAppId = "dev.omnesis.ios"
    static let independentlySignedAppId = "com.example.myomnesis"
    static let relayPushConsentError =
        "The gateway could not save this permission. Check the connection and try again."

    static let accessAuthorizationRequest = AccessAuthorizationRequest(
        id: "authorization-preview",
        approvalId: "approval-preview",
        status: "pending",
        clientId: "client-studio",
        clientName: "Studio assistant",
        clientUri: "https://studio-assistant.example.com",
        redirectOrigin: "http://127.0.0.1:49152",
        resource: "https://gateway.example.com/mcp",
        scope: "mcp answer direct",
        expiresAt: Int64((Date().timeIntervalSince1970 + 540) * 1000),
        requiresAnswer: false
    )

    /// The same request from an agent that asks through Answer, so a level or
    /// connection without Answer cannot serve it.
    static let accessAuthorizationRequestRequiringAnswer = AccessAuthorizationRequest(
        id: "authorization-preview-answer",
        approvalId: "approval-preview-answer",
        status: "pending",
        clientId: "client-studio",
        clientName: "Studio assistant",
        clientUri: "https://studio-assistant.example.com",
        redirectOrigin: "http://127.0.0.1:49152",
        resource: "https://gateway.example.com/mcp",
        scope: "mcp answer",
        expiresAt: Int64((Date().timeIntervalSince1970 + 540) * 1000),
        requiresAnswer: true
    )

    /// Answer over two sources plus Notes, shared by two connections, so a
    /// review of a new connection on it says who else it changes.
    static let accessResearchLevel = AccessLevelSummary(
        id: "level-research",
        name: "Research assistants",
        revision: 3,
        rules: [
            .answer(
                sources: AccessSourceBoundary(
                    mode: .allowlist,
                    sourceIds: ["github:maya-reeves", "claude-transcripts:studio-laptop"]
                ),
                release: .reviewed(policyFamilyId: "policy-work-safe")
            ),
            .notes,
        ],
        connectionCount: 2,
        createdAt: 1_790_000_000_000,
        updatedAt: 1_790_000_600_000
    )

    /// No connection uses it yet, and without Answer it cannot serve an
    /// agent that asks through Answer.
    static let accessNotesLevel = AccessLevelSummary(
        id: "level-notes",
        name: "Notes only",
        revision: 1,
        rules: [.notes],
        connectionCount: 0,
        createdAt: 1_790_000_000_000,
        updatedAt: 1_790_000_000_000
    )

    static let accessCodingLevel = AccessLevelSummary(
        id: "level-coding",
        name: "Coding helpers",
        revision: 2,
        rules: [
            .direct(sources: AccessSourceBoundary(mode: .all, sourceIds: [])),
            .answer(
                sources: AccessSourceBoundary(mode: .all, sourceIds: []),
                release: .reviewed(policyFamilyId: "policy-work-safe")
            ),
        ],
        connectionCount: 1,
        createdAt: 1_790_000_000_000,
        updatedAt: 1_790_000_300_000
    )

    /// The connection the gateway matches a returning agent to: on the shared
    /// research level, last used two hours ago.
    static let accessStudioGrant = AccessGrantSummary(
        id: "grant-studio",
        name: "Studio research agent access",
        revision: 4,
        rules: accessResearchLevel.rules,
        credentials: [
            AccessCredentialSummary(
                id: "credential-studio",
                label: "Studio research agent",
                status: "active",
                revokedAt: nil,
                lastUsedAt: Int64((Date().timeIntervalSince1970 - 7200) * 1000),
                clientName: "Studio assistant"
            ),
        ],
        expiresAt: nil,
        revokedAt: nil,
        levelId: accessResearchLevel.id
    )

    /// The overview the wizard reads: sources and policies, three access
    /// levels, and three live connections — one used recently, one days ago
    /// and one never.
    static let accessOverview = AccessOverview(
        principals: [
            AccessPrincipalSummary(
                id: "principal-studio",
                name: "Studio research agent",
                kind: "interactive",
                grants: [accessStudioGrant],
                revokedAt: nil
            ),
            AccessPrincipalSummary(
                id: "principal-northstar",
                name: "Northstar desk",
                kind: "interactive",
                grants: [AccessGrantSummary(
                    id: "grant-northstar",
                    name: "Northstar desk access",
                    revision: 2,
                    rules: accessResearchLevel.rules,
                    credentials: [
                        AccessCredentialSummary(
                            id: "credential-northstar",
                            label: "Northstar desk",
                            status: "active",
                            revokedAt: nil,
                            lastUsedAt: Int64((Date().timeIntervalSince1970 - 259_200) * 1000)
                        ),
                    ],
                    expiresAt: nil,
                    revokedAt: nil,
                    levelId: accessResearchLevel.id
                )],
                revokedAt: nil
            ),
            AccessPrincipalSummary(
                id: "principal-riverside",
                name: "Riverside planner",
                kind: "interactive",
                grants: [AccessGrantSummary(
                    id: "grant-riverside",
                    name: "Riverside planner access",
                    revision: 1,
                    rules: accessCodingLevel.rules,
                    credentials: [],
                    expiresAt: nil,
                    revokedAt: nil,
                    levelId: accessCodingLevel.id
                )],
                revokedAt: nil
            ),
        ],
        sources: [
            AccessSourceInstance(
                id: "github:maya-reeves",
                name: "GitHub · maya-reeves"
            ),
            AccessSourceInstance(
                id: "gmail:maya.reeves@example.com",
                name: "Gmail · maya.reeves@example.com"
            ),
            AccessSourceInstance(
                id: "claude-transcripts:studio-laptop",
                name: "Claude transcripts · studio laptop"
            ),
            AccessSourceInstance(
                id: "github:retired-workspace",
                name: "github:retired-workspace",
                available: false
            ),
        ],
        policyFamilies: [
            AccessPolicyFamilySummary(
                id: "policy-work-safe",
                name: "Work-safe assistant",
                revision: "policy-version-3"
            ),
        ],
        defaultPolicyFamilyId: "policy-work-safe",
        levels: [accessResearchLevel, accessNotesLevel, accessCodingLevel]
    )

    /// A first-time agent: nothing matched, so it opens on a new level.
    static let accessProposalNoMatch = AccessConnectionProposal(
        defaultName: "Studio assistant",
        defaultLevelName: "Studio assistant",
        match: nil,
        recommended: .newLevel
    )

    /// An agent recognised by its client: the level its connection uses is
    /// suggested, and the new connection's name is suffixed to stay unique.
    static let accessProposalLevelMatch = AccessConnectionProposal(
        defaultName: "Studio assistant 2",
        defaultLevelName: "Studio assistant",
        match: AccessConnectionProposal.Match(
            connectionId: "principal-studio",
            connectionName: "Studio research agent",
            matchedBy: "client",
            levelId: accessResearchLevel.id,
            grant: accessStudioGrant
        ),
        recommended: .existingLevel
    )

    /// An agent signing in again on the device its connection is bound to.
    static let accessProposalDeviceMatch = AccessConnectionProposal(
        defaultName: "Studio assistant 2",
        defaultLevelName: "Studio assistant",
        match: AccessConnectionProposal.Match(
            connectionId: "principal-studio",
            connectionName: "Studio research agent",
            matchedBy: "device",
            levelId: accessResearchLevel.id,
            grant: accessStudioGrant
        ),
        recommended: .replace
    )

    /// A level named at the gateway's 120-character limit.
    static let accessLongLevelName = "Research assistants for quarterly planning reviews across design, "
        + "engineering, operations, with notes kept for all teams"

    /// A connection named at the gateway's 120-character limit.
    static let accessLongConnectionName = "Studio research agent on the shared planning laptop in the design "
        + "room, drafting weekly summaries for every project lead"

    /// The name a new connection from the same app would take, also at the
    /// 120-character limit.
    static let accessLongNewConnectionName = "Studio assistant for the planning laptop in the design room, "
        + "drafting weekly summaries and quarterly notes for the leads"

    static let accessLongNameLevel = AccessLevelSummary(
        id: "level-long-name",
        name: accessLongLevelName,
        revision: 1,
        rules: accessResearchLevel.rules,
        connectionCount: 1,
        createdAt: 1_790_000_000_000,
        updatedAt: 1_790_000_000_000
    )

    static let accessLongNameGrant = AccessGrantSummary(
        id: "grant-long-name",
        name: "Long-named connection access",
        revision: 1,
        rules: accessResearchLevel.rules,
        credentials: [
            AccessCredentialSummary(
                id: "credential-long-name",
                label: "Long-named connection",
                status: "active",
                revokedAt: nil,
                lastUsedAt: Int64((Date().timeIntervalSince1970 - 600) * 1000),
                clientName: "Studio assistant"
            ),
        ],
        expiresAt: nil,
        revokedAt: nil,
        levelId: accessLongNameLevel.id
    )

    /// The overview with a connection and a level whose names are as long
    /// as the gateway allows, so rows and the review must wrap them.
    static let accessOverviewWithLongNames = AccessOverview(
        principals: [
            AccessPrincipalSummary(
                id: "principal-long-name",
                name: accessLongConnectionName,
                kind: "interactive",
                grants: [accessLongNameGrant],
                revokedAt: nil
            ),
        ] + accessOverview.principals,
        sources: accessOverview.sources,
        policyFamilies: accessOverview.policyFamilies,
        defaultPolicyFamilyId: accessOverview.defaultPolicyFamilyId,
        levels: [accessLongNameLevel] + accessOverview.levels
    )

    /// An agent recognised by its client whose connection and level carry
    /// 120-character names, suggesting that level for a new connection
    /// whose own name is as long.
    static let accessProposalLongNames = AccessConnectionProposal(
        defaultName: accessLongNewConnectionName,
        defaultLevelName: accessLongNewConnectionName,
        match: AccessConnectionProposal.Match(
            connectionId: "principal-long-name",
            connectionName: accessLongConnectionName,
            matchedBy: "client",
            levelId: accessLongNameLevel.id,
            grant: accessLongNameGrant
        ),
        recommended: .existingLevel
    )

    /// The overview plus a connection on the Notes-only level, which an
    /// agent that asks through Answer cannot take over.
    static let accessOverviewWithNotesConnection = AccessOverview(
        principals: accessOverview.principals + [
            AccessPrincipalSummary(
                id: "principal-field-notes",
                name: "Field notes helper",
                kind: "interactive",
                grants: [AccessGrantSummary(
                    id: "grant-field-notes",
                    name: "Field notes helper access",
                    revision: 1,
                    rules: accessNotesLevel.rules,
                    credentials: [
                        AccessCredentialSummary(
                            id: "credential-field-notes",
                            label: "Field notes helper",
                            status: "active",
                            revokedAt: nil,
                            lastUsedAt: Int64((Date().timeIntervalSince1970 - 86400) * 1000)
                        ),
                    ],
                    expiresAt: nil,
                    revokedAt: nil,
                    levelId: accessNotesLevel.id
                )],
                revokedAt: nil
            ),
        ],
        sources: accessOverview.sources,
        policyFamilies: accessOverview.policyFamilies,
        defaultPolicyFamilyId: accessOverview.defaultPolicyFamilyId,
        levels: accessOverview.levels
    )

    /// No access levels and no connections yet, with the sources a first
    /// level can be drawn over.
    static let accessOverviewWithoutConnections = AccessOverview(
        principals: [],
        sources: accessOverview.sources,
        policyFamilies: accessOverview.policyFamilies,
        defaultPolicyFamilyId: accessOverview.defaultPolicyFamilyId
    )

    /// Requests still waiting for a decision, as the overview lists them:
    /// the newest first, the older one from a client with a long name.
    static let accessPendingRequests = [
        AccessPendingRequest(
            id: "authorization-pending-newest",
            clientName: "Northstar assistant",
            createdAt: Int64((Date().timeIntervalSince1970 - 60) * 1000),
            expiresAt: Int64((Date().timeIntervalSince1970 + 540) * 1000)
        ),
        AccessPendingRequest(
            id: "authorization-pending-older",
            clientName: "Riverside scheduling companion for meeting notes",
            createdAt: Int64((Date().timeIntervalSince1970 - 240) * 1000),
            expiresAt: Int64((Date().timeIntervalSince1970 + 360) * 1000)
        ),
    ]

    /// Keeps the unreviewed-release snapshot focused on the warning and
    /// acknowledgement; the adjacent builder snapshots exercise source rows.
    static let accessOverviewWithoutSources = AccessOverview(
        principals: [],
        sources: [],
        policyFamilies: accessOverview.policyFamilies,
        defaultPolicyFamilyId: accessOverview.defaultPolicyFamilyId
    )

    static let sourcePermissionHealth = [
        PhotosPermissionHealth.report(access: .limited, backgroundRefresh: .available),
        CoreLocationVisitsPermissionHealth.report(state: .whenInUse, precise: false),
    ]

    static let longSourcePermissionHealth = [SourcePermissionHealthReport(
        sourceId: "photos:local",
        displayName: "Photos",
        capabilities: [SourcePermissionCapability(
            id: "photo-library",
            state: .permissionDegraded,
            requirement: .required,
            label: "Full photo-library access",
            impact: "Only a small selection of photos is currently available, so older screenshots, receipts, and images outside that selection cannot contribute to search or answers.",
            remediation: "Open iOS Settings, choose Omnesis, choose Photos, then allow access to all photos. Return to Omnesis afterward so the complete library can be checked and safely reconciled.",
            repairAction: .openAppSettings
        )]
    )]

    // MARK: - Sources

    static let sourceGmail = SourceRecord(
        id: "gmail:user@example.com",
        type: "gmail",
        accountId: "user@example.com",
        deviceId: "dev_mac_mini",
        config: [:],
        enabled: true,
        createdAt: 0,
        updatedAt: 0
    )
    static let sourceAppleNotes = SourceRecord(
        id: "apple-notes:user@example.com",
        type: "apple-notes",
        accountId: "user@example.com",
        deviceId: "dev_mac_mini",
        config: [:],
        enabled: true,
        createdAt: 0,
        updatedAt: 0
    )
    static let sourceAppleHealth = SourceRecord(
        id: "apple-health:user@example.com",
        type: "apple-health",
        accountId: "user@example.com",
        deviceId: "dev_iphone",
        config: [:],
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        members: ["dev_iphone", "dev_ipad"],
        multiDeviceMode: "replicated"
    )
    static let sourceWhatsApp = SourceRecord(
        id: "whatsapp-messages:+15550100000",
        type: "whatsapp-messages",
        accountId: "+15550100000",
        deviceId: "dev_mac_mini",
        config: [:],
        enabled: true,
        createdAt: 0,
        updatedAt: 0
    )
    static let sourceStrava = SourceRecord(
        id: "strava-activities:1234567",
        type: "strava-activities",
        accountId: "1234567",
        deviceId: "dev_mac_mini",
        config: [:],
        enabled: false,
        createdAt: 0,
        updatedAt: 0
    )
    /// A bank-aggregator source in the forward-looking `auth-expiring` state
    /// — still syncing, but its authorization expires soon. Fictional
    /// institution id; no real account.
    static let sourceExpiring = SourceRecord(
        id: "plaid:ins_northstar_demo",
        type: "plaid",
        accountId: "ins_northstar_demo",
        deviceId: "dev_mac_mini",
        config: [:],
        enabled: true,
        createdAt: 0,
        updatedAt: 0
    )
    /// A task source whose local database is maintained by a desktop app that
    /// isn't currently running, so it syncs successfully over frozen data.
    /// Fictional app; no real account.
    static let sourceStale = SourceRecord(
        id: "taskbook:local",
        type: "taskbook",
        accountId: "local",
        deviceId: "dev_mac_mini",
        config: [:],
        enabled: true,
        createdAt: 0,
        updatedAt: 0
    )
    /// A notes vault two Macs both index: one reaches only part of it, the
    /// other cannot read a folder and keeps notes its sibling deleted.
    /// Fictional vault and devices.
    static let sourceSharedVault = SourceRecord(
        id: "obsidian:team-vault",
        type: "obsidian",
        accountId: "team-vault",
        deviceId: "dev_studio_mac",
        config: [:],
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        members: ["dev_studio_mac", "dev_travel_macbook"],
        multiDeviceMode: "replicated"
    )
    static let sources: [SourceRecord] = [
        sourceGmail, sourceAppleNotes, sourceAppleHealth,
        sourceWhatsApp, sourceStrava, sourceExpiring, sourceStale, sourceSharedVault,
    ]

    static let deviceNames: [String: String] = [
        "dev_mac_mini": "mac-mini",
        "dev_iphone": "iPhone",
        "dev_ipad": "iPad",
        "dev_studio_mac": "studio-desk",
        "dev_travel_macbook": "travel-laptop",
    ]

    // MARK: - Device management (read-only)

    /// Invented device fixtures for the read-only device-management
    /// snapshot. Fictional names only (privacy): never sourced from the
    /// operator's real paired devices.
    private static func millisAgo(_ seconds: TimeInterval) -> Int64 {
        Int64((Date().timeIntervalSince1970 - seconds) * 1000)
    }

    static let deviceCollector = DeviceRecord(
        id: "dev-collector-1",
        name: "Studio Desktop",
        kind: "collector",
        pairedAt: millisAgo(86400 * 30),
        lastSeenAt: millisAgo(45),
        capabilities: DeviceCapabilities(hostname: "studio-desktop.local"),
        online: true
    )

    static let devicePhone = DeviceRecord(
        id: "dev-ios-1",
        name: "Maya's iPhone",
        kind: "ios",
        pairedAt: millisAgo(86400 * 5),
        lastSeenAt: millisAgo(600),
        capabilities: nil,
        online: false
    )

    static let deviceAgent = DeviceRecord(
        id: "dev-agent-1",
        name: "openclaw integration",
        kind: "agent",
        pairedAt: millisAgo(86400 * 2),
        lastSeenAt: millisAgo(120),
        capabilities: DeviceCapabilities(
            agentIntegration: AgentIntegrationCapability(
                harness: "openclaw",
                maxConcurrentRuns: 2
            )
        ),
        online: true
    )

    /// A phone whose access was revoked: it keeps its row and sources until
    /// it is re-paired or forgotten, so it is neither live nor "last active".
    static let deviceRevoked = DeviceRecord(
        id: "dev-ios-2",
        name: "Jamie's old iPhone",
        kind: "ios",
        pairedAt: millisAgo(86400 * 90),
        lastSeenAt: millisAgo(86400 * 12),
        revokedAt: millisAgo(86400 * 3),
        capabilities: nil,
        online: false
    )

    static let devices: [DeviceRecord] = [deviceCollector, devicePhone, deviceAgent]

    /// Invented HealthKit sample identities for the developer sample probe.
    static let healthSampleProbeRows: [HealthSampleProbe.Row] = {
        let base = Date(timeIntervalSince1970: 1_756_000_000)
        func row(_ uuid: String, _ type: String, minutesAgo: Double) -> HealthSampleProbe.Row {
            HealthSampleProbe.Row(uuid: uuid, typeIdentifier: type, endDate: base.addingTimeInterval(-60 * minutesAgo))
        }
        let heartRate = "HKQuantityTypeIdentifierHeartRate"
        let steps = "HKQuantityTypeIdentifierStepCount"
        let sleep = "HKCategoryTypeIdentifierSleepAnalysis"
        return [
            row("7C0E5F1A-2B3D-4E5F-8A9B-0C1D2E3F4A5B", heartRate, minutesAgo: 4),
            row("1F2E3D4C-5B6A-4798-8877-665544332211", heartRate, minutesAgo: 9),
            row("A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D", heartRate, minutesAgo: 14),
            row("0F1E2D3C-4B5A-4697-8899-AABBCCDDEEFF", steps, minutesAgo: 31),
            row("9E8D7C6B-5A49-4382-9170-6F5E4D3C2B1A", steps, minutesAgo: 91),
            row("5D4C3B2A-1908-4F7E-A6D5-C4B3A2918070", sleep, minutesAgo: 480),
        ]
    }()

    static let devicesWithRevoked: [DeviceRecord] = devices + [deviceRevoked]

    static let deviceTokens: [String: [TokenRecord]] = [
        "dev-collector-1": [
            TokenRecord(
                id: "tok-1",
                deviceId: "dev-collector-1",
                name: "initial",
                scopes: ["admin", "write:*"],
                createdAt: millisAgo(86400 * 30),
                lastUsedAt: millisAgo(45)
            ),
            TokenRecord(
                id: "tok-2",
                deviceId: "dev-collector-1",
                name: nil,
                scopes: ["read"],
                createdAt: millisAgo(86400 * 12),
                lastUsedAt: nil
            ),
        ],
        "dev-ios-1": [
            TokenRecord(
                id: "tok-3",
                deviceId: "dev-ios-1",
                name: "initial",
                scopes: ["admin"],
                createdAt: millisAgo(86400 * 5),
                lastUsedAt: millisAgo(600)
            ),
        ],
        "dev-agent-1": [],
    ]

    /// A pending pairing result for the pairing-result preview. Fictional code.
    static let pendingPairing = PendingPairing(
        pairingCode: "7K3M-9QX2",
        expiresAt: Int64((Date().timeIntervalSince1970 + 540) * 1000)
    )

    /// Fictional network identities for the pairing host picker.
    static let networkIdentities: [NetworkIdentity] = [
        NetworkIdentity(address: "192.0.2.42", label: "LAN (en0)", kind: "lan", offLan: false),
        NetworkIdentity(address: "host.example", label: "mDNS (.local)", kind: "mdns", offLan: false),
        NetworkIdentity(address: "198.51.100.7", label: "Tailscale (off-LAN)", kind: "tailscale", offLan: true),
    ]

    // MARK: - Sync statuses

    static let syncStatusSyncing = SourceSyncStatus(
        sourceId: sourceGmail.id,
        deviceId: "dev_mac_mini",
        state: "syncing",
        unitName: "emails",
        progress: SourceSyncStatus.Progress(
            phase: "bootstrap",
            total: 500, processed: 240,
            percentComplete: 48, message: "Page 6 of 12"
        ),
        startedAt: nil,
        lastSyncAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-180)),
        errorMessage: nil,
        erroredAt: nil,
        lastUpdated: Int64(Date().timeIntervalSince1970 * 1000)
    )
    static let syncStatusSynced = SourceSyncStatus(
        sourceId: sourceAppleNotes.id,
        deviceId: "dev_mac_mini",
        state: "synced",
        unitName: nil,
        progress: nil,
        startedAt: nil,
        lastSyncAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-300)),
        errorMessage: nil,
        erroredAt: nil,
        lastUpdated: Int64(Date().timeIntervalSince1970 * 1000)
    )
    static let syncStatusSyncedHealth = localSourceStatus(
        sourceId: sourceAppleHealth.id,
        lastSyncOffset: -30
    )
    static let syncStatusLocalHealth = localSourceStatus(
        sourceId: "apple-health:local",
        lastSyncOffset: -30
    )
    static func localSourceStatus(
        sourceId: String,
        state: String = "synced",
        lastSyncOffset: TimeInterval = -120,
        errorMessage: String? = nil,
        notices: [SourceNotice] = []
    )
        -> SourceSyncStatus {
        let local = SourceSyncStatus(
            sourceId: sourceId,
            deviceId: "dev_iphone",
            state: state,
            unitName: nil,
            progress: nil,
            startedAt: nil,
            lastSyncAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(lastSyncOffset)),
            errorMessage: errorMessage,
            erroredAt: nil,
            lastUpdated: Int64(Date().timeIntervalSince1970 * 1000),
            notices: notices
        )
        let sibling = SourceSyncStatus(
            sourceId: sourceId,
            deviceId: "dev_tablet",
            state: "syncing",
            unitName: nil,
            progress: .init(
                phase: "incremental", total: nil, processed: 42,
                percentComplete: nil, message: nil
            ),
            startedAt: Int64(Date().addingTimeInterval(-10).timeIntervalSince1970 * 1000),
            lastSyncAt: nil,
            errorMessage: nil,
            erroredAt: nil,
            lastUpdated: Int64(Date().timeIntervalSince1970 * 1000),
            notices: []
        )
        return SourceSyncStatus(
            sourceId: sourceId,
            deviceId: sibling.deviceId,
            members: [local, sibling],
            state: sibling.state,
            unitName: sibling.unitName,
            progress: sibling.progress,
            startedAt: sibling.startedAt,
            lastSyncAt: sibling.lastSyncAt,
            errorMessage: sibling.errorMessage,
            erroredAt: sibling.erroredAt,
            lastUpdated: sibling.lastUpdated
        )
    }

    static let syncStatusError = SourceSyncStatus(
        sourceId: sourceWhatsApp.id,
        deviceId: "dev_mac_mini",
        state: "error",
        unitName: nil,
        progress: nil,
        startedAt: nil,
        lastSyncAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)),
        errorMessage: "Auth expired — reconnect via portal",
        erroredAt: nil,
        lastUpdated: Int64(Date().timeIntervalSince1970 * 1000),
        notices: [
            SourceNotice(
                kind: "error",
                severity: .error,
                title: "The last sync failed",
                detail: "Auth expired — reconnect via portal",
                steps: ["It is retried on the next sync. If it keeps failing, open the source's debug view."],
                since: isoAgo(3600)
            ),
        ]
    )
    /// Forward-looking consent-expiry: a healthy-but-expiring source.
    /// The deadline is ~9 days out so the row/detail render "Expires on <date>"
    /// distinct from the red terminal `needs-auth` / `error`.
    static let syncStatusExpiring = SourceSyncStatus(
        sourceId: sourceExpiring.id,
        deviceId: "dev_mac_mini",
        state: "auth-expiring",
        unitName: "transactions",
        progress: nil,
        startedAt: nil,
        lastSyncAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600)),
        errorMessage: nil,
        erroredAt: nil,
        lastUpdated: Int64(Date().timeIntervalSince1970 * 1000),
        consentExpiresAt: ISO8601DateFormatter()
            .string(from: Date().addingTimeInterval(9 * 24 * 3600)),
        notices: [
            SourceNotice(
                kind: "auth-expiring",
                severity: .warning,
                title: "Connection expires on \(Date().addingTimeInterval(9 * 24 * 3600).formatted(date: .abbreviated, time: .omitted))",
                detail: "The source keeps syncing until then. Reconnecting before that date avoids a gap.",
                steps: ["Reconnect the account from the source's menu."]
            ),
        ]
    )
    /// A stalled local feed: the source syncs fine, but the app that maintains
    /// the file it reads isn't running, so nothing new has arrived in weeks.
    /// The hint is source-authored — this view renders it verbatim.
    static let syncStatusStale = SourceSyncStatus(
        sourceId: sourceStale.id,
        deviceId: "dev_mac_mini",
        state: "stale",
        unitName: "tasks",
        progress: nil,
        startedAt: nil,
        lastSyncAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-300)),
        errorMessage: nil,
        erroredAt: nil,
        lastUpdated: Int64(Date().timeIntervalSince1970 * 1000),
        consentExpiresAt: nil,
        staleHint: "Taskbook isn't running on this machine, so it can't pull new tasks. "
            + "Open it (and set it to open at login) to resume syncing.",
        notices: [
            SourceNotice(
                kind: "stale",
                severity: .warning,
                title: "No new data is arriving",
                detail: "Taskbook isn't running on this machine, so it can't pull new tasks. "
                    + "Open it (and set it to open at login) to resume syncing."
            ),
        ]
    )

    // MARK: - Source notices

    private static func isoAgo(_ seconds: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(-seconds))
    }

    /// The studio-desk side of the shared vault: a standing coverage note.
    static let noticesStudioMac: [SourceNotice] = [
        SourceNotice(
            kind: "coverage-partial",
            severity: .info,
            title: "Some history is not here",
            detail: "Two folders in this vault are outside what this Mac lets Omnesis read."
        ),
    ]

    /// The travel-laptop side: an unreadable folder, and notes it keeps
    /// that the studio-desk deleted.
    static let noticesTravelMacBook: [SourceNotice] = [
        SourceNotice(
            kind: "sync-issue",
            severity: .warning,
            title: "The archive folder could not be read",
            detail: "Restore folder access",
            steps: [
                "Open the privacy settings for files and folders.",
                "Allow the collector to read the vault's folder.",
                "Sync the source again.",
            ],
            since: isoAgo(2 * 86400)
        ),
        SourceNotice(
            kind: "replica-dispute",
            severity: .info,
            title: "Keeping 3 notes that studio-desk no longer has",
            detail: "This device still has them; studio-desk reported them gone. Omnesis keeps anything at "
                + "least one device still has, and removes it only once every device agrees. Nothing is lost.",
            steps: ["To clear this, delete the same notes on this device."]
        ),
    ]

    static let syncStatusSharedVault = SourceSyncStatus(
        sourceId: sourceSharedVault.id,
        deviceId: nil,
        members: [
            SourceSyncStatus(
                sourceId: sourceSharedVault.id,
                deviceId: "dev_studio_mac",
                state: "synced",
                unitName: "notes",
                progress: nil,
                startedAt: nil,
                lastSyncAt: isoAgo(240),
                errorMessage: nil,
                erroredAt: nil,
                lastUpdated: Int64(Date().timeIntervalSince1970 * 1000),
                notices: noticesStudioMac
            ),
            SourceSyncStatus(
                sourceId: sourceSharedVault.id,
                deviceId: "dev_travel_macbook",
                state: "synced",
                unitName: "notes",
                progress: nil,
                startedAt: nil,
                lastSyncAt: isoAgo(900),
                errorMessage: nil,
                erroredAt: nil,
                lastUpdated: Int64(Date().timeIntervalSince1970 * 1000),
                notices: noticesTravelMacBook
            ),
        ],
        state: "synced",
        unitName: "notes",
        progress: nil,
        startedAt: nil,
        lastSyncAt: isoAgo(240),
        errorMessage: nil,
        erroredAt: nil,
        lastUpdated: Int64(Date().timeIntervalSince1970 * 1000)
    )

    static let noticeSectionsMultiMember: [SourceNoticeSection] = [
        SourceNoticeSection(id: "dev_studio_mac", deviceName: "studio-desk", notices: noticesStudioMac),
        SourceNoticeSection(id: "dev_travel_macbook", deviceName: "travel-laptop", notices: noticesTravelMacBook),
    ]

    /// A dozen unreadable folders on one device, the first with a title long
    /// enough to wrap: a double-digit count beside the icon, and a sheet that
    /// scrolls.
    static let noticesMany: [SourceNotice] = (1 ... 12).map { index in
        SourceNotice(
            kind: "sync-issue",
            severity: .warning,
            title: index == 1
                ? "The shared projects folder on the external drive could not be read during the last sync, "
                + "so changes made there since then are not indexed yet"
                : "Folder \(index) could not be read",
            detail: "Restore folder access",
            since: isoAgo(Double(index) * 3600)
        )
    }

    /// What an older gateway's failed status reads as: it serves no notices,
    /// so the one shown is derived from the state and its message.
    static let syncStatusLegacyNeedsAuth = SourceSyncStatus(
        sourceId: sourceGmail.id,
        deviceId: "dev_mac_mini",
        state: "needs-auth",
        unitName: nil,
        progress: nil,
        startedAt: nil,
        lastSyncAt: isoAgo(7200),
        errorMessage: "needs reauth: Reconnect the account from the portal.",
        erroredAt: nil,
        lastUpdated: nil
    )
    static let noticesLegacy: [SourceNotice] = syncStatusLegacyNeedsAuth.displayNotices
    static let noticeSectionsLegacy: [SourceNoticeSection] = [
        SourceNoticeSection(id: "dev_mac_mini", deviceName: "mac-mini", notices: noticesLegacy),
    ]
    static let noticeSectionsMany: [SourceNoticeSection] = [
        SourceNoticeSection(id: "dev_archive", deviceName: "archive-server", notices: noticesMany),
    ]
    static let syncStatuses: [String: SourceSyncStatus] = [
        sourceGmail.id: syncStatusSyncing,
        sourceAppleNotes.id: syncStatusSynced,
        sourceAppleHealth.id: syncStatusSyncedHealth,
        "apple-health:local": syncStatusLocalHealth,
        "activity-segments:local": localSourceStatus(sourceId: "activity-segments:local"),
        "core-location-visits:local": localSourceStatus(
            sourceId: "core-location-visits:local",
            state: "error",
            lastSyncOffset: -3600,
            errorMessage: "Location access is required to update visits.",
            notices: [
                SourceNotice(
                    kind: "error",
                    severity: .error,
                    title: "The last sync failed",
                    detail: "Location access is required to update visits."
                ),
            ]
        ),
        "photos:local": localSourceStatus(sourceId: "photos:local"),
        sourceWhatsApp.id: syncStatusError,
        sourceExpiring.id: syncStatusExpiring,
        sourceStale.id: syncStatusStale,
        sourceSharedVault.id: syncStatusSharedVault,
    ]

    // MARK: - /status snapshot

    static let statusSnapshot = StatusSnapshot(
        documents: StatusSnapshot.Documents(
            total: 165_135,
            bySource: [
                sourceGmail.id: 509,
                sourceAppleNotes.id: 4,
                sourceAppleHealth.id: 128_000,
                sourceWhatsApp.id: 17421,
                sourceStrava.id: 10,
                sourceExpiring.id: 842,
            ],
            unitCountBySource: nil
        ),
        dbSizeBytes: 4_000_000_000,
        latestActivityBySource: [
            sourceGmail.id: StatusSnapshot.LatestActivity(
                kind: "document",
                docId: "abc-123",
                title: "Welcome to your weekly summary",
                latestActivityAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-90)),
                sourceCreatedAt: nil, ingestedAt: nil, isNew: true,
                tableName: nil, tableDisplayName: nil
            ),
            sourceAppleNotes.id: StatusSnapshot.LatestActivity(
                kind: "document",
                docId: "def-456",
                title: "Standup notes — Mar 9",
                latestActivityAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-1200)),
                sourceCreatedAt: nil, ingestedAt: nil, isNew: false,
                tableName: nil, tableDisplayName: nil
            ),
        ]
    )

    /// The paired gateway runs with `OMNESIS_DEV_MODE=1`: Settings shows the
    /// developer-only entries.
    static let statusSnapshotDeveloper = StatusSnapshot(
        documents: statusSnapshot.documents,
        dbSizeBytes: statusSnapshot.dbSizeBytes,
        latestActivityBySource: statusSnapshot.latestActivityBySource,
        developer: true
    )

    /// A `/status` snapshot from a gateway running in experimental mode —
    /// exercises experimental-gated UI such as the Watches menu entry and
    /// its "Experimental" tag.
    static let statusSnapshotExperimental = StatusSnapshot(
        documents: StatusSnapshot.Documents(
            total: 165_135,
            bySource: statusSnapshot.documents.bySource,
            unitCountBySource: nil
        ),
        dbSizeBytes: 4_000_000_000,
        latestActivityBySource: nil,
        experimental: true
    )

    /// A `/status` snapshot with the Omnesis Briefs feature active —
    /// exercises the Briefs menu entry (experimental mode on AND a
    /// background-agent model assigned).
    static let statusSnapshotBriefsActive = StatusSnapshot(
        documents: StatusSnapshot.Documents(
            total: 165_135,
            bySource: statusSnapshot.documents.bySource,
            unitCountBySource: nil
        ),
        dbSizeBytes: 4_000_000_000,
        latestActivityBySource: nil,
        experimental: true,
        briefs: BriefsStatus(enabled: true, modelAssigned: true, active: true)
    )

    /// A `/status` snapshot where Omnesis Briefs is switched on but its
    /// background-agent model cannot run — exercises the drawer's
    /// needs-attention Briefs entry and the feed's model warning.
    static let statusSnapshotBriefsNeedsAttention = StatusSnapshot(
        documents: StatusSnapshot.Documents(
            total: 165_135,
            bySource: statusSnapshot.documents.bySource,
            unitCountBySource: nil
        ),
        dbSizeBytes: 4_000_000_000,
        latestActivityBySource: nil,
        experimental: true,
        briefs: BriefsStatus(enabled: true, modelAssigned: false, active: false)
    )

    // MARK: - Briefs feed

    private static func briefsIso(secondsFromNow: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(secondsFromNow))
    }

    /// Long-form brief body for the talk-back thread's context card —
    /// exercises markdown lists + multiple paragraphs behind the
    /// show-details fold.
    static let briefLongBody = """
    Entry for the **marathon** closes Friday 17 Oct at 18:00. \
    Early-bird pricing still applies until then.

    What's already lined up:

    - Training plan drafted through week 8
    - Jamie Lopez confirmed as your long-run partner on Sundays
    - New shoes ordered, arriving Tuesday

    Still open: the entry itself and the hotel for the night before. The \
    race village opens at 06:30; bib pickup closes 30 minutes before the \
    start.
    """

    /// A loop-kind brief: an open commitment awaiting the user, with
    /// long-form context and citations. All content invented.
    static let briefLoop = BriefRecord(
        id: "brief-loop-1",
        kind: .loop,
        state: .unread,
        title: "Reply to Maya about the cabin weekend",
        description:
        "Maya Reeves proposed dates three days ago and asked which weekend works for you — no reply yet.",
        body: """
        Maya suggested July 18–20 or July 25–27 for the cabin trip. Jamie Lopez \
        said either works on the group chat, and David Lin can only make the \
        second weekend. Your calendar is free both weekends so far.

        A two-minute reply closes this out.
        """,
        confidence: 0.9,
        urgency: 0.6,
        createdAt: briefsIso(secondsFromNow: -7200),
        eventAt: nil,
        relevantUntil: nil,
        citations: [
            BriefCitation(
                docId: "doc-brief-1",
                title: "Cabin weekend — which dates?",
                providerId: "google",
                sourceId: sourceGmail.id
            ),
            BriefCitation(
                docId: "doc-brief-2",
                title: "Maya Reeves",
                providerId: "whatsapp",
                sourceId: sourceWhatsApp.id
            ),
        ]
    )

    /// An info-kind brief about an event starting soon (the next-hour
    /// ranking tier) — no related loop, body context + one citation.
    static let briefInfo = BriefRecord(
        id: "brief-info-1",
        kind: .info,
        state: .unread,
        title: "Design review with David Lin",
        description:
        "Video call at 3:00 PM. Last time you agreed to bring the updated onboarding flow.",
        body: """
        The invite came from David Lin this morning. In your last review you \
        agreed to walk through the revised onboarding flow and the empty-state \
        copy; the follow-up notes list both as open items.
        """,
        confidence: 0.8,
        urgency: 0.9,
        createdAt: briefsIso(secondsFromNow: -1800),
        eventAt: briefsIso(secondsFromNow: 2700),
        relevantUntil: briefsIso(secondsFromNow: 6300),
        citations: [
            BriefCitation(
                docId: "doc-brief-3",
                title: "Design review — agenda",
                providerId: "google",
                sourceId: sourceGmail.id
            ),
        ]
    )

    /// An info-kind brief drawn from the health-trends sweep: several weeks
    /// of wearable data read against the person's own baseline, not a
    /// threshold. Doubles as the still used on the website's Brain page (see
    /// `scripts/shot-website-brief.sh`), so its copy is written to be read
    /// cold by someone who has never seen the app. All content invented.
    static let briefHealthRecovery = BriefRecord(
        id: "brief-health-1",
        kind: .info,
        state: .unread,
        title: "Your body is asking for a lighter day",
        description:
        "Resting heart rate is up and HRV is down against your own baseline, after four hard sessions and a run of short nights.",
        body: """
        Over the last six days your resting heart rate has averaged **54 bpm** \
        against your usual 49, and overnight HRV has fallen to **38 ms** from a \
        typical 61. Both moved together, which points to load rather than one \
        bad night.

        - Four sessions above your normal intensity since Saturday
        - Sleep averaging **5h 48m**, an hour under your recent norm, with deep \
        sleep down to 42 minutes

        None of this is a medical reading, but it is the pattern that usually \
        precedes a bad week. An easy day would let it come back up.
        """,
        confidence: 0.86,
        urgency: 0.55,
        createdAt: briefsIso(secondsFromNow: -5400),
        eventAt: nil,
        relevantUntil: briefsIso(secondsFromNow: 86400),
        citations: [
            BriefCitation(
                docId: "doc-brief-health-1",
                title: "Resting heart rate — last 30 days",
                providerId: "apple",
                sourceId: sourceAppleHealth.id
            ),
            BriefCitation(
                docId: "doc-brief-health-2",
                title: "Sleep stages — last 7 nights",
                providerId: "apple",
                sourceId: sourceAppleHealth.id
            ),
        ]
    )

    /// A read, body-less loop brief — the glance is everything (no
    /// scroll hint, no citations), and it sorts last server-side.
    static let briefReminder = BriefRecord(
        id: "brief-loop-2",
        kind: .loop,
        state: .read,
        title: "Invoice #204 from Stellar Sound is still unpaid",
        description:
        "Due last Friday. No matching bank transaction has shown up yet.",
        body: nil,
        confidence: 0.7,
        urgency: 0.5,
        createdAt: briefsIso(secondsFromNow: -86400 * 2),
        eventAt: nil,
        relevantUntil: nil,
        citations: []
    )

    /// A loop brief whose Loop-Agent-authored copy carries markdown —
    /// **bold** inline emphasis in the description, and a bulleted list
    /// plus a link in the long-form body. Proves brief cards render the
    /// agent's markdown as emphasis / lists rather than literal syntax.
    /// All content invented.
    static let briefMarkdown = BriefRecord(
        id: "brief-loop-md",
        kind: .loop,
        state: .unread,
        title: "Confirm the venue booking for the launch party",
        description:
        "Studio Northstar needs your **OK by Friday** — the room hold expires over the weekend.",
        body: """
        A few things still need a decision before you reply:

        - **Date** — they've penciled in the second Saturday; the first is already booked.
        - **Headcount** — the quote assumes *60 guests*; confirm or adjust.
        - **Deposit** — a 20% deposit holds the date. See the [quote](https://example.com/quote).

        Once you confirm, the rest is automatic.
        """,
        confidence: 0.85,
        urgency: 0.7,
        createdAt: briefsIso(secondsFromNow: -5400),
        eventAt: nil,
        relevantUntil: nil,
        citations: [
            BriefCitation(
                docId: "doc-brief-md",
                title: "Studio Northstar — venue quote",
                providerId: "google",
                sourceId: sourceGmail.id
            ),
        ]
    )

    /// The ranked feed as `GET /briefs/feed` returns it, first on top.
    static let briefs: [BriefRecord] = [briefLoop, briefInfo, briefReminder]

    // MARK: - /index/stats

    static let indexStats = IndexStats(
        enabled: true,
        state: "running",
        totalIndexed: 163_500,
        totalIndexErrors: 0,
        totalChunks: 426_100,
        watermark: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-180)),
        model: IndexStats.Model(
            name: "nomic-embed-text-v1.5.Q8_0.gguf",
            path: nil,
            present: true
        ),
        bySource: [
            sourceGmail.id: IndexStats.BySource(
                indexedDocs: 509, gatewayDocs: 509,
                chunks: 1234, percentIndexed: 100,
                indexErrors: 0,
                earliestIndexedDate: nil, latestIndexedDate: nil
            ),
            sourceAppleHealth.id: IndexStats.BySource(
                indexedDocs: 126_500, gatewayDocs: 128_000,
                chunks: 0, percentIndexed: 98,
                indexErrors: 0,
                earliestIndexedDate: nil, latestIndexedDate: nil
            ),
            sourceWhatsApp.id: IndexStats.BySource(
                indexedDocs: 17421, gatewayDocs: 17421,
                chunks: 84320, percentIndexed: 100,
                indexErrors: 0,
                earliestIndexedDate: nil, latestIndexedDate: nil
            ),
        ]
    )

    // MARK: - Search

    static let searchResults: [SearchResultItem] = [
        SearchResultItem(
            documentId: "abc-123",
            sourceId: sourceGmail.id,
            documentType: "email",
            title: "Re: Stripe invoice for March",
            sourceUrl: nil,
            appUrl: nil,
            sourceCreatedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 3)),
            author: "billing@example.com",
            chunkText: "Your invoice for the period of Mar 1–31 is now available. Total: $124.00. Pay before Apr 15 to avoid late fees.",
            score: 0.91,
            refCount: 2,
            scoreBreakdown: SearchScoreBreakdown(
                bm25Rank: 1, vectorRank: 3,
                rrfScore: 0.0331, rankBonus: 0.05,
                typeBoost: 0.02, relevanceBoost: nil,
                sourcePrior: nil, finalScore: 0.1031
            )
        ),
        SearchResultItem(
            documentId: "def-456",
            sourceId: sourceAppleNotes.id,
            documentType: "note",
            title: "Trip planning — Tokyo",
            sourceUrl: nil,
            appUrl: nil,
            sourceCreatedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 12)),
            author: nil,
            chunkText: "Day 1 — arrive HND, take Narita Express. Hotel near Shinjuku. Day 2 — Tsukiji breakfast then teamLab Borderless.",
            score: 0.78,
            refCount: nil,
            scoreBreakdown: SearchScoreBreakdown(
                bm25Rank: 4, vectorRank: 1,
                rrfScore: 0.0288, rankBonus: 0.02,
                typeBoost: nil, relevanceBoost: 0.01,
                sourcePrior: nil, finalScore: 0.0588
            )
        ),
        SearchResultItem(
            documentId: "ghi-789",
            sourceId: sourceWhatsApp.id,
            documentType: "conversation",
            title: "Summer hike in the alps (group)",
            sourceUrl: nil,
            appUrl: nil,
            sourceCreatedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 1)),
            author: "Mateo Vidal",
            chunkText: "First week of july works for me, what do you all think? Maybe we pick a date next year.",
            score: 0.74,
            refCount: nil,
            scoreBreakdown: SearchScoreBreakdown(
                bm25Rank: 2, vectorRank: 5,
                rrfScore: 0.0245, rankBonus: nil,
                typeBoost: nil, relevanceBoost: nil,
                sourcePrior: -0.01, finalScore: 0.0145
            )
        ),
    ]

    /// Fully-populated response mirroring what the gateway emits when
    /// `verbose: true` is set — drives the search-pipeline footer
    /// preview.
    static let searchResponseVerbose = SearchResponse(
        results: searchResults,
        model: nil,
        models: SearchResponse.SearchModels(
            embedding: "nomic-embed-text-v1.5.Q8_0.gguf"
        ),
        query: SearchResponse.SearchQueryReport(
            original: "ledgerline invoice",
            effectiveText: "ledgerline invoice"
        ),
        timing: SearchResponse.SearchTiming(
            totalMs: 187,
            bm25Ms: 8, vectorMs: 92,
            bm25Candidates: 50, vectorCandidates: 50
        ),
        stages: SearchResponse.SearchStages(
            bm25: SearchResponse.StageReport(
                status: "ran", reason: nil, durationMs: 8,
                candidates: 50, method: nil, rrfK: nil,
                bm25Weight: nil, vectorWeight: nil, resultCount: nil,
                quantization: nil, rescore: nil, effectiveK: nil,
                embedMs: nil, sqlMs: nil
            ),
            vector: SearchResponse.StageReport(
                status: "ran", reason: nil, durationMs: 92,
                candidates: 50, method: nil, rrfK: nil,
                bm25Weight: nil, vectorWeight: nil, resultCount: nil,
                quantization: "int8", rescore: true, effectiveK: 200,
                embedMs: 38, sqlMs: 54
            ),
            fusion: SearchResponse.StageReport(
                status: "ran", reason: nil, durationMs: 2,
                candidates: nil, method: "rrf", rrfK: 60,
                bm25Weight: 1.0, vectorWeight: 1.0, resultCount: 30,
                quantization: nil, rescore: nil, effectiveK: nil,
                embedMs: nil, sqlMs: nil
            ),
            boost: SearchResponse.StageReport(
                status: "ran", reason: nil, durationMs: 1,
                candidates: nil, method: nil, rrfK: nil,
                bm25Weight: nil, vectorWeight: nil, resultCount: nil,
                quantization: nil, rescore: nil, effectiveK: nil,
                embedMs: nil, sqlMs: nil
            ),
            refCount: nil
        ),
        debug: SearchResponse.SearchDebugInfo(
            modelState: SearchResponse.SearchDebugInfo.ModelState(
                vector: "ready"
            ),
            query: SearchResponse.SearchDebugInfo.QueryLengths(
                inputLength: 14
            )
        )
    )

    // MARK: - People

    static let peopleSummaries: [PersonSummary] = [
        PersonSummary(
            id: "self-1", canonicalName: "You",
            source: "self", isSelf: true,
            aliasCount: 7, documentCount: 18421,
            firstSeen: nil,
            lastSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-180)),
            inboundCount: nil, outboundCount: nil,
            interactionScoreRecent: nil,
            sourceIds: [sourceGmail.id, sourceAppleNotes.id, sourceWhatsApp.id, sourceStrava.id, sourceAppleHealth.id]
        ),
        PersonSummary(
            id: "p-alice", canonicalName: "Alice Liddell",
            source: "extracted", isSelf: false,
            aliasCount: 3, documentCount: 412,
            firstSeen: nil,
            lastSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)),
            inboundCount: 200, outboundCount: 212,
            interactionScoreRecent: 0.41,
            sourceIds: [sourceGmail.id, sourceWhatsApp.id, sourceAppleNotes.id]
        ),
        PersonSummary(
            id: "p-bob", canonicalName: "Bob Martin",
            source: "extracted", isSelf: false,
            aliasCount: 2, documentCount: 287,
            firstSeen: nil,
            lastSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 4)),
            inboundCount: 130, outboundCount: 157,
            interactionScoreRecent: 0.32,
            sourceIds: [sourceGmail.id, sourceAppleNotes.id]
        ),
        PersonSummary(
            id: "p-rémi", canonicalName: "Rémi",
            source: "extracted", isSelf: false,
            aliasCount: 1, documentCount: 150,
            firstSeen: nil,
            lastSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 22)),
            inboundCount: 75, outboundCount: 75,
            interactionScoreRecent: 0.026,
            sourceIds: [sourceWhatsApp.id]
        ),
        // Stress-case: very long display name with the full source
        // fleet. Row must keep the doc-count + icon strip readable
        // and truncate the name with an ellipsis.
        PersonSummary(
            id: "p-long",
            canonicalName: "Maximilian Aurelius Bartholomew Hawthorne-Featherstonehaugh",
            source: "extracted", isSelf: false,
            aliasCount: 6, documentCount: 2487,
            firstSeen: nil,
            lastSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400)),
            inboundCount: 1200, outboundCount: 1287,
            interactionScoreRecent: 0.21,
            sourceIds: [sourceGmail.id, sourceAppleNotes.id, sourceWhatsApp.id, sourceStrava.id, sourceAppleHealth.id]
        ),
    ]

    static let personDetail = PersonDetail(
        id: "p-alice",
        canonicalName: "Alice Liddell",
        source: "extracted",
        isSelf: false,
        firstSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 365 * 4)),
        lastSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)),
        aliases: [
            PersonAlias(id: "a-1", aliasType: "email", alias: "alice@example.com", sourceId: nil),
            PersonAlias(id: "a-2", aliasType: "email", alias: "alice.liddell@work.co", sourceId: nil),
            PersonAlias(id: "a-3", aliasType: "phone", alias: "+44 7700 900100", sourceId: nil),
            PersonAlias(id: "a-4", aliasType: "name", alias: "Alice L.", sourceId: nil),
        ],
        aliasesOwn: nil,
        inboundCount: 200,
        outboundCount: 212,
        interactionScore: 0.412,
        interactionScoreRecent: 0.412,
        inboundScoreRecent: 0.198,
        outboundScoreRecent: 0.214,
        mergedInto: nil,
        mergedIntoCanonicalName: nil,
        mergedFrom: []
    )

    /// Canonical that has absorbed several losers — drives the
    /// "N people merged into this" surface on PersonDetailView.
    static let personDetailWithMerges = PersonDetail(
        id: "p-david",
        canonicalName: "david.lin@example.com",
        source: "extracted",
        isSelf: false,
        firstSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 30)),
        lastSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 4)),
        aliases: [
            PersonAlias(id: "a-e1", aliasType: "email", alias: "david@example.io", sourceId: nil),
            PersonAlias(id: "a-e2", aliasType: "email", alias: "davidlin.alt@example.com", sourceId: nil),
            PersonAlias(id: "a-e3", aliasType: "phone", alias: "+1 (555) 010-0001", sourceId: nil),
            PersonAlias(id: "a-e4", aliasType: "name", alias: "David Lin", sourceId: nil),
        ],
        aliasesOwn: nil,
        inboundCount: 41,
        outboundCount: 38,
        interactionScore: 0.034,
        interactionScoreRecent: 0.034,
        inboundScoreRecent: 0.018,
        outboundScoreRecent: 0.016,
        mergedInto: nil,
        mergedIntoCanonicalName: nil,
        mergedFrom: [
            MergedFromPerson(
                id: "p-david-phone",
                canonicalName: "+15550100001",
                aliases: [
                    PersonAlias(id: "a-f1", aliasType: "phone", alias: "+1 (555) 010-0001", sourceId: nil),
                ],
                inboundCount: 6, outboundCount: 4,
                appliedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-60)),
                sourceIds: [sourceWhatsApp.id]
            ),
            MergedFromPerson(
                id: "p-david-name",
                canonicalName: "David",
                aliases: [
                    PersonAlias(id: "a-f2", aliasType: "name", alias: "David", sourceId: nil),
                ],
                inboundCount: 12, outboundCount: 9,
                appliedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-120)),
                sourceIds: [sourceWhatsApp.id]
            ),
            MergedFromPerson(
                id: "p-david-docs",
                canonicalName: "David Lin (Google Docs)",
                aliases: [
                    PersonAlias(id: "a-f3", aliasType: "name", alias: "David Lin", sourceId: nil),
                ],
                inboundCount: 4, outboundCount: 3,
                appliedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-180)),
                sourceIds: [sourceGmail.id]
            ),
            MergedFromPerson(
                id: "p-david-fr",
                canonicalName: "david",
                aliases: [
                    PersonAlias(id: "a-f4", aliasType: "name", alias: "david", sourceId: nil),
                ],
                inboundCount: 2, outboundCount: 1,
                appliedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-240)),
                sourceIds: [sourceStrava.id, sourceWhatsApp.id]
            ),
        ]
    )

    /// Loser variant — `mergedInto` is non-nil so the view shows the
    /// "merged into [canonical]" banner.
    static let personDetailLoser = PersonDetail(
        id: "p-david-phone",
        canonicalName: "+15550100001",
        source: "extracted",
        isSelf: false,
        firstSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 14)),
        lastSeen: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 5)),
        aliases: [
            PersonAlias(id: "a-l1", aliasType: "phone", alias: "+1 (555) 010-0001", sourceId: nil),
        ],
        aliasesOwn: nil,
        inboundCount: 6, outboundCount: 4,
        interactionScore: 0.004,
        interactionScoreRecent: 0.004,
        inboundScoreRecent: 0.002,
        outboundScoreRecent: 0.002,
        mergedInto: "p-david",
        mergedIntoCanonicalName: "david.lin@example.com",
        mergedFrom: []
    )

    static let personDocuments: [PersonDocumentEntry] = [
        PersonDocumentEntry(id: "abc-123", roles: ["sender"]),
        PersonDocumentEntry(id: "def-456", roles: ["recipient", "mentioned"]),
        PersonDocumentEntry(id: "ghi-789", roles: ["participant"]),
    ]

    // MARK: - Merge rules

    /// Mixed merge-rule fixtures: a user single-pair rule, a
    /// system-detected single-pair rule, and a three-rule cluster merge
    /// (one `groupId`, four identities). Drives `MergeRulesView`.
    static let mergeRules: [MergeRule] = [
        MergeRule(
            id: "rule-user-1",
            kind: "user",
            sideA: MergeRuleSide(aliasType: "email", alias: "maya.reeves@example.com"),
            sideB: MergeRuleSide(aliasType: "phone", alias: "+1 (555) 010-0042"),
            winnerSide: "a",
            reason: "same person, work + mobile",
            createdAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)),
            groupId: nil,
            resolvedSideA: [
                MergeRulePerson(
                    id: "p-maya",
                    canonicalName: "Maya Reeves",
                    aliases: [MergeRuleSide(aliasType: "email", alias: "maya.reeves@example.com")],
                    sourceIds: [sourceGmail.id, sourceAppleNotes.id],
                    mergedIntoCanonicalName: nil
                ),
            ],
            resolvedSideB: [
                MergeRulePerson(
                    id: "p-maya-phone",
                    canonicalName: "+15550100042",
                    aliases: [MergeRuleSide(aliasType: "phone", alias: "+1 (555) 010-0042")],
                    sourceIds: [sourceWhatsApp.id],
                    mergedIntoCanonicalName: "Maya Reeves"
                ),
            ]
        ),
        MergeRule(
            id: "rule-system-1",
            kind: "system",
            sideA: MergeRuleSide(aliasType: "name", alias: "Jamie Lopez"),
            sideB: MergeRuleSide(aliasType: "email", alias: "jamie.lopez@example.org"),
            winnerSide: "b",
            reason: "exact-name auto-detect",
            createdAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 2)),
            groupId: nil,
            resolvedSideA: [
                MergeRulePerson(
                    id: "p-jamie-name",
                    canonicalName: "Jamie Lopez",
                    aliases: [MergeRuleSide(aliasType: "name", alias: "Jamie Lopez")],
                    sourceIds: [sourceStrava.id],
                    mergedIntoCanonicalName: "jamie.lopez@example.org"
                ),
            ],
            resolvedSideB: [
                MergeRulePerson(
                    id: "p-jamie",
                    canonicalName: "jamie.lopez@example.org",
                    aliases: [MergeRuleSide(aliasType: "email", alias: "jamie.lopez@example.org")],
                    sourceIds: [sourceGmail.id, sourceWhatsApp.id],
                    mergedIntoCanonicalName: nil
                ),
            ]
        ),
        MergeRule(
            id: "rule-cluster-a",
            kind: "user",
            sideA: MergeRuleSide(aliasType: "email", alias: "david.lin@example.com"),
            sideB: MergeRuleSide(aliasType: "name", alias: "David Lin"),
            winnerSide: "a",
            reason: nil,
            createdAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-300)),
            groupId: "grp-david",
            resolvedSideA: [
                MergeRulePerson(
                    id: "p-david",
                    canonicalName: "David Lin",
                    aliases: [MergeRuleSide(aliasType: "email", alias: "david.lin@example.com")],
                    sourceIds: [sourceGmail.id],
                    mergedIntoCanonicalName: nil
                ),
            ],
            resolvedSideB: [
                MergeRulePerson(
                    id: "p-david-name",
                    canonicalName: "David",
                    aliases: [MergeRuleSide(aliasType: "name", alias: "David Lin")],
                    sourceIds: [sourceWhatsApp.id],
                    mergedIntoCanonicalName: "David Lin"
                ),
            ]
        ),
        MergeRule(
            id: "rule-cluster-b",
            kind: "user",
            sideA: MergeRuleSide(aliasType: "email", alias: "david.lin@example.com"),
            sideB: MergeRuleSide(aliasType: "phone", alias: "+1 (555) 010-0001"),
            winnerSide: "a",
            reason: nil,
            createdAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-300)),
            groupId: "grp-david",
            resolvedSideA: [
                MergeRulePerson(
                    id: "p-david",
                    canonicalName: "David Lin",
                    aliases: [MergeRuleSide(aliasType: "email", alias: "david.lin@example.com")],
                    sourceIds: [sourceGmail.id],
                    mergedIntoCanonicalName: nil
                ),
            ],
            resolvedSideB: [
                MergeRulePerson(
                    id: "p-david-phone",
                    canonicalName: "+15550100001",
                    aliases: [MergeRuleSide(aliasType: "phone", alias: "+1 (555) 010-0001")],
                    sourceIds: [sourceWhatsApp.id],
                    mergedIntoCanonicalName: "David Lin"
                ),
            ]
        ),
        MergeRule(
            id: "rule-cluster-c",
            kind: "user",
            sideA: MergeRuleSide(aliasType: "email", alias: "david.lin@example.com"),
            sideB: MergeRuleSide(aliasType: "email", alias: "davidlin.alt@example.com"),
            winnerSide: "a",
            reason: nil,
            createdAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-300)),
            groupId: "grp-david",
            resolvedSideA: [
                MergeRulePerson(
                    id: "p-david",
                    canonicalName: "David Lin",
                    aliases: [MergeRuleSide(aliasType: "email", alias: "david.lin@example.com")],
                    sourceIds: [sourceGmail.id],
                    mergedIntoCanonicalName: nil
                ),
            ],
            resolvedSideB: [
                MergeRulePerson(
                    id: "p-david-alt",
                    canonicalName: "davidlin.alt@example.com",
                    aliases: [MergeRuleSide(aliasType: "email", alias: "davidlin.alt@example.com")],
                    sourceIds: [sourceAppleNotes.id],
                    mergedIntoCanonicalName: "David Lin"
                ),
            ]
        ),
    ]

    // MARK: - Merge candidates

    /// Two probable-duplicate clusters for the review queue: a three-member
    /// cluster (one member carrying enough attributes to overflow into
    /// "+N more") and a two-member pair. Drives `MergeCandidatesList`. All
    /// invented per the privacy rule.
    static let mergeCandidates = MergeCandidatesPage(
        items: [
            MergeCandidate(
                id: "cand-1",
                clusterId: "cl-maya",
                resolvedSideA: [
                    MergeRulePerson(
                        id: "p-maya",
                        canonicalName: "Maya Reeves",
                        aliases: [
                            MergeRuleSide(aliasType: "email", alias: "maya.reeves@example.com"),
                            MergeRuleSide(aliasType: "phone", alias: "+1 (555) 010-0142"),
                            MergeRuleSide(aliasType: "name", alias: "Maya Reeves"),
                        ],
                        sourceIds: [sourceGmail.id, sourceAppleNotes.id]
                    ),
                ],
                resolvedSideB: [
                    MergeRulePerson(
                        id: "p-maya-chat",
                        canonicalName: "Maya",
                        aliases: [
                            MergeRuleSide(aliasType: "email", alias: "maya.r.chat@example.com"),
                            MergeRuleSide(aliasType: "phone", alias: "+1 (555) 010-0143"),
                            MergeRuleSide(aliasType: "lid", alias: "88120104412233"),
                            MergeRuleSide(aliasType: "lid", alias: "77001920104998"),
                            MergeRuleSide(aliasType: "name", alias: "Maya"),
                        ],
                        sourceIds: [sourceWhatsApp.id]
                    ),
                ]
            ),
            MergeCandidate(
                id: "cand-1b",
                clusterId: "cl-maya",
                resolvedSideA: [
                    MergeRulePerson(
                        id: "p-maya",
                        canonicalName: "Maya Reeves",
                        aliases: [MergeRuleSide(aliasType: "email", alias: "maya.reeves@example.com")],
                        sourceIds: [sourceGmail.id]
                    ),
                ],
                resolvedSideB: [
                    MergeRulePerson(
                        id: "p-maya-work",
                        canonicalName: "m.reeves",
                        aliases: [
                            MergeRuleSide(aliasType: "email", alias: "m.reeves@northstar.example.com"),
                            MergeRuleSide(aliasType: "name", alias: "m.reeves"),
                        ],
                        sourceIds: [sourceAppleNotes.id]
                    ),
                ]
            ),
            MergeCandidate(
                id: "cand-2",
                clusterId: "cl-david",
                resolvedSideA: [
                    MergeRulePerson(
                        id: "p-david",
                        canonicalName: "David Lin",
                        aliases: [
                            MergeRuleSide(aliasType: "email", alias: "david.lin@example.com"),
                            MergeRuleSide(aliasType: "name", alias: "David Lin"),
                        ],
                        sourceIds: [sourceGmail.id]
                    ),
                ],
                resolvedSideB: [
                    MergeRulePerson(
                        id: "p-david-work",
                        canonicalName: "d.lin",
                        aliases: [
                            MergeRuleSide(aliasType: "email", alias: "d.lin@stellarsound.example.com"),
                            MergeRuleSide(aliasType: "name", alias: "d.lin"),
                        ],
                        sourceIds: [sourceWhatsApp.id]
                    ),
                ]
            ),
        ],
        counts: MergeCandidateCounts(pending: 14, accepted: 12, denied: 4)
    )

    // MARK: - Document detail

    /// Real-shape DocumentDetail decoded from the same JSON the gateway
    /// returns — keeps the preview honest about wire format quirks like
    /// stringified `metadata`. Any decode failure here is a mock-data bug.
    static let documentDetail: DocumentDetail = {
        let json = """
        {
          "id": "abc-123",
          "provider_id": "google:user@example.com",
          "source_id": "gmail:user@example.com",
          "external_id": "ext-1",
          "title": "Re: Stripe invoice for March",
          "content": "Hi Jamie,\\n\\nYour invoice for the period of Mar 1-31 is now available.\\n\\nTotal: $124.00\\nDue: Apr 15, 2026\\n\\nPay before the due date to avoid late fees.",
          "content_hash": "sha256:abc",
          "metadata": "{\\"documentType\\":\\"email\\",\\"sourceUrl\\":\\"https://mail.google.com/mail/u/0/#inbox/abc\\"}",
          "source_created_at": "2026-04-12T10:14:00Z",
          "source_updated_at": "2026-04-12T10:14:00Z",
          "ingested_at": "2026-04-12T10:15:00Z",
          "updated_at": "2026-04-12T10:15:00Z"
        }
        """
        return try! JSONDecoder().decode(DocumentDetail.self, from: Data(json.utf8))
    }()

    static let documentPeople: [PersonMention] = [
        PersonMention(
            personId: "self-1", canonicalName: "You",
            role: "recipient", isSelf: true,
            aliases: [PersonAlias(
                id: "a-self-1", aliasType: "email",
                alias: "user@example.com", sourceId: nil
            )]
        ),
        PersonMention(
            personId: "p-ledgerline", canonicalName: "",
            role: "sender", isSelf: false,
            aliases: [PersonAlias(
                id: "a-ledgerline", aliasType: "email",
                alias: "billing@example.com", sourceId: nil
            )]
        ),
    ]

    static let documentRefs = DocumentRefs(
        outbound: [
            OutboundRef(
                linkType: "url",
                rawTarget: "https://example.com/invoices/in_1ABC",
                normalizedTarget: "https://example.com/invoices/in_1ABC",
                targetDocId: nil,
                targetTitle: nil,
                targetSourceId: nil,
                targetSourceUrl: nil,
                targetAppUrl: nil
            ),
            OutboundRef(
                linkType: "url",
                rawTarget: "https://omnesis-app/notes/standup-mar-9",
                normalizedTarget: "https://omnesis-app/notes/standup-mar-9",
                targetDocId: "def-456",
                targetTitle: "Standup notes — Mar 9",
                targetSourceId: sourceAppleNotes.id,
                targetSourceUrl: nil,
                targetAppUrl: nil
            ),
            OutboundRef(
                linkType: "attachment",
                rawTarget: "inv.pdf",
                normalizedTarget: "att/inv.pdf",
                targetDocId: nil,
                targetTitle: nil,
                targetSourceId: nil,
                targetSourceUrl: nil,
                targetAppUrl: nil
            ),
        ],
        inbound: [
            InboundRef(
                sourceDocId: "ghi-789",
                sourceTitle: "Summer hike in the alps (group)",
                sourceSourceId: sourceWhatsApp.id,
                linkType: "url",
                sourceSourceUrl: nil,
                sourceAppUrl: nil
            ),
            InboundRef(
                sourceDocId: "jkl-012",
                sourceTitle: "Q1 finances",
                sourceSourceId: sourceAppleNotes.id,
                linkType: "url",
                sourceSourceUrl: nil,
                sourceAppUrl: nil
            ),
        ]
    )

    static let documentAttachments: [DocumentAttachment] = [
        DocumentAttachment(
            id: "att-1", externalId: "ext-1/att/inv.pdf",
            title: "invoice-march.pdf", attachmentId: "inv.pdf",
            mimeType: "application/pdf",
            sizeBytes: 132_000, pages: 2, truncated: false,
            sourceUrl: nil, appUrl: nil
        ),
    ]

    static let documentNearDupes = DocumentNearDupes(
        edges: [
            NearDupEdge(
                otherDocId: "near-1",
                otherTitle: "Re: Standup notes — Mar 9",
                otherSourceId: "gmail:work@example.com",
                otherDocType: "email",
                otherSourceUrl: nil,
                otherAppUrl: nil,
                jaccard: 0.92,
                pairUniqueDf2: 14,
                pairUniqueDf5: 22,
                containmentMin: 0.96,
                gateFamily: "email"
            ),
            NearDupEdge(
                otherDocId: "near-2",
                otherTitle: "Marathon entry form v2.pdf",
                otherSourceId: "google-drive:work@example.com",
                otherDocType: "file",
                otherSourceUrl: nil,
                otherAppUrl: nil,
                jaccard: 0.81,
                pairUniqueDf2: 6,
                pairUniqueDf5: 11,
                containmentMin: 0.98,
                gateFamily: "file"
            ),
        ],
        nextCursor: nil
    )

    /// Cross-store `same-entity` bound rows — the
    /// `analytics-row` vertices the graph walker returns for an activity
    /// document. Invented Strava activity (NOT from the user's corpus).
    static let documentGraphBoundRows: [GraphVertex] = [
        GraphVertex(
            id: "row:strava_activities:900100200",
            kind: "analytics-row",
            tableName: "strava_activities",
            tableDisplayName: "Strava Activities",
            rowPrimaryKey: "900100200",
            row: [
                "id": .int(900_100_200),
                "name": .string("Morning Run"),
                "sport_type": .string("Run"),
                "distance_m": .double(9200.0),
                "moving_time_seconds": .int(2880),
                "total_elevation_gain_m": .double(47.5),
                "start_time_local": .string("2026-06-09 07:14:02"),
            ]
        ),
    ]

    // MARK: - Agent LLM annotations (experimental)

    /// The agent's durable person annotations — rendered under a "Profile"
    /// heading for the self person, and a "learned about <name>" heading for
    /// anyone else. All invented from scratch (privacy): fictional names and
    /// reserved ranges only, never the operator's corpus. Includes a
    /// high-confidence self-memory-flavored row, a row with no evidence quote,
    /// and a long claim for wrap testing. The verification timestamps are
    /// computed relative to now so the rendered "· Nd ago" recency stays
    /// stable in snapshots.
    static let personAnnotations: [Annotation] = [
        Annotation(
            id: "ann-p-routine",
            claimType: "routine",
            claimText: "Reviews the week's open loops on Sunday evenings and clears the inbox before Monday.",
            evidenceDocId: "doc-ann-1",
            evidenceQuote: "doing my Sunday reset now — inbox to zero",
            confidence: 0.95,
            createdAt: "2026-07-01T09:00:00Z",
            claimBasis: "quoted",
            verificationState: "verified",
            lastVerifiedAt: isoDaysAgo(2)
        ),
        Annotation(
            id: "ann-p-preference",
            claimType: "preference",
            claimText:
            "Prefers async written updates over live calls, and keeps Friday afternoons free for focused, uninterrupted deep work.",
            evidenceDocId: nil,
            evidenceQuote: nil,
            confidence: 0.61,
            createdAt: "2026-07-03T14:30:00Z",
            claimBasis: "synthesized",
            verificationState: "unverified",
            lastVerifiedAt: nil
        ),
        Annotation(
            id: "ann-p-relationship",
            claimType: "relationship",
            claimText: "Trains with Jamie Lopez for the Sunday long run.",
            evidenceDocId: "doc-ann-2",
            evidenceQuote: "see you Sunday for the long run",
            confidence: 0.82,
            createdAt: "2026-07-05T18:00:00Z",
            claimBasis: "inferred",
            verificationState: "verified",
            lastVerifiedAt: isoDaysAgo(5)
        ),
    ]

    /// ISO timestamp N days before now — keeps relative "ago" labels stable.
    private static func isoDaysAgo(_ days: Double) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(-days * 86400))
    }

    /// The agent's durable document annotations — the "Enriched by Omnesis"
    /// panel on a document. Grounded on the fictional invoice `documentDetail`
    /// fixture; a second row carries no evidence quote and no basis or
    /// verification metadata (the legacy shape older gateways serve). All
    /// invented.
    static let documentAnnotations: [Annotation] = [
        Annotation(
            id: "ann-d-commitment",
            claimType: "commitment",
            claimText: "A payment of $124.00 is due by April 15.",
            evidenceDocId: "abc-123",
            evidenceQuote: "Pay before the due date to avoid late fees.",
            confidence: 0.88,
            createdAt: "2026-04-12T10:16:00Z",
            claimBasis: "quoted",
            verificationState: "verified",
            lastVerifiedAt: isoDaysAgo(1)
        ),
        Annotation(
            id: "ann-d-vendor",
            claimType: "vendor",
            claimText: "The invoice was issued by Stellar Sound for March services.",
            evidenceDocId: nil,
            evidenceQuote: nil,
            confidence: 0.7,
            createdAt: "2026-04-12T10:16:30Z"
        ),
    ]

    // MARK: - Pairing

    static let pairingPayloadV4System = PairingPayload.V4(
        gatewayUrl: "https://public-gateway.example.com",
        pairingCode: "A1B2-C3D4-EF",
        tls: .system
    )

    /// V3 payload mock — TLS-pinned exchange. Fingerprint is a fake
    /// but well-shaped 64-hex-char SHA-256 digest.
    static let pairingPayloadV3 = PairingPayload.V3(
        gatewayUrl: "https://mac-mini.local:7600",
        pairingCode: "A1B2-C3D4-EF",
        fingerprint: "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb"
    )

    /// V2 payload mock — legacy unpinned exchange.
    static let pairingPayloadV2 = PairingPayload.V2(
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "A1B2-C3D4-EF"
    )

    // MARK: - Recent + recent items

    static let recentDocuments: [RecentDocument] = [
        RecentDocument(
            id: "abc-123",
            sourceId: sourceGmail.id,
            externalId: "ext-1",
            title: "Re: Stripe invoice for March",
            contentPreview: "Your invoice for the period of Mar 1–31 is now available.",
            documentType: "email",
            relevanceScore: nil,
            sourceCreatedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 3)),
            sourceUpdatedAt: nil
        ),
        RecentDocument(
            id: "abc-124",
            sourceId: sourceGmail.id,
            externalId: "ext-2",
            title: "Welcome to your weekly summary",
            contentPreview: "This week you sent 47 emails and received 312.",
            documentType: "email",
            relevanceScore: nil,
            sourceCreatedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 7)),
            sourceUpdatedAt: nil
        ),
    ]

    /// A generated Notes day document row. The read-only affordance
    /// (Manage notes) lives in the row's long-press menu, so a static
    /// preview shows the row itself; the link predicate is unit-tested.
    static let recentNotesDocuments: [RecentDocument] = [
        RecentDocument(
            id: "notes-2026-03-01",
            sourceId: notesSourceId,
            externalId: "2026-03-01",
            title: "Notes for March 1",
            contentPreview: "Tell the team the studio booking moved to Friday.",
            documentType: "note",
            relevanceScore: nil,
            sourceCreatedAt: "2026-03-01T10:00:00Z",
            sourceUpdatedAt: nil
        ),
    ]

    /// A generated Notes day document. Read-only projection of the
    /// `note_entries` ledger — managed on Tell Omnesis, never deleted here.
    static let notesDayDocument: DocumentDetail = {
        let json = """
        {
          "id": "notes-2026-03-01",
          "provider_id": "system",
          "source_id": "\(notesSourceId)",
          "internal": true,
          "external_id": "2026-03-01",
          "title": "Notes for March 1",
          "content": "Tell the team the studio booking moved to Friday.",
          "content_hash": "sha256:preview",
          "metadata": "{\\"documentType\\":\\"note\\"}",
          "source_created_at": "2026-03-01T10:00:00Z",
          "source_updated_at": "2026-03-01T10:00:00Z",
          "ingested_at": "2026-03-01T10:00:00Z",
          "updated_at": "2026-03-01T10:00:00Z"
        }
        """
        return try! JSONDecoder().decode(DocumentDetail.self, from: Data(json.utf8))
    }()

    static let recentAnalytics: RecentItemsResponse = .analytics(
        table: "strava_activities",
        displayName: "Strava activities",
        columns: ["activity_id", "started_at", "distance_km", "active"],
        rows: [
            [.string("run-001"), .string("2026-01-05T08:30:00Z"), .double(8.4), .bool(true)],
            [.string("ride-002"), .string("2026-01-03T14:10:00Z"), .double(24.75), .bool(false)],
            [.string("walk-003"), .string("2026-01-02T12:00:00Z"), .int(3), .bool(true)],
        ]
    )

    // MARK: - Watches

    /// Watches as the Watches tab shows them: one running and quiet, one that
    /// has found things, one held by a failure, one finished.
    ///
    /// Invented names and requests — nothing here comes from an indexed corpus.
    static let watches: [WatchRecord] = [
        WatchRecord(
            id: "w-listing",
            name: "listing-unanswered",
            status: "active",
            firings: 3,
            note: nil,
            request: "Tell me when a property listing I asked about goes three days without a reply.",
            delivery: "omnesis-notify",
            verdict: WatchVerdict(
                name: "healthy",
                because: "fired 3 times, most recently 2 days ago",
                label: "Working",
                actionable: false
            )
        ),
        WatchRecord(
            id: "w-payment",
            name: "large-payment",
            status: "active",
            firings: 0,
            note: nil,
            request: "Tell me when a payment over 500 leaves the account.",
            verdict: WatchVerdict(
                name: "never-matched",
                because: "looked at 4,183 events over 21 days and admitted none",
                label: "Never matched",
                actionable: true
            )
        ),
        WatchRecord(
            id: "w-spend",
            name: "monthly-spend-review",
            status: "paused",
            firings: 12,
            note: "node 'spend' failed (query) — see `watch trace`",
            request: "Every month, tell me what I spent against what I spent last month.",
            delivery: "omnesis-notify",
            // The longest sentence the vocabulary produces, on the row that
            // also carries a note: the two together are what tests whether a
            // row still reads as one thing.
            verdict: WatchVerdict(
                name: "judge-declines-everything",
                because: "its arm nominated 137 documents and the judge refused every one",
                label: "Judge refuses everything",
                actionable: true
            )
        ),
        WatchRecord(
            id: "w-guard",
            name: "event-guard",
            status: "retired",
            firings: 1,
            note: "its horizon passed",
            request: nil,
            verdict: WatchVerdict(
                name: "silent-risk",
                because: "has fired 1 time, and holds no record to wake an agent through",
                label: "Reaching nobody",
                actionable: true
            )
        ),
        // The one an integration asked for, and the one that wakes it. Both
        // facts are indicators on the row: a watch is a watch however it was
        // asked for, so the list must be able to say so without splitting.
        WatchRecord(
            id: "w-invoice",
            name: "invoice-due",
            status: "active",
            firings: 5,
            note: nil,
            request: "Tell me when an invoice I have not paid reaches its due date.",
            delivery: "agent-wake",
            disclosure: watchDisclosureSummary
        ),
    ]

    /// What the listing carries about a watch that wakes an agent: who asked,
    /// which record authorises it, where that record stands, and whom it wakes.
    static let watchDisclosureSummary = WatchDisclosure(
        authoredBy: "integration",
        subscriptionId: "subscription-northstar",
        status: "active",
        integrationName: "Fictional OpenClaw integration"
    )

    /// The whole record, as the watch's own page reads it.
    static let watchDisclosure = WatchDisclosure(
        authoredBy: "integration",
        subscriptionId: "subscription-northstar",
        status: "active",
        integrationName: "Fictional OpenClaw integration",
        revision: 2,
        interpretation: "an invoice that has not been paid reaches its due date",
        condition: "an invoice I have not paid reaches its due date",
        instruction: "Draft a payment reminder and leave it where I will see it.",
        evidence: "condition-only",
        approval: WatchDisclosureApproval(status: "approved"),
        expiresAt: 1_901_209_600_000,
        revokedAt: nil,
        policyRevision: "policy-revision-example-001",
        firingCount: 2,
        lastFiredAt: 1_900_000_500_000
    )

    /// The operator's own watch that still wakes an agent. Nothing was put to
    /// them for approval, because the request was theirs — which is a different
    /// answer from an approval that is missing.
    static let watchDisclosureUnapproved = WatchDisclosure(
        authoredBy: "operator",
        subscriptionId: "subscription-northstar",
        status: "active",
        integrationName: "Fictional OpenClaw integration",
        revision: 1,
        interpretation: "an invoice that has not been paid reaches its due date",
        condition: "an invoice I have not paid reaches its due date",
        instruction: "Draft a payment reminder and leave it where I will see it.",
        evidence: "condition-only",
        approval: nil,
        expiresAt: 0,
        revokedAt: nil,
        policyRevision: "policy-revision-example-001",
        firingCount: 0,
        lastFiredAt: nil
    )

    /// A record the operator has revoked. The watch stays, the ledger of what
    /// it already sent stays, and there is nothing left to revoke.
    static let watchDisclosureRevoked = WatchDisclosure(
        authoredBy: "integration",
        subscriptionId: "subscription-northstar",
        status: "revoked",
        integrationName: "Fictional OpenClaw integration",
        revision: 2,
        interpretation: "an invoice that has not been paid reaches its due date",
        condition: "an invoice I have not paid reaches its due date",
        instruction: "Draft a payment reminder and leave it where I will see it.",
        evidence: "condition-only",
        approval: WatchDisclosureApproval(status: "approved"),
        expiresAt: 1_901_209_600_000,
        revokedAt: 1_900_600_000_000,
        policyRevision: "policy-revision-example-001",
        firingCount: 2,
        lastFiredAt: 1_900_000_500_000
    )

    /// Firings for the detail screen, oldest first — the order the firings
    /// route returns them in, so a preview exercises the screen's own ordering
    /// instead of standing in for it.
    ///
    /// The first is about something a month older than the moment it was
    /// noticed, which is the case the row's second line exists for; the other
    /// two were noticed as they happened.
    static let watchFirings: [WatchFiringRecord] = [
        WatchFiringRecord(
            seq: 10417,
            firedAt: "2026-07-07T19:20:04.000Z",
            noticedAt: "2026-08-08T08:46:38.093Z"
        ),
        WatchFiringRecord(
            seq: 15226,
            firedAt: "2026-08-08T09:50:04.000Z",
            noticedAt: "2026-08-08T09:50:05.100Z",
            documents: [
                WatchFiringDocument(
                    id: "doc_preview_quote",
                    title: "Your quote for the roof",
                    sourceId: "gmail:jamie.lopez@example.com"
                ),
                WatchFiringDocument(
                    id: "doc_preview_attachment",
                    title: "Schedule of works.pdf",
                    sourceId: "gmail:jamie.lopez@example.com"
                ),
            ]
        ),
        WatchFiringRecord(
            seq: 15775,
            firedAt: "2026-08-09T11:32:24.000Z",
            noticedAt: "2026-08-09T11:32:24.900Z"
        ),
    ]

    // MARK: - Agent fixtures

    /// The watch firing behind a thread the agent opened on its own.
    static let watchFiringOrigin = WatchFiringOriginSnapshot(
        name: "Marathon entry deadlines",
        condition: "a race I entered moves its date or its registration deadline",
        firedAt: 1_789_344_600_000
    )
    static let watchFiringOriginWatchId = "wat_marathon_deadlines"
    static let longWatchFiringOriginWatchId = "wat_northstar_rebuild"

    /// The landing: no session yet, because one is minted lazily on the first send. The
    /// new-conversation button is absent — this already is one.
    static let agentEmptyConnected = AppStore.AgentPreviewSeed(
        sessionId: nil,
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "",
        turns: [],
        citations: [],
        conversations: []
    )

    /// The first prompt has been submitted and is already visible while the
    /// new conversation's session mint is still in flight. The nil session id
    /// is load-bearing: this is the optimistic pre-network state, not a normal
    /// busy turn in an established conversation.
    static let agentFirstSendMinting = AppStore.AgentPreviewSeed(
        sessionId: nil,
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "Summarize my project notes",
        turns: [
            .user(id: "u-pending-preview", text: "Summarize my project notes."),
        ],
        citations: [],
        conversations: [],
        busy: true,
        connected: true
    )

    static let agentSqlExampleQuery = """
    SELECT
      CASE
        WHEN start_time >= DATE_TRUNC('month', CURRENT_DATE) THEN 'This Month (May)'
        ELSE 'Last Month (April)'
      END AS period,
      ROUND(AVG(value)::NUMERIC, 1) AS avg_heart_rate,
      ROUND(MIN(value)::NUMERIC, 1) AS min_hr,
      ROUND(MAX(value)::NUMERIC, 1) AS max_hr
    FROM health_vitals
    WHERE metric_slug = 'heart_rate'
      AND start_time >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
    GROUP BY 1
    ORDER BY 1 DESC
    """

    static let agentToolSqlRows: AgentToolResult = .sqlRows(
        sql: agentSqlExampleQuery,
        columns: ["period", "avg_heart_rate", "min_hr", "max_hr"],
        rows: [
            [JSONAny(value: "This Month (May)"), JSONAny(value: 87.4), JSONAny(value: 46.0), JSONAny(value: 185.0)],
            [JSONAny(value: "Last Month (April)"), JSONAny(value: 90.3), JSONAny(value: 43.0), JSONAny(value: 178.0)],
        ],
        rowCount: 2,
        truncated: false,
        durationMs: 7,
        sources: [
            AgentSqlSource(sourceId: "apple-health:user@example.com", sourceType: "apple-health", displayName: "Apple Health"),
        ],
        subjects: ["Vitals"]
    )

    /// Worst-case column alignment fixture — short headers like `day`
    /// next to wide cell values (`{"days":20551}` from DuckDB DATE
    /// columns + decimals). Used by the snapshot test to pin the fix
    /// for the misaligned header bug.
    static let agentToolSqlRowsDailyWide: AgentToolResult = .sqlRows(
        sql: """
        SELECT
          date_trunc('day', start_time)::DATE AS day,
          AVG(value) AS avg_hr,
          MIN(value) AS min_hr,
          MAX(value) AS max_hr
        FROM health_vitals
        WHERE metric_slug = 'heart_rate'
          AND start_time >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 1
        """,
        columns: ["day", "avg_hr", "min_hr", "max_hr"],
        rows: [
            [JSONAny(value: ["days": 20551]), JSONAny(value: 79.2), JSONAny(value: 47), JSONAny(value: 160)],
            [JSONAny(value: ["days": 20552]), JSONAny(value: 86.3), JSONAny(value: 50), JSONAny(value: 133)],
            [JSONAny(value: ["days": 20553]), JSONAny(value: 68.7), JSONAny(value: 48), JSONAny(value: 113)],
            [JSONAny(value: ["days": 20554]), JSONAny(value: 91.6), JSONAny(value: 50), JSONAny(value: 132)],
            [JSONAny(value: ["days": 20555]), JSONAny(value: 100.6), JSONAny(value: 45), JSONAny(value: 174)],
        ],
        rowCount: 5,
        truncated: false,
        durationMs: 18,
        sources: [
            AgentSqlSource(sourceId: "apple-health:user@example.com", sourceType: "apple-health", displayName: "Apple Health"),
        ],
        subjects: ["Vitals"]
    )

    /// Wraps a row of mixed scalars as `JSONAny` cells, keeping the
    /// wide-table fixture's rows compact instead of over-width inline
    /// arrays of `JSONAny(value:)` calls.
    private static func agentSqlRow(_ cells: [Any]) -> [JSONAny] {
        cells.map { JSONAny(value: $0) }
    }

    /// Many-column fixture — eight columns overflow the screen width.
    /// Pins the containment fix: without the table's horizontal
    /// `ScrollView`, the summed column widths would force the whole
    /// transcript wider than the viewport.
    static let agentToolSqlRowsWide: AgentToolResult = .sqlRows(
        sql: """
        SELECT
          name AS session, distance_km AS dist_km, duration_min AS dur_min,
          pace_min_km AS pace_min, avg_hr AS hr_avg, max_hr AS hr_max,
          pct_zone1 AS pct_z1, pct_zone2 AS pct_z2
        FROM workout_activities
        WHERE sport = 'run'
        ORDER BY start_time DESC
        """,
        columns: ["session", "dist_km", "dur_min", "pace_min", "hr_avg", "hr_max", "pct_z1", "pct_z2"],
        rows: [
            agentSqlRow(["Morning Run", 8.2, 44, 5.4, 148, 172, 38, 41]),
            agentSqlRow(["Tempo Loop", 10.1, 52, 5.1, 156, 181, 22, 35]),
            agentSqlRow(["Recovery Jog", 5.6, 36, 6.4, 131, 149, 64, 28]),
        ],
        rowCount: 3,
        truncated: false,
        durationMs: 12,
        sources: [
            AgentSqlSource(sourceId: "strava:user@example.com", sourceType: "strava", displayName: "Strava"),
        ],
        subjects: ["Activities"]
    )

    /// Source-type → unit-name map mirroring what `SourceDescriptor.unitName`
    /// would return for the providers used in agent previews. Production
    /// code reads this from `/admin/source-descriptors`; in previews
    /// `AppStore.preview(...)` seeds it from here so the agent search
    /// summary renders the right per-source nouns ("emails", "files",
    /// "messages") instead of the generic "items" fallback. Adding a new
    /// source to a preview only needs an entry here when that source's
    /// docs appear in a mock — no production code change.
    static let agentSourceUnitNames: [String: String] = [
        "gmail": "emails",
        "google-drive": "files",
        "google-calendar": "events",
        "google-contacts": "contacts",
        "whatsapp-messages": "messages",
        "apple-notes": "notes",
        "apple-reminders": "reminders",
        "apple-imessage": "messages",
        "apple-contacts": "contacts",
        "apple-health": "samples",
        "strava-activities": "activities",
        "screen-time": "sessions",
        "things": "tasks",
        "notion-pages": "pages",
        "notion-databases": "rows",
        "obsidian": "notes",
        "browser-history": "visits",
        "chrome-bookmarks": "bookmarks",
        "outlook-email": "emails",
    ]

    /// Per-source brand bg color, keyed by source type. Mirrors the
    /// `icon.bgColor` each provider package declares so SwiftUI
    /// previews render citation sticky tabs with the same palette
    /// production does — without paying the gateway round-trip.
    static let sourceBgColorByType: [String: String] = [
        "gmail": "#2D1716",
        "google-calendar": "#16213A",
        "google-drive": "#2D2410",
        "google-contacts": "#16213A",
        "apple-notes": "#2A2410",
        "apple-reminders": "#2D2010",
        "apple-imessage": "#14241F",
        "apple-contacts": "#2D1818",
        "notion-pages": "#1F1F1F",
        "notion-databases": "#1F1F1F",
        "chrome-bookmarks": "#16213A",
        "obsidian-notes": "#1F1734",
        "things": "#15243A",
        "whatsapp-messages": "#12251C",
        "outlook-email": "#0B2236",
        "strava-activities": "#2D170D",
        "browser-history": "#0E2236",
        "screen-time": "#1B1A2E",
    ]

    /// Per-source brand accent color, keyed by source type. Mirrors
    /// `icon.color` declared in each provider package.
    static let sourceAccentColorByType: [String: String] = [
        "gmail": "#EA4335",
        "google-calendar": "#4285F4",
        "google-drive": "#FBBC04",
        "google-contacts": "#4285F4",
        "apple-notes": "#FFCC00",
        "apple-reminders": "#FF9500",
        "apple-imessage": "#34C759",
        "apple-contacts": "#FF6B6B",
        "notion-pages": "#E0E0E0",
        "notion-databases": "#E0E0E0",
        "chrome-bookmarks": "#4285F4",
        "obsidian-notes": "#7C3AED",
        "things": "#4A90D9",
        "whatsapp-messages": "#25D366",
        "outlook-email": "#0078D4",
        "strava-activities": "#FC4C02",
        "browser-history": "#007AFF",
        "screen-time": "#5856D6",
        "enable-banking-accounts": "#111111",
    ]

    static let agentDocRefDriveContract = AgentDocRef(
        documentId: "drive-contract-1",
        sourceType: "google-drive",
        sourceId: "google-drive:me",
        documentType: "file",
        title: "Contrat R1.5 - 10 octobre 2024 - Mariage de Sarah et Jamie",
        snippet: "Prestation DJ et système son · Stellar Sound · 18h-04h · 1 DJ + 1 technicien",
        ts: 1_725_500_000_000,
        people: ["Olivia (Stellar Sound)"]
    )

    static let agentDocRefGmailContract = AgentDocRef(
        documentId: "gmail-contract-1",
        sourceType: "gmail",
        sourceId: "gmail:me",
        documentType: "email",
        title: "Signed: Contrat R1.5 Mariage de Sarah et Jamie (via DocuSign)",
        snippet: "Bonjour Jamie, voici le contrat signé pour la prestation du 10 octobre.",
        ts: 1_725_550_000_000,
        people: ["Olivia", "Stellar Sound"]
    )

    static let agentDocRefWhatsappBackup = AgentDocRef(
        documentId: "whatsapp-1",
        sourceType: "whatsapp-messages",
        sourceId: "whatsapp:+44…",
        documentType: "conversation",
        title: "Sarah — 2024-08-31",
        snippet: "Jamie a partagé le contrat avec le groupe pour validation.",
        ts: 1_725_600_000_000
    )

    static let agentToolSearchResults: AgentToolResult = .searchResults(
        query: "wedding DJ sound system contract",
        durationMs: 6854,
        candidates: 100,
        results: [
            agentDocRefGmailContract,
            agentDocRefDriveContract,
            agentDocRefWhatsappBackup,
        ]
    )

    static let agentToolDocument: AgentToolResult = .document(
        ref: agentDocRefDriveContract,
        content: """
        CONTRAT DE PRESTATION ARTISTIQUE — Stellar Sound

        Le 10 octobre 2024 — Riverside Estate

        - 1 DJ + 1 technicien · 18h00 → 04h00
        - Système son piste de danse, platines, 1 micro HF
        - Lumières piste de danse
        - DJ remplaçant garanti
        - Frais kilométriques au départ de Paris (0,6 €/km)

        Signé électroniquement le 20 août 2024 via Adobe Acrobat Sign.
        """,
        neighbors: []
    )

    /// Stand-in for an `event_trail.built` tool result. `events` is
    /// the typed `AgentTrailEvent` shape so the Timeline tab in the
    /// Citations drawer can render them natively. This fixture stays
    /// minimal — twelve placeholder events without people / related
    /// / attachments — so the one-line transcript fallback still has
    /// the right count to show; richer trail fixtures live in
    /// `PreviewMocks.trail*` below.
    static let agentToolEventTrail: AgentToolResult = .eventTrailBuilt(
        seeds: ["drive-contract-1"],
        events: (0 ..< 12).map { i in
            AgentTrailEvent(
                eventId: "evt-\(i)",
                at: "2026-03-12T10:14:00Z",
                kind: i == 0 ? "seed" : "document",
                doc: AgentTrailEventDoc(
                    documentId: "evt-\(i)",
                    title: "Doc \(i)",
                    sourceId: "gmail:user@example.com",
                    sourceUrl: nil,
                    appUrl: nil,
                    documentType: nil,
                    mimeType: nil
                ),
                attachments: [],
                people: [],
                related: []
            )
        },
        truncated: false,
        stats: JSONAny(value: [
            "visited": 12,
            "elapsedMs": 87,
            "maxDepthReached": 3,
        ] as [String: Any])
    )

    // MARK: - Trail fixtures for the Citations drawer's Timeline tab

    /// Hand-rolled event trail mirroring a real-world voucher journey:
    /// the same PDF arrives across Gmail (order email + saved-to-self
    /// + Christmas forward) and WhatsApp (asked-for + used). One
    /// attached PDF nests under the order email. Covers most rendering
    /// branches: seed kind, multiple days, both source families,
    /// people-by-role lines, attachments.
    static let trailVoucherJourney: [AgentTrailEvent] = [
        AgentTrailEvent(
            eventId: "evt-order",
            at: "2025-12-06T10:08:42Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: "evt-order",
                title: "Votre commande sur Restaurant de Le Petit Jardin est maintenant terminée",
                sourceId: "gmail:user@example.com",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "email",
                mimeType: nil
            ),
            attachments: [
                AgentTrailEvent(
                    eventId: "evt-ticket-pdf",
                    at: "2025-12-06T10:08:42Z",
                    kind: "document",
                    doc: AgentTrailEventDoc(
                        documentId: "evt-ticket-pdf",
                        title: "ticket_166740_125646287-…Z9F1GBD6N.pdf",
                        sourceId: "gmail:user@example.com",
                        sourceUrl: nil,
                        appUrl: nil,
                        documentType: "attachment",
                        mimeType: "application/pdf"
                    ),
                    attachments: [],
                    people: [],
                    related: []
                ),
            ],
            people: [
                AgentTrailEventPerson(personId: "p-self", name: "You", role: "recipient", isSelf: true),
            ],
            related: []
        ),
        AgentTrailEvent(
            eventId: "evt-voucher",
            at: "2025-12-06T10:09:25Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: "evt-voucher",
                title: "Bon Cadeau — Maya",
                sourceId: "gmail:user@example.com",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "email",
                mimeType: nil
            ),
            attachments: [
                AgentTrailEvent(
                    eventId: "evt-voucher-pdf",
                    at: "2025-12-06T10:09:25Z",
                    kind: "document",
                    doc: AgentTrailEventDoc(
                        documentId: "evt-voucher-pdf",
                        title: "bon-cadeau-maya.pdf",
                        sourceId: "gmail:user@example.com",
                        sourceUrl: nil,
                        appUrl: nil,
                        documentType: "attachment",
                        mimeType: "application/pdf"
                    ),
                    attachments: [],
                    people: [],
                    related: []
                ),
            ],
            people: [
                AgentTrailEventPerson(personId: "p-self", name: "You", role: "sender", isSelf: true),
                AgentTrailEventPerson(personId: "p-self", name: "You", role: "recipient", isSelf: true),
            ],
            related: []
        ),
        AgentTrailEvent(
            eventId: "evt-fwd",
            at: "2025-12-24T18:07:24Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: "evt-fwd",
                title: "Fwd: Votre commande sur Restaurant de Le Petit Jardin",
                sourceId: "gmail:user@example.com",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "email",
                mimeType: nil
            ),
            attachments: [],
            people: [
                AgentTrailEventPerson(personId: "p-self", name: "You", role: "sender", isSelf: true),
                AgentTrailEventPerson(personId: "p-riley", name: "Riley", role: "recipient", isSelf: false),
            ],
            related: []
        ),
        AgentTrailEvent(
            eventId: "evt-wa-ask",
            at: "2026-05-14T15:40:46Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: "evt-wa-ask",
                title: "Maya Reeves — 2026-05-14",
                sourceId: "whatsapp-messages:+44…",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "conversation",
                mimeType: nil
            ),
            attachments: [],
            people: [
                AgentTrailEventPerson(personId: "p-self", name: "You", role: "participant", isSelf: true),
                AgentTrailEventPerson(personId: "p-maya", name: "Maya Reeves", role: "participant", isSelf: false),
            ],
            related: []
        ),
        AgentTrailEvent(
            eventId: "evt-wa-used",
            at: "2026-05-16T16:29:34Z",
            kind: "seed",
            doc: AgentTrailEventDoc(
                documentId: "evt-wa-used",
                title: "Maya Reeves — 2026-05-16",
                sourceId: "whatsapp-messages:+44…",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "conversation",
                mimeType: nil
            ),
            attachments: [],
            people: [
                AgentTrailEventPerson(personId: "p-self", name: "You", role: "participant", isSelf: true),
                AgentTrailEventPerson(personId: "p-maya", name: "Maya Reeves", role: "participant", isSelf: false),
            ],
            related: []
        ),
    ]

    /// A transcript cites a structured change request while a browser capture
    /// remains as a second representation. Exercises the `same-resource`
    /// related row with deliberately long titles at a narrow snapshot width.
    static let trailUrlRepresentations: [AgentTrailEvent] = [
        AgentTrailEvent(
            eventId: "evt-transcript-release",
            at: "2026-07-03T09:10:00Z",
            kind: "seed",
            doc: AgentTrailEventDoc(
                documentId: "doc-transcript-release",
                title: "Planning transcript for the Northstar release checklist",
                sourceId: "session-transcripts:local",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "conversation",
                mimeType: nil
            ),
            related: [
                AgentTrailEventRelated(
                    documentId: "doc-change-request-42",
                    title: "Change request 42 — prepare the Northstar release",
                    sourceId: "code-hosting:local",
                    linkType: "url",
                    direction: "out"
                ),
            ]
        ),
        AgentTrailEvent(
            eventId: "evt-change-request-42",
            at: "2026-07-03T09:14:00Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: "doc-change-request-42",
                title: "Change request 42 — prepare the Northstar release",
                sourceId: "code-hosting:local",
                sourceUrl: "https://code.example.org/northstar/changes/42",
                appUrl: nil,
                documentType: "change-request",
                mimeType: nil
            ),
            related: [
                AgentTrailEventRelated(
                    documentId: "doc-capture-change-request-42",
                    title: "Captured page: Northstar change request 42",
                    sourceId: "web",
                    linkType: "same-resource",
                    direction: "peer"
                ),
            ]
        ),
        AgentTrailEvent(
            eventId: "evt-capture-change-request-42",
            at: "2026-07-03T09:16:00Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: "doc-capture-change-request-42",
                title: "Captured page: Northstar change request 42",
                sourceId: "web",
                sourceUrl: "https://code.example.org/northstar/changes/42",
                appUrl: nil,
                documentType: "webpage",
                mimeType: "text/html"
            ),
            related: [
                AgentTrailEventRelated(
                    documentId: "doc-change-request-42",
                    title: "Change request 42 — prepare the Northstar release",
                    sourceId: "code-hosting:local",
                    linkType: "same-resource",
                    direction: "peer"
                ),
            ]
        ),
    ]

    /// Hand-rolled annotations pairing with the `trailVoucherJourney`
    /// documents to exercise the annotation rendering surface: doc-scoped
    /// quote, doc-scoped quote-with-note, and note-only entries. Each slot
    /// carries the `ref` a real `annotate.recorded` always supplies — the
    /// unified Timeline synthesises one row per annotated document from it.
    static let trailVoucherAnnotations: AgentTrailAnnotations = {
        let iso = ISO8601DateFormatter()
        func ms(_ s: String) -> Double {
            (iso.date(from: s)?.timeIntervalSince1970 ?? 0) * 1000
        }
        var a = AgentTrailAnnotations()
        a.byDoc["evt-ticket-pdf"] = AgentDocAnnotations(
            ref: AgentDocRef(
                documentId: "evt-ticket-pdf",
                sourceType: "gmail",
                sourceId: "gmail:user@example.com",
                documentType: "attachment",
                title: "ticket_166740_125646287-…Z9F1GBD6N.pdf",
                ts: ms("2025-12-06T10:08:42Z"),
                mimeType: "application/pdf"
            ),
            note: "The voucher PDF attached to the Le Petit Jardin order confirmation",
            quotes: [
                AgentQuoteEntry(
                    quote: "Bon Cadeau — Soin complet en institut — Valable jusqu'au 04 Juin 2026",
                    note: nil,
                    quoteAuthor: nil
                ),
            ]
        )
        a.byDoc["evt-voucher"] = AgentDocAnnotations(
            ref: AgentDocRef(
                documentId: "evt-voucher",
                sourceType: "gmail",
                sourceId: "gmail:user@example.com",
                documentType: "email",
                title: "Bon Cadeau — Maya",
                ts: ms("2025-12-06T10:09:25Z")
            ),
            note: "You saved the voucher to yourself in Gmail as \"Bon Cadeau — Maya\" — 43 seconds after the order email arrived",
            quotes: []
        )
        a.byDoc["evt-fwd"] = AgentDocAnnotations(
            ref: AgentDocRef(
                documentId: "evt-fwd",
                sourceType: "gmail",
                sourceId: "gmail:user@example.com",
                documentType: "email",
                title: "Fwd: Votre commande sur Restaurant de Le Petit Jardin",
                ts: ms("2025-12-24T18:07:24Z")
            ),
            note: "You forwarded the order + voucher PDF to Riley on Christmas Eve 2025",
            quotes: [
                AgentQuoteEntry(
                    quote: "From: Jamie Reeves — To: Riley Reeves — Date: Wed, 24 Dec 2025 19:07:24 +0100",
                    note: nil,
                    quoteAuthor: "You"
                ),
            ]
        )
        a.byDoc["evt-wa-ask"] = AgentDocAnnotations(
            ref: AgentDocRef(
                documentId: "evt-wa-ask",
                sourceType: "whatsapp-messages",
                sourceId: "whatsapp-messages:+44…",
                documentType: "conversation",
                title: "Maya Reeves — 2026-05-14",
                ts: ms("2026-05-14T15:40:46Z")
            ),
            note: "Maya asked you for the voucher on 14 May 2026 — you sent the PDF over WhatsApp",
            quotes: [
                AgentQuoteEntry(
                    quote: "J'utilise le bon demain mais je ne le retrouve plus dans mes mails. Tu peux me le renvoyer ?",
                    note: nil,
                    quoteAuthor: "Maya"
                ),
            ]
        )
        a.byDoc["evt-wa-used"] = AgentDocAnnotations(
            ref: AgentDocRef(
                documentId: "evt-wa-used",
                sourceType: "whatsapp-messages",
                sourceId: "whatsapp-messages:+44…",
                documentType: "conversation",
                title: "Maya Reeves — 2026-05-16",
                ts: ms("2026-05-16T16:29:34Z")
            ),
            note: "Maya confirmed she used the voucher on 15 May 2026 — full spa treatment all done",
            quotes: [
                AgentQuoteEntry(
                    quote: "Bon utilisé hier — c'était parfait, merci encore !",
                    note: nil,
                    quoteAuthor: "Maya"
                ),
            ]
        )
        return a
    }()

    /// Annotations for the `trailLong` documents exercising multiple
    /// distinct `quoteAuthor` values — tests color palette assignment and
    /// the bar-quote "— Author" rendering on email-type docs. Each slot
    /// carries the `ref` a real `annotate.recorded` always supplies, so the
    /// unified Timeline synthesises a row per annotated document.
    static let trailLongMultiAuthorAnnotations: AgentTrailAnnotations = {
        let authors = ["Alice", "Bob", "Carol", "You", "Maya"]
        let sources = ["gmail:user@example.com", "whatsapp-messages:+44…", "google-drive:user", "notion:user", "apple-notes:user"]
        let sourceTypes = ["gmail", "whatsapp-messages", "google-drive", "notion", "apple-notes"]
        let iso = ISO8601DateFormatter()
        var a = AgentTrailAnnotations()
        for i in 0 ..< 5 {
            let at = "2026-0\(1 + (i % 5))-\(10 + i)T1\(i % 9):\(20 + i):00Z"
            let ts = iso.date(from: at).map { $0.timeIntervalSince1970 * 1000 }
            a.applyDocAnnotation(
                documentId: "evt-long-\(i)",
                ref: AgentDocRef(
                    documentId: "evt-long-\(i)",
                    sourceType: sourceTypes[i % sourceTypes.count],
                    sourceId: sources[i % sources.count],
                    documentType: i % 4 == 0 ? "file" : "email",
                    title: i % 3 == 0
                        ? "Doc \(i): a longer title that exercises truncation behaviour in the side panel"
                        : "Doc \(i)",
                    ts: ts,
                    mimeType: i % 4 == 0 ? "application/pdf" : nil
                ),
                quote: "Sample quote from author \(i) for testing palette colors",
                note: nil,
                quoteAuthor: authors[i]
            )
        }
        return a
    }()

    /// Empty-trail fixture for the "no events on this trail" rendering.
    static let trailEmpty: [AgentTrailEvent] = []

    /// A larger trail (10 events) to exercise the long-list rendering
    /// of the Timeline tab.
    static let trailLong: [AgentTrailEvent] = {
        let sources = ["gmail:user@example.com", "whatsapp-messages:+44…", "google-drive:user", "notion:user", "apple-notes:user"]
        return (0 ..< 10).map { i in
            AgentTrailEvent(
                eventId: "evt-long-\(i)",
                at: "2026-0\(1 + (i % 5))-\(10 + i)T1\(i % 9):\(20 + i):00Z",
                kind: i == 5 ? "seed" : "document",
                doc: AgentTrailEventDoc(
                    documentId: "evt-long-\(i)",
                    title: i % 3 == 0
                        ? "Doc \(i): a longer title that exercises truncation behaviour in the side panel"
                        : "Doc \(i)",
                    sourceId: sources[i % sources.count],
                    sourceUrl: nil,
                    appUrl: nil,
                    documentType: i % 4 == 0 ? "file" : "email",
                    mimeType: i % 4 == 0 ? "application/pdf" : nil
                ),
                attachments: [],
                people: [
                    AgentTrailEventPerson(personId: "p-self", name: "You", role: "sender", isSelf: true),
                ],
                related: []
            )
        }
    }()

    // MARK: - Record citation fixtures

    /// A record-only trail event: a cited DuckDB analytics row that
    /// binds NO document. Renders as a point-in-time citation with the
    /// database glyph, the gateway-derived title, the table label, and the
    /// declared key columns — no tap target (no bound doc → no dead link).
    /// Fully invented fitness data — never the user's corpus.
    static let trailRecordOnly: [AgentTrailEvent] = [
        AgentTrailEvent(
            eventId: "rec:fitness_workouts/abc123",
            at: "2026-04-20T07:12:00Z",
            kind: "record",
            record: AgentTrailRecord(
                recordKey: "rec:fitness_workouts/abc123",
                table: "fitness_workouts",
                tableDisplayName: "Workouts",
                title: "Morning run · 5.2 km",
                keyFields: [
                    AgentTrailRecordKeyField(label: "Distance", value: "5.2 km"),
                    AgentTrailRecordKeyField(label: "Duration", value: "28m 14s"),
                    AgentTrailRecordKeyField(label: "Avg pace", value: "5:25 /km"),
                    AgentTrailRecordKeyField(label: "Calories", value: "412"),
                ],
                semanticTime: "2026-04-20T07:12:00Z",
                sourceId: "demo-fitness:athlete",
                sourceType: "demo-fitness",
                boundDocumentId: nil
            )
        ),
    ]

    /// A deduped doc+record trail event: a document and its
    /// `same-entity` analytics row collapsed into ONE timeline entity. The
    /// doc card heads the row; the record's declared key fields appear
    /// inline below it (the title is the doc's, so it is never re-printed).
    static let trailDocPlusRecord: [AgentTrailEvent] = [
        AgentTrailEvent(
            eventId: "doc-evening-ride",
            at: "2026-04-21T18:40:00Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: "doc-evening-ride",
                title: "Evening ride along the river loop",
                sourceId: "demo-fitness:athlete",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "activity",
                mimeType: nil
            ),
            record: AgentTrailRecord(
                recordKey: "rec:fitness_workouts/def456",
                table: "fitness_workouts",
                tableDisplayName: "Workouts",
                title: "Evening ride along the river loop",
                keyFields: [
                    AgentTrailRecordKeyField(label: "Distance", value: "24.8 km"),
                    AgentTrailRecordKeyField(label: "Elevation", value: "186 m"),
                    AgentTrailRecordKeyField(label: "Avg speed", value: "27.4 km/h"),
                ],
                semanticTime: "2026-04-21T18:40:00Z",
                sourceId: "demo-fitness:athlete",
                sourceType: "demo-fitness",
                boundDocumentId: "doc-evening-ride"
            )
        ),
    ]

    /// A mixed trail: a document event, a record-only event WITH a
    /// bound document (tappable title), and a record-only event with empty
    /// key fields and a long title — exercises chronological interleave,
    /// the bound-doc deep-link, and the edge layout cases.
    static let trailMixedRecords: [AgentTrailEvent] = [
        AgentTrailEvent(
            eventId: "doc-plan",
            at: "2026-04-19T09:00:00Z",
            kind: "document",
            doc: AgentTrailEventDoc(
                documentId: "doc-plan",
                title: "Spring training plan",
                sourceId: "demo-notes:athlete",
                sourceUrl: nil,
                appUrl: nil,
                documentType: "note",
                mimeType: nil
            )
        ),
        AgentTrailEvent(
            eventId: "rec:fitness_workouts/ghi789",
            at: "2026-04-20T07:12:00Z",
            kind: "record",
            record: AgentTrailRecord(
                recordKey: "rec:fitness_workouts/ghi789",
                table: "fitness_workouts",
                tableDisplayName: "Workouts",
                title: "Tempo intervals at the track — 8 × 400 m with 90s recovery",
                keyFields: [],
                semanticTime: "2026-04-20T07:12:00Z",
                sourceId: "demo-fitness:athlete",
                sourceType: "demo-fitness",
                boundDocumentId: "doc-track-session"
            )
        ),
        AgentTrailEvent(
            eventId: "rec:fitness_workouts/abc123",
            at: "2026-04-22T07:30:00Z",
            kind: "record",
            record: AgentTrailRecord(
                recordKey: "rec:fitness_workouts/abc123",
                table: "fitness_workouts",
                tableDisplayName: "Workouts",
                title: "Morning run · 5.2 km",
                keyFields: [
                    AgentTrailRecordKeyField(label: "Distance", value: "5.2 km"),
                    AgentTrailRecordKeyField(label: "Avg HR", value: "148 bpm"),
                    AgentTrailRecordKeyField(label: "Notes", value: nil),
                ],
                semanticTime: "2026-04-22T07:30:00Z",
                sourceId: "demo-fitness:athlete",
                sourceType: "demo-fitness",
                boundDocumentId: nil
            )
        ),
    ]

    // Assistant turn variants used by per-component previews.

    static let agentAssistantTurnWithTable = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-table",
            parts: [
                .text("""
                Here's your heart rate comparison:

                | Period | Avg HR | Min | Max |
                |---|---|---|---|
                | **This Month (May)** | 87.4 bpm | 46 bpm | 185 bpm |
                | **Last Month (April)** | 90.3 bpm | 43 bpm | 178 bpm |

                Your average heart rate is **down ~3 bpm** vs April — a small but real improvement. Min HR is stable so your resting floor hasn't shifted much.
                """),
            ],
            stopReason: "end_turn",
            failure: nil
        )
    )

    static let agentAssistantTurnRunning = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-running",
            parts: [
                .text("Let me pull up your heart rate data from both months."),
                .tool(.init(
                    toolCallId: "tu_1",
                    tool: "run_sql",
                    args: JSONAny(value: ["sql": agentSqlExampleQuery] as [String: Any]),
                    argsSummary: String(agentSqlExampleQuery.prefix(80)),
                    argsKnown: true,
                    result: nil,
                    durationMs: nil
                )),
            ],
            stopReason: nil,
            failure: nil
        )
    )

    /// In-flight turn whose trailing part is a finished `.text` block — the
    /// exact "frozen gap" the turn-level `AgentWorkingIndicator` covers: the
    /// model has spoken, no tool card or thinking shimmer is on screen, and the
    /// next step hasn't arrived yet.
    static let agentAssistantTurnInFlightText = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-inflight-text",
            parts: [
                .text("Let me look into that — pulling the relevant messages now."),
            ],
            stopReason: nil,
            failure: nil
        )
    )

    /// In-flight turn whose trailing part is a thinking block: the live
    /// thinking indicator (animated dots + shimmer, expandable, no bar).
    static let agentAssistantTurnThinkingLive = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-thinking-live",
            parts: [
                .thinking(
                    "The user wants the Q4 audit vendor. Let me search the engagement letter, then cross-check the invoice dates before answering."
                ),
            ],
            stopReason: nil,
            failure: nil
        )
    )

    /// Completed turn that reasoned before answering. The thinking block is
    /// no longer live (it has faded away); only the answer remains.
    static let agentAssistantTurnThinkingDone = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-thinking-done",
            parts: [
                .thinking("The user wants the Q4 audit vendor. Let me search the engagement letter first."),
                .text("The Q4 audit was handled by **Studio Northstar**."),
            ],
            stopReason: "end_turn",
            failure: nil
        )
    )

    /// Mid-annotate snapshot: assistant has streamed some text, opened
    /// an `annotate` tool_use block, and the quote args are still
    /// streaming (no result yet). Drives the inline "citing…" pill so
    /// the user sees the pause as intentional. Once the annotate
    /// resolves the part collapses back to `EmptyView` and the next
    /// text segment streams.
    static let agentAssistantTurnMidCite = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-mid-cite",
            parts: [
                .text("Your heart rate trended higher this week, especially after the Wednesday run."),
                .tool(.init(
                    toolCallId: "tu_cite_1",
                    tool: "annotate",
                    args: JSONAny(value: [
                        "documentId": "apple-health:hr-wed",
                    ] as [String: Any]),
                    argsSummary: "apple-health:hr-wed",
                    argsKnown: false,
                    result: nil,
                    durationMs: nil
                )),
            ],
            stopReason: nil,
            failure: nil
        )
    )

    /// A turn the model provider rejected: the humanized sentence names the
    /// condition, the quiet line beneath carries the code and the provider's
    /// own disposition.
    static let agentAssistantTurnProviderFailure = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-provider-failure",
            parts: [.text("Let me check the vendor invoices for you.")],
            stopReason: "error",
            failure: AgentTurnFailure(
                code: "http_api_error",
                message:
                "The model provider does not have the assigned model — check the model assignment (HTTP 404).",
                provider: AgentProviderFailureDetail(
                    status: 404,
                    type: "invalid_request_error",
                    code: "NOT_FOUND",
                    param: "model",
                    requestId: "req_0a1b2c3d"
                )
            )
        )
    )

    /// The same surface on an older gateway, or on a failure no provider
    /// reported: the code stands alone under the sentence.
    static let agentAssistantTurnFailureCodeOnly = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-failure-code-only",
            parts: [.text("Let me check the vendor invoices for you.")],
            stopReason: "error",
            failure: AgentTurnFailure(
                code: "backend_unavailable",
                message: "The model backend closed the stream before the answer finished."
            )
        )
    )

    /// A reply the user stopped, reopened later: the partial answer stays,
    /// and the only trace of the stop is one quiet line — no error chip.
    static let agentAssistantTurnReopenedStopped = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-reopened-stopped",
            parts: [.text("The two invoices from the quarterly folder are dated March 3 and")],
            stopReason: "canceled",
            failure: nil,
            stopped: "You stopped this reply."
        )
    )

    static let agentAssistantTurnCompletedWithSql = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-sql-complete",
            parts: [
                .text("Let me pull up your heart rate data."),
                .tool(.init(
                    toolCallId: "tu_2",
                    tool: "run_sql",
                    args: JSONAny(value: ["sql": agentSqlExampleQuery] as [String: Any]),
                    argsSummary: String(agentSqlExampleQuery.prefix(80)),
                    argsKnown: true,
                    result: agentToolSqlRows,
                    durationMs: 21
                )),
                .text("""
                | Period | Avg | Min | Max |
                |---|---|---|---|
                | **May** | 87.4 | 46 | 185 |
                | **April** | 90.3 | 43 | 178 |

                Average is **down ~3 bpm**. Want me to break it out by day, or look at resting HR?
                """),
            ],
            stopReason: "end_turn",
            failure: nil
        )
    )

    // MARK: - Ephemeral tool-call fixtures

    //
    // The ephemeral cards (Search / Open Document / Run SQL) consume
    // `AgentToolCall` directly rather than just the inner result, so
    // they can paint the "args known, result still pending" phase
    // with the same chrome as the reveal animation. These three
    // fixtures cover the live phases: pending (args only) and
    // complete (args + result).

    static let agentToolCallSearchPending = AgentToolCall(
        toolCallId: "tu_search_pending",
        tool: "search_documents",
        args: JSONAny(value: [
            "query": "wedding DJ sound system contract",
        ] as [String: Any]),
        argsSummary: "wedding DJ sound system contract",
        argsKnown: true,
        result: nil,
        durationMs: nil
    )

    /// Interactive-memory action rendered by the generic ephemeral card.
    static let agentToolCallMemoryReplaceComplete = AgentToolCall(
        toolCallId: "tu_memory_replace_complete",
        tool: "person_annotation_supersede",
        args: JSONAny(value: [
            "id": "pa-memory-1",
        ] as [String: Any]),
        argsSummary: "",
        argsKnown: true,
        result: .unknown(
            kind: "structured",
            raw: JSONAny(value: [
                "kind": "structured",
                "resultType": "person_annotation.superseded",
                "data": ["id": "pa-memory-1"] as [String: Any],
            ] as [String: Any])
        ),
        durationMs: 42
    )

    /// Loop-agent action still running — spinner header, no outcome row.
    static let agentToolCallLoopSearchRunning = AgentToolCall(
        toolCallId: "tu_open_loop_search_running",
        tool: "open_loop_search",
        args: JSONAny(value: ["query": "cabin weekend"] as [String: Any]),
        argsSummary: "cabin weekend",
        argsKnown: true,
        result: nil,
        durationMs: nil
    )

    /// Loop-agent action that failed — the card rolls the error line.
    static let agentToolCallTimeIndexError = AgentToolCall(
        toolCallId: "tu_temporal_annotation_error",
        tool: "temporal_annotation_add",
        args: JSONAny(value: ["title": "the marathon"] as [String: Any]),
        argsSummary: "the marathon",
        argsKnown: true,
        result: .error(
            code: "overlap_refused",
            message: "An overlapping entry exists for that window — pass force to add anyway."
        ),
        durationMs: 88
    )

    static let agentToolCallSearchComplete = AgentToolCall(
        toolCallId: "tu_search_complete",
        tool: "search_documents",
        args: JSONAny(value: [
            "query": "wedding DJ sound system contract",
        ] as [String: Any]),
        argsSummary: "wedding DJ sound system contract",
        argsKnown: true,
        result: agentToolSearchResults,
        durationMs: 6854
    )

    static let agentToolCallDocumentComplete = AgentToolCall(
        toolCallId: "tu_doc_complete",
        tool: "fetch_document",
        args: JSONAny(value: ["documentId": "drive-contract-1"] as [String: Any]),
        argsSummary: "drive-contract-1",
        argsKnown: true,
        result: agentToolDocument,
        durationMs: 18
    )

    /// A `search_many` batch call mid-flight: three child searches, two
    /// resolved (their per-child cards render results) and one still running.
    /// Drives the `AgentBatchToolCards` preview so the snapshot covers the
    /// concurrent per-child card projection a batch retrieval tool renders.
    static let agentToolCallSearchManyRunning = AgentToolCall(
        toolCallId: "tu_search_many",
        tool: "search_many",
        args: JSONAny(value: [
            "queries": [
                ["query": "Q4 budget review deck"],
                ["query": "Stellar Sound vendor invoice"],
                ["query": "team headcount plan"],
            ] as [Any],
        ] as [String: Any]),
        argsSummary: "3 searches",
        argsKnown: true,
        result: nil,
        durationMs: nil,
        children: [
            AgentToolChild(
                index: 0,
                tool: "search_documents",
                argsSummary: "Q4 budget review deck",
                result: agentToolSearchResults
            ),
            AgentToolChild(
                index: 1,
                tool: "search_documents",
                argsSummary: "Stellar Sound vendor invoice",
                result: agentToolSearchResults
            ),
            AgentToolChild(
                index: 2,
                tool: "search_documents",
                argsSummary: "team headcount plan",
                result: nil
            ),
        ]
    )

    /// Invented per-child search outcomes for the non-streaming `search_many`
    /// mocks below. Each is a plain `.searchResults` (the singular result shape
    /// a batch child wraps), with clearly fictional queries / vendors / people
    /// so the fixture never leans on the corpus.
    static let agentSearchManyBatchItems: [AgentToolResult] = [
        .searchResults(
            query: "Q4 budget review deck",
            durationMs: 214,
            candidates: 40,
            results: [
                AgentDocRef(
                    documentId: "drive-q4-deck",
                    sourceType: "google-drive",
                    sourceId: "google-drive:me",
                    documentType: "file",
                    title: "Q4 Budget Review — draft deck",
                    snippet: "Opex, headcount, and the revised Q4 forecast for the leadership review.",
                    ts: 1_726_000_000_000,
                    people: ["Maya Reeves"]
                ),
                AgentDocRef(
                    documentId: "gmail-q4-thread",
                    sourceType: "gmail",
                    sourceId: "gmail:me",
                    documentType: "email",
                    title: "Re: Q4 budget review — agenda",
                    snippet: "Sharing the deck ahead of Thursday. Numbers are close to final.",
                    ts: 1_726_050_000_000,
                    people: ["Maya Reeves", "David Lin"]
                ),
            ]
        ),
        .searchResults(
            query: "Stellar Sound invoice",
            durationMs: 188,
            candidates: 22,
            results: [
                AgentDocRef(
                    documentId: "drive-stellar-invoice",
                    sourceType: "google-drive",
                    sourceId: "google-drive:me",
                    documentType: "file",
                    title: "Stellar Sound — invoice #4821",
                    snippet: "Deposit due on booking; balance on the event date.",
                    ts: 1_725_400_000_000,
                    people: ["Stellar Sound"]
                ),
            ]
        ),
        .searchResults(
            query: "marathon entry form",
            durationMs: 173,
            candidates: 15,
            results: [
                AgentDocRef(
                    documentId: "gmail-marathon-form",
                    sourceType: "gmail",
                    sourceId: "gmail:me",
                    documentType: "email",
                    title: "Your marathon entry is confirmed",
                    snippet: "Bib collection opens the day before. Bring photo ID.",
                    ts: 1_724_900_000_000,
                    people: ["Jamie Lopez"]
                ),
            ]
        ),
    ]

    /// A SETTLED `search_many` from a non-streaming backend (Anthropic /
    /// DeepSeek-over-http): `children` is empty — those backends emit no
    /// per-child progress — but the terminal `.searchBatch` result carries
    /// three per-child outcomes. `AgentBatchToolCards` must project one settled
    /// card per item off the result alone; this drives the snapshot proving it.
    static let agentToolCallSearchManySettled = AgentToolCall(
        toolCallId: "tu_search_many_settled",
        tool: "search_many",
        args: JSONAny(value: [
            "queries": [
                ["query": "Q4 budget review deck"],
                ["query": "Stellar Sound invoice"],
                ["query": "marathon entry form"],
            ] as [Any],
        ] as [String: Any]),
        argsSummary: "3 searches",
        argsKnown: true,
        result: .searchBatch(items: agentSearchManyBatchItems),
        durationMs: 412
    )

    /// A PENDING `search_many` from a non-streaming backend: `children` empty,
    /// no result yet, but `args` already carries the three queries. Drives the
    /// snapshot proving three "searching…" spinner cards render during the tool
    /// call so the turn looks alive, keyed off `args` alone.
    static let agentToolCallSearchManyPending = AgentToolCall(
        toolCallId: "tu_search_many_pending",
        tool: "search_many",
        args: JSONAny(value: [
            "queries": [
                ["query": "Q4 budget review deck"],
                ["query": "Stellar Sound invoice"],
                ["query": "marathon entry form"],
            ] as [Any],
        ] as [String: Any]),
        argsSummary: "3 searches",
        argsKnown: true,
        result: nil,
        durationMs: nil
    )

    /// A pending `annotate_many` batch — silent apart from the "Citing N"
    /// pill sized to the batch. Drives the annotate_many pill preview.
    static let agentToolCallAnnotateManyPending = AgentToolCall(
        toolCallId: "tu_annotate_many",
        tool: "annotate_many",
        args: JSONAny(value: [
            "annotations": [
                ["documentId": "drive-doc-1", "quote": "Approved Q4 budget: $48,000"],
                ["documentId": "gmail-msg-1", "note": "confirms the Stellar Sound deposit"],
                ["documentId": "notion-doc-1", "quote": "final headcount is 84"],
            ] as [Any],
        ] as [String: Any]),
        argsSummary: "3 citations",
        argsKnown: true,
        result: nil,
        durationMs: nil
    )

    static let agentToolCallSqlQueryOnly = AgentToolCall(
        toolCallId: "tu_sql_args_only",
        tool: "run_sql",
        args: JSONAny(value: ["sql": agentSqlExampleQuery] as [String: Any]),
        argsSummary: String(agentSqlExampleQuery.prefix(80)),
        argsKnown: true,
        result: nil,
        durationMs: nil
    )

    static let agentToolCallSqlComplete = AgentToolCall(
        toolCallId: "tu_sql_complete",
        tool: "run_sql",
        args: JSONAny(value: ["sql": agentSqlExampleQuery] as [String: Any]),
        argsSummary: String(agentSqlExampleQuery.prefix(80)),
        argsKnown: true,
        result: agentToolSqlRows,
        durationMs: 21
    )

    static let agentToolCallSqlWide = AgentToolCall(
        toolCallId: "tu_sql_wide",
        tool: "run_sql",
        args: JSONAny(value: ["sql": "SELECT * FROM workout_activities WHERE sport = 'run'"] as [String: Any]),
        argsSummary: "SELECT * FROM workout_activities WHERE sport = 'run'",
        argsKnown: true,
        result: agentToolSqlRowsWide,
        durationMs: 12
    )

    /// `lookup_people` happy path — three "Maria" candidates, used by
    /// the ephemeral card preview so the snapshot covers the
    /// multi-result disambiguation flow.
    static let agentToolPeopleResults: AgentToolResult = .personResults(
        query: "Maria Smith",
        durationMs: 22,
        results: [
            AgentPersonSummary(
                canonicalId: "p-maria-work",
                displayName: "Maria Smith",
                aliases: ["maria.smith@acme.com", "+15550133"],
                emailCount: 12,
                meetingCount: 2,
                chatCount: 3,
                lastInteraction: 1_726_345_600_000,
                interactionScore: 0.82
            ),
            AgentPersonSummary(
                canonicalId: "p-maria-personal",
                displayName: "Maria Smith",
                aliases: ["maria@smith.family"],
                emailCount: 4,
                lastInteraction: 1_710_000_000_000,
                interactionScore: 0.21
            ),
            AgentPersonSummary(
                canonicalId: "p-maria-vendor",
                displayName: "Maria Smith-Lopez",
                aliases: ["maria@bluestone-ledger.com"],
                emailCount: 1,
                interactionScore: 0.05
            ),
        ]
    )

    static let agentToolCallPeoplePending = AgentToolCall(
        toolCallId: "tu_people_pending",
        tool: "lookup_people",
        args: JSONAny(value: ["query": "Maria Smith"] as [String: Any]),
        argsSummary: "Maria Smith",
        argsKnown: true,
        result: nil,
        durationMs: nil
    )

    static let agentToolCallPeopleComplete = AgentToolCall(
        toolCallId: "tu_people_complete",
        tool: "lookup_people",
        args: JSONAny(value: ["query": "Maria Smith"] as [String: Any]),
        argsSummary: "Maria Smith",
        argsKnown: true,
        result: agentToolPeopleResults,
        durationMs: 22
    )

    /// Empty-result fixture — exercises the "no match" branch of the
    /// `lookup_people` card, where the header lands but no rows roll
    /// before the card fades.
    static let agentToolCallPeopleEmpty = AgentToolCall(
        toolCallId: "tu_people_empty",
        tool: "lookup_people",
        args: JSONAny(value: ["query": "Nonexistent Person"] as [String: Any]),
        argsSummary: "Nonexistent Person",
        argsKnown: true,
        result: .personResults(query: "Nonexistent Person", durationMs: 9, results: []),
        durationMs: 9
    )

    /// Single-candidate fixture — exercises the layout when there's
    /// only one row to roll (no real disambiguation, but the agent
    /// still uses the alias to seed a follow-up `from:` filter).
    static let agentToolCallPeopleSingle = AgentToolCall(
        toolCallId: "tu_people_single",
        tool: "lookup_people",
        args: JSONAny(value: ["query": "Daniel Harper"] as [String: Any]),
        argsSummary: "Daniel Harper",
        argsKnown: true,
        result: .personResults(
            query: "Daniel Harper",
            durationMs: 11,
            results: [
                AgentPersonSummary(
                    canonicalId: "p_daniel_harper",
                    displayName: "Daniel Harper",
                    aliases: ["daniel.harper@acme-property.co.uk", "+44 7700 900123"],
                    emailCount: 3,
                    chatCount: 1,
                    lastInteraction: 1_758_555_000_000,
                    interactionScore: 0.71
                ),
            ]
        ),
        durationMs: 11
    )

    /// Name-only fixture — person with NO aliases. Exercises the
    /// people-row layout where `primaryAlias` returns nil and the row
    /// collapses to just the display name.
    static let agentToolCallPeopleNameOnly = AgentToolCall(
        toolCallId: "tu_people_name_only",
        tool: "lookup_people",
        args: JSONAny(value: ["query": "Carlos"] as [String: Any]),
        argsSummary: "Carlos",
        argsKnown: true,
        result: .personResults(
            query: "Carlos",
            durationMs: 7,
            results: [
                AgentPersonSummary(
                    canonicalId: "p_carlos_noaliases",
                    displayName: "Carlos (no aliases)",
                    aliases: [],
                    interactionScore: 0.12
                ),
            ]
        ),
        durationMs: 7
    )

    /// `lookup_document_by_url` happy path — URL resolves to one Drive
    /// document. Used by the ephemeral card preview so the snapshot
    /// covers the matched-row state.
    static let agentToolUrlLookupHit: AgentToolResult = .documentByUrl(
        url: "https://docs.google.com/document/d/1abc.../edit",
        durationMs: 8,
        ref: AgentDocRef(
            documentId: "drive-q4-deck-1",
            sourceType: "google-drive",
            sourceId: "google-drive:self",
            documentType: "file",
            title: "Q4 launch plan — board pre-read",
            snippet: nil,
            ts: 1_726_345_600_000,
            url: "https://docs.google.com/document/d/1abc.../edit",
            people: nil,
            unitName: "files"
        )
    )

    static let agentToolUrlLookupMiss: AgentToolResult = .documentByUrl(
        url: "https://example.com/something-not-in-the-corpus",
        durationMs: 5,
        ref: nil
    )

    static let agentToolCallUrlLookupPending = AgentToolCall(
        toolCallId: "tu_url_pending",
        tool: "lookup_document_by_url",
        args: JSONAny(value: [
            "url": "https://docs.google.com/document/d/1abc.../edit",
        ] as [String: Any]),
        argsSummary: "https://docs.google.com/document/d/1abc.../edit",
        argsKnown: true,
        result: nil,
        durationMs: nil
    )

    static let agentToolCallUrlLookupHit = AgentToolCall(
        toolCallId: "tu_url_hit",
        tool: "lookup_document_by_url",
        args: JSONAny(value: [
            "url": "https://docs.google.com/document/d/1abc.../edit",
        ] as [String: Any]),
        argsSummary: "https://docs.google.com/document/d/1abc.../edit",
        argsKnown: true,
        result: agentToolUrlLookupHit,
        durationMs: 8
    )

    static let agentToolCallUrlLookupMiss = AgentToolCall(
        toolCallId: "tu_url_miss",
        tool: "lookup_document_by_url",
        args: JSONAny(value: [
            "url": "https://example.com/something-not-in-the-corpus",
        ] as [String: Any]),
        argsSummary: "https://example.com/something-not-in-the-corpus",
        argsKnown: true,
        result: agentToolUrlLookupMiss,
        durationMs: 5
    )

    /// Notion-flavoured URL-lookup fixture — exercises the source icon
    /// path for a non-Google source.
    static let agentToolUrlLookupNotion: AgentToolResult = .documentByUrl(
        url: "https://notion.so/Vendor-eval-matrix-abc123",
        durationMs: 7,
        ref: AgentDocRef(
            documentId: "notion-vendor-eval-1",
            sourceType: "notion-pages",
            sourceId: "notion-pages:self",
            documentType: "note",
            title: "Vendor evaluation — comparison matrix",
            snippet: nil,
            ts: 1_726_345_600_000,
            url: "https://notion.so/Vendor-eval-matrix-abc123",
            people: nil,
            unitName: "pages"
        )
    )

    static let agentToolCallUrlLookupNotion = AgentToolCall(
        toolCallId: "tu_url_notion",
        tool: "lookup_document_by_url",
        args: JSONAny(value: [
            "url": "https://notion.so/Vendor-eval-matrix-abc123",
        ] as [String: Any]),
        argsSummary: "https://notion.so/Vendor-eval-matrix-abc123",
        argsKnown: true,
        result: agentToolUrlLookupNotion,
        durationMs: 7
    )

    /// Long-URL fixture — exercises the header's `lineLimit(2)`
    /// truncation path. A query-string-heavy Drive URL with ~250
    /// characters.
    static let agentToolUrlLookupLongUrl: AgentToolResult = .documentByUrl(
        url: "https://docs.google.com/spreadsheets/d/1AbcDefGhiJklMnoPqrStuVwxYz0123456789AbCdEfGh/edit?usp=sharing&authuser=0&rtpof=true&sd=true&gid=42&range=A1%3AZ100&utm_source=email&utm_campaign=q4-forecast&utm_medium=link",
        durationMs: 11,
        ref: AgentDocRef(
            documentId: "drive-long-url-1",
            sourceType: "google-drive",
            sourceId: "google-drive:self",
            documentType: "file",
            title: nil,
            snippet: nil,
            ts: nil,
            url: "https://docs.google.com/spreadsheets/d/1AbcDefGhiJklMnoPqrStuVwxYz0123456789AbCdEfGh/edit",
            people: nil,
            unitName: "files"
        )
    )

    static let agentToolCallUrlLookupLong = AgentToolCall(
        toolCallId: "tu_url_long",
        tool: "lookup_document_by_url",
        args: JSONAny(value: [
            "url": "https://docs.google.com/spreadsheets/d/1AbcDefGhiJklMnoPqrStuVwxYz0123456789AbCdEfGh/edit?usp=sharing&authuser=0&rtpof=true&sd=true&gid=42&range=A1%3AZ100&utm_source=email&utm_campaign=q4-forecast&utm_medium=link",
        ] as [String: Any]),
        argsSummary: "https://docs.google.com/spreadsheets/d/1AbcDefGhiJklMnoPqrStuVwxYz0…",
        argsKnown: true,
        result: agentToolUrlLookupLongUrl,
        durationMs: 11
    )

    /// Error-result fixture for an ephemeral tool — exercises the
    /// layout where `hasResult` is true (so the card lifecycle runs
    /// and flushes the gate) but no result rows are available.
    static let agentToolCallSearchError = AgentToolCall(
        toolCallId: "tu_search_error",
        tool: "search_documents",
        args: JSONAny(value: [
            "query": "annual report trends",
        ] as [String: Any]),
        argsSummary: "annual report trends",
        argsKnown: true,
        result: .error(code: "SEARCH_TIMEOUT", message: "search timed out after 30 000 ms"),
        durationMs: 30012
    )

    // MARK: - Loop fixtures (search_loops / fetch_loop, experimental)

    //
    // Fully fictional loop scenario — invented names + example venues only.
    // The chat agent reads the background Cognition Steward's tracked obligations
    // around planning a team offsite.

    /// A document that two tracked loops rest on — drives the inline
    /// loop chip on a search / document result row.
    static let agentDocRefWithLoops = AgentDocRef(
        documentId: "gmail-venue-1",
        sourceType: "gmail",
        sourceId: "gmail:me",
        documentType: "email",
        title: "Re: Q3 offsite — venue options",
        snippet: "Maya asked which venue to lock in before the deposit deadline.",
        ts: 1_719_500_000_000,
        people: ["Maya Reeves"],
        openLoops: [
            AgentDocLoopRef(
                loopId: "loop-venue-1",
                title: "Reply to Maya Reeves about the Q3 offsite venue",
                state: "open",
                importance: 0.82
            ),
            AgentDocLoopRef(
                loopId: "loop-catering-1",
                title: "Confirm catering headcount with the venue",
                state: "snoozed",
                importance: 0.3
            ),
        ]
    )

    /// A document referenced by a single tracked loop — the "🔗 1" chip.
    static let agentDocRefOneLoop = AgentDocRef(
        documentId: "gmail-contract-2",
        sourceType: "gmail",
        sourceId: "gmail:me",
        documentType: "email",
        title: "Studio Northstar — signed contract attached",
        snippet: "Please countersign and return by Friday.",
        ts: 1_719_400_000_000,
        people: ["David Lin"],
        openLoops: [
            AgentDocLoopRef(
                loopId: "loop-contract-1",
                title: "Send the signed contract back to Studio Northstar",
                state: "open",
                importance: 0.6
            ),
        ]
    )

    /// A document with no tracked loops — chip renders nothing.
    static let agentDocRefNoLoops = AgentDocRef(
        documentId: "gmail-notes-1",
        sourceType: "gmail",
        sourceId: "gmail:me",
        documentType: "email",
        title: "Offsite brainstorm notes",
        snippet: "Rough ideas for the agenda.",
        ts: 1_719_300_000_000,
        people: ["Jamie Lopez"]
    )

    static let agentToolSearchResultsWithLoops: AgentToolResult = .searchResults(
        query: "Q3 offsite venue",
        durationMs: 21,
        candidates: 12,
        results: [
            agentDocRefWithLoops,
            agentDocRefOneLoop,
            agentDocRefNoLoops,
        ]
    )

    static let agentToolCallSearchWithLoops = AgentToolCall(
        toolCallId: "tu_search_with_loops",
        tool: "search_documents",
        args: JSONAny(value: ["query": "Q3 offsite venue"] as [String: Any]),
        argsSummary: "Q3 offsite venue",
        argsKnown: true,
        result: agentToolSearchResultsWithLoops,
        durationMs: 21
    )

    /// `fetch_document` whose ref carries open loops — drives the loop
    /// chip on the document card's identity header.
    static let agentToolDocumentWithLoops: AgentToolResult = .document(
        ref: agentDocRefWithLoops,
        content: """
        Hi Maya,

        Sharing the two shortlisted venues for the Q3 offsite:
        - Riverside Estate — larger, deposit due Jul 12
        - Studio Northstar — closer to the office

        Which should I lock in?
        """,
        neighbors: []
    )

    static let agentToolCallDocumentWithLoops = AgentToolCall(
        toolCallId: "tu_doc_with_loops",
        tool: "fetch_document",
        args: JSONAny(value: ["documentId": "gmail-venue-1"] as [String: Any]),
        argsSummary: "gmail-venue-1",
        argsKnown: true,
        result: agentToolDocumentWithLoops,
        durationMs: 12
    )

    /// `search_loops` happy path — three tracked obligations across
    /// open + snoozed states.
    static let agentToolLoopsSearched: AgentToolResult = .loopsSearched(
        query: "offsite follow-ups",
        durationMs: 14,
        loops: [
            AgentLoopSummary(
                loopId: "loop-venue-1",
                title: "Reply to Maya Reeves about the Q3 offsite venue",
                description: "Maya needs a venue decision before the deposit deadline.",
                state: "open",
                importance: 0.82,
                confidence: 0.7,
                deadline: "Jul 12"
            ),
            AgentLoopSummary(
                loopId: "loop-contract-1",
                title: "Send the signed contract back to Studio Northstar",
                state: "open",
                importance: 0.6,
                deadline: "Jul 9"
            ),
            AgentLoopSummary(
                loopId: "loop-catering-1",
                title: "Confirm catering headcount with the venue",
                state: "snoozed",
                importance: 0.3
            ),
        ]
    )

    static let agentToolCallLoopSearch = AgentToolCall(
        toolCallId: "tu_loop_search",
        tool: "search_loops",
        args: JSONAny(value: ["query": "offsite follow-ups"] as [String: Any]),
        argsSummary: "offsite follow-ups",
        argsKnown: true,
        result: agentToolLoopsSearched,
        durationMs: 14
    )

    static let agentToolCallLoopSearchPending = AgentToolCall(
        toolCallId: "tu_loop_search_pending",
        tool: "search_loops",
        args: JSONAny(value: ["query": "offsite follow-ups"] as [String: Any]),
        argsSummary: "offsite follow-ups",
        argsKnown: true,
        result: nil,
        durationMs: nil
    )

    static let agentToolCallLoopSearchEmpty = AgentToolCall(
        toolCallId: "tu_loop_search_empty",
        tool: "search_loops",
        args: JSONAny(value: ["query": "nothing tracked here"] as [String: Any]),
        argsSummary: "nothing tracked here",
        argsKnown: true,
        result: .loopsSearched(query: "nothing tracked here", durationMs: 6, loops: []),
        durationMs: 6
    )

    /// `fetch_loop` happy path — one loop opened in full, with actors,
    /// involved people, and a short ledger.
    static let agentToolLoopFetched: AgentToolResult = .loopFetched(
        loop: AgentLoopDetail(
            loopId: "loop-venue-1",
            title: "Reply to Maya Reeves about the Q3 offsite venue",
            description: "Maya asked which of two venues to lock in before the deposit deadline.",
            state: "open",
            importance: 0.82,
            confidence: 0.7,
            deadline: "Jul 12",
            actors: ["Maya Reeves"],
            involved: ["Jamie Lopez", "David Lin"],
            docIds: ["gmail-venue-1", "gmail-venue-2"],
            ledger: [
                AgentLoopLedgerEntry(at: 1_719_500_000_000, note: "Detected obligation from Maya's email"),
                AgentLoopLedgerEntry(at: 1_719_700_000_000, note: "Snoozed until the venue quotes arrive"),
                AgentLoopLedgerEntry(at: 1_719_900_000_000, note: "Reopened — deposit deadline is approaching"),
            ]
        )
    )

    static let agentToolCallLoopFetch = AgentToolCall(
        toolCallId: "tu_loop_fetch",
        tool: "fetch_loop",
        args: JSONAny(value: ["loopId": "loop-venue-1"] as [String: Any]),
        argsSummary: "loop-venue-1",
        argsKnown: true,
        result: agentToolLoopFetched,
        durationMs: 9
    )

    static let agentToolCallLoopFetchEmpty = AgentToolCall(
        toolCallId: "tu_loop_fetch_empty",
        tool: "fetch_loop",
        args: JSONAny(value: ["loopId": "loop-does-not-exist"] as [String: Any]),
        argsSummary: "loop-does-not-exist",
        argsKnown: true,
        result: .loopFetched(loop: nil),
        durationMs: 4
    )

    // MARK: - Sub-agent cards

    //
    // Fully fictional Deep Research fixtures — invented names, vendors, and
    // example.* domains only (never sourced from the corpus). The scenario:
    // an agent researching a quarterly budget review fans out two reader
    // sub-agents.

    /// An in-flight reader sub-agent with a live token total.
    static let agentSubagentCardRunning = AgentSubagentCard(
        subagentId: "sess-1.sub.a1",
        specialist: "history-sweep",
        title: "Marketing budget history",
        task: "Find every document touching Q4 marketing spend",
        parentToolCallId: "tu_spawn_1",
        childTurns: [],
        docs: [
            AgentResearchDoc(documentId: "doc-budget-deck", title: "Budget deck", sourceId: "google-drive:me"),
            AgentResearchDoc(documentId: "doc-budget-thread", title: "Budget thread", sourceId: "gmail:me"),
            AgentResearchDoc(documentId: "doc-budget-note", title: "Board prep", sourceId: "apple-notes:local"),
        ],
        stepCount: 1,
        tokens: 1840,
        status: nil,
        summary: nil
    )

    /// A finished reader sub-agent with a distilled summary and token total.
    static let agentSubagentCardComplete = AgentSubagentCard(
        subagentId: "sess-1.sub.b2",
        specialist: "source-digest",
        title: "Events budget digest",
        task: "Summarise the events overspend from the budget deck",
        parentToolCallId: "tu_spawn_2",
        childTurns: [],
        docs: [
            AgentResearchDoc(documentId: "doc-budget-deck", title: "Budget deck", sourceId: "google-drive:me"),
        ],
        stepCount: 2,
        tokens: 3120,
        status: "complete",
        summary: "Events overspent by 18% (~$24k), offset by paid-media savings; "
            + "net marketing 8% under plan for Q4."
    )

    /// A truncated worker whose deliberate citations remain useful upstream.
    static let agentSubagentCardPartial = AgentSubagentCard(
        subagentId: "sess-1.sub.c3",
        specialist: "history-sweep",
        title: "Project approval history",
        task: "Trace the fictional project's approval history",
        parentToolCallId: "tu_spawn_3",
        docs: [
            AgentResearchDoc(documentId: "doc-project-note", title: "Project status", sourceId: "apple-notes:local"),
        ],
        stepCount: 2,
        tokens: 16384,
        status: "failed",
        summary: "Partial evidence collected before the worker reached its output limit:\n- Project status: The milestone was approved.",
        retainedCitationCount: 1,
        failureCode: "output_truncated"
    )

    /// A worker killed by the model provider rather than by its own budget:
    /// the summary says what the reader gets, the quiet line beneath says
    /// which knob to turn.
    static let agentSubagentCardProviderFailure = AgentSubagentCard(
        subagentId: "sess-1.sub.c4",
        specialist: "invoice-sweep",
        title: "Vendor invoice trail",
        task: "Trace the fictional vendor's invoice trail",
        parentToolCallId: "tu_spawn_4",
        docs: [],
        stepCount: 1,
        tokens: 2048,
        status: "failed",
        summary: "The model provider does not have the assigned model.",
        retainedCitationCount: 0,
        failureCode: "http_api_error",
        failureProvider: AgentProviderFailureDetail(
            status: 404,
            type: "invalid_request_error",
            code: "NOT_FOUND",
            param: "model"
        )
    )

    /// A narrow-screen stress case: enough distinct sources to require two
    /// rows while the title, status, and token count remain readable above.
    static let agentSubagentCardManySources = AgentSubagentCard(
        subagentId: "sess-1.sub.sources",
        specialist: "source-sweep",
        title: "Cross-source project history",
        task: "Find the project history across every connected source",
        parentToolCallId: "tu_spawn_sources",
        childTurns: [],
        docs: (1 ... 123).map { index in
            AgentResearchDoc(documentId: "source-mail-\(index)", title: "Project message \(index)", sourceId: "gmail:me")
        } + [
            AgentResearchDoc(documentId: "source-doc-3", title: "Planning file", sourceId: "google-drive:me"),
            AgentResearchDoc(documentId: "source-doc-4", title: "Meeting notes", sourceId: "apple-notes:local"),
            AgentResearchDoc(documentId: "source-doc-5", title: "Workspace page", sourceId: "notion-pages:self"),
            AgentResearchDoc(documentId: "source-doc-6", title: "Project chat", sourceId: "whatsapp-messages:local"),
            AgentResearchDoc(documentId: "source-doc-7", title: "Calendar entry", sourceId: "google-calendar:me"),
            AgentResearchDoc(documentId: "source-doc-8", title: "Code review", sourceId: "github:self"),
            AgentResearchDoc(documentId: "source-doc-9", title: "Task reminder", sourceId: "apple-reminders:local"),
            AgentResearchDoc(documentId: "source-doc-10", title: "Project message", sourceId: "apple-imessage:local"),
            AgentResearchDoc(documentId: "source-doc-11", title: "Task list", sourceId: "things:local"),
            AgentResearchDoc(documentId: "source-doc-12", title: "Research note", sourceId: "obsidian:local"),
            AgentResearchDoc(documentId: "source-doc-13", title: "Reference page", sourceId: "browser-history:local"),
            AgentResearchDoc(documentId: "source-doc-14", title: "Saved reference", sourceId: "chrome-bookmarks:local"),
            AgentResearchDoc(documentId: "source-doc-15", title: "Project email", sourceId: "outlook-email:me"),
            AgentResearchDoc(documentId: "source-doc-16", title: "Activity record", sourceId: "strava-activities:self"),
        ],
        stepCount: 9,
        tokens: 12400,
        status: nil,
        summary: nil
    )

    /// Neutral local artwork injected into the preview descriptor cache. The
    /// production view receives each provider's real descriptor icon.
    static let agentSourceLayoutIcon = "data:image/png;base64,"
        + "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgBAMAAACBVGfHAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA"
        + "6mAAADqYAAAXcJy6UTwAAAAeUExURQAAAFts/1ts/1ts/1ts/1ts/1ts/1ts/1ts/////7xhIYYAAAAIdF"
        + "JOUwAkhN3cCZzUR0hMfQAAAAFiS0dECfHZpewAAAAHdElNRQfqCAIIDS0fEGKOAAAAXElEQVQoz2NgYBCy"
        + "6ICCFkUGIAjrQAKpDAysFcgC7QEMbB0oIIFBAlWgkUEDVaCJwQNVoJmhAw0QKdA5EwKGpQB+71ug8lswA"
        + "xkjGjAiCiMqMSIbmBzgcdUMTA4ArAQHjGwG/5cAAAAASUVORK5CYII="

    // MARK: - Research working-set surface

    /// A live Deep Research run mid-flight: three researchers side by side, two
    /// still searching (with their documents accumulating) and one already
    /// done. Fictional specialists/docs across distinct sources so the surface
    /// shows the source-tinted chips spanning the registry.
    static let researchPanelsLive: [AgentResearchPanel] = [
        AgentResearchPanel(
            subagentId: "sess-1.sub.a1",
            specialist: "history-sweep",
            title: "Marketing budget history",
            task: "Find every document touching the Q4 marketing budget",
            docs: [
                AgentResearchDoc(documentId: "doc-deck", title: "Q4 Budget Review — Northstar deck", sourceId: "google-drive:me"),
                AgentResearchDoc(documentId: "doc-thread", title: "Re: Q4 numbers before the board sync", sourceId: "gmail:me"),
                AgentResearchDoc(documentId: "doc-note", title: "Board prep — open questions", sourceId: "apple-notes:local"),
            ],
            stepCount: 2,
            tokens: 2840,
            status: nil,
            summary: nil
        ),
        AgentResearchPanel(
            subagentId: "sess-1.sub.b2",
            specialist: "source-digest",
            title: "Events budget digest",
            task: "Summarise the events overspend from the budget deck",
            docs: [
                AgentResearchDoc(documentId: "doc-deck", title: "Q4 Budget Review — Northstar deck", sourceId: "google-drive:me"),
                AgentResearchDoc(documentId: "doc-invoice", title: "Stellar Sound — events invoice", sourceId: "gmail:me"),
            ],
            stepCount: 3,
            tokens: 3120,
            status: "complete",
            summary: "Events ran 18% over plan; offset by lower paid media."
        ),
        AgentResearchPanel(
            subagentId: "sess-1.sub.c3",
            specialist: "history-sweep",
            title: "Paid-media history",
            task: "Trace the paid-media line back to the original plan",
            docs: [],
            stepCount: 1,
            tokens: 740,
            status: nil,
            summary: nil
        ),
    ]

    /// A finishing run — every researcher has landed a terminal status (the
    /// instant before the surface collapses into the written-back report).
    static let researchPanelsFinishing: [AgentResearchPanel] = [
        AgentResearchPanel(
            subagentId: "sess-2.sub.a1",
            specialist: "history-sweep",
            title: "Marketing budget history",
            task: "Find every document touching the Q4 marketing budget",
            docs: [
                AgentResearchDoc(documentId: "doc-deck", title: "Q4 Budget Review — Northstar deck", sourceId: "google-drive:me"),
                AgentResearchDoc(documentId: "doc-thread", title: "Re: Q4 numbers before the board sync", sourceId: "gmail:me"),
            ],
            stepCount: 3,
            tokens: 4210,
            status: "complete",
            summary: "Three primary sources; the deck and the board thread agree on the events swing."
        ),
        AgentResearchPanel(
            subagentId: "sess-2.sub.b2",
            specialist: "source-digest",
            title: "Paid-media savings",
            task: "Confirm the paid-media savings figure",
            docs: [
                AgentResearchDoc(documentId: "doc-media", title: "Paid media — Q4 reconciliation", sourceId: "apple-notes:local"),
            ],
            stepCount: 2,
            tokens: 1980,
            status: "complete",
            summary: "Paid media came in ~$31k under plan, fully offsetting the events overspend."
        ),
    ]

    /// A live run where one researcher has accumulated MANY documents — stresses
    /// the per-panel doc-list height cap so the band stays a fixed bottom rail
    /// and never grows into a full-screen overlay that buries the conversation.
    /// The first panel holds 16 source-tinted docs; it must scroll
    /// WITHIN the panel rather than make the panel taller than the screen.
    static let researchPanelsManyDocs: [AgentResearchPanel] = [
        AgentResearchPanel(
            subagentId: "sess-3.sub.a1",
            specialist: "history-sweep",
            title: "Race history",
            task: "Find every document touching running races and 10k events",
            docs: (1 ... 16).map { i in
                AgentResearchDoc(
                    documentId: "doc-many-\(i)",
                    title: "Race document #\(i) — registration / result / photos",
                    sourceId: ["gmail:me", "google-drive:me", "apple-notes:local"][i % 3]
                )
            },
            stepCount: 18,
            tokens: 941_300,
            status: nil,
            summary: nil
        ),
        AgentResearchPanel(
            subagentId: "sess-3.sub.b2",
            specialist: "source-digest",
            title: "Race results digest",
            task: "Digest the marathon and half-marathon finish times",
            docs: (1 ... 4).map { i in
                AgentResearchDoc(
                    documentId: "doc-many-m\(i)",
                    title: "Marathon result #\(i)",
                    sourceId: "gmail:me"
                )
            },
            stepCount: 6,
            tokens: 120_000,
            status: nil,
            summary: nil
        ),
    ]

    static let agentAssistantTurnSearchPlusFetch = AgentTurn.assistant(
        AgentAssistantTurn(
            id: "a-search-fetch",
            parts: [
                .text("Searching for that contract across email and Drive."),
                .tool(.init(
                    toolCallId: "tu_search",
                    tool: "search_documents",
                    args: JSONAny(value: [
                        "query": "wedding DJ sound system contract",
                    ] as [String: Any]),
                    argsSummary: "wedding DJ sound system contract",
                    argsKnown: true,
                    result: agentToolSearchResults,
                    durationMs: 6854
                )),
                .tool(.init(
                    toolCallId: "tu_fetch",
                    tool: "fetch_document",
                    args: JSONAny(value: ["documentId": "drive-contract-1"] as [String: Any]),
                    argsSummary: "drive-contract-1",
                    argsKnown: true,
                    result: agentToolDocument,
                    durationMs: 18
                )),
                .text("""
                Found it. The DJ was **Stellar Sound**.

                - 1 DJ + 1 technician, 18:00–04:00
                - Signed 20 Aug 2024 via Adobe Acrobat Sign by **Olivia (Stellar Sound)**
                - Stored on Google Drive as *Contrat R1.5 - 10 octobre 2024…*
                """),
            ],
            stopReason: "end_turn",
            failure: nil
        )
    )

    static let agentConversations: [ConversationSummary] = [
        ConversationSummary(
            sessionId: "s_pinned",
            title: "Quarterly planning notes",
            model: "claude-sonnet-4-6",
            backend: "anthropic",
            createdAt: "2026-05-10T09:00:00Z",
            updatedAt: "2026-05-10T09:05:00Z",
            messageCount: 8,
            pinned: true
        ),
        ConversationSummary(
            sessionId: "s_a",
            title: "Hey, can you remind me who was the provider of the DJ and sound syste…",
            model: "claude-sonnet-4-6",
            backend: "anthropic",
            createdAt: "2026-05-15T13:12:36Z",
            updatedAt: "2026-05-15T13:13:01Z",
            messageCount: 4,
            unread: true
        ),
        ConversationSummary(
            sessionId: "s_b",
            title: "Hey, can you find the tenancy agreement for our previous flat in 3 Ha…",
            model: "claude-sonnet-4-6",
            backend: "anthropic",
            createdAt: "2026-05-15T13:13:34Z",
            updatedAt: "2026-05-15T13:14:21Z",
            messageCount: 6
        ),
        ConversationSummary(
            sessionId: "s_c",
            title: "hey, how has my heart rate been compared to last month?",
            model: "claude-sonnet-4-6",
            backend: "anthropic",
            createdAt: "2026-05-15T13:11:31Z",
            updatedAt: "2026-05-15T13:15:45Z",
            messageCount: 6,
            unread: true
        ),
        ConversationSummary(
            sessionId: "s_d",
            title: "What is 2 + 2? Just answer quickly.",
            model: "claude-sonnet-4-6",
            backend: "anthropic",
            createdAt: "2026-05-15T13:15:38Z",
            updatedAt: "2026-05-15T13:15:45Z",
            messageCount: 2
        ),
    ]

    static let agentCitationGmailContract = AgentCitation(
        documentId: agentDocRefGmailContract.documentId,
        ref: agentDocRefGmailContract,
        docNote: nil,
        entries: [
            AgentCitationEntry(
                toolCallId: "tc_cite_1",
                messageId: "a-1",
                quote: "DJ et sonorisation pour le 14 juin — Studio Northstar",
                note: nil,
                quoteAuthor: nil
            ),
        ]
    )

    /// Two quote entries + a doc-level note set via a separate note-only
    /// cite. The docNote renders once at the top of the card, the entries
    /// render as quotes below.
    static let agentCitationDriveContract = AgentCitation(
        documentId: agentDocRefDriveContract.documentId,
        ref: agentDocRefDriveContract,
        docNote: "Signed vendor contract for the venue stage",
        entries: [
            AgentCitationEntry(
                toolCallId: "tc_cite_2",
                messageId: "a-1",
                quote: "Prestation: DJ, éclairage et système son",
                note: nil,
                quoteAuthor: nil
            ),
            AgentCitationEntry(
                toolCallId: "tc_cite_3",
                messageId: "a-1",
                quote: "Acompte versé le 12 mars",
                note: nil,
                quoteAuthor: nil
            ),
        ]
    )

    /// Note-only cite on a non-text-y source — docNote captures the gist
    /// since there's nothing to quote.
    static let agentCitationWhatsappBackup = AgentCitation(
        documentId: agentDocRefWhatsappBackup.documentId,
        ref: agentDocRefWhatsappBackup,
        docNote: "Group chat where the venue walk-through was scheduled",
        entries: []
    )

    /// Three same-source citations used to exercise the sticky-tab
    /// "deck" compaction — the panel should render one front tab plus
    /// two thin slivers peeking out below.
    static let agentCitationGmailA = AgentCitation(
        documentId: "gmail-stack-a",
        ref: AgentDocRef(
            documentId: "gmail-stack-a",
            sourceType: "gmail",
            sourceId: "gmail:me",
            documentType: "email",
            title: "Re: Q1 budget review",
            snippet: "Approving the cloud-spend line item.",
            ts: 1_725_300_000_000,
            people: ["finance@example.com"]
        ),
        docNote: nil,
        entries: [
            AgentCitationEntry(
                toolCallId: "tc_stack_a",
                messageId: "a-1",
                quote: "Approving the cloud-spend line item — let's revisit in March.",
                note: nil,
                quoteAuthor: nil
            ),
        ]
    )

    static let agentCitationGmailB = AgentCitation(
        documentId: "gmail-stack-b",
        ref: AgentDocRef(
            documentId: "gmail-stack-b",
            sourceType: "gmail",
            sourceId: "gmail:me",
            documentType: "email",
            title: "FastFiber — Direct Debit set up",
            snippet: "Confirmation: payments will be collected from your bank account.",
            ts: 1_725_350_000_000,
            people: ["GoCardless"]
        ),
        docNote: "Direct Debit confirmation, 12 May",
        entries: []
    )

    static let agentCitationGmailC = AgentCitation(
        documentId: "gmail-stack-c",
        ref: AgentDocRef(
            documentId: "gmail-stack-c",
            sourceType: "gmail",
            sourceId: "gmail:me",
            documentType: "email",
            title: "Re: [EXTERNAL] FastFiber vs MetroNet at 42 Example Street",
            snippet: "Pricing comparison thread.",
            ts: 1_725_400_000_000,
            people: ["MetroNet"]
        ),
        docNote: nil,
        entries: [
            AgentCitationEntry(
                toolCallId: "tc_stack_c",
                messageId: "a-1",
                quote: "I would love to know what metronet can offer to compete with fastfiber's pricing.",
                note: nil,
                quoteAuthor: nil
            ),
        ]
    )

    static let agentRichTranscript = AppStore.AgentPreviewSeed(
        sessionId: "s_rich",
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "Hey, can you remind me who was the provider of the DJ…",
        turns: [
            .user(
                id: "u-0",
                text: "Hey, can you remind me who was the provider of the DJ and sound system for my wedding? I can't find the contract (it's in french)."
            ),
            agentAssistantTurnSearchPlusFetch,
            .user(id: "u-1", text: "Nice — also how has my heart rate been compared to last month?"),
            agentAssistantTurnCompletedWithSql,
        ],
        citations: [
            agentCitationGmailContract,
            agentCitationDriveContract,
            agentCitationWhatsappBackup,
        ],
        conversations: agentConversations
    )

    static let agentStoreTranscript: AppStore.AgentPreviewSeed = {
        var seed = agentRichTranscript
        seed.connected = true
        return seed
    }()

    /// Existing pinned chat used to verify the top-right actions beside the
    /// new-chat button. The transcript content stays shared with the rich seed.
    static let agentPinnedTranscript: AppStore.AgentPreviewSeed = {
        var seed = agentRichTranscript
        seed.conversations = [
            ConversationSummary(
                sessionId: "s_rich",
                title: seed.title,
                model: seed.model,
                backend: seed.backend,
                createdAt: "2026-05-15T13:12:36Z",
                updatedAt: "2026-05-15T13:15:45Z",
                messageCount: 4,
                pinned: true
            ),
        ] + seed.conversations
        return seed
    }()

    static let agentContextWindowExceeded = AppStore.AgentPreviewSeed(
        sessionId: "s_context_limit",
        model: "fictional-model",
        backend: "openai-compatible",
        title: "Quarterly planning notes",
        turns: [
            .user(id: "u-context", text: "Can you connect this to the earlier planning notes?"),
            .assistant(
                AgentAssistantTurn(
                    id: "a-context",
                    parts: [.text("The earlier notes establish three priorities")],
                    stopReason: "error",
                    failure: nil
                )
            ),
        ],
        citations: [],
        conversations: [],
        terminalFailure: AgentConversationTerminalFailure(
            code: "context_window_exceeded",
            message:
            "This conversation no longer fits in the selected model's context window. "
                + "Start a new conversation to continue.",
            retryable: false,
            backend: "openai-compatible",
            model: "fictional-model",
            failedAt: "2026-07-29T12:00:00.000Z"
        )
    )

    static let agentOutputTruncated = AppStore.AgentPreviewSeed(
        sessionId: "s_output_truncated",
        model: "fictional-model",
        backend: "openai-compatible",
        title: "Quarterly planning summary",
        turns: [
            .user(id: "u-truncated", text: "Summarize the complete planning history."),
            .assistant(
                AgentAssistantTurn(
                    id: "a-truncated",
                    parts: [.text("The planning history begins with three priorities and")],
                    stopReason: "max_tokens",
                    failure: AgentTurnFailure(
                        code: "output_truncated",
                        message: "The model reached its output limit before completing this response."
                    )
                )
            ),
        ],
        citations: [],
        conversations: [],
        connected: true
    )

    /// A transcript long enough to overflow the viewport so the
    /// conversation content reaches down into the composer band — used
    /// by the bottom-fade snapshot. Fictional Q&A, no corpus content.
    static let agentTallTranscript = AppStore.AgentPreviewSeed(
        sessionId: "s_tall",
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "Long conversation",
        turns: (0 ..< 14).flatMap { i -> [AgentTurn] in
            [
                .user(
                    id: "u-\(i)",
                    text: "Question \(i + 1): can you summarise what we covered so far and add one more detail to keep the thread going a little longer?"
                ),
                AgentTurn.assistant(
                    AgentAssistantTurn(
                        id: "a-\(i)",
                        parts: [
                            .text(
                                "Sure — here's a recap of point \(i + 1). Everything is on track, the numbers line up, and there's nothing blocking the next step. Let me know if you'd like me to expand on any part of this."
                            ),
                        ],
                        stopReason: "end_turn",
                        failure: nil
                    )
                ),
            ]
        },
        citations: [],
        conversations: []
    )

    /// Unique text on the very last turn of `agentScrollStressTranscript`.
    /// The scroll-to-bottom UI test asserts this becomes visible after the
    /// chevron tap — it only renders (LazyVStack is lazy) once the
    /// transcript has actually scrolled to the true bottom.
    static let agentScrollBottomMarker = "SCROLL-SENTINEL-BOTTOM-MARKER"

    /// A transcript engineered to defeat `LazyVStack` row-height estimation,
    /// reproducing the real-world "open an old conversation and the
    /// scroll-to-bottom chevron lands short" bug: a run of short turns at the
    /// top, then several very tall assistant answers, then a tiny marker turn
    /// at the very bottom. When the view opens at the top only the short rows
    /// are materialised, so SwiftUI under-estimates the height of the tall
    /// rows below and a single `scrollTo(.bottom)` stops far above the real
    /// bottom. A uniform-height transcript (every row the same size) would
    /// NOT reproduce this — the estimate would be accurate — which is why
    /// this fixture deliberately mixes short and very tall turns. Fictional
    /// content, no corpus.
    static let agentScrollStressTranscript: AppStore.AgentPreviewSeed = {
        let longBody = (1 ... 7)
            .map { p in
                "Section \(p). This is an intentionally long block of text so "
                    + "the assistant bubble grows several times taller than the "
                    + "short turns above it. The marathon plan ramps mileage by "
                    + "ten percent each week, holds a cut-back week every fourth "
                    + "week, and keeps the long run under thirty percent of the "
                    + "weekly total. Hydration and sleep matter as much as the "
                    + "mileage itself, so protect both. Review progress at the "
                    + "end of every block and adjust the next block before it "
                    + "starts rather than midway through."
            }
            .joined(separator: "\n\n")

        var turns: [AgentTurn] = []
        for i in 0 ..< 8 {
            turns.append(.user(id: "u-\(i)", text: "Quick check \(i + 1): all good so far?"))
            turns.append(AgentTurn.assistant(AgentAssistantTurn(
                id: "a-\(i)",
                parts: [.text("Yes — item \(i + 1) is on track.")],
                stopReason: "end_turn",
                failure: nil
            )))
        }
        for j in 0 ..< 3 {
            turns.append(.user(id: "uL-\(j)", text: "Write a detailed summary, part \(j + 1)."))
            turns.append(AgentTurn.assistant(AgentAssistantTurn(
                id: "aL-\(j)",
                parts: [.text(longBody)],
                stopReason: "end_turn",
                failure: nil
            )))
        }
        turns.append(.user(id: "u-bottom", text: agentScrollBottomMarker))

        return AppStore.AgentPreviewSeed(
            sessionId: "s_stress",
            model: "claude-sonnet-4-6",
            backend: "anthropic",
            title: "Scroll stress",
            turns: turns,
            citations: [],
            conversations: []
        )
    }()

    static let agentBusyStreaming = AppStore.AgentPreviewSeed(
        sessionId: "s_busy",
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "Heart rate vs last month",
        turns: [
            .user(id: "u-0", text: "How has my heart rate been compared to last month?"),
            agentAssistantTurnRunning,
        ],
        citations: [],
        conversations: [],
        busy: true
    )

    /// A history long enough to fill the menu past its viewport, so the action
    /// bar at its foot has something to sit over. The short fixture above
    /// never scrolls at menu width, which leaves the bar overlapping nothing
    /// and the inset it reserves unexercised. Titles are invented and vary in
    /// length so truncation is visible at the same time.
    static let agentConversationsLong: [ConversationSummary] = agentConversations + (0 ..< 18).map { index in
        let subjects = [
            "Draft the Q4 budget review summary",
            "What did Maya Reeves send about the Northstar rollout?",
            "Find the invoice from Riverside Estate",
            "Summarise this week's calendar",
            "Marathon entry form — what's still outstanding?",
            "Compare my sleep to the previous quarter",
        ]
        return ConversationSummary(
            sessionId: "s_long_\(index)",
            title: subjects[index % subjects.count],
            model: "claude-sonnet-4-6",
            backend: "anthropic",
            createdAt: "2026-05-0\(index % 9 + 1)T09:00:00Z",
            updatedAt: "2026-05-0\(index % 9 + 1)T09:30:00Z",
            messageCount: index % 7 + 2
        )
    }

    static let agentConversationsRich = AppStore.AgentPreviewSeed(
        sessionId: "s_a",
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "Wedding DJ",
        turns: [],
        citations: [],
        conversations: agentConversations,
        conversationsNextCursor: "preview-next-page"
    )

    /// `agentConversationsRich`, but with a history that overflows the menu.
    static let agentConversationsOverflowing = AppStore.AgentPreviewSeed(
        sessionId: "s_a",
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "Wedding DJ",
        turns: [],
        citations: [],
        conversations: agentConversationsLong,
        conversationsNextCursor: "preview-next-page"
    )

    // MARK: - Plan-panel fixtures

    /// Single in-progress row — minimum panel state.
    static let agentPlanItemsSingleInProgress: [AgentPlanItem] = [
        AgentPlanItem(id: "p1", label: "Search Claire's messages", status: .inProgress),
    ]

    /// Mid-progress: one row already done, one running, one queued.
    /// Mirrors the second `plan.updated` snapshot in the Claire demo
    /// fixture (`evals/fixtures/agent/demos/birthday-gifts.jsonl`).
    static let agentPlanItemsMixed: [AgentPlanItem] = [
        AgentPlanItem(id: "p1", label: "Search Claire's messages", status: .done),
        AgentPlanItem(id: "p2", label: "Check purchase history for duplicates", status: .inProgress),
        AgentPlanItem(id: "p3", label: "Summarize candidates", status: .pending),
    ]

    /// All done — the panel will collapse a beat later via the row-
    /// level auto-remove. Useful for testing the "everything green
    /// checkmarks, about to vanish" snapshot.
    static let agentPlanItemsAllDone: [AgentPlanItem] = [
        AgentPlanItem(id: "p1", label: "Search Claire's messages", status: .done),
        AgentPlanItem(id: "p2", label: "Check purchase history for duplicates", status: .done),
        AgentPlanItem(id: "p3", label: "Summarize candidates", status: .done),
    ]

    /// AgentView seed for the busy + plan-in-flight composite preview
    /// — the assistant is mid-turn, the plan panel sits above the
    /// composer, and the transcript shows the running tool card.
    static let agentBusyWithPlan = AppStore.AgentPreviewSeed(
        sessionId: "s_plan_busy",
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "Birthday gifts for Claire",
        turns: [
            .user(id: "u-0", text: "Help me figure out a birthday gift for Claire — she's turning 30 next week."),
            agentAssistantTurnRunning,
        ],
        citations: [],
        conversations: [],
        busy: true,
        planItems: agentPlanItemsMixed
    )

    /// All-done variant used by the snapshot that captures the
    /// panel right before its grace-period collapse.
    static let agentBusyWithPlanAllDone = AppStore.AgentPreviewSeed(
        sessionId: "s_plan_done",
        model: "claude-sonnet-4-6",
        backend: "anthropic",
        title: "Birthday gifts for Claire",
        turns: [
            .user(id: "u-0", text: "Help me figure out a birthday gift for Claire — she's turning 30 next week."),
            agentAssistantTurnRunning,
        ],
        citations: [],
        conversations: [],
        busy: true,
        planItems: agentPlanItemsAllDone
    )
}

// MARK: - Notes ("Tell Omnesis" quick capture)

@available(iOS 17.0, *)
extension PreviewMocks {
    static let privacyExternalAgent = PrivacyExternalAgent(
        displayName: "Atlas",
        narrativeName: "Atlas",
        integrationSlug: "openclaw",
        connectionName: "Studio desktop",
        source: .principal
    )

    static let subscriptionApproval = PrivacySubscriptionApprovalSummary(
        id: "subscription-approval-northstar",
        subscriptionId: "subscription-northstar",
        workflowHandle: "workflow-northstar",
        integration: privacyExternalAgent,
        status: "pending",
        interpretedCondition: PrivacyInterpretedCondition(
            summary: "A new Studio Northstar update requests a decision"
        ),
        revisionId: "subscription-revision-northstar-001",
        revision: 1,
        createdAt: 1_900_000_000_000,
        expiresAt: 1_901_209_600_000,
        resolvedAt: nil
    )

    static let subscriptionApprovalDetail = PrivacySubscriptionApprovalDetail(
        id: subscriptionApproval.id,
        subscriptionId: subscriptionApproval.subscriptionId,
        workflowHandle: subscriptionApproval.workflowHandle,
        integration: privacyExternalAgent,
        status: "pending",
        interpretedCondition: subscriptionApproval.interpretedCondition,
        interpretation: subscriptionApproval.interpretedCondition,
        workflowId: "workflow-northstar",
        integrationDeviceId: "integration-device-northstar",
        integrationDevice: PrivacySubscriptionIntegrationDevice(
            id: "integration-device-northstar",
            name: "Fictional OpenClaw integration"
        ),
        workflow: PrivacySubscriptionWorkflow(
            id: "workflow-northstar",
            name: "Studio Northstar review",
            purpose: "Review fictional project updates"
        ),
        revisionId: subscriptionApproval.revisionId,
        revision: subscriptionApproval.revision,
        createdAt: subscriptionApproval.createdAt,
        expiresAt: subscriptionApproval.expiresAt,
        resolvedAt: nil,
        condition: PrivacySubscriptionCondition(
            description: "a Studio Northstar update that requests a decision"
        ),
        reaction: PrivacySubscriptionReaction(
            instruction: "Review the update, decide whether follow-up is required, and draft a response if useful."
        ),
        categories: ["private communication"],
        policyRevision: "policy-revision-example-001"
    )

    static let subscriptionApprovalRevisionDetail = PrivacySubscriptionApprovalDetail(
        id: "subscription-approval-northstar-revision-2",
        subscriptionId: subscriptionApprovalDetail.subscriptionId,
        workflowHandle: subscriptionApprovalDetail.workflowHandle,
        integration: privacyExternalAgent,
        status: "pending",
        interpretedCondition: subscriptionApprovalDetail.interpretedCondition,
        interpretation: subscriptionApprovalDetail.interpretation,
        workflowId: subscriptionApprovalDetail.workflowId,
        integrationDeviceId: subscriptionApprovalDetail.integrationDeviceId,
        integrationDevice: subscriptionApprovalDetail.integrationDevice,
        workflow: subscriptionApprovalDetail.workflow,
        revisionId: "subscription-revision-northstar-002",
        revision: 2,
        createdAt: subscriptionApprovalDetail.createdAt,
        expiresAt: subscriptionApprovalDetail.expiresAt,
        resolvedAt: nil,
        condition: subscriptionApprovalDetail.condition,
        reaction: subscriptionApprovalDetail.reaction,
        categories: subscriptionApprovalDetail.categories,
        policyRevision: subscriptionApprovalDetail.policyRevision
    )

    /// What a watch's record actually sent. The first names the journal event a
    /// `watchFirings` entry also names, so the merged ledger folds the two into
    /// one row; the second names none, which is a record written before the
    /// runtime stamped a firing with its own identity and still has to appear.
    static let subscriptionFirings: [PrivacySubscriptionFiring] = [
        PrivacySubscriptionFiring(
            id: "firing-northstar-002",
            subscriptionId: watchDisclosure.subscriptionId,
            revisionId: "subscription-revision-northstar-002",
            workflowHandle: "workflow-northstar",
            createdAt: 1_900_000_500_000,
            deliveryStatus: "delivered",
            acceptedAt: 1_900_000_501_000,
            watchId: "watch-invoice-due",
            seq: 15226
        ),
        PrivacySubscriptionFiring(
            id: "firing-northstar-001",
            subscriptionId: watchDisclosure.subscriptionId,
            revisionId: "subscription-revision-northstar-002",
            workflowHandle: "workflow-northstar",
            createdAt: 1_900_000_100_000,
            deliveryStatus: "blocked",
            acceptedAt: nil
        ),
    ]

    /// Queued notes old enough to trigger the drawer warning, with only
    /// invented, sanitized delivery diagnostics.
    static let pendingNotes: [PendingNote] = [
        PendingNote(
            id: "20260309T171201000-aaaa0001",
            text: "Look up whether the ferry runs on public holidays",
            capturedAt: Date(timeIntervalSinceNow: -540),
            surface: "ios-control",
            deliveryDiagnostics: PendingNoteDeliveryDiagnostics(
                attemptCount: 2,
                lastAttemptAt: Date(timeIntervalSinceNow: -120),
                lastFailure: PendingNoteDeliveryFailure(kind: .unreachable, code: -1004),
                redeliveryFailed: true
            )
        ),
        PendingNote(
            id: "20260309T171530000-aaaa0002",
            text: "Move the dentist reminder to Friday",
            capturedAt: Date(timeIntervalSinceNow: -320),
            surface: "ios-siri",
            deliveryDiagnostics: PendingNoteDeliveryDiagnostics(
                attemptCount: 1,
                lastAttemptAt: Date(timeIntervalSinceNow: -315),
                lastFailure: PendingNoteDeliveryFailure(kind: .unauthorized, code: 401)
            )
        ),
    ]

    /// A newly queued note remains quiet during the normal five-minute
    /// grace period.
    static let freshPendingNotes: [PendingNote] = [
        PendingNote(
            id: "20260309T172000000-aaaa0003",
            text: "Sketch a packing checklist for the weekend",
            capturedAt: Date(timeIntervalSinceNow: -60),
            surface: "ios-app",
            deliveryDiagnostics: PendingNoteDeliveryDiagnostics(
                attemptCount: 1,
                lastAttemptAt: Date(timeIntervalSinceNow: -55),
                lastFailure: PendingNoteDeliveryFailure(kind: .unreachable, code: -1009)
            )
        ),
    ]
}

// MARK: - Answer privacy

@available(iOS 17.0, *)
extension PreviewMocks {
    static let privacyPolicyText = """
    # Omnesis answer privacy policy (Guarded)

    This policy controls what information may leave Omnesis through external answers and watch
    existence signals. The privacy reviewer applies it before either disclosure is returned.

    | Information | Existence | Summary | Exact or original |
    | --- | --- | --- | --- |
    | Calendar and availability | Allow | Allow | Approval required |
    | Location and addresses | Approval required | Release with reductions | Approval required |
    | Health and fitness | Approval required | Approval required | Deny |
    | Money and finances | Approval required | Approval required | Deny |
    | Messages about other people | Approval required | Approval required | Deny |
    | Passwords, authentication codes, tokens, private keys, and recovery codes | Deny | Deny | Deny |

    ## Floor

    Credentials are blocked outright. No row above can release one.
    """

    static let privacyPolicy = PrivacyPolicyDocument(
        policy: privacyPolicyText,
        revision: "rev_preview_01",
        updatedAt: 1_786_851_000_000
    )

    /// The document one named policy family carries, as the read-only view
    /// shows it when it is opened from the grant that points at that family.
    static let privacyPolicyFamily = PrivacyPolicyDocument(
        policy: """
        # Work-safe assistant

        This policy governs one grant: what a connected assistant may learn from the corpus, and at what level of detail.

        | Information | Existence | Summary | Exact or original |
        | --- | --- | --- | --- |
        | Calendar and availability | Allow | Allow | Approval required |
        | Files and documents | Allow | Approval required | Approval required |
        | Health and fitness | Deny | Deny | Deny |
        | Money and finances | Deny | Deny | Deny |
        | Passwords, authentication codes, tokens, and recovery codes | Deny | Deny | Deny |

        ## Floor

        Credentials are blocked outright. No row above can release one.
        """,
        revision: "b7d1e9c3a5f048216d2a",
        updatedAt: 1_786_851_000_000
    )

    /// The family the previewed access overview reports as the default.
    static let privacyDefaultPolicyFamilyId = "00000000-0000-4000-8000-000000000001"

    /// The catalogue Settings lists. Carries a retired family so the list's
    /// filtering is visible, and the default so it leads.
    static let privacyPolicyFamilies: [PrivacyPolicyFamilySummary] = [
        PrivacyPolicyFamilySummary(
            id: "policy-research-desk",
            name: "Research desk",
            currentRevision: "c41e8b0d7f52a9603b1d",
            currentVersion: 4,
            updatedAt: 1_786_850_000_000,
            archivedAt: nil,
            affectedGrantIds: ["grant_preview_03"]
        ),
        PrivacyPolicyFamilySummary(
            id: privacyDefaultPolicyFamilyId,
            name: "Household",
            currentRevision: "9f2c7a1b4e6d03a85c7e",
            currentVersion: 2,
            updatedAt: 1_786_851_000_000,
            archivedAt: nil,
            affectedGrantIds: []
        ),
        PrivacyPolicyFamilySummary(
            id: "policy-work-safe",
            name: "Work safe",
            currentRevision: "b7d1e9c3a5f048216d2a",
            currentVersion: 3,
            updatedAt: 1_786_851_000_000,
            archivedAt: nil,
            affectedGrantIds: ["grant_preview_01", "grant_preview_02"]
        ),
        PrivacyPolicyFamilySummary(
            id: "policy-old-travel-desk",
            name: "Old travel desk",
            currentRevision: "e9f0a3c6d18b4275f90c",
            currentVersion: 1,
            updatedAt: 1_786_700_000_000,
            archivedAt: 1_786_720_000_000,
            affectedGrantIds: []
        ),
    ]

    /// A catalogue of one: the install's default and nothing else.
    static let privacyPolicyFamilySingle: [PrivacyPolicyFamilySummary] = [privacyPolicyFamilies[1]]

    /// A family named at the length a row must survive: the name wraps, the
    /// revision line and the chevron stay where they are.
    static let privacyPolicyFamiliesLongName: [PrivacyPolicyFamilySummary] = [
        privacyPolicyFamilies[1],
        PrivacyPolicyFamilySummary(
            id: "policy-conference-desk",
            name: "Conference desk assistant for the autumn programme committee and its visiting speakers",
            currentRevision: "d2a7f41c9e0b6835a1f3",
            currentVersion: 6,
            updatedAt: 1_786_852_000_000,
            archivedAt: nil,
            affectedGrantIds: ["grant_preview_04"]
        ),
    ]

    static let privacyReviewerHealthAttention = PrivacyReviewerHealth(
        status: .attention,
        recentOperationalFailureCount: 3,
        lastFailureAt: 1_786_852_224_000
    )

    static let privacyReview = PrivacyReviewRecord(
        recipeVersion: "privacy-review-v1",
        provider: "anthropic",
        model: "claude-example-reviewer",
        confidence: 0.91,
        policyRevision: "rev_preview_01",
        policyFamilyId: "policy-work-safe",
        policyFamilyName: "Work safe",
        envelopeDigest: "sha256:preview-review-envelope-01",
        findings: [
            PrivacyFinding(
                category: "schedule",
                detailLevel: .summary,
                subject: .user,
                disposition: .allow,
                description: "A broad availability window can be released."
            ),
            PrivacyFinding(
                category: "location",
                detailLevel: .exact,
                subject: .otherPerson,
                disposition: .approval,
                description: "The draft includes another person's exact meeting location."
            ),
        ],
        rationale: "The schedule summary is allowed, but the exact location requires approval."
    )

    /// The same review as recorded by a gateway that kept no policy family on
    /// the record: the approval screen shows nothing about the policy.
    static let privacyReviewWithoutPolicy = PrivacyReviewRecord(
        recipeVersion: privacyReview.recipeVersion,
        provider: privacyReview.provider,
        model: privacyReview.model,
        confidence: privacyReview.confidence,
        policyRevision: privacyReview.policyRevision,
        envelopeDigest: privacyReview.envelopeDigest,
        findings: privacyReview.findings,
        rationale: privacyReview.rationale
    )

    /// The pending review every other Privacy fixture is anchored to: the feed
    /// exchange, the pinned card, and the deep-linked approval all read their
    /// identity from here.
    static let privacyApprovalDetail = PrivacyApprovalDetail(
        id: "pap_preview_01",
        taskId: "task_preview_01",
        workflowId: "workflow_conference_trip",
        conversationId: "conversation_preview_01",
        workflowName: "Plan a conference trip",
        externalAgent: privacyExternalAgent,
        status: .pending,
        createdAt: 1_786_852_200_000,
        expiresAt: 1_786_938_600_000,
        resolvedAt: nil,
        workflowPurpose: "Compare travel options and prepare a draft itinerary.",
        question: "When is the user free to meet the event organizer, and where is the proposed meeting?",
        candidateAnswer: "The user is free on Thursday afternoon. The proposed meeting is at 42 Example Street.",
        review: privacyReview
    )

    /// The same approval after the operator decided it. A link minted while it
    /// was pending still resolves here, and must say so instead of offering the
    /// decision again.
    /// The pending review as an older record: no policy family on it.
    static let privacyApprovalDetailWithoutPolicy = PrivacyApprovalDetail(
        id: privacyApprovalDetail.id,
        taskId: privacyApprovalDetail.taskId,
        workflowId: privacyApprovalDetail.workflowId,
        conversationId: privacyApprovalDetail.conversationId,
        workflowName: privacyApprovalDetail.workflowName,
        externalAgent: privacyExternalAgent,
        status: .pending,
        createdAt: privacyApprovalDetail.createdAt,
        expiresAt: privacyApprovalDetail.expiresAt,
        resolvedAt: nil,
        workflowPurpose: privacyApprovalDetail.workflowPurpose,
        question: privacyApprovalDetail.question,
        candidateAnswer: privacyApprovalDetail.candidateAnswer,
        review: privacyReviewWithoutPolicy
    )

    static let privacyDecidedApprovalDetail = PrivacyApprovalDetail(
        id: privacyApprovalDetail.id,
        taskId: privacyApprovalDetail.taskId,
        workflowId: privacyApprovalDetail.workflowId,
        conversationId: privacyApprovalDetail.conversationId,
        workflowName: privacyApprovalDetail.workflowName,
        externalAgent: privacyExternalAgent,
        status: .approved,
        createdAt: privacyApprovalDetail.createdAt,
        expiresAt: privacyApprovalDetail.expiresAt,
        resolvedAt: 1_786_852_260_000,
        sharedAt: 1_786_852_262_000,
        workflowPurpose: privacyApprovalDetail.workflowPurpose,
        question: privacyApprovalDetail.question,
        candidateAnswer: privacyApprovalDetail.candidateAnswer,
        review: privacyReview
    )

    static let privacyUnavailableApproval = PrivacyApprovalDetail(
        id: "pap_preview_unavailable",
        taskId: "task_preview_unavailable",
        workflowId: "workflow_route_summary",
        conversationId: "conversation_preview_unavailable",
        workflowName: "Prepare a route summary",
        externalAgent: privacyExternalAgent,
        status: .pending,
        createdAt: 1_786_852_220_000,
        expiresAt: 1_786_938_620_000,
        resolvedAt: nil,
        workflowPurpose: "Summarize route options for a draft itinerary.",
        question: "Which route should be included in the draft?",
        candidateAnswer: "Route A is the shortest option and avoids the city center.",
        review: PrivacyReviewRecord(
            recipeVersion: "privacy-review-v1",
            provider: nil,
            model: nil,
            confidence: nil,
            policyRevision: "rev_preview_01",
            findings: [],
            rationale: "Privacy reviewer returned an invalid response.",
            fallbackCause: .invalidOutput
        )
    )

    /// A draft long enough to judge a quotation at phone width: several
    /// paragraphs of ordinary prose and a list, where a fixed-width face would
    /// show its cost. Entirely invented.
    static let privacyLongDraftAnswer = """
    Thursday afternoon is the clearest window. Nothing is scheduled between 13:00 and 17:30, \
    and the blocks on either side are internal, so they can move if the organizer needs longer.

    The organizer proposed the venue's east entrance, a fifteen-minute walk from the hotel \
    booked for that night. An alternative that avoids the walk:

    - Meet in the lobby of Studio Northstar, two streets away.
    - Ask Maya Reeves to join for the last twenty minutes, since she presents that afternoon.
    - Keep the slot to an hour, so the 18:00 rehearsal is not at risk.

    Friday morning is also free, but the return flight leaves at 11:20 and a meeting that \
    overruns would put it at risk.
    """

    static let privacyExchanges: [PrivacyExchangePresentation] = [
        PrivacyExchangePresentation(
            taskId: privacyApprovalDetail.taskId,
            conversationId: privacyApprovalDetail.conversationId,
            workflowId: privacyApprovalDetail.workflowId,
            externalAgent: privacyExternalAgent,
            workflow: PrivacyExchangeWorkflow(
                name: privacyApprovalDetail.workflowName,
                purpose: "Compare travel options and prepare a draft itinerary."
            ),
            question: "When is the user free to meet the event organizer, and where is the proposed meeting?",
            status: .approvalRequired,
            outcome: .needsReview,
            createdAt: privacyApprovalDetail.createdAt,
            resolvedAt: nil,
            sharedAnswer: nil,
            pendingCandidate: "The user is free on Thursday afternoon. The proposed meeting is at 42 Example Street.",
            reductions: [],
            approval: PrivacyExchangeApproval(
                id: privacyApprovalDetail.id,
                status: .pending,
                expiresAt: privacyApprovalDetail.expiresAt,
                resolvedAt: nil
            ),
            userDecision: nil,
            review: PrivacyExchangeReview(
                fallbackCause: .policyRequiresReview,
                findings: privacyReview.findings,
                rationale: privacyReview.rationale
            )
        ),
        PrivacyExchangePresentation(
            taskId: "task_preview_02",
            conversationId: privacyApprovalDetail.conversationId,
            workflowId: privacyApprovalDetail.workflowId,
            externalAgent: privacyExternalAgent,
            workflow: PrivacyExchangeWorkflow(
                name: privacyApprovalDetail.workflowName,
                purpose: "Compare travel options and prepare a draft itinerary."
            ),
            question: "Can you share only a broad area instead?",
            status: .releasedWithReductions,
            outcome: .sharedWithReductions,
            createdAt: 1_786_852_210_000,
            resolvedAt: 1_786_852_217_000,
            sharedAt: 1_786_852_277_000,
            sharedAnswer: "The user is available Thursday afternoon near the venue.",
            draftAnswer: "The user is available Thursday afternoon at 42 Example Street.",
            pendingCandidate: nil,
            reductions: ["Removed the exact street address"],
            approval: nil,
            userDecision: nil,
            review: PrivacyExchangeReview(
                fallbackCause: nil,
                findings: privacyReview.findings,
                rationale: "The exact location was removed before sharing.",
                policyFamilyId: "policy-work-safe",
                policyFamilyName: "Work safe"
            )
        ),
    ]

    /// The same pending exchange carrying a multi-paragraph draft, so the
    /// quoted answer is judged at the length one actually arrives at.
    static let privacyLongDraftExchange = PrivacyExchangePresentation(
        taskId: "task_preview_long_draft",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Compare travel options and prepare a draft itinerary."
        ),
        question: "Which afternoon works for the organizer meeting, where should it happen, "
            + "and what else on that day would have to move to make room for it?",
        status: .approvalRequired,
        outcome: .needsReview,
        createdAt: privacyApprovalDetail.createdAt,
        resolvedAt: nil,
        sharedAnswer: nil,
        pendingCandidate: privacyLongDraftAnswer,
        reductions: [],
        approval: PrivacyExchangeApproval(
            id: "pap_preview_long_draft",
            status: .pending,
            expiresAt: privacyApprovalDetail.expiresAt,
            resolvedAt: nil
        ),
        userDecision: nil,
        review: PrivacyExchangeReview(
            fallbackCause: .policyRequiresReview,
            findings: privacyReview.findings,
            rationale: "The availability summary is allowed, but the meeting place and the "
                + "people named alongside it need your decision before anything is shared."
        )
    )

    static let privacyFailedExchange = PrivacyExchangePresentation(
        taskId: "task_preview_failed",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Compare travel options and prepare a draft itinerary."
        ),
        question: "Which route should be included in the draft?",
        status: .failed,
        outcome: .failed,
        createdAt: 1_782_000_030_000,
        resolvedAt: 1_782_000_040_000,
        sharedAnswer: nil,
        pendingCandidate: nil,
        reductions: [],
        approval: nil,
        userDecision: nil,
        review: nil,
        failure: PrivacyExchangeFailure(
            code: "agent_unavailable",
            message: "The answer could not be drafted, so the privacy check never ran.",
            stage: .answerGeneration
        )
    )

    /// The draft died on something the provider itself reported, so the card
    /// carries the vetted disposition line under the humanized sentence.
    static let privacyProviderFailedExchange = PrivacyExchangePresentation(
        taskId: "task_preview_provider_failed",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Compare travel options and prepare a draft itinerary."
        ),
        question: "Which route should be included in the draft?",
        status: .failed,
        outcome: .failed,
        createdAt: 1_782_000_030_000,
        resolvedAt: 1_782_000_040_000,
        sharedAnswer: nil,
        pendingCandidate: nil,
        reductions: [],
        approval: nil,
        userDecision: nil,
        review: nil,
        failure: PrivacyExchangeFailure(
            code: "http_api_error",
            message:
            "The model provider does not have the assigned model — check the model assignment (HTTP 404).",
            stage: .answerGeneration,
            detail: "HTTP 404 · NOT_FOUND · param=model"
        )
    )

    static let privacyReviewFailedExchange = PrivacyExchangePresentation(
        taskId: "task_preview_review_failed",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Prepare an invented route summary."
        ),
        question: "Which fictional route is shortest?",
        status: .failed,
        outcome: .failed,
        createdAt: 1_782_000_030_000,
        resolvedAt: 1_782_000_040_000,
        sharedAnswer: nil,
        draftAnswer: "Route A is the shortest fictional route.",
        pendingCandidate: nil,
        reductions: [],
        approval: nil,
        userDecision: nil,
        review: PrivacyExchangeReview(
            fallbackCause: .requestFailed,
            findings: [],
            rationale: "The privacy reviewer did not return a decision."
        ),
        failure: PrivacyExchangeFailure(
            code: "privacy_review_failed",
            message: "The privacy check could not complete.",
            stage: .privacyCheck
        )
    )

    static let privacyUnattendedDraftExchange = PrivacyExchangePresentation(
        taskId: "task_preview_unattended_draft",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Prepare an invented venue update."
        ),
        question: "When does the fictional venue desk close?",
        status: .denied,
        outcome: .notShared,
        createdAt: 1_786_852_220_000,
        resolvedAt: 1_786_852_250_000,
        sharedAnswer: nil,
        draftAnswer: "The fictional venue desk is open until 17:00.",
        pendingCandidate: nil,
        reductions: [],
        approval: nil,
        userDecision: nil,
        denialReason: .approvalNotAvailable,
        review: PrivacyExchangeReview(
            fallbackCause: .policyRequiresReview,
            findings: [],
            rationale: "The answer required approval before it could leave Omnesis."
        )
    )

    static let privacyRunningExchange = PrivacyExchangePresentation(
        taskId: "task_preview_running",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Prepare an invented venue update."
        ),
        question: "When does the fictional venue desk close?",
        status: .running,
        outcome: .checking,
        createdAt: 1_786_000_000_000,
        resolvedAt: nil,
        sharedAnswer: nil,
        draftAnswer: nil,
        pendingCandidate: nil,
        reductions: [],
        approval: nil,
        userDecision: nil,
        review: nil
    )

    static let privacyReadyExchange = PrivacyExchangePresentation(
        taskId: "task_preview_ready",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Compare travel options and prepare a draft itinerary."
        ),
        question: "What broad availability can be shared with the event organizer?",
        status: .released,
        outcome: .ready,
        createdAt: 1_786_852_220_000,
        resolvedAt: 1_786_852_240_000,
        sharedAt: nil,
        sharedAnswer: nil,
        pendingCandidate: nil,
        reductions: [],
        approval: PrivacyExchangeApproval(
            id: "pap_preview_ready",
            status: .approved,
            expiresAt: 1_786_938_620_000,
            resolvedAt: 1_786_852_240_000
        ),
        userDecision: .approved,
        review: PrivacyExchangeReview(
            fallbackCause: .policyRequiresReview,
            findings: privacyReview.findings,
            rationale: "The privacy policy required a human decision."
        )
    )

    static let privacyHardStoppedExchange = PrivacyExchangePresentation(
        taskId: "task_preview_hard_stopped",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Compare travel options and prepare a draft itinerary."
        ),
        question: "Can an authentication detail be included in the setup notes?",
        status: .denied,
        outcome: .notShared,
        createdAt: 1_786_852_220_000,
        resolvedAt: 1_786_852_250_000,
        sharedAt: nil,
        sharedAnswer: nil,
        pendingCandidate: nil,
        reductions: [],
        approval: PrivacyExchangeApproval(
            id: "pap_preview_hard_stopped",
            status: .denied,
            expiresAt: 1_786_938_620_000,
            resolvedAt: 1_786_852_250_000
        ),
        userDecision: .approvedButBlocked,
        review: PrivacyExchangeReview(
            fallbackCause: .hardStop,
            findings: [
                PrivacyFinding(
                    category: "authentication_secret",
                    detailLevel: .original,
                    subject: .user,
                    disposition: .deny,
                    description: "The held answer contains an authentication secret."
                ),
            ],
            rationale: "An authentication secret cannot leave Omnesis."
        )
    )

    /// The ledger for both preview exchanges. The steps that carry the
    /// exchange's own words — the request, each draft, the reduction, the
    /// release — hold that text rather than a description of it, the way the
    /// gateway records them; the rest speak in Omnesis's voice.
    static let privacyAuditEvents: [PrivacyAuditEventSummary] = [
        PrivacyAuditEventSummary(
            id: "audit_request_01",
            taskId: "task_preview_01",
            kind: .externalRequest,
            createdAt: 1_786_852_200_000,
            display: PrivacyAuditEventDisplay(
                title: "External request",
                text: "When is the user free to meet the event organizer, and where is the "
                    + "proposed meeting?",
                detail: "Compare travel options and prepare a draft itinerary."
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_agent_01",
            taskId: "task_preview_01",
            kind: .agentTrace,
            createdAt: 1_786_852_203_000,
            display: PrivacyAuditEventDisplay(
                title: "Agent activity",
                text: "Searched the calendar index for the requested week.",
                detail: "3 tool calls, read-only, inside Omnesis.",
                provider: "anthropic",
                model: "claude-example-agent"
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_candidate_01",
            taskId: "task_preview_01",
            kind: .candidateGenerated,
            createdAt: 1_786_852_204_000,
            display: PrivacyAuditEventDisplay(
                title: "Candidate drafted inside Omnesis",
                text: "The user is free on Thursday afternoon. The proposed meeting is at "
                    + "42 Example Street.",
                provider: "anthropic",
                model: "claude-example-agent"
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_review_01",
            taskId: "task_preview_01",
            kind: .privacyReview,
            createdAt: 1_786_852_206_000,
            display: PrivacyAuditEventDisplay(
                title: "Privacy review",
                text: "The schedule summary is allowed, but the exact location requires approval.",
                status: PrivacyAuditStatusDisplay(code: .held, label: "Held for your review"),
                provider: "anthropic",
                model: "claude-example-reviewer",
                confidence: 0.91
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_approval_01",
            taskId: "task_preview_01",
            kind: .approvalRequested,
            createdAt: 1_786_852_208_000,
            display: PrivacyAuditEventDisplay(
                title: "Waiting for approval",
                text: "Nothing was released while this answer waits for you.",
                status: PrivacyAuditStatusDisplay(code: .held, label: "Held for your review"),
                approvalId: "pap_preview_01"
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_request_02",
            taskId: "task_preview_02",
            kind: .externalRequest,
            createdAt: 1_786_852_210_000,
            display: PrivacyAuditEventDisplay(
                title: "External follow-up",
                text: "Can you share only a broad area instead?"
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_candidate_02",
            taskId: "task_preview_02",
            kind: .candidateGenerated,
            createdAt: 1_786_852_212_000,
            display: PrivacyAuditEventDisplay(
                title: "Candidate drafted inside Omnesis",
                text: "The user is available Thursday afternoon at 42 Example Street, "
                    + "near the venue.",
                provider: "anthropic",
                model: "claude-example-agent"
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_reduction_02",
            taskId: "task_preview_02",
            kind: .reductionGenerated,
            createdAt: 1_786_852_214_000,
            display: PrivacyAuditEventDisplay(
                title: "Details removed",
                text: "The user is available Thursday afternoon near the venue.",
                status: PrivacyAuditStatusDisplay(code: .reduced, label: "Details removed"),
                reductions: ["Removed the exact street address"]
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_release_02",
            taskId: "task_preview_02",
            kind: .released,
            createdAt: 1_786_852_216_000,
            display: PrivacyAuditEventDisplay(
                title: "Approved for release",
                text: "The user is available Thursday afternoon near the venue.",
                status: PrivacyAuditStatusDisplay(code: .reduced, label: "Details removed"),
                releaseId: "release_preview_02",
                reductions: ["Removed the exact street address"]
            )
        ),
        PrivacyAuditEventSummary(
            id: "audit_egress_02",
            taskId: "task_preview_02",
            kind: .egress,
            createdAt: 1_786_852_217_000,
            display: PrivacyAuditEventDisplay(
                title: "Outbound response",
                text: "The response was returned to the external agent.",
                status: PrivacyAuditStatusDisplay(code: .allowed, label: "Left this machine"),
                releaseId: "release_preview_02"
            )
        ),
    ]

    // MARK: - Privacy — the released answer against the draft

    /// The draft, before the privacy check reduced it. Two of its lines differ
    /// from what left, one has no counterpart at all, and one differs only in
    /// the spacing inside it.
    static let privacyAnswerDiffCandidate = """
    The user is free on Thursday afternoon.
    The proposed meeting is at 42 Example Street, Riverside.
    The organizer asked for a reply by Tuesday.

    Travel time from the venue is about  20 minutes.
    Everything else in the draft — the travel options, the return leg and the checklist — was left as written.
    """

    /// What actually left, in the same fixture.
    static let privacyAnswerDiffReleased = """
    The user is free on Thursday afternoon.
    The proposed meeting is near the venue.

    Travel time from the venue is about 20 minutes.
    Everything else in the draft — the travel options, the return leg and the checklist — was left as written.
    """

    /// The gateway's comparison of the two above, in the shape it sends: a
    /// matched pair with word spans, a removed line with no counterpart, a blank
    /// line, a pair differing only in spacing, and a line long enough to wrap.
    static let privacyAnswerDiff: PrivacyAnswerComparison = .diff(lines: [
        PrivacyAnswerDiffLine(op: .equal, text: "The user is free on Thursday afternoon."),
        PrivacyAnswerDiffLine(
            op: .removed,
            text: "The proposed meeting is at 42 Example Street, Riverside.",
            spans: [
                PrivacyAnswerDiffSpan(op: .equal, text: "The proposed meeting is "),
                PrivacyAnswerDiffSpan(op: .removed, text: "at 42 Example Street, Riverside"),
                PrivacyAnswerDiffSpan(op: .equal, text: "."),
            ]
        ),
        PrivacyAnswerDiffLine(op: .removed, text: "The organizer asked for a reply by Tuesday."),
        PrivacyAnswerDiffLine(
            op: .added,
            text: "The proposed meeting is near the venue.",
            spans: [
                PrivacyAnswerDiffSpan(op: .equal, text: "The proposed meeting is "),
                PrivacyAnswerDiffSpan(op: .added, text: "near the venue"),
                PrivacyAnswerDiffSpan(op: .equal, text: "."),
            ]
        ),
        PrivacyAnswerDiffLine(op: .equal, text: ""),
        PrivacyAnswerDiffLine(
            op: .removed,
            text: "Travel time from the venue is about  20 minutes.",
            spans: [
                PrivacyAnswerDiffSpan(op: .equal, text: "Travel time from the venue is about"),
                PrivacyAnswerDiffSpan(op: .removed, text: "  "),
                PrivacyAnswerDiffSpan(op: .equal, text: "20 minutes."),
            ]
        ),
        PrivacyAnswerDiffLine(
            op: .added,
            text: "Travel time from the venue is about 20 minutes.",
            spans: [
                PrivacyAnswerDiffSpan(op: .equal, text: "Travel time from the venue is about"),
                PrivacyAnswerDiffSpan(op: .added, text: " "),
                PrivacyAnswerDiffSpan(op: .equal, text: "20 minutes."),
            ]
        ),
        PrivacyAnswerDiffLine(
            op: .equal,
            text: "Everything else in the draft — the travel options, the return leg and the checklist — was left as written."
        ),
    ])

    /// A two-step record — the draft, then the release — carrying one
    /// comparison. The release step's body follows the gateway: dropped when the
    /// released bytes are the candidate's, the released answer otherwise.
    static func privacyComparisonEvents(
        _ comparison: PrivacyAnswerComparison
    )
        -> [PrivacyAuditEventSummary] {
        var identical = false
        if case .identical = comparison { identical = true }
        return [
            PrivacyAuditEventSummary(
                id: "audit_candidate_diff",
                taskId: "task_preview_diff",
                kind: .candidateGenerated,
                createdAt: 1_786_852_230_000,
                display: PrivacyAuditEventDisplay(
                    title: "Candidate drafted inside Omnesis",
                    text: privacyAnswerDiffCandidate,
                    provider: "anthropic",
                    model: "claude-example-agent"
                )
            ),
            PrivacyAuditEventSummary(
                id: "audit_release_diff",
                taskId: "task_preview_diff",
                kind: .released,
                createdAt: 1_786_852_236_000,
                display: PrivacyAuditEventDisplay(
                    title: "Approved answer released",
                    text: identical ? nil : privacyAnswerDiffReleased,
                    status: identical
                        ? PrivacyAuditStatusDisplay(code: .allowed, label: "Left this machine")
                        : PrivacyAuditStatusDisplay(code: .reduced, label: "Details removed"),
                    releaseId: "release_preview_diff",
                    reductions: identical ? [] : ["Removed the exact street address"]
                ),
                answerComparison: comparison
            ),
        ]
    }

    /// The landing feed the gateway returns: ordered by each exchange's
    /// `presentationTimestamp`, newest first, and spanning multiple days and
    /// outcomes so its grouping and status treatments are exercised.
    static let privacyExchangeFeed: [PrivacyExchangePresentation] = [
        privacyExchanges[1],
        privacyHardStoppedExchange,
        privacyReadyExchange,
        privacyExchanges[0],
        privacyBudgetExchange,
        privacyFailedExchange,
    ]

    /// Direct transcript sessions, newest first as the gateway returns them:
    /// one named agent grouped by an explicit conversation key, one workflow
    /// session whose principal row is gone, one the gateway grouped
    /// heuristically, and one carrying a grouping key from a newer gateway.
    static let directAuditSessions: [DirectAuditSessionSummary] = [
        DirectAuditSessionSummary(
            id: "direct_preview_01",
            ownerId: "owner_preview",
            principalId: "principal_preview_atlas",
            principalName: "Atlas",
            credentialId: "credential_preview_laptop",
            grantId: "grant_preview_01",
            explicitKey: "conversation:conv_preview_01",
            heuristicKey: "principal_preview_atlas|credential_preview_laptop",
            createdAt: 1_786_852_200_000,
            lastEventAt: 1_786_852_277_000,
            eventCount: 5
        ),
        DirectAuditSessionSummary(
            id: "direct_preview_02",
            ownerId: "owner_preview",
            principalId: "principal_preview_atlas",
            principalName: nil,
            credentialId: "credential_preview_phone",
            grantId: "grant_preview_01",
            explicitKey: "workflow:weekly-digest",
            heuristicKey: "principal_preview_atlas|credential_preview_phone",
            createdAt: 1_786_765_800_000,
            lastEventAt: 1_786_765_860_000,
            eventCount: 1
        ),
        DirectAuditSessionSummary(
            id: "direct_preview_03",
            ownerId: "owner_preview",
            principalId: "principal_preview_bex",
            principalName: "Bex",
            credentialId: "credential_preview_cli",
            grantId: "grant_preview_02",
            explicitKey: nil,
            heuristicKey: "principal_preview_bex|credential_preview_cli",
            createdAt: 1_786_679_400_000,
            lastEventAt: 1_786_679_470_000,
            eventCount: 12
        ),
        DirectAuditSessionSummary(
            id: "direct_preview_04",
            ownerId: "owner_preview",
            principalId: "principal_preview_bex",
            principalName: "Bex",
            credentialId: "credential_preview_cli",
            grantId: "grant_preview_02",
            explicitKey: "handoff:preview-handoff",
            heuristicKey: "principal_preview_bex|credential_preview_cli",
            createdAt: 1_786_593_000_000,
            lastEventAt: 1_786_593_060_000,
            eventCount: 2
        ),
    ]

    /// The tool calls of the first Direct session, oldest first: a batch
    /// search, a person lookup, a failed SQL call, a URL lookup, a refused
    /// call with no recorded result, and a call from a future tool.
    static let directAuditSessionEvents: [DirectAuditEventSummary] = [
        DirectAuditEventSummary(
            sequence: 1,
            id: "direct_event_preview_01",
            sessionId: "direct_preview_01",
            tool: "search_many",
            outcome: .ok,
            requestId: "request_preview_01",
            display: DirectAuditEventDisplay(title: "search_many"),
            payloadTruncated: false,
            payloadBytes: 812,
            originalPayloadBytes: 812,
            createdAt: 1_786_852_201_000
        ),
        DirectAuditEventSummary(
            sequence: 2,
            id: "direct_event_preview_02",
            sessionId: "direct_preview_01",
            tool: "lookup_people",
            outcome: .ok,
            requestId: "request_preview_02",
            display: DirectAuditEventDisplay(title: "lookup_people"),
            payloadTruncated: false,
            payloadBytes: 640,
            originalPayloadBytes: 640,
            createdAt: 1_786_852_240_000
        ),
        DirectAuditEventSummary(
            sequence: 3,
            id: "direct_event_preview_03",
            sessionId: "direct_preview_01",
            tool: "run_sql",
            outcome: .failed,
            requestId: "request_preview_03",
            display: DirectAuditEventDisplay(title: "run_sql"),
            payloadTruncated: false,
            payloadBytes: 320,
            originalPayloadBytes: 320,
            createdAt: 1_786_852_255_000
        ),
        DirectAuditEventSummary(
            sequence: 4,
            id: "direct_event_preview_04",
            sessionId: "direct_preview_01",
            tool: "lookup_document_by_url",
            outcome: .ok,
            requestId: "request_preview_04",
            display: DirectAuditEventDisplay(title: "lookup_document_by_url"),
            payloadTruncated: true,
            payloadBytes: 190,
            originalPayloadBytes: 200_192,
            createdAt: 1_786_852_266_000
        ),
        DirectAuditEventSummary(
            sequence: 5,
            id: "direct_event_preview_05",
            sessionId: "direct_preview_01",
            tool: "fetch_many",
            outcome: .refused,
            requestId: "request_preview_05",
            display: DirectAuditEventDisplay(title: "fetch_many"),
            payloadTruncated: false,
            payloadBytes: 96,
            originalPayloadBytes: 96,
            createdAt: 1_786_852_277_000
        ),
    ]

    /// The fetched args/result records behind the transcript preview: a
    /// settled search batch (one hit child, one failed child), a person
    /// match, a SQL failure, a URL match, and a refused call whose record
    /// carries no result.
    static let directAuditPayloads: [String: JSONValue] = [
        "direct_event_preview_01": .object([
            "tool": .string("search_many"),
            "args": .object([
                "queries": .array([
                    .object(["query": .string("marathon training plan")]),
                    .object(["query": .string("venue deposit")]),
                ]),
            ]),
            "result": .object([
                "kind": .string("search.batch"),
                "items": .array([
                    .object([
                        "kind": .string("search.results"),
                        "query": .string("marathon training plan"),
                        "results": .array([
                            .object([
                                "documentId": .string("doc_preview_spring"),
                                "sourceType": .string("notes"),
                                "sourceId": .string("notes"),
                                "title": .string("Spring training notes"),
                            ]),
                            .object([
                                "documentId": .string("doc_preview_venue"),
                                "sourceType": .string("email"),
                                "sourceId": .string("gmail"),
                                "title": .string("Venue plan from Stellar Sound"),
                            ]),
                        ]),
                    ]),
                    .object([
                        "kind": .string("error"),
                        "code": .string("search_failed"),
                        "message": .string("Search failed."),
                    ]),
                ]),
            ]),
            "outcome": .string("ok"),
        ]),
        "direct_event_preview_02": .object([
            "tool": .string("lookup_people"),
            "args": .object(["name": .string("Maya Reeves")]),
            "result": .object([
                "kind": .string("person.results"),
                "query": .string("Maya Reeves"),
                "results": .array([
                    .object([
                        "canonicalId": .string("person_preview_maya"),
                        "displayName": .string("Maya Reeves"),
                        "aliases": .array([.string("maya.reeves@example.com")]),
                    ]),
                ]),
            ]),
            "outcome": .string("ok"),
        ]),
        "direct_event_preview_03": .object([
            "tool": .string("run_sql"),
            "args": .object(["sql": .string("SELECT metric FROM health WHERE day = 'oops'")]),
            "result": .object([
                "kind": .string("error"),
                "code": .string("sql_failed"),
                "message": .string("Table health_metrics does not exist."),
            ]),
            "outcome": .string("failed"),
        ]),
        "direct_event_preview_04": .object([
            "tool": .string("lookup_document_by_url"),
            "args": .object(["url": .string("https://example.com/venue-plan")]),
            "result": .object([
                "kind": .string("document.byUrl"),
                "url": .string("https://example.com/venue-plan"),
                "ref": .object([
                    "documentId": .string("doc_preview_venue"),
                    "sourceType": .string("email"),
                    "sourceId": .string("gmail"),
                    "title": .string("Venue plan from Stellar Sound"),
                ]),
            ]),
            "outcome": .string("ok"),
        ]),
        "direct_event_preview_05": .object([
            "tool": .string("fetch_many"),
            "args": .object([
                "documents": .array([
                    .object(["documentId": .string("doc_preview_spring")]),
                ]),
            ]),
            "outcome": .string("refused"),
        ]),
    ]

    /// The sentinel stored when a call's values exceeded the size cap.
    static let directAuditTruncatedPayload = JSONValue.object([
        "truncated": .bool(true),
        "reason": .string("tool_payload_limit"),
        "originalBytes": .int(200_192),
        "sha256": .string("preview-digest"),
    ])

    /// Static card contents for the card previews: search, person and SQL
    /// cards built through the same mapping the transcript uses.
    static let directSearchCard = directCardContent(
        tool: "search_many",
        record: directAuditPayloads["direct_event_preview_01"]
    )
    static let directPeopleCard = directCardContent(
        tool: "lookup_people",
        record: directAuditPayloads["direct_event_preview_02"]
    )
    static let directSqlCard = directCardContent(
        tool: "run_sql",
        record: .object([
            "tool": .string("run_sql"),
            "args": .object(["sql": .string("SELECT day, resting_hr FROM health ORDER BY day")]),
            "result": .object([
                "kind": .string("sql.rows"),
                "sql": .string("SELECT day, resting_hr FROM health ORDER BY day"),
                "columns": .array([.string("day"), .string("resting_hr")]),
                "rows": .array([
                    .array([.string("2026-09-01"), .int(58)]),
                    .array([.string("2026-09-02"), .int(61)]),
                ]),
                "rowCount": .int(2),
            ]),
            "outcome": .string("ok"),
        ])
    )
    static let directErrorCard = directCardContent(
        tool: "run_sql",
        record: directAuditPayloads["direct_event_preview_03"]
    )
    static let directEmptyCard = directCardContent(
        tool: "lookup_people",
        record: .object([
            "tool": .string("lookup_people"),
            "args": .object(["name": .string("Mendez")]),
            "result": .object([
                "kind": .string("person.results"),
                "query": .string("Mendez"),
                "results": .array([]),
            ]),
            "outcome": .string("ok"),
        ])
    )
    static let directUnknownToolCard = directCardContent(
        tool: "future_tool",
        record: .object([
            "tool": .string("future_tool"),
            "args": .object([:]),
            "result": .object([
                "kind": .string("future.kind"),
                "data": .string("preview"),
            ]),
            "outcome": .string("ok"),
        ])
    )

    /// Two stored local-generation attempts behind one exchange: the first
    /// mixes a search call with a settled citation (silent), a text part
    /// (shown elsewhere), and two malformed parts (skipped); the second is a
    /// truncated document fetch. All people, places, and documents invented.
    static let privacyAgentTraces: [PrivacyAgentTrace] = [
        PrivacyAgentTrace(
            attempt: 1,
            provider: "anthropic",
            model: "claude-preview-large",
            sessionId: "trace_session_preview_01",
            messages: [
                PrivacyAgentTraceMessage(
                    role: "assistant",
                    parts: [
                        .object([
                            "kind": .string("text"),
                            "text": .string("I'll search the corpus first."),
                        ]),
                        .object([
                            "kind": .string("tool_use"),
                            "toolCallId": .string("call_preview_01"),
                            "tool": .string("search_documents"),
                            "args": .object(["query": .string("marathon training plan")]),
                        ]),
                        .object([
                            "kind": .string("tool_result"),
                            "toolCallId": .string("call_preview_01"),
                            "result": .object([
                                "kind": .string("search.results"),
                                "query": .string("marathon training plan"),
                                "results": .array([
                                    .object([
                                        "documentId": .string("doc_preview_spring"),
                                        "sourceType": .string("notes"),
                                        "sourceId": .string("notes"),
                                        "title": .string("Spring training notes"),
                                    ]),
                                ]),
                            ]),
                        ]),
                        .object([
                            "kind": .string("tool_use"),
                            "toolCallId": .string("call_preview_02"),
                            "tool": .string("annotate"),
                            "args": .object(["documentId": .string("doc_preview_spring")]),
                        ]),
                        .object([
                            "kind": .string("tool_result"),
                            "toolCallId": .string("call_preview_02"),
                            "result": .object([
                                "kind": .string("annotate.recorded"),
                                "documentId": .string("doc_preview_spring"),
                            ]),
                        ]),
                        .object(["tool": .string("search_documents")]),
                        .string("not a part"),
                    ]
                ),
                PrivacyAgentTraceMessage(
                    role: "user",
                    parts: [
                        .object([
                            "kind": .string("text"),
                            "text": .string("When is the venue deposit due?"),
                        ]),
                    ]
                ),
            ],
            terminalStopReason: "end_turn",
            createdAt: 1_786_852_200_000
        ),
        PrivacyAgentTrace(
            attempt: 2,
            provider: "anthropic",
            model: "claude-preview-large",
            sessionId: "trace_session_preview_02",
            messages: [
                PrivacyAgentTraceMessage(
                    role: "assistant",
                    parts: [
                        .object([
                            "kind": .string("tool_use"),
                            "toolCallId": .string("call_preview_03"),
                            "tool": .string("fetch_document"),
                            "args": .object(["documentId": .string("doc_preview_venue")]),
                        ]),
                        .object([
                            "kind": .string("tool_result"),
                            "toolCallId": .string("call_preview_03"),
                            "result": .object([
                                "kind": .string("document"),
                                "ref": .object([
                                    "documentId": .string("doc_preview_venue"),
                                    "sourceType": .string("email"),
                                    "sourceId": .string("gmail"),
                                    "title": .string("Venue plan from Stellar Sound"),
                                ]),
                            ]),
                        ]),
                    ]
                ),
            ],
            terminalStopReason: "end_turn",
            createdAt: 1_786_852_210_000,
            truncated: true,
            omittedParts: 2
        ),
    ]

    /// A pending exchange carrying stored agent transcripts plus one omitted
    /// attempt, so the attempt sections render with their notes.
    static let privacyExchangeWithTraces = PrivacyExchangePresentation(
        taskId: "task_preview_traces",
        conversationId: privacyApprovalDetail.conversationId,
        workflowId: privacyApprovalDetail.workflowId,
        externalAgent: privacyExternalAgent,
        workflow: PrivacyExchangeWorkflow(
            name: privacyApprovalDetail.workflowName,
            purpose: "Compare travel options and prepare a draft itinerary."
        ),
        question: "When is the venue deposit due, and where is the proposed meeting?",
        status: .approvalRequired,
        outcome: .needsReview,
        createdAt: 1_786_852_200_000,
        resolvedAt: nil,
        sharedAnswer: nil,
        pendingCandidate: "The deposit is due Friday. The proposed meeting is at 42 Example Street.",
        reductions: [],
        approval: PrivacyExchangeApproval(
            id: privacyApprovalDetail.id,
            status: .pending,
            expiresAt: privacyApprovalDetail.expiresAt,
            resolvedAt: nil
        ),
        userDecision: nil,
        review: PrivacyExchangeReview(
            fallbackCause: .policyRequiresReview,
            findings: [],
            rationale: "Review required."
        ),
        agentTraces: privacyAgentTraces,
        agentTraceOmittedAttempts: 1
    )

    /// The longest principal name accepted by the authorization flow, paired
    /// with a reduced release so the compact feed must accommodate both the
    /// actor sentence and its name-aware outcome at accessibility sizes.
    private static let privacyExtremePrincipalName =
        "Example principal with an intentionally long display name for accessibility "
            + "layout verification in compact privacy views"

    static let privacyExtremePrincipalExchange = PrivacyExchangePresentation(
        taskId: "task_preview_extreme_principal",
        conversationId: "conversation_preview_extreme_principal",
        workflowId: "workflow_extreme_principal",
        externalAgent: PrivacyExternalAgent(
            displayName: privacyExtremePrincipalName,
            narrativeName: privacyExtremePrincipalName,
            integrationSlug: nil,
            connectionName: "Accessibility preview connection",
            source: .principal
        ),
        workflow: PrivacyExchangeWorkflow(
            name: "Prepare a planning summary",
            purpose: "Summarize fictional project updates for a planning document."
        ),
        question: "Which project milestones changed this week?",
        status: .releasedWithReductions,
        outcome: .sharedWithReductions,
        createdAt: 1_786_679_400_000,
        resolvedAt: 1_786_679_404_000,
        sharedAt: 1_786_679_405_000,
        sharedAnswer: "Two fictional milestones moved to next week.",
        pendingCandidate: nil,
        reductions: ["Removed exact dates"],
        approval: nil,
        userDecision: nil,
        review: PrivacyExchangeReview(
            fallbackCause: nil,
            findings: [],
            rationale: "The released answer contains only a broad summary."
        )
    )

    /// A second workflow, so the feed carries more than one.
    static let privacyBudgetExchange = PrivacyExchangePresentation(
        taskId: "task_preview_budget",
        conversationId: "conversation_preview_audit_02",
        workflowId: "workflow_budget_summary",
        externalAgent: PrivacyExternalAgent(displayName: "Ledgerbot (hermes)", source: .token),
        workflow: PrivacyExchangeWorkflow(
            name: "Prepare a budget summary",
            purpose: "Summarize quarterly spending for a planning document."
        ),
        question: "What were the largest spending categories this quarter?",
        status: .released,
        outcome: .shared,
        createdAt: 1_786_679_400_000,
        resolvedAt: 1_786_679_404_000,
        sharedAt: 1_786_679_405_000,
        sharedAnswer: "The largest categories were travel, equipment, and training.",
        pendingCandidate: nil,
        reductions: [],
        approval: nil,
        userDecision: nil,
        review: PrivacyExchangeReview(
            fallbackCause: nil,
            findings: [],
            rationale: "Category totals carry no exact figures, so the policy allowed them."
        )
    )

    /// What the Activity pane says right after the operator shares an answer.
    static let privacyApprovedResolution = privacyResolutionCopy(
        PrivacyApprovalResolution(
            status: .released,
            workflowId: privacyApprovalDetail.workflowId,
            conversationId: privacyApprovalDetail.conversationId,
            taskId: privacyApprovalDetail.taskId,
            releaseId: "release_preview_approved",
            answer: nil,
            reductions: nil,
            reason: nil
        ),
        agentName: externalAgentNarrativeName(privacyExternalAgent)
    )
}

#endif
