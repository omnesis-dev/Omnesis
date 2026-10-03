// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation

/// Local unsent text, isolated by gateway credential and conversation. The request
/// identity survives relaunch so an ambiguous HTTP result can be retried safely.
struct ConversationDraft: Codable, Equatable {
    var text: String
    var clientMessageId: String
    var submission: ConversationDraftSubmission?
    var answerCurrentQuestion: Bool?
}

struct ConversationDraftSubmission: Codable, Equatable {
    let interrupt: Bool
    let deepResearch: Bool
    let clarificationId: String?
}

struct ConversationDraftStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    static func scope(url: URL, token: String) -> String {
        SHA256.hash(data: Data("\(url.absoluteString)\n\(token)".utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    func research(_ key: String) -> Bool {
        defaults.bool(forKey: "agent.draft.research.\(key)")
    }

    func setResearch(_ enabled: Bool, key: String) {
        if enabled {
            defaults.set(true, forKey: "agent.draft.research.\(key)")
        } else {
            defaults.removeObject(forKey: "agent.draft.research.\(key)")
        }
    }

    func hasBackup(_ key: String) -> Bool {
        defaults.data(forKey: "agent.draft.backup.\(key)") != nil
    }

    func beginReplacement(_ text: String, key: String, deepResearch: Bool = false, answerCurrentQuestion: Bool = true) {
        if !hasBackup(key) {
            let original = read(key) ?? ConversationDraft(text: "", clientMessageId: UUID().uuidString)
            defaults.set(try? JSONEncoder().encode(original), forKey: "agent.draft.backup.\(key)")
            defaults.set(research(key), forKey: "agent.draft.backupResearch.\(key)")
        }
        write(text, key: key)
        renewRequest(key)
        setResearch(deepResearch, key: key)
        if var draft = read(key) {
            draft.answerCurrentQuestion = answerCurrentQuestion
            defaults.set(try? JSONEncoder().encode(draft), forKey: "agent.draft.\(key)")
        }
    }

    func restoreBackup(_ key: String) {
        guard let data = defaults.data(forKey: "agent.draft.backup.\(key)") else { return }
        defaults.set(data, forKey: "agent.draft.\(key)")
        setResearch(defaults.bool(forKey: "agent.draft.backupResearch.\(key)"), key: key)
        defaults.removeObject(forKey: "agent.draft.backup.\(key)")
        defaults.removeObject(forKey: "agent.draft.backupResearch.\(key)")
    }

    func read(_ key: String) -> ConversationDraft? {
        guard let data = defaults.data(forKey: "agent.draft.\(key)") else { return nil }
        return try? JSONDecoder().decode(ConversationDraft.self, from: data)
    }

    func renewRequest(_ key: String) {
        guard var draft = read(key) else { return }
        draft.clientMessageId = UUID().uuidString
        draft.submission = nil
        defaults.set(try? JSONEncoder().encode(draft), forKey: "agent.draft.\(key)")
    }

    func prepare(key: String, submission: ConversationDraftSubmission) -> ConversationDraft? {
        guard var draft = read(key) else { return nil }
        if draft.submission == nil {
            draft.submission = submission
            defaults.set(try? JSONEncoder().encode(draft), forKey: "agent.draft.\(key)")
        }
        return draft
    }

    func move(from: String, to: String) {
        guard from != to, let data = defaults.data(forKey: "agent.draft.\(from)") else { return }
        defaults.set(data, forKey: "agent.draft.\(to)")
        defaults.removeObject(forKey: "agent.draft.\(from)")
        setResearch(research(from), key: to)
        setResearch(false, key: from)
        for prefix in ["agent.draft.backup.", "agent.draft.backupResearch."] {
            if let value = defaults.object(forKey: prefix + from) {
                defaults.set(value, forKey: prefix + to)
                defaults.removeObject(forKey: prefix + from)
            }
        }
    }

    func write(_ text: String, key: String) {
        guard !text.isEmpty else {
            defaults.removeObject(forKey: "agent.draft.\(key)")
            return
        }
        if read(key)?.text == text { return }
        let draft = ConversationDraft(
            text: text, clientMessageId: UUID().uuidString, answerCurrentQuestion: read(key)?.answerCurrentQuestion
        )
        defaults.set(try? JSONEncoder().encode(draft), forKey: "agent.draft.\(key)")
    }
}

public struct ConversationClarification: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let question: String
    public let choices: [Choice]
    public struct Choice: Decodable, Sendable, Equatable {
        public let label: String
        public let description: String?
    }
}

public struct ConversationQueuedMessage: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let text: String
    public let status: String
    public let error: String?
    public var deepResearch: Bool?
}

public struct ConversationControls: Decodable, Sendable, Equatable {
    public let busy: Bool
    public let pendingClarification: ConversationClarification?
    public let queuedMessages: [ConversationQueuedMessage]
    public var capabilities: Capabilities?

    public struct Capabilities: Decodable, Sendable, Equatable {
        public var coalescedQueue: Bool?
        public var queueSendNow: Bool?
    }

    public var queued: [ConversationQueuedMessage] {
        queuedMessages.filter { $0.status == "queued" }
    }

    public var queuedBubbleTexts: [String] {
        capabilities?.coalescedQueue == true ? (queued.isEmpty ? [] : [queuedText]) : queued.map(\.text)
    }

    public var queuedText: String {
        queued.map(\.text).joined(separator: "\n\n")
    }
}
