// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How long to wait before asking the gateway again for something it is still working out: the wait it asks for,
/// kept between half a second and fifteen seconds, or, when it names none, two seconds at first and longer each
/// time, fifteen at most.
func scopeRetryDelay(retryAfterMs: Int?, attempt: Int) -> Duration {
    if let retryAfterMs { return .milliseconds(min(15000, max(500, retryAfterMs))) }
    return .seconds(min(15, 2 * max(1, attempt)))
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

/// The words beside the spinner while the gateway is still counting.
let scopeCountingText = "Counting…"

/// A filter's counts, asked for again while the gateway works them out; nil when it is still counting after
/// several tries or the task is cancelled.
func scopeSettledPreview(_ policy: ScopePolicy, client: AccessClient, attempts: Int = 8) async throws -> ScopePreview? {
    for attempt in 1 ... attempts {
        switch try await client.scopePreview(policy) {
        case .ready(let preview): return preview
        case .pending(let retryAfterMs):
            try await Task.sleep(for: scopeRetryDelay(retryAfterMs: retryAfterMs, attempt: attempt))
        }
    }
    return nil
}

/// Said under a filter that names more entries than the gateway holds.
let scopeFilterLimitMessage = "A filter can include at most \(scopeFilterMaxEntries) items."
