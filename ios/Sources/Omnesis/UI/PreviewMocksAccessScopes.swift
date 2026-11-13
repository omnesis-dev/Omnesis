// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The one set of example data every access preview and gallery render draws: two access levels, three
/// source accounts, their saved filters, and an agent asking to connect.
@available(iOS 17.0, *)
extension PreviewMocks {
    /// The fields each canonical account offers, as each source declares them.
    static let accessPeopleByEmail = FilterEditorField(
        field: FilterEditorField.peopleField,
        capability: "person",
        noun: .init(one: "person", many: "people"),
        picker: "search",
        identifiers: ["email", "domain"]
    )
    static let accessPeopleByPhone = FilterEditorField(
        field: FilterEditorField.peopleField,
        capability: "person",
        noun: .init(one: "person", many: "people"),
        picker: "search",
        identifiers: ["phone"]
    )
    static let accessChatField = "extra.chatJid"
    static let accessLabelField = "extra.labelIds"
    static let accessFolderField = "extra.folderIds"

    /// A field shown as a tree whose every level is called the same: labels inside labels, folders inside folders.
    private static func treeField(_ field: String, _ noun: FilterNoun, state: FilterFieldState = .ready) -> FilterEditorField {
        FilterEditorField(
            field: field,
            capability: "tree",
            noun: noun,
            levels: [noun],
            inside: noun,
            insideText: "Includes the \(noun.many) inside.",
            picker: "tree",
            state: state
        )
    }

    private static func account(_ id: String, _ name: String, type: String) -> AccessSourceInstance {
        var source = AccessSourceInstance(id: id, name: name)
        source.sourceType = type
        source.filterable = true
        return source
    }

    static let accessGmail = account("gmail:reader@example.org", "Gmail · reader@example.org", type: "gmail")
    static let accessDrive = account("google-drive:reader@example.org", "Google Drive · reader@example.org", type: "google-drive")
    static let accessWhatsApp = account("whatsapp-messages:+15550100123", "WhatsApp · +1 (555) 010-0123", type: "whatsapp-messages")

    /// Gmail: people at once, labels once the account is resynced in place.
    static let accessGmailEditor = SourceFilterEditor(sourceId: accessGmail.id, sourceType: "gmail", fields: [
        accessPeopleByEmail,
        treeField(accessLabelField, .init(one: "label", many: "labels"), state: .needsResync(
            cost: "This reads about 75,000 messages a day.",
            text: "Label filters need Gmail to be resynced. Your mail stays searchable meanwhile. "
                + "This reads about 75,000 messages a day."
        )),
    ])
    static let accessDriveEditor = SourceFilterEditor(
        sourceId: accessDrive.id, sourceType: "google-drive", fields: [treeField(accessFolderField, .init(one: "folder", many: "folders"))]
    )
    /// Drive while it is resynced in place for its folders.
    static let accessDriveResyncingEditor = SourceFilterEditor(sourceId: accessDrive.id, sourceType: "google-drive", fields: [
        treeField(accessFolderField, .init(one: "folder", many: "folders"), state: .resyncing(
            processed: 212, total: 900, text: "Resyncing Google Drive: 212 of about 900."
        )),
    ])
    static let accessWhatsAppEditor = SourceFilterEditor(sourceId: accessWhatsApp.id, sourceType: "whatsapp-messages", fields: [
        FilterEditorField(field: accessChatField, capability: "membership", noun: .init(one: "chat", many: "chats"), picker: "search"),
        accessPeopleByPhone,
    ])

    static var accessEditors: [String: SourceFilterEditor] {
        [
            accessGmail.id: accessGmailEditor, accessDrive.id: accessDriveEditor, accessWhatsApp.id: accessWhatsAppEditor,
            accessSessions.id: accessSessionsEditor, accessRepositories.id: accessRepositoriesEditor,
        ]
    }

    /// The WhatsApp account once the gateway no longer lists it.
    static var accessDisconnectedWhatsApp: AccessSourceInstance {
        var source = AccessSourceInstance(id: accessWhatsApp.id, name: "WhatsApp", available: false)
        source.sourceType = "whatsapp-messages"
        return source
    }

    static let accessCanonicalLevelId = "level-research-assistant"

    static let accessConversations: [ScopeOption] = [
        ("chat-workshop-planning", "Workshop planning", 24), ("chat-weekend-hike", "Weekend hike", 12),
        ("chat-book-club", "Book club", 7),
    ]
    .map { .init(ref: .membership(field: accessChatField, id: $0.0), label: $0.1, count: $0.2) }

