// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// The Connection step of the access wizard, as pure state: what the approved
// sign-in becomes, what it is called, and which access level it uses.
// UIKit-free so the `swift test` lane covers it; the portal and Android print
// the same strings.

/// The three ways an approval can produce a connection.
enum AccessConnectionPath: Equatable, Sendable {
    /// A new connection on a new access level, drawn in the wizard.
    case newLevel
    /// A new connection on an access level that already exists.
    case existingLevel
    /// An existing connection that the new sign-in takes over.
    case replace
}

/// The longest connection or access level name the gateway accepts, in
/// UTF-16 units.
let accessConnectionNameMaxLength = 120

enum AccessConnectionCopy {
    static let nameLabel = "Connection name"
    static let nameEmpty = "Enter a name for this connection."
    static let levelSection = "Access level"
    static let levelHelper = "Connections that use the same access level share its permissions."
    static let suggestedTag = "Suggested"
    static let needsAnswer = "This agent needs Answer."
    static let newLevel = "New access level"
    static let connectAgent = "Connect an agent"
    static let reviewAccess = "Review access"
    static let levelNameLabel = "Access level name"
    static let replaceEntry = "Signing in again? Replace a connection"
    static let replaceTitle = "Replace a connection"
    static let replaceHelper = "The new sign-in takes over the chosen connection's name and access level. "
        + "Its old sign-in stops working."
    static let newConnectionEntry = "Connect as a new connection instead"
    static let alreadyConnectedHere = "Already connected on this device."
    static let neverUsed = "Never used"

    static func usesLevel(connection: String) -> String {
        "\(connection) uses this access level."
    }

    static func connectionCount(_ count: Int) -> String {
        switch count {
        case 0: "No connections"
        case 1: "1 connection"
        default: "\(count) connections"
        }
    }

    static func lastUsed(_ millis: Int64?) -> String {
        guard let millis else { return neverUsed }
        return "Last used \(formatUnixMillisAgo(millis))"
    }

    /// The replace-mode row's line naming the access level a connection uses.
    /// Labelled as a level because several connections can share one, and a
    /// level is often named after the agent it was first made for.
    static func connectionLevel(_ level: String) -> String {
        "Access level: \(level)"
    }

    static func newLevelName(_ name: String) -> String {
        "\(name) (new)"
    }

    static func replaces(connection: String) -> String {
        "The current sign-in of \(connection)"
    }

    static func sharedLevel(otherConnections count: Int) -> String {
        "Also used by \(count) other connection\(count == 1 ? "" : "s"). "
            + "Changing this access level later changes all of them."
    }
}

