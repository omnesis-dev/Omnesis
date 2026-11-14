// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

enum AccessAuthorizationChoiceRefresh: Equatable {
    case notAttempted
    case refreshed
    case failed
}

enum AccessAuthorizationLocalError: Error {
    case expired
    case alreadyDecided
    /// A request opened by id that the gateway no longer lists as waiting:
    /// decided elsewhere, expired, or never known to this gateway.
    case noLongerPending
}

/// How the sheet asks the gateway for a request: by the short code the
/// owner typed, or by the id of a request the overview lists as waiting.
enum AccessAuthorizationLookupKey: Equatable {
    case code(String)
    case id(String)
}

enum AccessAuthorizationOutcome: Equatable {
    case approved
    case denied
}

enum AccessAuthorizationLookupDisposition: Equatable {
    case pending
    case approved
    case denied
    case expired
    case alreadyDecided
}

func accessAuthorizationLookupDisposition(
    status: String,
    expiresAt: Int64,
    nowMillis: Int64
)
    -> AccessAuthorizationLookupDisposition {
    if accessAuthorizationDecisionWasRecorded(status: status, approve: true) { return .approved }
    if accessAuthorizationDecisionWasRecorded(status: status, approve: false) { return .denied }
    if status == "expired" || expiresAt <= nowMillis { return .expired }
    return status == "pending" ? .pending : .alreadyDecided
}

struct AccessAuthorizationOutcomePresentation: Equatable {
    let symbol: String
    let title: String
    let detail: String
    let approved: Bool
}

func accessAuthorizationOutcomePresentation(
    outcome: AccessAuthorizationOutcome,
    clientName: String?
)
    -> AccessAuthorizationOutcomePresentation {
    let name = clientName ?? "The requesting app"
    switch outcome {
    case .approved:
        return AccessAuthorizationOutcomePresentation(
            symbol: "checkmark.circle.fill",
            title: "Access granted",
            detail: "\(name) can now finish connecting with the access you approved.",
            approved: true
        )
    case .denied:
        return AccessAuthorizationOutcomePresentation(
            symbol: "xmark.circle.fill",
            title: "Request denied",
            detail: "\(name) was not given access to Omnesis.",
            approved: false
        )
    }
}

func accessAuthorizationDeadlineText(expiresAt: Int64, nowMillis: Int64) -> String {
    let remaining = expiresAt - nowMillis
    guard remaining > 0 else { return "This request has expired." }
    let minutes = max(1, Int(ceil(Double(remaining) / 60000)))
    return "Expires in \(minutes) minute\(minutes == 1 ? "" : "s")."
}

func accessAuthorizationMayBeginDecision(
    deciding: Bool,
    expiresAt: Int64,
    nowMillis: Int64
)
    -> Bool {
    !deciding && nowMillis < expiresAt
}

private enum AccessAuthorizationCopy {
    static let expired = "This authorization request expired. Start the connection again."
    static let alreadyCompleted = "This authorization request was already completed."
    static let phoneUnauthorized = "This phone is no longer authorized. Re-pair it from Settings."
    static let phoneForbidden = "This phone does not have permission to authorize connections. Re-pair it from Settings."
}

func accessAuthorizationDecisionMessage(
    errorCode: String?,
    choiceRefresh: AccessAuthorizationChoiceRefresh
)
    -> String {
    switch errorCode {
    case "expired":
        return AccessAuthorizationCopy.expired
    case "already-decided":
        return AccessAuthorizationCopy.alreadyCompleted
    case "inactive-grant", "invalid-selection", "stale-revision":
        if choiceRefresh == .refreshed {
            return "Access choices changed. Review the refreshed request."
        }
        if choiceRefresh == .failed {
            return "The available access choices changed, but Omnesis could not reload them. "
                + "Close this sheet, enter the code again, and try once more."
        }
        return "The available access choices changed. Reload the request before trying again."
    case "device-unauthorized":
        return AccessAuthorizationCopy.phoneUnauthorized
    case "device-forbidden":
        return AccessAuthorizationCopy.phoneForbidden
    case "invalid-input":
        return "Some values are invalid. Review the source selections."
    default:
        return "The authorization decision could not be saved. Try again."
    }
}

func accessAuthorizationDecisionWasRecorded(status: String, approve: Bool) -> Bool {
    if approve {
        return ["approved", "code-issued", "complete"].contains(status)
    }
    return status == "denied"
}

/// The failure to report when reading a request by `key` threw `error`.
///
/// A gateway that no longer lists an id answers 404, which for the owner
/// means the request stopped waiting rather than that a code was mistyped;
/// a 404 for a typed code, and every other failure, is reported as it is.
func accessAuthorizationLookupFailure(_ error: Error, key: AccessAuthorizationLookupKey) -> Error {
    if case .id = key, case GatewayClient.Error.notFound = error {
        return AccessAuthorizationLocalError.noLongerPending
    }
    return error
}

