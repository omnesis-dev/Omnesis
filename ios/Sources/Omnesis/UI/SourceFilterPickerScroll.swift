// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension SourceFilterPickerView {
    var location: ScopePickerLocation {
        .init(sourceId: source.id, kind: kind, query: query, parentId: parentId, ancestors: ancestors)
    }

    /// The path to the open folder, from the root every account has, named in the source's word for its top level.
    var folderTrail: [String] {
        let roots = scopeLevelNoun(declaration, depth: 0)?.many ?? declaration?.noun?.many ?? "folders"
        return ["All " + roots] + ancestors.map(\.label)
    }

    var folderScopeText: String {
        folderTrail.joined(separator: " › ")
    }

    /// Opens the ancestor at `depth` of the trail; depth 0 is the root.
    func openAncestor(depth: Int) {
        ancestors = Array(ancestors.prefix(depth))
        parentId = ancestors.last?.ref.id
    }

    var pickerRows: [ScopePickerRow] {
        (options?.items ?? []).map { .init(option: $0) }
    }

    var scrollPosition: Binding<ScopePickerAnchor?> {
        Binding(get: { scrollAnchor }, set: { anchor in
            guard let anchor else { return }
            scrollAnchor = anchor
            guard restoringLocation != location, optionsLocation == location else { return }
            if anchor == .top {
                positions[location] = nil
            } else if let index = pickerRows.firstIndex(where: { $0.id == anchor }) {
                positions[location] = .init(itemId: anchor, index: index)
            }
        })
    }

    func openLocation() async {
        let revision = UUID()
        activeRestoreRevision = revision
        let requested = location
        let retainedAnchor = positions[requested]?.itemId ?? .top
        restoringLocation = requested
        pendingRestore = nil
        if let cached = catalogues[requested], cached.sourceId == source.id {
            options = cached
            optionsLocation = requested
            catalogueRevision += 1
        } else if optionsLocation != requested { options = nil }
        await load()
        guard !Task.isCancelled, activeRestoreRevision == revision,
              requested == location, restoringLocation == requested else { return }
        let target = retainedAnchor == .top || pickerRows.contains(where: { $0.id == retainedAnchor }) ? retainedAnchor : .top
        pendingRestore = .init(
            revision: revision,
            location: requested,
            catalogueRevision: catalogueRevision,
            loadGeneration: loadGeneration,
            target: target
        )
    }

    func consumeRestore(layout: ScopePickerLayout, proxy: ScrollViewProxy) {
        guard let request = pendingRestore, activeRestoreRevision == request.revision,
              issuedRestoreRevision != request.revision,
              request.location == location, request.catalogueRevision == catalogueRevision,
              request.loadGeneration == loadGeneration, optionsLocation == location,
              openedClient?.baseURL == store.access?.baseURL, openedClient?.token == store.access?.token,
              layout.viewport.width > 0, layout.viewport.height > 0,
              let catalogue = layout.catalogue, catalogue.size.width > 0, catalogue.size.height > 0,
              catalogue.requestRevision == request.revision, catalogue.location == request.location,
              catalogue.catalogueRevision == request.catalogueRevision else { return }
        // Layout acknowledges this exact catalogue/request, even when a seeded load did not suspend.
        // Keep the stamp stable after issuance; geometry feedback must not issue another scroll.
        issuedRestoreRevision = request.revision
        activeRestoreRevision = nil
        restoringLocation = nil
        scrollAnchor = request.target
        proxy.scrollTo(request.target, anchor: .top)
    }
}

struct ScopePickerRestoreRequest {
    let revision: UUID
    let location: ScopePickerLocation
    let catalogueRevision: Int
    let loadGeneration: Int
    let target: ScopePickerAnchor
}

struct ScopePickerCatalogueLayout: Equatable {
    var requestRevision: UUID?
    var catalogueRevision: Int
    var location: ScopePickerLocation
    var size: CGSize
}

struct ScopePickerLayout: Equatable {
    var viewport: CGSize = .zero
    var catalogue: ScopePickerCatalogueLayout?
}

struct ScopePickerLayoutKey: PreferenceKey {
    static var defaultValue: ScopePickerLayout {
        .init()
    }

    static func reduce(value: inout ScopePickerLayout, nextValue: () -> ScopePickerLayout) {
        let next = nextValue()
        if next.viewport != .zero { value.viewport = next.viewport }
        if let catalogue = next.catalogue { value.catalogue = catalogue }
    }
}

#if DEBUG
#Preview("Folder picker scroll") {
    NavigationStack {
        SourceFilterPickerView(source: PreviewMocks.accessDrive, options: PreviewMocks.accessRootFolderOptions) { _ in }
    }.environment(AppStore.preview())
}
#endif
#endif
