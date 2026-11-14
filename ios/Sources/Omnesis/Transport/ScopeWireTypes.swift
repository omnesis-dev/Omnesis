// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A typed phone number, email address or domain, in the gateway's canonical form.
public struct ScopeIdentifier: Codable, Equatable, Hashable, Sendable {
    public var type: String
    public var value: String

    public init(type: String, value: String) {
        self.type = type
        self.value = value
    }
}

/// One entry of a saved filter. A membership or tree entry names an item of one of the source's fields by the
/// source's own id (and, for a field kept per device, the device; an empty id is the whole device). A person
/// entry carries the identifiers it matches and a name for display.
public struct ScopeRef: Codable, Equatable, Hashable, Sendable {
    public var capability: String
    public var field: String?
    public var id: String?
    public var device: String?
    public var label: String?
    public var identifiers: [ScopeIdentifier]?

    public init(
        capability: String,
        field: String? = nil,
        id: String? = nil,
        device: String? = nil,
        label: String? = nil,
        identifiers: [ScopeIdentifier]? = nil
    ) {
        self.capability = capability
        self.field = field
        self.id = id
        self.device = device
        self.label = label
        self.identifiers = identifiers
    }

    public static func membership(field: String, id: String, device: String? = nil) -> Self {
        .init(capability: "membership", field: field, id: id, device: device)
    }

    public static func tree(field: String, id: String, device: String? = nil) -> Self {
        .init(capability: "tree", field: field, id: id, device: device)
    }

    public static func person(label: String, identifiers: [ScopeIdentifier]) -> Self {
        .init(capability: "person", label: label, identifiers: identifiers)
    }

    /// Whether the entry names someone by their identifiers rather than an item of a field.
    public var isPerson: Bool {
        capability == "person"
    }

    /// The editor field the entry belongs to: its field path, or the person field.
    public var editorField: String {
        isPerson ? FilterEditorField.peopleField : field ?? ""
    }

    /// A whole device of a field kept per device.
    public var isDevice: Bool {
        !isPerson && device != nil && id?.isEmpty == true
    }
}

/// The filter one access level applies to one account, for one capability.
public struct ScopePolicy: Codable, Equatable, Hashable, Sendable {
    public struct Audience: Codable, Equatable, Hashable, Sendable {
        public var accessLevel: String
        public var capability: String
    }

    public struct Rule: Codable, Equatable, Hashable, Sendable {
        public var match: [ScopeRef]
        public var action: String
    }

    public var sourceId: String
    public var audience: Audience
    public var rules: [Rule]
    public var otherwise: String

    /// Whether this editor can express the filter: one rule that shares or hides what it matches, the other way
    /// round from everything else, naming only entries of the capabilities the gateway knows.
    public var editable: Bool {
        rules.count == 1 && ["share", "hide"].contains(otherwise)
            && rules[0].action != otherwise && ["share", "hide"].contains(rules[0].action)
            && rules[0].match.allSatisfy { ["membership", "tree", "person"].contains($0.capability) }
    }

    /// How many entries the gateway counts against `scopeFilterMaxEntries`: each of a person's identifiers, and
    /// every other entry once.
    public var entryCount: Int {
        rules.reduce(0) { total, rule in
            total + rule.match.reduce(0) { $0 + ($1.capability == "person" ? $1.identifiers?.count ?? 0 : 1) }
        }
    }

    /// The gateway holds at most `scopeFilterMaxEntries` entries in a filter.
    public var withinLimits: Bool {
        rules.count == 1 && entryCount <= scopeFilterMaxEntries
    }

    public static func empty(sourceId: String, levelId: String, capability: String) -> Self {
        Self(
            sourceId: sourceId,
            audience: .init(accessLevel: levelId, capability: capability),
            rules: [.init(match: [], action: "hide")],
            otherwise: "share"
        )
    }
}

/// The most entries one filter can hold.
public let scopeFilterMaxEntries = 256

/// What a source calls one item of a field, and several: `label` / `labels`.
public struct FilterNoun: Codable, Equatable, Hashable, Sendable {
    public var one: String
    public var many: String

    public init(one: String, many: String) {
        self.one = one
        self.many = many
    }
}

/// A device that hosts an account.
public struct FilterDevice: Codable, Equatable, Hashable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// Whether a field can be used in a new entry, and what to say when it cannot. Every sentence is the gateway's.
public enum FilterFieldState: Equatable, Sendable {
    case ready
    /// The account's records predate the field: an in-place resync of the whole account adds it.
    case needsResync(cost: String?, text: String)
    case resyncing(processed: Int, total: Int, text: String)
    /// A device hosting the account runs an Omnesis too old to record the field.
    case collectorBehind(devices: [FilterDevice], text: String)
    case gatewayBehind(text: String)
    /// The account has not sent the list of items the field can name yet.
    case listPending(text: String)
    /// The account is gone; its saved entries are kept until the owner removes them.
    case disconnected(text: String)
    /// A state this app does not know, from a newer gateway.
    case unsupported

