// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The one set of example data every access preview and gallery render draws: two access levels, three
/// source accounts, their saved filters, and an agent asking to connect.
@available(iOS 17.0, *)
extension PreviewMocks {
    /// Each contract mirrors one source-owned declaration; no provider combines these kinds.
    static let scopeGmailContract = SourceScopes(revision: 2, items: [
        .init(kind: "participant", identifiers: ["email", "domain"], link: "fixed"),
        .init(kind: "label", noun: .init(one: "label", many: "labels"), picker: "search", link: "changes"),
    ])
    static let scopeWhatsappContract = SourceScopes(revision: 2, items: [
        .init(kind: "conversation", noun: .init(one: "conversation", many: "conversations"), picker: "search", link: "fixed"),
        .init(kind: "participant", identifiers: ["phone"], link: "changes"),
    ])
    static let scopeDriveContract = SourceScopes(revision: 3, items: [
        .init(kind: "folder", noun: .init(one: "folder", many: "folders"), picker: "tree", link: "hierarchy"),
    ])

    private static func account(_ id: String, _ name: String, type: String, scopes: SourceScopes) -> AccessSourceInstance {
        var source = AccessSourceInstance(id: id, name: name)
        source.sourceType = type
        source.scopes = scopes
        source.scopeReadiness = scopes.items.map { .init(kind: $0.kind, ready: true) }
        return source
    }

    static let accessGmail = account("gmail:reader@example.org", "Gmail · reader@example.org", type: "gmail", scopes: scopeGmailContract)
    static let accessDrive = account(
        "google-drive:reader@example.org", "Google Drive · reader@example.org", type: "google-drive", scopes: scopeDriveContract
    )
    static let accessWhatsApp = account(
        "whatsapp-messages:+15550100123", "WhatsApp · +1 (555) 010-0123", type: "whatsapp-messages", scopes: scopeWhatsappContract
    )

    /// The WhatsApp account once the gateway no longer lists it.
    static var accessDisconnectedWhatsApp: AccessSourceInstance {
        var source = AccessSourceInstance(id: accessWhatsApp.id, name: "WhatsApp", available: false)
        source.sourceType = "whatsapp-messages"
        return source
    }

    static let accessCanonicalLevelId = "level-research-assistant"

    static let accessConversations: [ScopeOption] = [
        ("workshop", "Workshop planning", 24), ("hike", "Weekend hike", 12), ("books", "Book club", 7),
    ]
    .map { .init(ref: .init(kind: "conversation", id: "conversation-" + $0.0), label: $0.1, count: $0.2) }

    static let accessPeople: [ScopeOption] = [
        ("Maya Reeves", "141", 17), ("Jamie Lopez", "142", 9), ("David Lin", "143", 6), ("Sarah Mendez", "144", 3),
    ]
    .map { name, suffix, count in
        .init(
            ref: .init(kind: "participant", label: name, identifiers: [.init(type: "phone", value: "+15550100" + suffix)]),
            label: name,
            count: count
        )
    }

    static let accessRootFolders: [ScopeOption] = [
        .init(ref: .init(kind: "folder", id: "projects"), label: "Projects", count: 18, hasChildren: true),
        .init(ref: .init(kind: "folder", id: "archive"), label: "Archive", count: 9),
    ]

    static let accessProjectFolders: [ScopeOption] = [("plans", "Plans", 11), ("budgets", "Budgets", 5), ("reference", "Reference", 2)]
        .map { .init(ref: .init(kind: "folder", id: "projects-" + $0.0), label: $0.1, count: $0.2, parentId: "projects") }

    private static func policy(
        _ source: AccessSourceInstance,
        _ refs: [ScopeRef],
        share: Bool,
        level: String = accessCanonicalLevelId,
        capability: String = "answer"
    )
        -> ScopePolicy {
        ScopePolicy(
            sourceId: source.id,
            audience: .init(accessLevel: level, capability: capability),
            rules: [.init(match: refs, action: share ? "share" : "hide")],
            otherwise: share ? "hide" : "share"
        )
    }

    /// Google Drive shares only the Projects folder.
    static let accessDrivePolicy = policy(accessDrive, [accessRootFolders[0].ref], share: true)
    /// WhatsApp shares everything except one conversation and one person.
    static let accessWhatsAppPolicy = policy(accessWhatsApp, [accessConversations[0].ref, accessPeople[0].ref], share: false)
    /// The WhatsApp filter after dropping the conversation and adding a second person.
    static let accessWhatsAppChangedPolicy = policy(accessWhatsApp, [accessPeople[0].ref, accessPeople[1].ref], share: false)

