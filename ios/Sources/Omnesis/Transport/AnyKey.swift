// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A `CodingKey` whose value is supplied at runtime — for encoding maps with
/// dynamic string keys (e.g. the `inference.assignments` capability patch).
struct AnyKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init(_ stringValue: String) {
        self.stringValue = stringValue
    }

    init?(stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue _: Int) {
        nil
    }
}