    public var isReady: Bool {
        self == .ready
    }

    /// The gateway's sentence for a field that cannot be used yet.
    public var text: String? {
        switch self {
        case .ready: nil
        case .needsResync(_, let text), .resyncing(_, _, let text), .collectorBehind(_, let text),
             .gatewayBehind(let text), .listPending(let text), .disconnected(let text): text
        case .unsupported: "This version of Omnesis can’t use this filter yet."
        }
    }

    /// Whether the state changes by itself, so the editor is asked again until it does.
    public var settling: Bool {
        switch self {
        case .resyncing, .listPending: true
        default: false
        }
    }
}

extension FilterFieldState: Decodable {
    private enum CodingKeys: String, CodingKey { case status, cost, text, processed, total, devices }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let text = { try values.decode(String.self, forKey: .text) }
        switch try values.decode(String.self, forKey: .status) {
        case "ready": self = .ready
        case "needs-resync": self = try .needsResync(cost: values.decodeIfPresent(String.self, forKey: .cost), text: text())
        case "resyncing": self = try .resyncing(
                processed: values.decode(Int.self, forKey: .processed),
                total: values.decode(Int.self, forKey: .total),
                text: text()
            )
        case "collector-behind": self = try .collectorBehind(devices: values.decode([FilterDevice].self, forKey: .devices), text: text())
        case "gateway-behind": self = try .gatewayBehind(text: text())
        case "list-pending": self = try .listPending(text: text())
        case "disconnected": self = try .disconnected(text: text())
        default: self = .unsupported
        }
    }
}

/// How many records of an account a field cannot decide, with the gateway's sentences for them; pending while
/// the gateway is still counting.
public enum FilterFieldCounts: Equatable, Sendable, Decodable {
    case pending
    case ready(tooOld: Int, unmatched: Int, tooOldText: String?, unmatchedText: String?)

    private enum CodingKeys: String, CodingKey { case status, tooOld, unmatched, tooOldText, unmatchedText }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(String.self, forKey: .status) == "ready" else {
            self = .pending
            return
        }
        self = try .ready(
            tooOld: values.decode(Int.self, forKey: .tooOld),
            unmatched: values.decode(Int.self, forKey: .unmatched),
            tooOldText: values.decodeIfPresent(String.self, forKey: .tooOldText),
            unmatchedText: values.decodeIfPresent(String.self, forKey: .unmatchedText)
        )
    }
}

/// One field of an account a filter can match on, as the editor shows it.
public struct FilterEditorField: Equatable, Sendable, Decodable {
    /// The field path of the person field.
    public static let peopleField = "$people"

    public var field: String
    public var capability: String
    public var noun: FilterNoun
    /// A tree's word for each depth, roots first; the last names every deeper level.
    public var levels: [FilterNoun]?
    public var inside: FilterNoun?
    /// "Includes the folders inside.", for a tree.
    public var insideText: String?
    public var picker: String
    /// "device" for a field whose items exist per device, "global" otherwise.
    public var scope: String
    /// What a typed identifier may be, for the person field.
    public var identifiers: [String]?
    public var state: FilterFieldState
    public var counts: FilterFieldCounts

    public init(
        field: String,
        capability: String,
        noun: FilterNoun,
        levels: [FilterNoun]? = nil,
        inside: FilterNoun? = nil,
        insideText: String? = nil,
        picker: String,
        scope: String = "global",
        identifiers: [String]? = nil,
        state: FilterFieldState = .ready,
        counts: FilterFieldCounts = .ready(tooOld: 0, unmatched: 0, tooOldText: nil, unmatchedText: nil)
    ) {
        self.field = field
        self.capability = capability
        self.noun = noun
        self.levels = levels
        self.inside = inside
        self.insideText = insideText
        self.picker = picker
        self.scope = scope
        self.identifiers = identifiers
        self.state = state
        self.counts = counts
    }

    public var isTree: Bool {
        picker == "tree"
    }

    public var perDevice: Bool {
        scope == "device"
    }
}

/// The one resync several fields of an account wait for, or the one running for them, with the gateway's sentence
/// naming them together.
public struct FilterAccountResync: Equatable, Sendable, Decodable {
    /// "needs-resync" or "resyncing".
    public var state: String
    /// The paths of the fields it covers.
    public var fields: [String]
    public var text: String
    public var processed: Int?
    public var total: Int?

    public init(state: String, fields: [String], text: String, processed: Int? = nil, total: Int? = nil) {
        self.state = state
        self.fields = fields
        self.text = text
        self.processed = processed
        self.total = total
    }

