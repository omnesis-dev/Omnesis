// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Example data for the two kinds of tree a filter can browse beyond plain folders: a coding agent's
/// sessions by project folder on two devices, and repositories under their owners. Every name is invented.
@available(iOS 17.0, *)
extension PreviewMocks {
    static let accessProjectFolderField = "extra.projectFolder"
    static let accessRepositoryField = "extra.repositoryIds"

    private static func treeAccount(_ id: String, _ name: String, type: String) -> AccessSourceInstance {
        var source = AccessSourceInstance(id: id, name: name)
        source.sourceType = type
        source.filterable = true
        return source
    }

    static let accessSessions = treeAccount("claude-code:sessions", "Claude Code · Studio Mac, Travel laptop", type: "claude-code")
    static let accessRepositories = treeAccount("github:maya-reeves", "GitHub · maya-reeves", type: "github")

    static let accessStudioMac = FilterDevice(id: "device-studio-mac", name: "Studio Mac")
    static let accessTravelLaptop = FilterDevice(id: "device-travel-laptop", name: "Travel laptop")

    private static let projectFolderNoun = FilterNoun(one: "project folder", many: "project folders")

    /// Claude Code sessions by the folder each started in, on two devices.
    private static func sessionsEditor(_ state: FilterFieldState) -> SourceFilterEditor {
        SourceFilterEditor(
            sourceId: accessSessions.id,
            sourceType: "claude-code",
            devices: [accessStudioMac, accessTravelLaptop],
            showDeviceLevel: true,
            fields: [FilterEditorField(
                field: accessProjectFolderField,
                capability: "tree",
                noun: projectFolderNoun,
                levels: [projectFolderNoun],
                inside: projectFolderNoun,
                insideText: "Includes the project folders inside.",
                picker: "tree",
                scope: "device",
                state: state
            )]
        )
    }

    static let accessSessionsEditor = sessionsEditor(.ready)
    /// One of the devices runs an Omnesis too old to record project folders.
    static let accessSessionsBehindEditor = sessionsEditor(.collectorBehind(
        devices: [accessStudioMac], text: "Update Omnesis on Studio Mac to use these filters."
    ))

    static let accessRepositoriesEditor = SourceFilterEditor(sourceId: accessRepositories.id, sourceType: "github", fields: [
        FilterEditorField(
            field: accessRepositoryField,
            capability: "tree",
            noun: .init(one: "repository", many: "repositories"),
            levels: [.init(one: "owner", many: "owners"), .init(one: "repository", many: "repositories")],
            inside: .init(one: "repository", many: "repositories"),
            insideText: "Includes the repositories inside.",
            picker: "tree"
        ),
    ])

    /// The two devices at the top of the project-folder tree.
    static let accessSessionDevices = [(accessStudioMac, 46), (accessTravelLaptop, 12)].map { device, count in
        ScopeOption(
            ref: .tree(field: accessProjectFolderField, id: "", device: device.id),
            label: device.name,
            count: count,
            hasChildren: true
        )
    }

    private static func folder(
        _ path: String, _ count: Int, parent: String? = nil, children: Bool = false, depth: Int
    )
        -> ScopeOption {
        .init(
            ref: .tree(field: accessProjectFolderField, id: path, device: accessStudioMac.id),
            label: path,
            shortLabel: path == "~" ? path : String(path.split(separator: "/").last ?? ""),
            count: count,
            parentId: parent,
            hasChildren: children,
            depth: depth
        )
    }

    /// The home directory every session on the Studio Mac was run under, and the two folders inside it.
    static let accessHomeFolder = folder("~", 46, children: true, depth: 0)
    static let accessHomeFolders = [
        folder("~/work", 31, parent: "~", children: true, depth: 1),
        folder("~/personal", 15, parent: "~", children: true, depth: 1),
        folder("~/scratch", 0, parent: "~", depth: 1),
    ]

    private static func repository(
        _ id: String, _ label: String, _ count: Int, parent: String? = nil, children: Bool = false, depth: Int
    )
        -> ScopeOption {
        .init(
            ref: .tree(field: accessRepositoryField, id: id),
            label: label,
            shortLabel: String(label.split(separator: "/").last ?? ""),
            count: count,
            parentId: parent,
            hasChildren: children,
            depth: depth
        )
    }

