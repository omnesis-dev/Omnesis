// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

struct ScopePickerLocation: Hashable {
    var sourceId: String
    var kind: String
    var query: String
    var parentId: String?
    var trail: [String]
}

struct ScopePickerPosition: Equatable {
    var itemId: ScopePickerAnchor
    var index: Int
    var offset: Double
    var rowHeight: Double
}

struct ScopePickerSession: Equatable {
    var kind = ""
    var query = ""
    var parentId: String?
    var ancestors: [ScopeOption] = []
    var identifierType = ""
    var typed = ""
    var enteringIdentifier = false
    var sourceId: String?
    var positions: [ScopePickerLocation: ScopePickerPosition] = [:]
    var catalogues: [ScopePickerLocation: ScopeOptions] = [:]

    func location(for sourceId: String) -> ScopePickerLocation {
        .init(sourceId: sourceId, kind: kind, query: query, parentId: parentId, trail: ancestors.map { $0.ref.id ?? "" })
    }

    func retained(for sourceId: String) -> Self {
        guard self.sourceId == nil || self.sourceId == sourceId else { return .init(sourceId: sourceId) }
        var copy = self
        copy.sourceId = sourceId
        return copy
    }

    mutating func changeKind(_ value: String, scopes: SourceScopes?) {
        guard value != kind else { return }
        kind = value
        parentId = nil
        ancestors = []
        identifierType = scopes?.items.first { $0.kind == value }?.identifiers?.first ?? ""
    }

    mutating func goToParent() {
        _ = ancestors.popLast()
        parentId = ancestors.last?.ref.id
    }
}

struct ScopePickerItemIdentity: Hashable {
    var kind: String
    var id: String?
    var identifiers: [ScopeIdentifier]?

    init(_ ref: ScopeRef) {
        kind = ref.kind
        id = ref.id
        identifiers = ref.identifiers?.sorted { ($0.type, $0.value) < ($1.type, $1.value) }
    }
}

enum ScopePickerAnchor: Hashable {
    case top
    case item(ScopePickerItemIdentity)
}

struct ScopePickerRow: Identifiable {
    var option: ScopeOption
    var id: ScopePickerAnchor {
        .item(.init(option.ref))
    }
}
