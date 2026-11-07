// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension PreviewMocks {
    /// Each example mirrors one source-owned declaration; no provider combines these kinds.
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
    static let scopeEditorReadiness = scopeGmailContract.items.map { ScopeKindReadiness(kind: $0.kind, ready: true) }

    static var scopeEditorSource: AccessSourceInstance {
        var source = AccessSourceInstance(id: "gmail:mail@example.org", name: "Gmail · mail@example.org")
        source.sourceType = "gmail"
        source.scopes = scopeGmailContract
        source.scopeReadiness = scopeEditorReadiness
        return source
    }

    static var scopeFolderSource: AccessSourceInstance {
        var source = AccessSourceInstance(id: "google-drive:files@example.org", name: "Google Drive · files@example.org")
        source.sourceType = "google-drive"
        source.scopes = scopeDriveContract
        source.scopeReadiness = [.init(kind: "folder", ready: true)]
        return source
    }

    static var scopeParticipantSource: AccessSourceInstance {
        var source = AccessSourceInstance(id: "whatsapp-messages:+15550100111", name: "WhatsApp · +1 (555) 010-0111")
        source.sourceType = "whatsapp-messages"
        source.scopes = scopeWhatsappContract
        source.scopeReadiness = scopeWhatsappContract.items.map { .init(kind: $0.kind, ready: true) }
        return source
    }

    static let scopeEditorRefs: [ScopeRef] = [
        .init(kind: "label", id: "Label_design", label: "Design"),
        .init(kind: "participant", label: "Jamie Lopez", identifiers: [.init(type: "email", value: "jamie@example.org")]),
    ]
    static let scopeEditorPolicy = ScopePolicy(
        sourceId: scopeEditorSource.id,
        audience: .init(accessLevel: "scope-level", capability: "answer"),
        rules: [.init(match: scopeEditorRefs, action: "hide")],
        otherwise: "share"
    )
    static let scopeEditorPreview = ScopePreview(
        sourceId: scopeEditorSource.id,
        total: 120,
        visible: 83,
        hidden: 37,
        unknown: 4,
        items: [
            .init(ref: scopeEditorRefs[0], label: "Design", count: 24),
            .init(ref: scopeEditorRefs[1], label: "Jamie Lopez", count: 17),
        ],
        samples: [
            .init(documentId: "example-visible", title: "Project outline", visible: true, unknown: false),
            .init(documentId: "example-hidden", title: "Design draft", visible: false, unknown: false),
            .init(documentId: "example-unknown", title: "Item awaiting metadata", visible: false, unknown: true),
        ],
        identifierProposals: [.init(
            itemIndex: 1,
            label: "Jamie Lopez",
            identifiers: [.init(type: "email", value: "jamie.work@example.org")]
        )],
        readiness: scopeEditorReadiness
    )

    static let scopeFolderOptions = ScopeOptions(
        sourceId: scopeFolderSource.id,
        sourceType: "google-drive",
        scopes: scopeDriveContract,
        readiness: [.init(kind: "folder", ready: true)],
        items: [
            .init(ref: .init(kind: "folder", id: "projects", label: "Projects"), label: "Projects", count: 18, hasChildren: true),
            .init(ref: .init(kind: "folder", id: "archive", label: "Archive"), label: "Archive", count: 9),
        ]
    )

    static var scopeEditorOverview: AccessOverview {
        let sources = [scopeEditorSource, scopeFolderSource, scopeParticipantSource]
        let drivePolicy = ScopePolicy(
            sourceId: scopeFolderSource.id,
            audience: .init(accessLevel: "scope-level", capability: "answer"),
            rules: [.init(match: [scopeFolderOptions.items[0].ref], action: "share")],
            otherwise: "hide"
        )
        let conversation = ScopeRef(kind: "conversation", id: "conversation-example", label: "Workshop planning")
        let whatsappPolicy = ScopePolicy(
            sourceId: scopeParticipantSource.id,
            audience: .init(accessLevel: "scope-level", capability: "answer"),
            rules: [.init(match: [conversation], action: "hide")],
            otherwise: "share"
        )
        var overview = AccessOverview(
            principals: [],
            sources: sources,
            policyFamilies: accessOverview.policyFamilies,
            defaultPolicyFamilyId: accessOverview.defaultPolicyFamilyId,
            levels: [AccessLevelSummary(
                id: "scope-level",
                name: "Research assistant",
                revision: 4,
                rules: [
                    .answer(
                        sources: .init(mode: .allowlist, sourceIds: sources.map(\.id)),
                        release: .unreviewed,
                        filterRevision: 3,
                        scopePolicies: [scopeEditorPolicy, drivePolicy, whatsappPolicy]
                    ),
                    .direct(sources: .init(mode: .allowlist, sourceIds: [scopeEditorSource.id])),
                ],
                connectionCount: 2,
                createdAt: 1,
                updatedAt: 2
            )]
        )
        overview.sourceFilters = .init(enabled: true)
        return overview
    }

    static var scopeReadOnlyOverview: AccessOverview {
        var overview = scopeEditorOverview
        overview.sourceFilters = .init(enabled: false)
        return overview
    }

    static var scopePreparingPreview: ScopePreview {
        var preview = scopeEditorPreview
        preview.readiness = [
            .init(kind: "participant", ready: true),
            .init(kind: "label", ready: false, reason: "metadata-refresh", message: "Preparing label filters", processed: 120, pending: 30),
        ]
        return preview
    }
}
#endif
