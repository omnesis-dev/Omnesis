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

func accessAuthorizationDecisionMessage(
    errorCode: String?,
    choiceRefresh: AccessAuthorizationChoiceRefresh
)
    -> String {
    switch errorCode {
    case "expired":
        return "This authorization request expired. Start the connection again."
    case "already-decided":
        return "This authorization request was already completed."
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
        return "This phone is no longer authorized. Re-pair it from Settings."
    case "device-forbidden":
        return "This phone does not have permission to authorize connections. Re-pair it from Settings."
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
        case .expired: return "This authorization request expired. Start the connection again."
        case .alreadyDecided: return "This authorization request was already completed."
        case .noLongerPending: return "This request is no longer waiting for a decision."
        }
    }
    if case GatewayClient.Error.unauthorized = error {
        return "This phone is no longer authorized. Re-pair it from Settings."
    }
    if case GatewayClient.Error.forbidden = error {
        return "This phone does not have permission to authorize connections. Re-pair it from Settings."
    }
    if case GatewayClient.Error.notFound = error {
        return "No pending authorization matches that code."
    }
    switch accessAuthorizationErrorCode(error) {
    case "expired":
        return "This authorization request expired. Start the connection again."
    case "already-decided":
        return "This authorization request was already completed."
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
    return gatewayError.gatewayCode ?? gatewayError.gatewayMessage
}

func accessAuthorizationIsTerminalError(_ error: Error) -> Bool {
    guard let code = accessAuthorizationErrorCode(error) else { return false }
    return ["expired", "already-decided", "no-longer-pending"].contains(code)
}

func accessAuthorizationIsStaleSelectionError(_ error: Error) -> Bool {
    guard let code = accessAuthorizationErrorCode(error) else { return false }
    return ["inactive-grant", "invalid-selection", "stale-revision"].contains(code)
}

/// The review's Answer privacy row: the policy the form's rules are judged
/// against, by name when the overview lists it.
func accessAnswerPrivacySummary(form: AccessAuthorizationFormState, overview: AccessOverview) -> String {
    switch form.answerRelease {
    case .reviewed:
        overview.policyFamilies.first(where: { $0.id == form.policyFamilyId })?.name
            ?? "Privacy policy"
    case .unreviewed:
        "No privacy review"
    }
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

/// The semantic colour a capability is drawn in.
///
/// A granted capability is never `withheld`: grey means the connection does
/// not hold it, so a granted one drawn grey would say the opposite of what it
/// means. Danger belongs to Direct alone — the capability that actually
/// returns raw records — which is why an answer released without review is the
/// warning tone rather than a second red.
enum AccessCapabilityTone: Equatable {
    case granted
    case raw
    case unreviewed
    case notes
    case withheld
}

func accessCapabilityTone(
    _ capability: AccessCapability,
    held: Bool,
    unreviewed: Bool = false
)
    -> AccessCapabilityTone {
    guard held else { return .withheld }
    switch capability {
    case .answer: return unreviewed ? .unreviewed : .granted
    case .direct: return .raw
    case .notes: return .notes
    }
}

/// What a connection would be allowed to do, as the three slots print it.
struct AccessCapabilityHoldings: Equatable {
    var answer = false
    var direct = false
    var notes = false
    var answerUnreviewed = false

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

    func tone(_ capability: AccessCapability) -> AccessCapabilityTone {
        accessCapabilityTone(
            capability,
            held: holds(capability),
            unreviewed: capability == .answer && answerUnreviewed
        )
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
        case .answer(_, let release):
            holdings.answer = true
            holdings.answerUnreviewed = release == .unreviewed
        }
    }
    return holdings
}

/// The capabilities a single source list governs.
///
/// One list standing for two capabilities has to name both when it refuses:
/// saying only "Direct" in front of a list the owner chose for Answer and
/// Direct together describes a boundary that is not there.
enum AccessSourceScope: Hashable {
    case answer
    case direct
    case shared

    var name: String {
        switch self {
        case .answer: "Answer"
        case .direct: "Direct"
        case .shared: "Answer and Direct"
        }
    }