    static let accessWhatsAppPreview = ScopePreview(
        sourceId: accessWhatsApp.id,
        total: 120,
        visible: 83,
        hidden: 37,
        unknown: 4,
        items: [
            .init(ref: accessConversations[0].ref, label: "Workshop planning", count: 24),
            .init(ref: accessPeople[0].ref, label: "Maya Reeves", count: 17),
        ],
        samples: [
            .init(documentId: "example-shared", title: "Weekend hike", visible: true, unknown: false),
            .init(documentId: "example-hidden", title: "Workshop planning", visible: false, unknown: false),
        ],
        readiness: scopeWhatsappContract.items.map { .init(kind: $0.kind, ready: true) }
    )

    /// Answer's Drive and WhatsApp filters, as Direct holds them when it reads what Answer reads.
    static let accessDirectDrivePolicy = policy(accessDrive, [accessRootFolders[0].ref], share: true, capability: "direct")
    static let accessDirectWhatsAppPolicy = policy(
        accessWhatsApp, [accessConversations[0].ref, accessPeople[0].ref], share: false, capability: "direct"
    )

    /// Names and match counts for every item the fixtures select, keyed by capability and account.
    static var accessCanonicalLabels: [String: [ScopePreview.Item]] {
        let drive: [ScopePreview.Item] = [.init(ref: accessRootFolders[0].ref, label: "Projects", count: 18)]
        let whatsApp: [ScopePreview.Item] = (accessConversations.prefix(1) + accessPeople.prefix(2))
            .map { .init(ref: $0.ref, label: $0.label, count: $0.count) }
        return [
            "answer:" + accessDrive.id: drive, "answer:" + accessWhatsApp.id: whatsApp,
            "direct:" + accessDrive.id: drive, "direct:" + accessWhatsApp.id: whatsApp,
        ]
    }

    /// What each fixture filter leaves shared and hidden.
    static var accessCanonicalTotals: [ScopePolicy: AccessFilterTotals] {
        [
            canonicalAccessPolicy(accessDrivePolicy): .init(shared: 18, hidden: 102),
            canonicalAccessPolicy(accessWhatsAppPolicy): .init(shared: 83, hidden: 37),
            canonicalAccessPolicy(accessWhatsAppChangedPolicy): .init(shared: 98, hidden: 22),
            canonicalAccessPolicy(accessDirectDrivePolicy): .init(shared: 18, hidden: 102),
            canonicalAccessPolicy(accessDirectWhatsAppPolicy): .init(shared: 83, hidden: 37),
        ]
    }

    static let accessCanonicalPolicyFamily = AccessPolicyFamilySummary(
        id: "policy-everyday", name: "Everyday privacy", revision: "policy-version-4"
    )

    /// "Research assistant", used by two connections and one integration, and "Notes capture", which nothing uses.
    static var accessCanonicalOverview: AccessOverview {
        accessOverview(direct: .direct(sources: .init(mode: .allowlist, sourceIds: [accessGmail.id])))
    }

    /// The canonical overview with "Research assistant"'s Direct reading the accounts and filters its Answer reads.
    static var accessDirectAsAnswerOverview: AccessOverview {
        accessOverview(direct: .direct(
            sources: .init(mode: .allowlist, sourceIds: [accessGmail.id, accessDrive.id, accessWhatsApp.id]),
            scopePolicies: [accessDirectDrivePolicy, accessDirectWhatsAppPolicy]
        ))
    }

    private static func accessOverview(direct: AccessGrantRule) -> AccessOverview {
        let sources = [accessGmail, accessDrive, accessWhatsApp]
        let research = AccessLevelSummary(
            id: accessCanonicalLevelId,
            name: "Research assistant",
            revision: 4,
            rules: [
                .answer(
                    sources: .init(mode: .allowlist, sourceIds: sources.map(\.id)),
                    release: .reviewed(policyFamilyId: accessCanonicalPolicyFamily.id),
                    filterRevision: 3,
                    scopePolicies: [accessDrivePolicy, accessWhatsAppPolicy]
                ),
                direct,
            ],
            connectionCount: 2,
            devices: [.init(id: "device-speaker", name: "Kitchen speaker", kind: "agent")],
            createdAt: 1,
            updatedAt: 2
        )
        let notes = AccessLevelSummary(
            id: "level-notes-capture",
            name: "Notes capture",
            revision: 1,
            rules: [.notes],
            connectionCount: 0,
            devices: [],
            createdAt: 1,
            updatedAt: 2
        )
        let principals = [("aurora", "Aurora Planner"), ("northstar", "Northstar Assistant")].map { id, name in
            AccessPrincipalSummary(
                id: "principal-" + id,
                name: name,
                kind: "interactive",
                grants: [AccessGrantSummary(
                    id: "grant-" + id,
                    name: name + " access",
                    revision: 1,
                    rules: research.rules,
                    credentials: [],
                    expiresAt: nil,
                    revokedAt: nil,
                    levelId: research.id
                )],
                revokedAt: nil
            )
        }
        var overview = AccessOverview(
            principals: principals,
            sources: sources,
            policyFamilies: [accessCanonicalPolicyFamily],
            defaultPolicyFamilyId: accessCanonicalPolicyFamily.id,
            levels: [research, notes]
        )
        overview.sourceFilters = .init(enabled: true)
        return overview
    }

