// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What a filter can see on one document: for each field its source can be filtered on, the items the record
/// carries, and the version of the source that wrote the record. Owner only.
public struct DocumentFilterDetails: Decodable, Equatable, Sendable {
    public struct Item: Decodable, Equatable, Sendable {
        public var id: String
        /// The item's name; its id when the account's list does not hold it.
        public var label: String
        public var listed: Bool

        public init(id: String, label: String, listed: Bool = true) {
            self.id = id
            self.label = label
            self.listed = listed
        }
    }

    public struct Field: Decodable, Equatable, Sendable {
        public var field: String
        public var noun: FilterNoun
        /// "present", "too-old" or "unknown".
        public var state: String
        /// The gateway's sentence for a field that is not present.
        public var stateText: String
        public var items: [Item]

        public init(field: String, noun: FilterNoun, state: String = "present", stateText: String = "", items: [Item]) {
            self.field = field
            self.noun = noun
            self.state = state
            self.stateText = stateText
            self.items = items
        }
    }

    public var documentId: String
    /// The source version that wrote the record; 0 for a record written before versions.
    public var sourceVersion: Int
    public var fields: [Field]

    public init(documentId: String, sourceVersion: Int, fields: [Field]) {
        self.documentId = documentId
        self.sourceVersion = sourceVersion
        self.fields = fields
    }
}

/// Whether one capability of one access level can read a document, and why, in the gateway's words.
public struct DocumentAccessVerdict: Decodable, Equatable, Sendable {
    /// The code of a capability the level does not grant.
    public static let notGranted = "permission-not-granted"

    public var readable: Bool
    public var code: String
    public var text: String

    public init(readable: Bool, code: String, text: String) {
        self.readable = readable
        self.code = code
        self.text = text
    }
}

/// Every access level, with the agents on it and whether its Answer and its Direct can read one document. Owner only.
public struct DocumentAccessAudit: Decodable, Equatable, Sendable {
    public struct Notes: Decodable, Equatable, Sendable {
        /// What "readable" means for Answer.
        public var answer: String
        /// That the page is for the owner only.
        public var owner: String

        public init(answer: String, owner: String) {
            self.answer = answer
            self.owner = owner
        }
    }

    public struct Agent: Decodable, Equatable, Sendable {
        public var id: String
        public var name: String
        /// "connection" for an agent that connected itself, "device" for a paired integration.
        public var kind: String

        public init(id: String, name: String, kind: String) {
            self.id = id
            self.name = name
            self.kind = kind
        }
    }

    public struct Level: Decodable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var agents: [Agent]
        public var answer: DocumentAccessVerdict
        public var direct: DocumentAccessVerdict

        public init(id: String, name: String, agents: [Agent], answer: DocumentAccessVerdict, direct: DocumentAccessVerdict) {
            self.id = id
            self.name = name
            self.agents = agents
            self.answer = answer
            self.direct = direct
        }
    }

    public var documentId: String
    public var title: String
    public var sourceId: String
    public var sourceName: String
    /// What the gateway calls the account beside `sourceName`; nil when nothing names it.
    public var accountLabel: String?
    public var sourceVersion: Int
    public var notes: Notes
    /// In the gateway's order.
    public var levels: [Level]

    public init(
        documentId: String,
        title: String,
        sourceId: String,
        sourceName: String,
        accountLabel: String?,
        sourceVersion: Int,
        notes: Notes,
        levels: [Level]
    ) {
        self.documentId = documentId
        self.title = title
        self.sourceId = sourceId
        self.sourceName = sourceName
        self.accountLabel = accountLabel
        self.sourceVersion = sourceVersion
        self.notes = notes
        self.levels = levels
    }
}

extension DocumentAccessAudit {
    /// The account line under the title, in the gateway's words: the source's name, then the account's label.
    public var sourceLine: String {
        [sourceName, accountLabel ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
