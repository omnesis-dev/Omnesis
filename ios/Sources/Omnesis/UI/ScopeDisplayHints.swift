// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

func scopeLabelHint(for ref: ScopeRef, in hints: [ScopePreview.Item]) -> ScopePreview.Item? {
    hints.first { scopeRefIdentityMatches($0.ref, ref) }
}

func mergingScopeLabelHints(
    _ existing: [ScopePreview.Item],
    _ incoming: [ScopePreview.Item],
    preserveMissing: Bool = false
)
    -> [ScopePreview.Item] {
    var result: [ScopePreview.Item] = []
    var indices: [ScopePickerItemIdentity: Int] = [:]
    for item in existing + incoming {
        let key = ScopePickerItemIdentity(item.ref)
        if let index = indices[key] {
            var value = item
            if preserveMissing, result[index].missing == true { value.missing = true }
            if item.missing == true, !result[index].label.isEmpty, result[index].label != item.ref.id {
                value.label = result[index].label
            }
            result[index] = value
        } else {
            indices[key] = result.count
            result.append(item)
        }
    }
    return result
}

func scopeDisplayLabel(_ ref: ScopeRef, previewItem: ScopePreview.Item?) -> String {
    let saved = ref.label ?? ref.identifiers?.map(\.value).joined(separator: ", ") ?? "Saved item"
    guard let previewItem else { return saved }
    if previewItem.missing == true {
        let known = previewItem.label.isEmpty || previewItem.label == ref.id ? saved : previewItem.label
        return known + " (unavailable)"
    }
    return previewItem.label
}

func scopeCatalogueLabelHints(_ session: ScopePickerSession, sourceId: String) -> [ScopePreview.Item] {
    let current = session.location(for: sourceId)
    let keys = session.catalogues.keys.filter { $0.sourceId == sourceId && $0 != current }.sorted {
        ($0.kind, $0.query, $0.parentId ?? "", $0.trail.joined(separator: "/")) <
            ($1.kind, $1.query, $1.parentId ?? "", $1.trail.joined(separator: "/"))
    } + [current]
    return keys.reduce(into: [ScopePreview.Item]()) { hints, key in
        guard let catalogue = session.catalogues[key], catalogue.sourceId == sourceId else { return }
        let items = catalogue.items.map { ScopePreview.Item(ref: $0.ref, label: $0.label, count: $0.count) }
        hints = mergingScopeLabelHints(hints, items)
    }
}