    static let accessPeople: [ScopeOption] = [
        ("Maya Reeves", "141", 17), ("Jamie Lopez", "142", 9), ("David Lin", "143", 6), ("Sarah Mendez", "144", 3),
    ]
    .map { name, suffix, count in
        .init(
            ref: .person(label: name, identifiers: [.init(type: "phone", value: "+15550100" + suffix)]),
            label: name,
            count: count
        )
    }

    static let accessRootFolders: [ScopeOption] = [
        .init(ref: .tree(field: accessFolderField, id: "folder-projects"), label: "Projects", count: 18, hasChildren: true, depth: 0),
        .init(ref: .tree(field: accessFolderField, id: "folder-archive"), label: "Archive", count: 9, depth: 0),
    ]

    static let accessProjectFolders: [ScopeOption] = [("plans", "Plans", 11), ("budgets", "Budgets", 5), ("reference", "Reference", 2)]
        .map {
            .init(
                ref: .tree(field: accessFolderField, id: "folder-" + $0.0),
                label: "Projects/" + $0.1,
                shortLabel: $0.1,
                count: $0.2,
                parentId: "folder-projects",
                depth: 1
            )
        }

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
        unmatched: 4,
        unmatchedText: "4 records can't be matched to a chat and stay hidden.",
        items: [
            .init(ref: accessConversations[0].ref, label: "Workshop planning", count: 24),
            .init(ref: accessPeople[0].ref, label: "Maya Reeves", count: 17),
        ]
    )

    /// Drive's Projects filter, with records too old for it and records it cannot place.
    static let accessDrivePreview = ScopePreview(
        sourceId: accessDrive.id,
        total: 120,
        visible: 18,
        hidden: 102,
        tooOld: 6,
        unmatched: 2,
        tooOldText: "6 older items could not be resynced and stay hidden from agents using this filter.",
        unmatchedText: "2 records can't be matched to a folder and stay hidden.",
        items: [.init(ref: accessRootFolders[0].ref, label: "Projects", count: 18)]
    )

    /// Answer's Drive and WhatsApp filters, as Direct holds them when it reads what Answer reads.
    static let accessDirectDrivePolicy = policy(accessDrive, [accessRootFolders[0].ref], share: true, capability: "direct")
    static let accessDirectWhatsAppPolicy = policy(
        accessWhatsApp, [accessConversations[0].ref, accessPeople[0].ref], share: false, capability: "direct"
    )

    /// Names and match counts for every item the fixtures select, keyed by capability and account.
    static var accessCanonicalLabels: [String: [ScopeItemHint]] {
        let drive = [ScopeItemHint(ref: accessRootFolders[0].ref, label: "Projects", count: 18, noun: "folder")]
        let whatsApp = [ScopeItemHint(ref: accessConversations[0].ref, label: "Workshop planning", count: 24, noun: "chat")]
            + accessPeople.prefix(2).map { ScopeItemHint(ref: $0.ref, label: $0.label, count: $0.count, noun: "person") }
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

    private static func options(_ source: AccessSourceInstance, field: String, _ items: [ScopeOption]) -> ScopeOptions {
        ScopeOptions(sourceId: source.id, field: field, items: items)
    }

    static let accessRootFolderOptions = options(accessDrive, field: accessFolderField, accessRootFolders)

    /// The folder picker opened one level down, inside Projects.
    static var accessFolderSession: ScopePickerSession {
        var session = ScopePickerSession(field: accessFolderField, sourceId: accessDrive.id)
        session.catalogues[session.location(for: accessDrive.id)] = accessRootFolderOptions
        session.open(accessRootFolders[0])
        session.catalogues[session.location(for: accessDrive.id)] = options(accessDrive, field: accessFolderField, accessProjectFolders)
        return session
    }

    /// The picker listing the people of the messaging account, with its chats one tab away.
    static var accessPeopleSession: ScopePickerSession {
        var session = ScopePickerSession(field: accessChatField, sourceId: accessWhatsApp.id)
        session.catalogues[session.location(for: accessWhatsApp.id)] = options(accessWhatsApp, field: accessChatField, accessConversations)
        session.field = FilterEditorField.peopleField
        session.identifierType = "phone"
        session.catalogues[session.location(for: accessWhatsApp.id)] = options(
            accessWhatsApp, field: FilterEditorField.peopleField, accessPeople
        )
        return session
    }

    /// The Gmail picker on its labels, which wait for a resync.
    static var accessLabelSession: ScopePickerSession {
        ScopePickerSession(field: accessLabelField, sourceId: accessGmail.id)
    }

    /// The Drive picker on its folders, while Drive resyncs.
    static var accessDriveFolderSession: ScopePickerSession {
        ScopePickerSession(field: accessFolderField, sourceId: accessDrive.id)
    }
}
#endif