func accessAuthorizationLookupMessage(_ error: Error) -> String {
    if let local = error as? AccessAuthorizationLocalError {
        switch local {
        case .expired: return AccessAuthorizationCopy.expired
        case .alreadyDecided: return AccessAuthorizationCopy.alreadyCompleted
        case .noLongerPending: return "This request is no longer waiting for a decision."
        }
    }
    if case GatewayClient.Error.unauthorized = error {
        return AccessAuthorizationCopy.phoneUnauthorized
    }
    if case GatewayClient.Error.forbidden = error {
        return AccessAuthorizationCopy.phoneForbidden
    }
    if case GatewayClient.Error.notFound = error {
        return "No pending authorization matches that code."
    }
    switch accessAuthorizationErrorCode(error) {
    case "expired":
        return AccessAuthorizationCopy.expired
    case "already-decided":
        return AccessAuthorizationCopy.alreadyCompleted
    case "inactive-grant", "invalid-selection", "stale-revision":
        return "The available access choices changed. Review the refreshed request."
    default:
        return accessAuthorizationUnmappedMessage(error)
    }
}

/// What to say about a failure none of the named cases covers.
///
/// A phone off the network, a gateway speaking a shape this build cannot
/// read, and a genuine server fault each get a sentence of their own, and a
/// server fault carries its status, so the next occurrence is diagnosable
/// from a screenshot — by the owner and by anyone they report it to.
func accessAuthorizationUnmappedMessage(_ error: Error) -> String {
    if let urlError = error as? URLError {
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
            return "This phone is offline. Reconnect and try again."
        case .cannotConnectToHost, .cannotFindHost, .timedOut, .dnsLookupFailed:
            return "Could not reach your Omnesis gateway. Check that this phone is on the same network as it, then try again."
        case .secureConnectionFailed, .serverCertificateUntrusted,
             .serverCertificateHasBadDate, .serverCertificateNotYetValid,
             .serverCertificateHasUnknownRoot:
            return "The connection to your gateway is not trusted. Re-pair this phone from Settings."
        case .userAuthenticationRequired:
            return "This phone is not paired with a gateway. Pair it from Settings."
        default:
            return "Could not reach your Omnesis gateway (\(urlError.code.rawValue)). Try again."
        }
    }
    guard let gatewayError = error as? GatewayClient.Error else {
        return "The authorization request could not be loaded or updated. Try again."
    }
    if case .decoding = gatewayError {
        return "This gateway replied in a form this app version cannot read. Update Omnesis on both, then try again."
    }
    if case .serverError(let status, _) = gatewayError {
        return "The gateway refused the request (HTTP \(status)). Try again."
    }
    return "The authorization request could not be loaded or updated. Try again."
}

func accessAuthorizationErrorCode(_ error: Error) -> String? {
    if let local = error as? AccessAuthorizationLocalError {
        switch local {
        case .expired: return "expired"
        case .alreadyDecided: return "already-decided"
        case .noLongerPending: return "no-longer-pending"
        }
    }
    guard let gatewayError = error as? GatewayClient.Error else { return nil }
    if case .unauthorized = gatewayError { return "device-unauthorized" }
    if case .forbidden = gatewayError { return "device-forbidden" }
    if case .serverError(let status, _) = gatewayError, status == 400 {
        return "invalid-input"
    }
    return accessRefusalCode(gatewayError)
}

/// The name the gateway gives a refusal on the access routes, such as `level-name-taken`.
func accessRefusalCode(_ error: GatewayClient.Error) -> String? {
    error.gatewayCode ?? error.gatewayMessage
}

func accessAuthorizationIsTerminalError(_ error: Error) -> Bool {
    guard let code = accessAuthorizationErrorCode(error) else { return false }
    return ["expired", "already-decided", "no-longer-pending"].contains(code)
}

func accessAuthorizationIsStaleSelectionError(_ error: Error) -> Bool {
    guard let code = accessAuthorizationErrorCode(error) else { return false }
    return ["inactive-grant", "invalid-selection", "stale-revision"].contains(code)
}

/// One capability a connection may hold.
///
/// `allCases` is the order every surface prints them in, so a capability's
/// slot never moves between the wizard and the review and "which of these
/// reads raw records" is answerable without reading the labels.
enum AccessCapability: String, CaseIterable {
    case answer
    case direct
    case notes

    var label: String {
        switch self {
        case .answer: "Answer"
        case .direct: "Direct"
        case .notes: "Notes"
        }
    }
}

/// A capability's name as every screen prints it, from the name a rule carries on the wire.
func accessCapabilityName(_ capability: String) -> String {
    AccessCapability(rawValue: capability)?.label ?? capability.capitalized
}

/// What a connection would be allowed to do, as the three slots print it.
struct AccessCapabilityHoldings: Equatable {
    var answer = false
    var direct = false
    var notes = false

    /// Nothing else about a connection means anything until it grants
    /// something.
    var holdsAnything: Bool {
        answer || direct || notes
    }

