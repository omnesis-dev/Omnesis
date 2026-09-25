// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Shared helpers for the gateway-internal Notes source. Generated daily
/// search documents are read-only projections of the `note_entries` ledger;
/// managing them means managing the original notes on Tell Omnesis, reached
/// through the portal (which accepts the device token as a `token` query
/// item for one-click sign-in, preserving the deep link).
private let noteDayPattern = #"^\d{4}-\d{2}-\d{2}$"#

/// The gateway-internal source whose day documents the Manage-notes link
/// serves. Notes is currently the only internal source; the link (day
/// seed + Tell Omnesis destination) is Notes-specific, so callers gate on
/// this id rather than the generic internal flag — a future internal
/// sibling must not inherit a link to the wrong surface.
public let notesSourceId = "omnesis-notes"

/// Whether a string is a capture-local calendar day key.
public func isNoteDayKey(_ value: String) -> Bool {
    value.range(of: noteDayPattern, options: .regularExpression) != nil
}

/// The day a document belongs to, for the Manage-notes link. Generated
/// Notes documents carry the day as their external id; anything else falls
/// back to the creation date. Nil when neither is day-shaped.
public func notesDayForDocument(externalId: String?, sourceCreatedAt: String?) -> String? {
    if let externalId, isNoteDayKey(externalId) {
        return externalId
    }
    if let sourceCreatedAt, isNoteDayKey(String(sourceCreatedAt.prefix(10))) {
        return String(sourceCreatedAt.prefix(10))
    }
    return nil
}

/// Portal Tell Omnesis URL for managing notes. With a day, the history
/// seeds at that day (a link from an old daily document still lands on
/// relevant notes); without one it opens the latest notes.
public func manageNotesURL(baseURL: URL, token: String, day: String?) -> URL? {
    var components = URLComponents(
        url: baseURL.appendingPathComponent("portal/capture"),
        resolvingAgainstBaseURL: false
    )
    var items: [URLQueryItem] = []
    if let day {
        items.append(URLQueryItem(name: "day", value: day))
    }
    items.append(URLQueryItem(name: "token", value: token))
    components?.queryItems = items
    // `URLComponents` leaves `+` unescaped in query values, but a `+`
    // form-decodes to a space — and device tokens are opaque strings
    // that may contain one. Encode it so the builder agrees with the
    // Android `URLEncoder` one byte-for-byte.
    if var query = components?.percentEncodedQuery {
        query = query.replacingOccurrences(of: "+", with: "%2B")
        components?.percentEncodedQuery = query
    }
    return components?.url
}
