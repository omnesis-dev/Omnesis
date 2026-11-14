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
/// carry, or whose detail is not known, says so in the gateway's words. A source no filter can use has no rows at
/// all, so the inspector leaves the section out instead of showing a lone source version.
func documentFilterDetailRows(_ details: DocumentFilterDetails) -> [DocumentFilterDetailRow] {
    guard !details.fields.isEmpty else { return [] }
    let rows = details.fields.map { field in
        let noun = field.state == "present" && field.items.count == 1 ? field.noun.one : field.noun.many
        let key = noun.prefix(1).uppercased() + noun.dropFirst()
        guard field.state == "present" else {
            return DocumentFilterDetailRow(key: key, value: field.stateText.isEmpty ? "Not recorded" : field.stateText)
        }
        let value = field.items.map(\.label).joined(separator: ", ")
        return DocumentFilterDetailRow(key: key, value: value.isEmpty ? "None" : value)
    }
    return rows + [DocumentFilterDetailRow(key: "Source version", value: "\(details.sourceVersion)")]
}

/// A timestamp as the document inspector shows it: "14 March 2026, 09:12" in the reader's time zone. A time
/// written without a zone is read as local; anything that is not a timestamp is shown as it came.
func inspectorTimestamp(_ raw: String, timeZone: TimeZone = .current) -> String {
    let zoned = ISO8601DateFormatter()
    zoned.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    let local = DateFormatter()
    local.locale = Locale(identifier: "en_US_POSIX")
    local.timeZone = timeZone
    local.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    guard let date = zoned.date(from: raw) ?? plain.date(from: raw) ?? local.date(from: raw) else { return raw }
    let shown = DateFormatter()
    shown.locale = Locale(identifier: "en_GB")
    shown.timeZone = timeZone
    shown.dateFormat = "d MMMM yyyy, HH:mm"
    return shown.string(from: date)
}