    /// The state the fields it covers show together; nil for a state this app does not know.
    public var fieldState: FilterFieldState? {
        switch state {
        case "needs-resync": .needsResync(cost: nil, text: text)
        case "resyncing": .resyncing(processed: processed ?? 0, total: total ?? 0, text: text)
        default: nil
        }
    }
}

/// What the gateway says about filtering one account: its devices and the fields a filter can use.
public struct SourceFilterEditor: Equatable, Sendable, Decodable {
    public var sourceId: String
    public var sourceType: String
    public var devices: [FilterDevice]
    /// Whether a per-device field's tree starts at the devices; false for an account on one device.
    public var showDeviceLevel: Bool
    /// "declared", "no-profile" or "collector-behind": whether the account's source has said what can be filtered.
    public var profile: String
    /// The gateway's sentence about the account as a whole: why it has no fields, or that it is no longer connected.
    public var profileText: String?
    /// False for an account that is gone while a saved filter still names it: its entries can only be removed.
    public var connected: Bool
    public var fields: [FilterEditorField]
    /// The resync several fields share, when they do: shown once for all of them.
    public var resync: FilterAccountResync?
    /// Set while a field's counts are being worked out: ask again after it.
    public var retryAfterMs: Int?

    public init(
        sourceId: String,
        sourceType: String,
        devices: [FilterDevice] = [],
        showDeviceLevel: Bool = false,
        profile: String = "declared",
        profileText: String? = nil,
        connected: Bool = true,
        fields: [FilterEditorField],
        resync: FilterAccountResync? = nil,
        retryAfterMs: Int? = nil
    ) {
        self.sourceId = sourceId
        self.sourceType = sourceType
        self.devices = devices
        self.showDeviceLevel = showDeviceLevel
        self.profile = profile
        self.profileText = profileText
        self.connected = connected
        self.fields = fields
        self.resync = resync
        self.retryAfterMs = retryAfterMs
    }

    private enum CodingKeys: String, CodingKey {
        case sourceId, sourceType, devices, showDeviceLevel, profile, profileText, connected, fields, resync, retryAfterMs
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            sourceId: values.decode(String.self, forKey: .sourceId),
            sourceType: values.decode(String.self, forKey: .sourceType),
            devices: values.decodeIfPresent([FilterDevice].self, forKey: .devices) ?? [],
            showDeviceLevel: values.decodeIfPresent(Bool.self, forKey: .showDeviceLevel) ?? false,
            profile: values.decodeIfPresent(String.self, forKey: .profile) ?? "declared",
            profileText: values.decodeIfPresent(String.self, forKey: .profileText),
            connected: values.decodeIfPresent(Bool.self, forKey: .connected) ?? true,
            fields: values.decode([FilterEditorField].self, forKey: .fields),
            resync: values.decodeIfPresent(FilterAccountResync.self, forKey: .resync),
            retryAfterMs: values.decodeIfPresent(Int.self, forKey: .retryAfterMs)
        )
    }

    public func field(_ path: String) -> FilterEditorField? {
        fields.first { $0.field == path }
    }

    /// The state the picker shows for `field`: the shared resync's when it covers the field, the field's own
    /// otherwise.
    public func shownState(_ field: FilterEditorField) -> FilterFieldState {
        guard let resync, resync.fields.contains(field.field), let shared = resync.fieldState else { return field.state }
        return shared
    }

    /// Whether one shared resync covers every field, so the picker shows it alone, without tabs.
    public var resyncCoversEveryField: Bool {
        guard let resync, resync.fieldState != nil else { return false }
        return fields.allSatisfy { resync.fields.contains($0.field) }
    }

    /// Whether the editor must be asked again: counts are being worked out, or a field is on its way to ready.
    public var settling: Bool {
        retryAfterMs != nil || fields.contains { $0.state.settling } || resync?.state == "resyncing"
    }
}

public struct ScopeOption: Codable, Equatable, Sendable {
    public var ref: ScopeRef
    /// The full name: "~/work/atlas-api", "northstar-labs/atlas-api".
    public var label: String
    /// The last part of the name, for a row shown inside its parent: "atlas-api".
    public var shortLabel: String
    /// Records a filter sharing only this item would share; nil while the gateway is counting.
    public var count: Int?
    public var parentId: String?
    public var hasChildren: Bool?
    /// How many nodes lie above this one in its tree.
    public var depth: Int?
    public var personId: String?

    public init(
        ref: ScopeRef,
        label: String,
        shortLabel: String? = nil,
        count: Int?,
        parentId: String? = nil,
        hasChildren: Bool? = nil,
        depth: Int? = nil,
        personId: String? = nil
    ) {
        self.ref = ref
        self.label = label
        self.shortLabel = shortLabel ?? label
        self.count = count
        self.parentId = parentId
        self.hasChildren = hasChildren
        self.depth = depth
        self.personId = personId
    }
}