    /// The organization that holds the work repositories, and those repositories.
    static let accessOwner = repository("owner:4101", "northstar-labs", 34, children: true, depth: 0)
    static let accessOwnerRepositories = [
        ("repo:5201", "northstar-labs/atlas-api", 19), ("repo:5202", "northstar-labs/atlas-api-docs", 6),
        ("repo:5203", "northstar-labs/billing-service", 9),
    ]
    .map { repository($0.0, $0.1, $0.2, parent: "owner:4101", depth: 1) }

    /// The picker of `source` opened along `path`, listing `children`.
    private static func treeSession(_ source: AccessSourceInstance, field: String, _ path: [ScopeOption], _ children: [ScopeOption])
        -> ScopePickerSession {
        var session = ScopePickerSession(field: field, sourceId: source.id)
        for item in path {
            session.open(item)
        }
        session.catalogues[session.location(for: source.id)] = ScopeOptions(sourceId: source.id, field: field, items: children)
        return session
    }

    /// The filter of a tree account sharing only `shared`, or a new one that names nothing yet: its choices opened
    /// along `path`, or its review.
    static func accessTreeFilter(
        _ source: AccessSourceInstance,
        editor: SourceFilterEditor,
        sharing shared: ScopeOption?,
        total: Int = 0,
        openAlong path: [ScopeOption]? = nil,
        listing children: [ScopeOption] = []
    )
        -> some View {
        let field = editor.fields[0]
        let preview = shared.map { shared in
            ScopePreview(
                sourceId: source.id,
                total: total,
                visible: shared.count ?? 0,
                hidden: total - (shared.count ?? 0),
                items: [.init(ref: shared.ref, label: shared.label, count: shared.count ?? 0, depth: shared.depth)]
            )
        }
        let hints = shared.map { shared in
            [ScopeItemHint(
                ref: shared.ref,
                label: shared.label,
                count: shared.count,
                noun: scopeFieldNoun(shared.ref, fields: editor.fields, depth: shared.depth)
            )]
        } ?? []
        return SourceFilterEditorView(
            source: source,
            levelId: accessCanonicalLevelId,
            capability: "answer",
            initialPolicy: accessSharingPolicy(source, shared.map { [$0.ref] } ?? []),
            authoringEnabled: true,
            editor: editor,
            preview: path == nil ? preview : nil,
            previewStep: path == nil ? .review : .matches,
            previewSession: path.map { treeSession(source, field: field.field, $0, children) } ?? .init(),
            displayHints: hints
        ) { _ in }
    }

    /// A filter of `source` that shares only `refs`; with none, a new filter that names nothing yet.
    static func accessSharingPolicy(_ source: AccessSourceInstance, _ refs: [ScopeRef]) -> ScopePolicy {
        ScopePolicy(
            sourceId: source.id,
            audience: .init(accessLevel: accessCanonicalLevelId, capability: "answer"),
            rules: [.init(match: refs, action: "share")],
            otherwise: "hide"
        )
    }

    /// The marks of the two tree accounts, so their renders need no network.
    static let accessTreeIcons: [String: String] = [
        "claude-code": "data:image/png;base64,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",
        "github": "data:image/png;base64,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",
    ]
}

#Preview("Choose project folders") {
    NavigationStack {
        PreviewMocks.accessTreeFilter(
            PreviewMocks.accessSessions,
            editor: PreviewMocks.accessSessionsEditor,
            sharing: PreviewMocks.accessHomeFolders[0],
            total: 46,
            openAlong: [PreviewMocks.accessSessionDevices[0], PreviewMocks.accessHomeFolder],
            listing: PreviewMocks.accessHomeFolders
        )
    }.environment(AppStore.preview(sourceIconByType: PreviewMocks.accessTreeIcons))
}

#Preview("Choose repositories") {
    NavigationStack {
        PreviewMocks.accessTreeFilter(
            PreviewMocks.accessRepositories,
            editor: PreviewMocks.accessRepositoriesEditor,
            sharing: PreviewMocks.accessOwner,
            total: 42,
            openAlong: [PreviewMocks.accessOwner],
            listing: PreviewMocks.accessOwnerRepositories
        )
    }.environment(AppStore.preview(sourceIconByType: PreviewMocks.accessTreeIcons))
}
#endif