    func holds(_ capability: AccessCapability) -> Bool {
        switch capability {
        case .answer: answer
        case .direct: direct
        case .notes: notes
        }
    }

    /// "Answer and Direct allowed, Notes not allowed": the three slots as one sentence.
    var spokenSummary: String {
        let allowed = AccessCapability.allCases.filter(holds).map(\.label)
        let withheld = AccessCapability.allCases.filter { !holds($0) }.map(\.label)
        return [(allowed, "allowed"), (withheld, "not allowed")]
            .filter { !$0.0.isEmpty }
            .map { names, state in
                let list = names.count == 1 ? names[0] : names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
                return list + " " + state
            }
            .joined(separator: ", ")
    }
}

func accessCapabilityHoldings(rules: [AccessGrantRule]) -> AccessCapabilityHoldings {
    var holdings = AccessCapabilityHoldings()
    for rule in rules {
        switch rule {
        case .notes:
            holdings.notes = true
        case .direct:
            holdings.direct = true
        case .answer:
            holdings.answer = true
        }
    }
    return holdings
}

/// Nothing else about a connection means anything until it grants something.
let accessNoCapabilityMessage = "Choose at least one permission."

/// The numbered steps the approval's indicator shows. Data & privacy stands for every screen between Permissions
/// and the review.
enum AccessAuthorizationStep: CaseIterable, Hashable {
    case connection
    case permissions
    case data
    case review

    /// The indicator step a screen of the flow belongs to.
    init(_ step: AccessFlowStep) {
        switch step {
        case .name, .overview: self = .connection
        case .permissions: self = .permissions
        case .answerData, .directChoice, .directData, .future, .release: self = .data
        case .review: self = .review
        }
    }

    var title: String {
        switch self {
        case .connection: "Connection"
        case .permissions: "Permissions"
        case .data: "Data & privacy"
        case .review: "Review"
        }
    }

    /// The title trimmed to what still fits when several steps share one phone
    /// width. The full title stays the accessible name and the step's own
    /// heading, so nothing is lost by shortening the chip.
    var shortTitle: String {
        switch self {
        case .data: "Data"
        default: title
        }
    }
}

/// `value` cut at a character boundary to at most `maxUTF16Length` UTF-16
/// units, the unit the gateway measures names and labels in.
func accessAuthorizationPrefix(_ value: String, maxUTF16Length: Int) -> String {
    guard value.utf16.count > maxUTF16Length else { return value }
    var result = ""
    for character in value {
        let next = String(character)
        guard result.utf16.count + next.utf16.count <= maxUTF16Length else { break }
        result.append(character)
    }
    return result
}

extension AccessLevelDraft {
    /// The new level an approval opens on, built from what the gateway serves for the request right now: the level
    /// editor's blank level (Answer, released through the default policy, with no account chosen yet) or `prefill`,
    /// the rules of a connection the same app already holds, so the wizard opens on what that connection can do
    /// today. A refresh after a refused selection builds it the same way, so permissions revoked in the meantime
    /// are gone from it. An agent that asks through Answer always holds Answer.
    static func approving(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
        prefill: [AccessGrantRule]?
    )
        -> AccessLevelDraft {
        var draft = AccessLevelDraft(level: nil, overview: overview)
        if let prefill { draft.adopt(prefill, overview: overview) }
        if request.requiresAnswer { draft.setEnabled("answer", true, overview: overview) }
        return draft
    }

    /// Takes another level's rules as this unsaved level's own: no filter revision to fence on, every filter
    /// addressed to this level, and the default policy in place of one the overview no longer lists, which the
    /// policy picker could not show.
    private mutating func adopt(_ saved: [AccessGrantRule], overview: AccessOverview) {
        let levelId = id
        rules = saved.map { rule -> AccessGrantRule in
            let policies = rule.scopePolicies.map { policy -> ScopePolicy in
                var copy = policy
                copy.audience = .init(accessLevel: levelId, capability: rule.capability)
                return copy
            }
            switch rule {
            case .notes:
                return .notes
            case .direct(let sources, _, _):
                return .direct(sources: sources, scopePolicies: policies)
            case .answer(let sources, let release, _, _):
                var kept = release
                if case .reviewed(let family) = release, !overview.policyFamilies.contains(where: { $0.id == family }) {
                    kept = .reviewed(policyFamilyId: overview.startingPolicyFamilyId)
                }
                return .answer(sources: sources, release: kept, scopePolicies: policies)
            }
        }
        directSameAsAnswer = accessDirectMirrorsAnswer(rules)
    }
}

/// What approval sends to a gateway without connection proposals: the rules, under a credential labelled with the
/// client's own name. Nil while the rules cannot be sent.
func accessConnectSelection(rules: [AccessGrantRule]?, request: AccessAuthorizationRequest) -> AccessAuthorizationSelection? {
    rules.map { .connect(rules: $0, credentialLabel: accessAuthorizationPrefix(request.clientName, maxUTF16Length: 160)) }
}