    var editorTitle: String {
        switch self {
        case .answer: "Answer sources"
        case .direct: "Direct sources"
        case .shared: "Sources for Answer and Direct"
        }
    }
}

/// The most source decisions one rule can record on the wire.
let accessMaxSourceSelections = 256

/// Shown where the fix is — inside the source list that earns it.
func accessSourceBoundaryError(
    scope: AccessSourceScope,
    permitsAnyKnownSource: Bool,
    recordedSelectionCount: Int
)
    -> String? {
    if recordedSelectionCount > accessMaxSourceSelections {
        return "\(scope.name) can record at most \(accessMaxSourceSelections) source selections."
    }
    if !permitsAnyKnownSource {
        return "Select at least one source for \(scope.name)."
    }
    return nil
}

/// Nothing else about a connection means anything until it grants something.
let accessNoCapabilityMessage = "Select at least one capability."

enum AccessAuthorizationStep: CaseIterable, Hashable {
    case connection
    case permissions
    case data
    case review

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

enum AccessAnswerReleaseChoice: String, CaseIterable, Identifiable {
    case reviewed
    case unreviewed
    var id: String {
        rawValue
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

/// The permissions being approved, as the wizard's steps edit them.
///
/// The form holds capabilities and source lists only; which connection they
/// belong to is the Connection step's choice.
struct AccessAuthorizationFormState {
    var notesEnabled = false
    var directEnabled = false
    var answerEnabled = true
    var directSources: AccessSourceSelectionState
    var answerSources: AccessSourceSelectionState
    /// Whether one source list governs both Answer and Direct. They read the
    /// same corpus, so one list is the usual answer; a narrower one for
    /// Direct, which returns raw records, is the deliberate exception. While
    /// the two are linked `answerSources` is the only list that exists —
    /// `directSources` is not consulted and not kept in step.
    var linkSources = true
    var answerRelease: AccessAnswerReleaseChoice = .reviewed
    var policyFamilyId = ""

    init(sourceIds: Set<String>) {
        directSources = .newGrant(knownSourceIds: sourceIds)
        answerSources = .newGrant(knownSourceIds: sourceIds)
    }

    /// The form the wizard opens on, built from what the gateway serves for
    /// the request right now: every available source the overview lists is
    /// known to it, and the prefill is the rules the lookup names, if any. A
    /// refresh after a refused selection rebuilds the form the same way, so
    /// permissions revoked in the meantime are gone from it.
    static func opening(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
        prefill: [AccessGrantRule]?
    )
        -> AccessAuthorizationFormState {
        var form = AccessAuthorizationFormState(sourceIds: overview.availableSourceIds)
        form.populate(request: request, overview: overview, prefill: prefill)
        return form
    }

    /// Start from the request's defaults — Answer on, released through the
    /// default policy — or from `prefill`, the rules of a connection the
    /// same app already holds, so the wizard opens on what that connection
    /// can do today rather than on a blank grant.
    ///
    /// Only available sources are known to the lists, so "every source" means
    /// the same set on every platform that approves the same client; a source
    /// the grant names that is listed but unavailable is a retained reference,
    /// like one the overview no longer lists at all.
    mutating func populate(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
        prefill: [AccessGrantRule]? = nil
    ) {
        policyFamilyId = overview.defaultPolicyFamilyId
            ?? overview.policyFamilies.first?.id
            ?? ""
        guard let prefill else {
            answerEnabled = true
            return
        }
        let known = overview.availableSourceIds
        notesEnabled = false
        directEnabled = false
        answerEnabled = false
        var directBoundary: AccessSourceBoundary?
        var answerBoundary: AccessSourceBoundary?
        for rule in prefill {
            switch rule {
            case .notes:
                notesEnabled = true
            case .direct(let sources):
                directEnabled = true
                directBoundary = sources
                directSources = AccessSourceSelectionState(boundary: sources, knownSourceIds: known)
            case .answer(let sources, let release):
                answerEnabled = true
                answerBoundary = sources
                answerSources = AccessSourceSelectionState(boundary: sources, knownSourceIds: known)
                switch release {
                case .reviewed(let familyId):
                    answerRelease = .reviewed
                    // A policy the overview no longer lists cannot be picked,
                    // so the default already set above stands in for it.
                    if overview.policyFamilies.contains(where: { $0.id == familyId }) {
                        policyFamilyId = familyId
                    }
                case .unreviewed:
                    answerRelease = .unreviewed
                }
            }
        }
        // Two reading rules drawn on the same boundary are one list; a Direct
        // rule narrower than Answer's is the separate list it was written as.
        if let directBoundary, let answerBoundary {
            linkSources = directBoundary == answerBoundary
        }
    }

    /// Whether Answer is part of this grant, however it got there.
    func answerActive(request: AccessAuthorizationRequest) -> Bool {
        answerEnabled || request.requiresAnswer
    }

    /// Which capabilities this grant would hold, as the three slots print it.
    func holdings(request: AccessAuthorizationRequest) -> AccessCapabilityHoldings {
        let answer = answerActive(request: request)
        return AccessCapabilityHoldings(
            answer: answer,
            direct: directEnabled,
            notes: notesEnabled,
            answerUnreviewed: answer && answerRelease == .unreviewed
        )
    }

    /// The scopes this grant asks the owner to draw a source list for, in slot
    /// order. Two linked reading capabilities share one list, so they ask once.
    func sourceScopes(request: AccessAuthorizationRequest) -> [AccessSourceScope] {
        let answer = answerActive(request: request)
        if answer, directEnabled { return linkSources ? [.shared] : [.answer, .direct] }
        if answer { return [.answer] }
        return directEnabled ? [.direct] : []
    }

    /// The source list a scope edits. A linked pair edits Answer's, which is
    /// what makes the Direct rule written below Answer's list by construction
    /// rather than by keeping a second copy in step with it.
    func sources(for scope: AccessSourceScope) -> AccessSourceSelectionState {
        scope == .direct ? directSources : answerSources
    }

    mutating func setSources(_ value: AccessSourceSelectionState, for scope: AccessSourceScope) {
        if scope == .direct { directSources = value } else { answerSources = value }
    }

    /// What approval sends to a gateway without connection proposals, or nil
    /// while the form does not yet describe a grant the gateway would accept.
    /// The credential is labelled with the client's own name.
    func selection(
        request: AccessAuthorizationRequest,
        overview: AccessOverview
    )
        -> AccessAuthorizationSelection? {
        let rules = rules(request: request, overview: overview)
        guard !rules.isEmpty else { return nil }
        return .connect(
            rules: rules,
            credentialLabel: accessAuthorizationPrefix(request.clientName, maxUTF16Length: 160)
        )
    }

    /// The rules the form describes, or none while it does not yet describe
    /// a grant the gateway would accept.
    func rules(
        request: AccessAuthorizationRequest,
        overview: AccessOverview
    )
        -> [AccessGrantRule] {
        let known = overview.availableSourceIds
        var result: [AccessGrantRule] = notesEnabled ? [.notes] : []
        if directEnabled {
            let selection = sources(
                for: linkSources && answerActive(request: request) ? .shared : .direct
            )
            guard selection.permitsAnyKnownSource(known) else { return [] }
            let boundary = selection.boundary(knownSourceIds: known)
            guard boundary.sourceIds.count <= accessMaxSourceSelections else { return [] }
            result.append(.direct(sources: boundary))
        }
        if answerActive(request: request) {
            guard answerSources.permitsAnyKnownSource(known) else { return [] }
            let release: AccessAnswerRelease
            switch answerRelease {
            case .reviewed:
                guard !policyFamilyId.isEmpty else { return [] }
                release = .reviewed(policyFamilyId: policyFamilyId)
            case .unreviewed:
                release = .unreviewed
            }
            let boundary = answerSources.boundary(knownSourceIds: known)
            guard boundary.sourceIds.count <= accessMaxSourceSelections else { return [] }
            result.append(.answer(sources: boundary, release: release))
        }
        return result
    }
}
