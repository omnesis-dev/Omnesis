// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

struct ScopePickerItemIdentity: Hashable {
    var kind: String
    var id: String?
    var identifiers: [ScopeIdentifier]?

    init(_ ref: ScopeRef) {
        kind = ref.kind
        id = ref.id
        identifiers = ref.identifiers.map { Array(Set($0)) }?.sorted { ($0.type, $0.value) < ($1.type, $1.value) }
    }
}

func scopeRefIdentityMatches(_ lhs: ScopeRef, _ rhs: ScopeRef) -> Bool {
    ScopePickerItemIdentity(lhs) == ScopePickerItemIdentity(rhs)
}