    /// The same overview from a gateway that does not offer filter editing.
    static var scopeReadOnlyOverview: AccessOverview {
        var overview = accessCanonicalOverview
        overview.sourceFilters = .init(enabled: false)
        return overview
    }

    /// The agent asking to connect: it wants Answer and Direct, and its request stands for nine more minutes.
    static let accessCanonicalRequest = AccessAuthorizationRequest(
        id: "authorization-northstar",
        approvalId: "approval-northstar",
        status: "pending",
        clientId: "client-northstar",
        clientName: "Northstar Assistant",
        clientUri: "https://northstar-assistant.example.com",
        redirectOrigin: "http://127.0.0.1:49152",
        resource: "https://gateway.example.com/mcp",
        scope: "mcp answer direct",
        expiresAt: Int64((Date().timeIntervalSince1970 + 540) * 1000),
        requiresAnswer: false
    )

    static let accessCanonicalProposal = AccessConnectionProposal(
        defaultName: "Northstar Assistant", defaultLevelName: "Northstar Assistant", match: nil, recommended: .newLevel
    )

    /// A renamed level, for a review that shows one changed decision.
    static func accessNameChange(_ draft: inout AccessLevelDraft) {
        draft.name = "Updated helper"
    }

    /// Direct reading Answer's sources and filters rather than a list of its own.
    static func accessDirectLinked(_ draft: inout AccessLevelDraft) {
        draft.setDirectSameAsAnswer(true)
    }

    /// Direct switched off.
    static func accessDirectRemoved(_ draft: inout AccessLevelDraft) {
        draft.setEnabled("direct", false, overview: accessDirectAsAnswerOverview)
    }

    /// One account's filter changed: a conversation dropped and a person added.
    static func accessFilterChange(_ draft: inout AccessLevelDraft) {
        draft.setPolicy(accessWhatsAppChangedPolicy, sourceId: accessWhatsApp.id, capability: "answer")
    }

    /// A new level named "Shared helper": Answer reads what the saved level reads, and Direct reads the same.
    static func accessNewLevel(_ draft: inout AccessLevelDraft) {
        let overview = accessCanonicalOverview
        draft.name = "Shared helper"
        draft.setBoundary(.init(mode: .allowlist, sourceIds: overview.sources.map(\.id)), capability: "answer", authoringEnabled: true)
        draft.setPolicy(
            policy(accessDrive, accessDrivePolicy.rules[0].match, share: true, level: "new"),
            sourceId: accessDrive.id,
            capability: "answer"
        )
        draft.setPolicy(
            policy(accessWhatsApp, accessWhatsAppPolicy.rules[0].match, share: false, level: "new"),
            sourceId: accessWhatsApp.id,
            capability: "answer"
        )
        draft.setEnabled("direct", true, overview: overview)
    }

    private static func options(_ source: AccessSourceInstance, _ items: [ScopeOption]) -> ScopeOptions {
        ScopeOptions(
            sourceId: source.id,
            sourceType: source.sourceType ?? "",
            scopes: source.scopes ?? .init(items: []),
            readiness: (source.scopes?.items ?? []).map { .init(kind: $0.kind, ready: true) },
            items: items
        )
    }

    static let accessRootFolderOptions = options(accessDrive, accessRootFolders)

    /// The folder picker opened one level down, inside Projects.
    static var accessFolderSession: ScopePickerSession {
        var session = ScopePickerSession(kind: "folder", sourceId: accessDrive.id)
        session.catalogues[session.location(for: accessDrive.id)] = accessRootFolderOptions
        session.ancestors = [accessRootFolders[0]]
        session.parentId = accessRootFolders[0].ref.id
        session.catalogues[session.location(for: accessDrive.id)] = options(accessDrive, accessProjectFolders)
        return session
    }

    /// The picker listing the people of the messaging account, with its conversations one tab away.
    static var accessPeopleSession: ScopePickerSession {
        var session = ScopePickerSession(kind: "conversation", sourceId: accessWhatsApp.id)
        session.catalogues[session.location(for: accessWhatsApp.id)] = options(accessWhatsApp, accessConversations)
        session.kind = "participant"
        session.catalogues[session.location(for: accessWhatsApp.id)] = options(accessWhatsApp, accessPeople)
        return session
    }
}
#endif