/// A name as the gateway will store it: trimmed, or nil when nothing is left.
func accessConnectionTrimmedName(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

/// A name cut to what the gateway accepts, at a character boundary. The
/// connection name's field applies it as the owner types, so that name is
/// never refused for length.
func accessConnectionClampedName(_ value: String) -> String {
    accessAuthorizationPrefix(value, maxUTF16Length: accessConnectionNameMaxLength)
}

/// Why a set of permissions cannot serve this request, or nil when it can.
/// An agent that asks through Answer is useless without it.
func accessConnectionUnavailableReason(
    rules: [AccessGrantRule],
    request: AccessAuthorizationRequest
)
    -> String? {
    request.requiresAnswer && !accessCapabilityHoldings(rules: rules).answer
        ? AccessConnectionCopy.needsAnswer
        : nil
}

/// A connection that can be replaced: live, with the permissions it holds
/// and when any of its sign-ins last reached the gateway.
struct AccessLiveConnection: Equatable, Identifiable {
    let id: String
    let name: String
    let grant: AccessGrantSummary

    var lastUsedAt: Int64? {
        grant.credentials.compactMap(\.lastUsedAt).max()
    }

    func level(in overview: AccessOverview) -> AccessLevelSummary? {
        overview.levels.first { $0.id == grant.levelId }
    }
}

/// Every connection that has not been revoked: a live interactive principal
/// with its live grant, whether or not that grant has expired.
private func accessUnrevokedConnections(_ overview: AccessOverview) -> [AccessLiveConnection] {
    overview.principals.compactMap { principal -> AccessLiveConnection? in
        guard principal.kind == "interactive",
              principal.revokedAt == nil,
              let grant = principal.grants.first(where: { $0.revokedAt == nil }) else { return nil }
        return AccessLiveConnection(id: principal.id, name: principal.name, grant: grant)
    }
}

/// The connections a new sign-in can take over at `nowMillis`: those whose
/// grant has not expired, most recently used first; those never used
/// follow, and ties are broken by name.
func accessLiveConnections(_ overview: AccessOverview, nowMillis: Int64) -> [AccessLiveConnection] {
    accessUnrevokedConnections(overview)
        .filter { connection in connection.grant.expiresAt.map { $0 > nowMillis } ?? true }
        .sorted { lhs, rhs in
            switch (lhs.lastUsedAt, rhs.lastUsedAt) {
            case (let left?, let right?) where left != right: left > right
            case (.some, nil): true
            case (nil, .some): false
            default: accessNameOrder(lhs.name, lhs.id, rhs.name, rhs.id)
            }
        }
}

/// The access levels in the order every list shows them: by name, whatever the case.
func accessLevelsByName(_ overview: AccessOverview) -> [AccessLevelSummary] {
    overview.levels.sorted { accessNameOrder($0.name, $0.id, $1.name, $1.id) }
}

private func accessNameOrder(_ lhsName: String, _ lhsId: String, _ rhsName: String, _ rhsId: String) -> Bool {
    let left = lhsName.lowercased()
    let right = rhsName.lowercased()
    return left == right ? lhsId < rhsId : left < right
}

/// What the review prints about the connection an approval produces.
struct AccessConnectionReview: Equatable {
    let connectionName: String
    /// The Access level row's value, or nil when there is no level to name.
    let accessLevel: String?
    /// The Replaces row's value, or nil when nothing is replaced.
    let replaces: String?
    /// The note that other connections share the level, when they do.
    let levelFootnote: String?
    /// Whether this approval makes the level's decisions, on its own steps: a new level, or a gateway without
    /// connection proposals. A connection to an existing level takes that level's decisions as they are.
    var decidesPermissions = true

    /// A gateway without connection proposals connects the client to the
    /// principal it recognises, or to a new one named after the client.
    static func legacy(
        request: AccessAuthorizationRequest,
        reconnect: AccessReconnectProposal?
    )
        -> AccessConnectionReview {
        AccessConnectionReview(
            connectionName: reconnect?.principal.name ?? request.clientName,
            accessLevel: nil,
            replaces: nil,
            levelFootnote: nil
        )
    }
}

/// The Connection step's choices, opened from the gateway's proposal.
struct AccessConnectionChoice: Equatable {
    let proposal: AccessConnectionProposal
    /// The level the matched connection uses, when it is live: listed first
    /// and tagged as suggested.
    let suggestedLevelId: String?
    /// Whether the step is picking a connection to replace rather than
    /// describing a new one.
    var replacing: Bool
    var name: String
    /// The existing level the new connection uses; nil picks a new level.
    var levelId: String?
    var levelName: String
    var connectionId: String?

    /// Preselect what the gateway recommends when it still applies: the
    /// matched level or connection must be live and able to serve the
    /// request, and a matched connection must not have expired by
    /// `nowMillis`. Anything else opens on a new access level, with the
    /// matched level still tagged as suggested.
    static func opening(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
        proposal: AccessConnectionProposal,
        nowMillis: Int64
    )
        -> AccessConnectionChoice {
        let match = proposal.match
        let suggestedLevel = overview.levels.first { $0.id == match?.levelId }
        let target = accessLiveConnections(overview, nowMillis: nowMillis).first { $0.id == match?.connectionId }
        let targetServes = target.map {
            accessConnectionUnavailableReason(rules: $0.grant.rules, request: request) == nil
        } ?? false
        let replace = proposal.recommended == .replace && targetServes
        let levelServes = suggestedLevel.map {
            accessConnectionUnavailableReason(rules: $0.rules, request: request) == nil
        } ?? false
        let preselectLevel = proposal.recommended == .existingLevel && levelServes
        return AccessConnectionChoice(
            proposal: proposal,
            suggestedLevelId: suggestedLevel?.id,
            replacing: replace,
            name: accessConnectionClampedName(proposal.defaultName),
            levelId: preselectLevel ? suggestedLevel?.id : nil,
            levelName: accessConnectionClampedName(proposal.defaultLevelName),
            connectionId: replace ? target?.id : nil
        )
    }

    var path: AccessConnectionPath {
        if replacing { return .replace }
        return levelId == nil ? .newLevel : .existingLevel
    }

    /// The permissions a new level starts from: those of the connection the
    /// gateway matched, when it found one.
    var prefillRules: [AccessGrantRule]? {
        proposal.match?.grant.rules
    }

    /// The levels to pick from: the suggested one first, the rest by name.
    func orderedLevels(overview: AccessOverview) -> [AccessLevelSummary] {
        let named = accessLevelsByName(overview)
        return named.filter { $0.id == suggestedLevelId } + named.filter { $0.id != suggestedLevelId }
    }

    /// The line under the suggested level, naming the connection that uses it.
    func suggestion(for level: AccessLevelSummary) -> String? {
        guard level.id == suggestedLevelId, let match = proposal.match else { return nil }
        return AccessConnectionCopy.usesLevel(connection: match.connectionName)
    }

    /// The line inside the replace row of the connection the gateway
    /// recognised as this agent's on this device, whichever connection is
    /// picked. The row carries the Suggested tag beside it.
    func suggestion(for connection: AccessLiveConnection) -> String? {
        guard proposal.recommended == .replace, connection.id == proposal.match?.connectionId else { return nil }
        return AccessConnectionCopy.alreadyConnectedHere
    }

    var nameError: String? {
        guard !replacing else { return nil }
        return accessConnectionTrimmedName(name) == nil ? AccessConnectionCopy.nameEmpty : nil
    }

    /// Why the new level's name cannot be sent, as the level editor judges
    /// a name. Only a new level sends one.
    func levelNameError(overview: AccessOverview) -> String? {
        path == .newLevel ? accessLevelNameProblem(levelName, id: "new", levels: overview.levels) : nil
    }

    /// Whether the gateway's refusal of a level name still bars approval.
    /// The sheet holds that refusal until the level name is edited, and only
    /// a new level sends a name.
    func levelNameRefusalApplies(_ refused: Bool) -> Bool {
        refused && path == .newLevel
    }

    /// This choice, reopened after a refused approval, with the names the
    /// owner typed into `previous` when both describe the same path. The
    /// permissions still come from the refreshed proposal.
    func keepingNames(from previous: AccessConnectionChoice?) -> AccessConnectionChoice {
        guard let previous, previous.path == path else { return self }
        var kept = self
        kept.name = previous.name
        kept.levelName = previous.levelName
        return kept
    }

    func selectedLevel(overview: AccessOverview) -> AccessLevelSummary? {
        overview.levels.first { $0.id == levelId }
    }

    /// The connection picked for replacement. It is looked up without the
    /// expiry filter the list applies, so the review and the selection do
    /// not change with the clock; the gateway refuses a grant that has
    /// expired since.
    func selectedConnection(overview: AccessOverview) -> AccessLiveConnection? {
        accessUnrevokedConnections(overview).first { $0.id == connectionId }
    }

    /// Whether the Connection step describes something approval could send.
    func isComplete(request: AccessAuthorizationRequest, overview: AccessOverview) -> Bool {
        switch path {
        case .newLevel:
            return nameError == nil && levelNameError(overview: overview) == nil
        case .existingLevel:
            guard nameError == nil, let level = selectedLevel(overview: overview) else { return false }
            return accessConnectionUnavailableReason(rules: level.rules, request: request) == nil
        case .replace:
            guard let target = selectedConnection(overview: overview) else { return false }
            return accessConnectionUnavailableReason(rules: target.grant.rules, request: request) == nil
        }
    }

    /// The permissions the connection takes on as they stand: the existing
    /// level's, or those of the connection replaced. Nil for a new level,
    /// whose permissions this approval draws.
    /// The existing level the connection will use, or nil for a new level.
    func reviewedLevel(overview: AccessOverview) -> AccessLevelSummary? {
        switch path {
        case .newLevel: nil
        case .existingLevel: selectedLevel(overview: overview)
        case .replace: selectedConnection(overview: overview)?.level(in: overview)
        }
    }

    func existingRules(overview: AccessOverview) -> [AccessGrantRule]? {
        switch path {
        case .newLevel: nil
        case .existingLevel: selectedLevel(overview: overview)?.rules
        case .replace: selectedConnection(overview: overview)?.grant.rules
        }
    }

    /// What approval sends, or nil while the choices are incomplete.
    /// `newLevelRules` are the rules drawn for a new level, nil while they
    /// cannot be sent.
    func selection(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
        newLevelRules: [AccessGrantRule]?
    )
        -> AccessAuthorizationSelection? {
        guard isComplete(request: request, overview: overview) else { return nil }
        switch path {
        case .newLevel:
            guard let rules = newLevelRules,
                  let name = accessConnectionTrimmedName(name),
                  let levelName = accessConnectionTrimmedName(levelName) else { return nil }
            return .newConnection(name: name, level: .new(name: levelName, rules: rules))
        case .existingLevel:
            guard let name = accessConnectionTrimmedName(name),
                  let level = selectedLevel(overview: overview) else { return nil }
            return .newConnection(
                name: name,
                level: .existing(levelId: level.id, expectedLevelRevision: level.revision)
            )
        case .replace:
            guard let target = selectedConnection(overview: overview) else { return nil }
            return .replaceConnection(connectionId: target.id, expectedGrantRevision: target.grant.revision)
        }
    }

    func review(overview: AccessOverview) -> AccessConnectionReview {
        switch path {
        case .newLevel:
            return AccessConnectionReview(
                connectionName: accessConnectionTrimmedName(name) ?? name,
                accessLevel: AccessConnectionCopy.newLevelName(accessConnectionTrimmedName(levelName) ?? levelName),
                replaces: nil,
                levelFootnote: nil
            )
        case .existingLevel:
            let level = selectedLevel(overview: overview)
            return AccessConnectionReview(
                connectionName: accessConnectionTrimmedName(name) ?? name,
                accessLevel: level?.name,
                replaces: nil,
                levelFootnote: Self.sharedFootnote(otherConnections: level?.connectionCount ?? 0),
                decidesPermissions: false
            )
        case .replace:
            let target = selectedConnection(overview: overview)
            let level = target?.level(in: overview)
            return AccessConnectionReview(
                connectionName: target?.name ?? "",
                accessLevel: level?.name,
                replaces: target.map { AccessConnectionCopy.replaces(connection: $0.name) },
                // The connection being replaced is one of the level's own.
                levelFootnote: Self.sharedFootnote(otherConnections: (level?.connectionCount ?? 0) - 1),
                decidesPermissions: false
            )
        }
    }

    private static func sharedFootnote(otherConnections count: Int) -> String? {
        count > 0 ? AccessConnectionCopy.sharedLevel(otherConnections: count) : nil
    }
}

/// The screens an approval walks through, in order. The Connection step
/// (`.name`) comes first when the gateway proposes one. A new level, and the
/// flow of a gateway without proposals, then ask the level editor's questions
/// for a new level; a level or connection that already exists goes straight
/// to the review.
func accessAuthorizationFlow(choice: AccessConnectionChoice?, draft: AccessLevelDraft) -> [AccessFlowStep] {
    guard let choice else { return draft.creationSteps }
    return [.name] + (choice.path == .newLevel ? draft.creationSteps : [.review])
}

/// The numbered steps the indicator shows for a flow, each once.
func accessAuthorizationIndicatorSteps(_ flow: [AccessFlowStep]) -> [AccessAuthorizationStep] {
    var seen: Set<AccessAuthorizationStep> = []
    return flow.map(AccessAuthorizationStep.init).filter { seen.insert($0).inserted }
}

/// Where the wizard opens for a pending request: on the Connection step when
/// the gateway proposes one, otherwise on Permissions with the `connect`
/// flow a gateway without proposals accepts, pre-filled from the principal
/// it would reconnect to. `nowMillis` only decides which connections have
/// expired.
struct AccessAuthorizationOpening {
    let choice: AccessConnectionChoice?
    /// The new level the approval draws, as its decision screens edit it.
    let level: AccessDraftDecisions
    let step: AccessFlowStep

    init(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
        connection: AccessConnectionProposal?,
        reconnect: AccessReconnectProposal?,
        nowMillis: Int64
    ) {
        let opened = connection.map {
            AccessConnectionChoice.opening(request: request, overview: overview, proposal: $0, nowMillis: nowMillis)
        }
        let prefill = connection == nil ? reconnect?.grant.rules : opened?.prefillRules
        let draft = AccessLevelDraft.approving(request: request, overview: overview, prefill: prefill)
        choice = opened
        level = AccessDraftDecisions(draft: draft, overview: overview, original: draft, answerRequired: request.requiresAnswer)
        step = opened == nil ? .permissions : .name
    }
}

/// Whether a refused approval named an access level that already exists,
/// which the owner fixes on the Connection step rather than by reloading.
func accessAuthorizationIsLevelNameTaken(_ error: Error) -> Bool {
    accessAuthorizationErrorCode(error) == "level-name-taken"
}

/// The screen a refused approval returns the wizard to, or nil to stay on the
/// current one. A taken level name is fixed on the Connection step. A stale
/// selection whose choices were refreshed reopens where the refreshed
/// request opens: the Connection step when the gateway proposes one,
/// otherwise Permissions.
func accessAuthorizationRefusalStep(error: Error, hasChoice: Bool, refreshed: Bool) -> AccessFlowStep? {
    if accessAuthorizationIsLevelNameTaken(error) { return hasChoice ? .name : nil }
    guard refreshed, accessAuthorizationIsStaleSelectionError(error) else { return nil }
    return hasChoice ? .name : .permissions
}
