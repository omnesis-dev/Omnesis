// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Whether a filter's counts must be asked for again: none have arrived for this account, the gateway is
/// still counting the kinds the filter names, or the last attempt failed in a way that another may not.
func scopeCountsNeedRefresh(policy: ScopePolicy, preview: ScopePreview?, error: Error?) -> Bool {
    if let error { return scopePreviewCanRetry(error) }
    guard let preview, preview.sourceId == policy.sourceId else { return true }
    return !policy.readyToSave(preview.readiness)
}

/// How long to wait before asking for counts again: two seconds at first, longer each time, fifteen at most.
func scopeCountRefreshDelay(attempt: Int) -> Duration {
    .seconds(min(15, 2 * max(1, attempt)))
}

/// The row that offers typing what the list does not offer, naming only what the source accepts:
/// "Add an email, domain or phone number".
func scopeAddIdentifierTitle(_ types: [String]) -> String {
    let names = [("email", "an email"), ("domain", "a domain"), ("phone", "a phone number")].filter { types.contains($0.0) }.map(\.1)
    guard let first = names.first else { return "Add a match" }
    let rest = names.dropFirst().map { $0.replacingOccurrences(of: "a ", with: "", options: .anchored) }
    guard let last = rest.last else { return "Add " + first }
    return "Add " + ([first] + rest.dropLast()).joined(separator: ", ") + " or " + last
}

/// What an address typed by hand is called, by its type: "Phone number", "Domain" or "Email address".
func scopeIdentifierTypeName(_ type: String) -> String {
    type == "phone" ? "Phone number" : type == "domain" ? "Domain" : "Email address"
}

/// What is said under a typed address that names no address of its type.
func scopeTypedIdentifierProblem(_ type: String) -> String {
    switch type {
    case "phone": "Enter a valid phone number. Include the international country code."
    case "domain": "Enter a valid domain."
    default: "Enter a valid email address."
    }
}

/// "4 records stay hidden until their details finish syncing.", or nil when every record could be compared with the filter.
/// A record stays hidden while the gateway lacks the details a filter on its source matches it on.
func scopeUncheckedRecordsLine(_ count: Int) -> String? {
    guard count > 0 else { return nil }
    return count == 1
        ? "1 record stays hidden until its details finish syncing."
        : "\(count) records stay hidden until their details finish syncing."
}

/// Why records wait hidden, under the line that counts them.
let scopeUncheckedRecordsExplanation =
    "Omnesis doesn’t have the details it needs to check them yet. Nothing is shared by mistake while they sync."
