// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension SourceFilterPickerView {
    var location: ScopePickerLocation {
        .init(sourceId: source.id, kind: kind, query: query, parentId: parentId, trail: ancestors.map { $0.ref.id ?? "" })
    }

    var pickerRows: [ScopePickerRow] {
        (options?.items ?? []).map { .init(option: $0) }
    }

    var scrollPosition: Binding<ScopePickerAnchor?> {
        Binding(get: { scrollAnchor }, set: { anchor in
            guard let anchor else { return }
            scrollAnchor = anchor
            if anchor == .top {
                positions[location] = nil
            } else if let index = pickerRows.firstIndex(where: { $0.id == anchor }) {
                positions[location] = .init(itemId: anchor, index: index)
            }
        })
    }

    func openLocation(proxy: ScrollViewProxy) async {
        let requested = location
        let retainedAnchor = positions[requested]?.itemId
        if let cached = catalogues[requested], cached.sourceId == source.id {
            options = cached
            optionsLocation = requested
        } else if optionsLocation != requested { options = nil }
        scrollAnchor = retainedAnchor ?? .top
        await load()
        guard !Task.isCancelled, requested == location else { return }
        // Reapply the saved leading row after refreshing its catalogue.
        scrollAnchor = retainedAnchor ?? .top
        proxy.scrollTo(retainedAnchor ?? .top, anchor: .top)
    }
}

#if DEBUG
#Preview("Folder picker scroll") {
    NavigationStack {
        SourceFilterPickerView(source: PreviewMocks.scopeFolderSource, options: PreviewMocks.scopeFolderOptions) { _ in }
    }.environment(AppStore.preview())
}
#endif
#endif
