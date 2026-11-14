// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What the screens have learnt about one item a filter names: its full name, how many records it matches, the
/// source's word for its kind, and whether the account's list still holds it. Saved filters hold ids only, so
/// every list of a filter's items names them from these.
struct ScopeItemHint: Equatable {
    var ref: ScopeRef
    var label: String
    var count: Int?
    /// "chat", "label", "owner", "device": what the source calls the item.
    var noun: String?
    var missing = false
}

func scopeLabelHint(for ref: ScopeRef, in hints: [ScopeItemHint]) -> ScopeItemHint? {
    hints.first { scopeRefIdentityMatches($0.ref, ref) }
}

/// `incoming` over `existing`, item by item. A newer hint that only knows an item is gone keeps the name an
/// earlier one gave it, and a newer hint without a word for the item's kind keeps the earlier word.
func mergingScopeLabelHints(_ existing: [ScopeItemHint], _ incoming: [ScopeItemHint], preserveMissing: Bool = false)
    -> [ScopeItemHint] {
    var result: [ScopeItemHint] = []
    var indices: [ScopePickerItemIdentity: Int] = [:]
    for item in existing + incoming {
        let key = ScopePickerItemIdentity(item.ref)
        guard let index = indices[key] else {
            indices[key] = result.count
            result.append(item)
            continue
        }
        var value = item
        let earlier = result[index]
        if preserveMissing, earlier.missing { value.missing = true }
        if value.noun == nil { value.noun = earlier.noun }
        if item.missing, !earlier.label.isEmpty, earlier.label != item.ref.id { value.label = earlier.label }
        result[index] = value
    }
    return result
}

/// What a tree calls an item `depth` levels down: a word per level, the last standing for every deeper level.
func scopeLevelNoun(_ field: FilterEditorField?, depth: Int?) -> FilterNoun? {
    guard let levels = field?.levels, !levels.isEmpty, let depth, depth >= 0 else { return nil }
    return levels[min(depth, levels.count - 1)]
}

/// The source's word for the item an entry names, from the editor's fields: "device" for a whole device, a tree's
/// word for the item's level when it names its levels, and the field's word otherwise.
func scopeFieldNoun(_ ref: ScopeRef, fields: [FilterEditorField], depth: Int? = nil) -> String? {
    if ref.isDevice { return "device" }
    let field = fields.first { $0.field == ref.editorField }
    return scopeLevelNoun(field, depth: depth)?.one ?? field?.noun.one ?? (ref.isPerson ? "person" : nil)
}

/// The names a filter's counts give its items.
func scopeItemHints(_ preview: ScopePreview, fields: [FilterEditorField]) -> [ScopeItemHint] {
    preview.items.map {
        ScopeItemHint(
            ref: $0.ref,
            label: $0.label,
            count: $0.count,
            noun: scopeFieldNoun($0.ref, fields: fields, depth: $0.depth),
            missing: $0.missing == true
        )
    }
}

/// The names a page of a field's items gives them, in their full form.
func scopeItemHints(_ options: ScopeOptions, fields: [FilterEditorField]) -> [ScopeItemHint] {
    options.items.map {
        ScopeItemHint(ref: $0.ref, label: $0.label, count: $0.count, noun: scopeFieldNoun($0.ref, fields: fields, depth: $0.depth))
    }
}

/// What an item is called when nothing names it: the source's word for its kind, from what named the item or from
/// the editor's fields (`noun`).
func scopeSavedItemNoun(_ ref: ScopeRef, hint: ScopeItemHint?, noun: String? = nil) -> String {
    hint?.noun ?? noun ?? (ref.isPerson ? "person" : ref.isDevice ? "device" : "item")
}

/// The kind of item an entry names, as a short caption: Label, Folder, Chat, Person.
func accessScopeKindName(_ ref: ScopeRef, hint: ScopeItemHint?, noun: String? = nil) -> String {
    let noun = scopeSavedItemNoun(ref, hint: hint, noun: noun)
    return noun.prefix(1).uppercased() + noun.dropFirst()
}

/// Whether nothing names a saved item: it was saved by id alone, and no list or count has named it since.
/// An account that is no longer connected leaves every such item this way; a person keeps the saved name.
func scopeNameUnavailable(_ ref: ScopeRef, hint: ScopeItemHint?) -> Bool {
    guard ref.label == nil, ref.identifiers?.isEmpty != false else { return false }
    guard let hint else { return true }
    return hint.missing && (hint.label.isEmpty || hint.label == ref.id)
}

/// The line under an item whose name cannot be loaded.
let scopeNameUnavailableNote = "Name unavailable"

func scopeDisplayLabel(_ ref: ScopeRef, hint: ScopeItemHint?) -> String {
    let saved = ref.label ?? ref.identifiers?.map(\.value).joined(separator: ", ")
        ?? "Saved \(scopeSavedItemNoun(ref, hint: hint)) selection"
    guard let hint else { return saved }
    if hint.missing {
        if scopeNameUnavailable(ref, hint: hint) { return saved }
        let known = hint.label.isEmpty || hint.label == ref.id ? saved : hint.label
        return known + " (unavailable)"
    }
    return hint.label
}

func scopeCatalogueLabelHints(_ session: ScopePickerSession, sourceId: String, fields: [FilterEditorField]) -> [ScopeItemHint] {
    let current = session.location(for: sourceId)
    let keys = session.catalogues.keys.filter { $0.sourceId == sourceId && $0 != current }.sorted {
        ($0.field, $0.query, $0.device ?? "", $0.parentId ?? "", $0.trail.joined(separator: "/")) <
            ($1.field, $1.query, $1.device ?? "", $1.parentId ?? "", $1.trail.joined(separator: "/"))
    } + [current]
    return keys.reduce(into: [ScopeItemHint]()) { hints, key in
        guard let catalogue = session.catalogues[key], catalogue.sourceId == sourceId else { return }
        hints = mergingScopeLabelHints(hints, scopeItemHints(catalogue, fields: fields))
    }
}

/// A field's tab: its word for several items, with a capital: "Labels", "Project folders".
func scopeFieldTabTitle(_ field: FilterEditorField) -> String {
    field.noun.many.prefix(1).uppercased() + field.noun.many.dropFirst()
}

/// A row's name in the picker: the last part of its name inside a tree, where its parent is already shown, and the
/// full name in a list and in search results.
func scopePickerRowTitle(_ item: ScopeOption, inTree: Bool, searching: Bool) -> String {
    inTree && !searching ? item.shortLabel : item.label
}

/// What an empty list of a field's items says: "No labels match this search." or "No folders here."
func scopePickerEmptyText(_ many: String, searching: Bool) -> String {
    searching ? "No \(many) match this search." : "No \(many) here."
}

/// What a field's search says it looks through: "Search labels", or for a tree whose levels have their own names,
/// each of them from the deepest up, "Search repositories and owners".
func scopeSearchPrompt(_ field: FilterEditorField?) -> String {
    guard let field else { return "Search people" }
    var names: [String] = []
    for level in (field.levels ?? []).reversed() where !names.contains(level.many) {
        names.append(level.many)
    }
    return "Search " + (names.count > 1 ? names.joined(separator: " and ") : field.noun.many)
}
