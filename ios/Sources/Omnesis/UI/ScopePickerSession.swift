// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

struct ScopePickerLocation: Hashable {
    var sourceId: String
    var field: String
    var query: String
    var parentId: String?
    var device: String?
    var trail: [String]

    /// The place in an account's lists that a field, a search and the items opened on the way to it lead to.
    init(sourceId: String, field: String, query: String, parentId: String?, device: String?, ancestors: [ScopeOption]) {
        self.sourceId = sourceId
        self.field = field
        self.query = query
        self.parentId = parentId
        self.device = device
        trail = ancestors.map { ($0.ref.device ?? "") + "/" + ($0.ref.id ?? "") }
    }
}

struct ScopePickerPosition: Equatable {
    var itemId: ScopePickerAnchor
    var index: Int
}

struct ScopePickerSession: Equatable {
    var field = ""
    var query = ""
    var parentId: String?
    /// The device whose tree is open, for a field kept per device whose tree starts at the devices.
    var device: String?
    var ancestors: [ScopeOption] = []
    var identifierType = ""
    var typed = ""
    var enteringIdentifier = false
    var sourceId: String?
    var positions: [ScopePickerLocation: ScopePickerPosition] = [:]
    var catalogues: [ScopePickerLocation: ScopeOptions] = [:]

    func location(for sourceId: String) -> ScopePickerLocation {
        .init(sourceId: sourceId, field: field, query: query, parentId: parentId, device: device, ancestors: ancestors)
    }

    func retained(for sourceId: String) -> Self {
        guard self.sourceId == nil || self.sourceId == sourceId else { return .init(sourceId: sourceId) }
        var copy = self
        copy.sourceId = sourceId
        return copy
    }

    mutating func changeField(_ value: String, fields: [FilterEditorField]) {
        guard value != field else { return }
        field = value
        parentId = nil
        device = nil
        ancestors = []
        identifierType = fields.first { $0.field == value }?.identifiers?.first ?? ""
    }

    /// Opens `item` one level down: a device's tree, or the children of a node.
    mutating func open(_ item: ScopeOption) {
        ancestors.append(item)
        if item.ref.isDevice {
            device = item.ref.device
            parentId = nil
        } else {
            parentId = item.ref.id
        }
    }

    /// Goes back up to the ancestor at `depth` of the trail; depth 0 is the root.
    mutating func openAncestor(depth: Int) {
        ancestors = Array(ancestors.prefix(depth))
        device = ancestors.first { $0.ref.isDevice }?.ref.device
        parentId = ancestors.last.flatMap { $0.ref.isDevice ? nil : $0.ref.id }
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