public struct ScopeOptions: Codable, Equatable, Sendable {
    public var sourceId: String
    public var field: String
    public var items: [ScopeOption]
    public var nextCursor: String?
    /// Set when a count is still being worked out: ask again after it.
    public var retryAfterMs: Int?

    public init(sourceId: String, field: String, items: [ScopeOption], nextCursor: String? = nil, retryAfterMs: Int? = nil) {
        self.sourceId = sourceId
        self.field = field
        self.items = items
        self.nextCursor = nextCursor
        self.retryAfterMs = retryAfterMs
    }
}

/// What a draft filter leaves readable on its account, with the gateway's sentences for the records it cannot
/// decide.
public struct ScopePreview: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public var ref: ScopeRef
        /// The full name; the id when the account's list no longer holds the item.
        public var label: String
        public var count: Int
        /// The item is gone from the account's list.
        public var missing: Bool?
        /// Why the name may be missing: "not-in-list" when the list no longer holds the item, "list-gone" when the
        /// account has no list for the field at all.
        public var reason: String?
        /// How many nodes lie above the item in its tree, for a tree field.
        public var depth: Int?

        public init(ref: ScopeRef, label: String, count: Int, missing: Bool? = nil, reason: String? = nil, depth: Int? = nil) {
            self.ref = ref
            self.label = label
            self.count = count
            self.missing = missing
            self.reason = reason
            self.depth = depth
        }
    }

    public var sourceId: String
    public var total: Int
    public var visible: Int
    public var hidden: Int
    public var tooOld: Int
    public var unmatched: Int
    public var tooOldText: String?
    public var unmatchedText: String?
    /// False for an account that is gone while a saved filter names it: every count is 0 and is not shown.
    public var connected: Bool
    public var items: [Item]

    public init(
        sourceId: String,
        total: Int,
        visible: Int,
        hidden: Int,
        tooOld: Int = 0,
        unmatched: Int = 0,
        tooOldText: String? = nil,
        unmatchedText: String? = nil,
        connected: Bool = true,
        items: [Item]
    ) {
        self.sourceId = sourceId
        self.total = total
        self.visible = visible
        self.hidden = hidden
        self.tooOld = tooOld
        self.unmatched = unmatched
        self.tooOldText = tooOldText
        self.unmatchedText = unmatchedText
        self.connected = connected
        self.items = items
    }

    private enum CodingKeys: String, CodingKey {
        case sourceId, total, visible, hidden, tooOld, unmatched, tooOldText, unmatchedText, connected, items
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            sourceId: values.decode(String.self, forKey: .sourceId),
            total: values.decode(Int.self, forKey: .total),
            visible: values.decode(Int.self, forKey: .visible),
            hidden: values.decode(Int.self, forKey: .hidden),
            tooOld: values.decodeIfPresent(Int.self, forKey: .tooOld) ?? 0,
            unmatched: values.decodeIfPresent(Int.self, forKey: .unmatched) ?? 0,
            tooOldText: values.decodeIfPresent(String.self, forKey: .tooOldText),
            unmatchedText: values.decodeIfPresent(String.self, forKey: .unmatchedText),
            connected: values.decodeIfPresent(Bool.self, forKey: .connected) ?? true,
            items: values.decode([Item].self, forKey: .items)
        )
    }

    /// The gateway's sentences for records the filter cannot decide, each present only when its count is not zero.
    public var undecidedLines: [String] {
        [tooOld > 0 ? tooOldText : nil, unmatched > 0 ? unmatchedText : nil].compactMap { $0 }
    }
}

/// The counts of a draft filter, or that the gateway is still working them out.
public enum ScopePreviewResponse: Equatable, Sendable, Decodable {
    case pending(retryAfterMs: Int)
    case ready(ScopePreview)

    private enum CodingKeys: String, CodingKey { case status, retryAfterMs }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if try values.decode(String.self, forKey: .status) == "ready" {
            self = try .ready(ScopePreview(from: decoder))
        } else {
            self = try .pending(retryAfterMs: values.decodeIfPresent(Int.self, forKey: .retryAfterMs) ?? 1500)
        }
    }

    public var ready: ScopePreview? {
        if case .ready(let preview) = self { return preview }
        return nil
    }
}

/// The gateway's reading of a typed identifier: its canonical form, or the sentence to show under the field.
public enum ScopeIdentifierCheck: Equatable, Sendable, Decodable {
    case identifier(ScopeIdentifier)
    case problem(String)

    private enum CodingKeys: String, CodingKey { case identifier, error }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if let identifier = try values.decodeIfPresent(ScopeIdentifier.self, forKey: .identifier) {
            self = .identifier(identifier)
        } else {
            self = try .problem(values.decode(String.self, forKey: .error))
        }
    }
}
