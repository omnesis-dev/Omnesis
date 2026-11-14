// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What makes two filter entries the same entry: the field item and device they name, or the set of identifiers
/// a person entry matches. A person's display name plays no part.
struct ScopePickerItemIdentity: Hashable {
    var capability: String
    var field: String?
    var id: String?
    var device: String?
    var identifiers: [ScopeIdentifier]?

    init(_ ref: ScopeRef) {
        capability = ref.capability
        field = ref.isPerson ? nil : ref.field
        id = ref.isPerson ? nil : ref.id
        device = ref.isPerson ? nil : ref.device
        identifiers = ref.isPerson
            ? ref.identifiers.map { Array(Set($0)) }?.sorted { ($0.type, $0.value) < ($1.type, $1.value) }
            : nil
    }
}

func scopeRefIdentityMatches(_ lhs: ScopeRef, _ rhs: ScopeRef) -> Bool {
    ScopePickerItemIdentity(lhs) == ScopePickerItemIdentity(rhs)
}
