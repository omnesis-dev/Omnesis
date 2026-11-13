// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One line of a document's filter details: what a filter can see on it, as a name and a value.
struct DocumentFilterDetailRow: Equatable {
    var key: String
    var value: String
}

/// What a filter can see on one document, a line per field and then the source version that wrote it: "Chat:
/// Workshop planning", "People: Maya Reeves, Jamie Lopez", "Source version: 1". A field the record is too old to
/// carry, or whose detail is not known, says so in the gateway's words.
func documentFilterDetailRows(_ details: DocumentFilterDetails) -> [DocumentFilterDetailRow] {
    let rows = details.fields.map { field in
        let noun = field.items.count == 1 ? field.noun.one : field.noun.many
        let key = noun.prefix(1).uppercased() + noun.dropFirst()
        guard field.state == "present" else {
            return DocumentFilterDetailRow(key: key, value: field.stateText.isEmpty ? "Not recorded" : field.stateText)
        }
        let value = field.items.map(\.label).joined(separator: ", ")
        return DocumentFilterDetailRow(key: key, value: value.isEmpty ? "None" : value)
    }
    return rows + [DocumentFilterDetailRow(key: "Source version", value: "\(details.sourceVersion)")]
}
