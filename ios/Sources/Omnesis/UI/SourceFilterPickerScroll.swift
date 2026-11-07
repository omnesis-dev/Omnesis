// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

struct ScopePickerFramesKey: PreferenceKey {
    static let defaultValue: [ScopePickerLocation: [ScopePickerAnchor: CGRect]] = [:]
    static func reduce(
        value: inout [ScopePickerLocation: [ScopePickerAnchor: CGRect]],
        nextValue: () -> [ScopePickerLocation: [ScopePickerAnchor: CGRect]]
    ) {
        for (location, frames) in nextValue() {
            value[location, default: [:]].merge(frames) { _, new in new }
        }
    }
}

struct ScopePickerViewportKey: PreferenceKey {
    static let defaultValue: [ScopePickerLocation: CGRect] = [:]
    static func reduce(value: inout [ScopePickerLocation: CGRect], nextValue: () -> [ScopePickerLocation: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

@available(iOS 17.0, *)
extension SourceFilterPickerView {
    var location: ScopePickerLocation {
        .init(sourceId: source.id, kind: kind, query: query, parentId: parentId, trail: ancestors.map { $0.ref.id ?? "" })
    }

    var pickerRows: [ScopePickerRow] {
        (options?.items ?? []).map { .init(option: $0) }
    }

    func observeFrames(_ frames: [ScopePickerAnchor: CGRect], proxy: ScrollViewProxy) {
        visibleFrames = frames
        restorePosition(proxy: proxy)
        guard !restoringPosition, !loading, !enteringIdentifier, viewport.height > 0 else { return }
        if let top = frames[.top], top.minY >= viewport.minY - 2 {
            positions[location] = nil
            return
        }
        for (index, row) in pickerRows.enumerated() {
            guard let frame = frames[row.id], frame.minY >= viewport.minY - 1, frame.minY < viewport.maxY else { continue }
            positions[location] = .init(
                itemId: row.id,
                index: index,
                offset: Double(frame.minY - viewport.minY),
                rowHeight: Double(frame.height)
            )
            break
        }
    }

    func restorePosition(proxy: ScrollViewProxy) {
        guard restoringPosition, !loading, viewport.height > 0 else { return }
        guard let saved = positions[location], !pickerRows.isEmpty else {
            if !restorationIssued {
                restorationIssued = true
                proxy.scrollTo(ScopePickerAnchor.top, anchor: .top)
            }
            restoringPosition = false
            return
        }
        let row = pickerRows.first { $0.id == saved.itemId } ?? pickerRows[max(0, min(saved.index, pickerRows.count - 1))]
        guard visibleFrames[row.id] != nil else { return }
        if restorationIssued {
            restoringPosition = false
            return
        }
        restorationIssued = true
        let fraction = saved.offset / max(1, Double(viewport.height) - saved.rowHeight)
        proxy.scrollTo(row.id, anchor: UnitPoint(x: 0.5, y: CGFloat(fraction)))
    }

    func openLocation(proxy: ScrollViewProxy) async {
        let requested = location
        restoringPosition = true
        restorationIssued = false
        if let cached = catalogues[requested], cached.sourceId == source.id {
            options = cached
            optionsLocation = requested
        } else if optionsLocation != requested { options = nil }
        await load()
        guard !Task.isCancelled, requested == location else { return }
        restorePosition(proxy: proxy)
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
