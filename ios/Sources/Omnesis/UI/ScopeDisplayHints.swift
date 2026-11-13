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
            if value.depth == nil { value.depth = result[index].depth }
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

/// What a source calls an item `depth` levels down a kind's tree. A source that names its levels has a word for each,
/// the last standing for every deeper level; nil for any other source and for an item whose depth is not known.
func scopeLevelNoun(_ declaration: SourceScopes.Item?, depth: Int?) -> SourceScopeNoun? {
    guard let levels = declaration?.levels, !levels.isEmpty, let depth, depth >= 0 else { return nil }
    return levels[min(depth, levels.count - 1)]
}

/// What choosing an item `depth` levels down a tree also takes in, in the source's words; nil when nothing lies beneath it.
func scopeNestingHint(_ declaration: SourceScopes.Item?, depth: Int?) -> String? {
    guard let levels = declaration?.levels, !levels.isEmpty else {
        return "Includes the \(declaration?.noun?.many ?? "folders") inside."
    }
    guard let depth, depth >= 0, depth + 1 < levels.count else { return nil }
    return "Selecting \(levels[depth].many) includes their \(levels[depth + 1].many)."
}

/// What a saved item is called when nothing names it: the source's own word for its kind, or for its level of a tree.
func scopeSavedItemNoun(_ ref: ScopeRef, scopes: SourceScopes?, depth: Int? = nil) -> String {
    let declaration = scopes?.items.first { $0.kind == ref.kind }
    return scopeLevelNoun(declaration, depth: depth)?.one ?? declaration?.noun?.one
        ?? (ref.kind == "participant" ? "person" : ref.kind)
}

/// The name of the kind of item a filter selects, as a short caption: Label, Folder, Conversation, Person.
func accessScopeKindName(_ ref: ScopeRef, scopes: SourceScopes?, depth: Int? = nil) -> String {
    let noun = scopeSavedItemNoun(ref, scopes: scopes, depth: depth)
    return noun.prefix(1).uppercased() + noun.dropFirst()
}

/// Whether nothing names a saved item: it was saved by id alone, and no list or count has named it since.
/// An account that is no longer connected leaves every such item this way; a person keeps the saved name.
func scopeNameUnavailable(_ ref: ScopeRef, previewItem: ScopePreview.Item?) -> Bool {
    guard ref.label == nil, ref.identifiers?.isEmpty != false else { return false }
    guard let previewItem else { return true }
    return previewItem.missing == true && (previewItem.label.isEmpty || previewItem.label == ref.id)
}

/// The line under an item whose name cannot be loaded.
let scopeNameUnavailableNote = "Name unavailable"

func scopeDisplayLabel(_ ref: ScopeRef, previewItem: ScopePreview.Item?, scopes: SourceScopes? = nil) -> String {
    let saved = ref.label ?? ref.identifiers?.map(\.value).joined(separator: ", ")
        ?? "Saved \(scopeSavedItemNoun(ref, scopes: scopes)) selection"
    guard let previewItem else { return saved }
    if previewItem.missing == true {
        if scopeNameUnavailable(ref, previewItem: previewItem) { return saved }
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
        let items = catalogue.items.map {
            ScopePreview.Item(ref: $0.ref, label: $0.label, count: $0.count, depth: $0.depth)
        }
        hints = mergingScopeLabelHints(hints, items)
    }
}
