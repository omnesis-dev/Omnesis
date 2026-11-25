// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation
import Omnesis
import SwiftUI

@MainActor @Observable
final class DesktopChat {
    struct Row: Identifiable { let id: String
        let role: String
        var text: String
    }

    var rows: [Row] = []
    var sessionId: String?
    var input = ""
    var busy = false
    var failure: String?
    private var client: AgentClient?
    private var streamTask: Task<Void, Never>?
    private var cursor: String?

    func attach(_ api: DesktopAPI) {
        guard client !== api.agent || streamTask == nil else { return }
        streamTask?.cancel()
        client = api.agent
        cursor = nil
        streamTask = Task { [weak self] in await self?.listen(api.agent) }
    }

    func open(_ id: String? = nil) async {
        guard let client else { return }
        failure = nil
        do {
            let session = try await client.createSession(resumeFromId: id)
            sessionId = session.sessionId
            busy = session.busy
            rows = Self.project(session.messages)
        } catch { failure = error.localizedDescription }
    }

    func send() async {
        guard let client else { return }
        let question = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !busy else { return }
        if sessionId == nil { await open() }
        guard let sessionId else { return }
        failure = nil
        busy = true
        do {
            _ = try await client.sendMessage(sessionId: sessionId, text: question)
            input = ""
        } catch {
            // Do not resend automatically: the server may already have accepted it.
            failure = "Your message may not have reached Omnesis. Reopen this conversation before trying again. \(error.localizedDescription)"
            busy = false
        }
    }

    func cancel() async {
        guard let client, let sessionId else { return }
        do { try await client.cancel(sessionId: sessionId) }
        catch { failure = error.localizedDescription }
    }

    func detach() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func listen(_ client: AgentClient) async {
        while !Task.isCancelled {
            do {
                for try await item in client.events(lastEventId: cursor) {
                    try Task.checkCancellation()
                    if let id = item.id { cursor = id }
                    if case .resync = item.event {
                        if let sessionId { await open(sessionId) }
                    } else if item.event.sessionId == sessionId {
                        await reduce(item.event)
                    }
                }
                if Task.isCancelled { return }
                failure = "Reconnecting to your conversation…"
            } catch is CancellationError { return }
            catch {
                if Task.isCancelled { return }
                failure = "Your connection was interrupted. Reconnecting…"
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    private func reduce(_ event: AgentEvent) async {
        switch event {
        case .userMessage(_, let id, let text, _):
            if !rows.contains(where: { $0.id == id }) { rows.append(Row(id: id, role: "user", text: text)) }
        case .messageStart(_, let id):
            busy = true
            failure = nil
            if !rows.contains(where: { $0.id == id }) { rows.append(Row(id: id, role: "assistant", text: "")) }
        case .textDelta(_, let id, let delta):
            if let index = rows.firstIndex(where: { $0.id == id }) { rows[index].text += delta }
        case .messageEnd, .outputTruncated, .contextWindowExceeded:
            busy = false
            if let sessionId { await open(sessionId) }
        case .error(_, _, _, let message, _):
            busy = false
            failure = message
        default: break
        }
    }

    private static func project(_ messages: [ChatMessage]) -> [Row] {
        messages.enumerated().compactMap { index, message in
            let text: String
            switch message {
            case .user(let parts): text = parts.compactMap { if case .text(let t) = $0 { return t }
                    return nil
                }.joined(separator: "\n")
            case .assistant(let parts): text = parts.compactMap { if case .text(let t) = $0 { return t }
                    return nil
                }.joined(separator: "\n")
            default: return nil
            }
            return text.isEmpty ? nil : Row(id: "saved-\(index)", role: message.role, text: text)
        }
    }
}

struct DesktopAskView: View {
    @Environment(DesktopStore.self) private var store
    @State private var chat = DesktopChat()
    @State private var chosenConversation: String?
    var body: some View {
        HSplitView {
            List(selection: $chosenConversation) {
                Button("New conversation", systemImage: "square.and.pencil") { Task { await chat.open() } }
                ForEach(store.conversations) { conversation in
                    Text(conversation.title.isEmpty ? "Conversation" : conversation.title).lineLimit(2).tag(conversation.sessionId)
                }
            }.frame(minWidth: 150, idealWidth: 210, maxWidth: 260)
            VStack(spacing: 0) {
                if chat.rows.isEmpty {
                    ContentUnavailableView(
                        "Ask about your information",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text(
                            "Your conversations are available on every device. Add a source to give Omnesis something to search."
                        )
                    )
                } else {
                    ScrollViewReader { scroll in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 22) {
                                ForEach(chat.rows) { row in
                                    VStack(alignment: .leading, spacing: 7) {
                                        Text(row.role == "user" ? "You" : "Omnesis").font(.caption.bold()).foregroundStyle(.secondary)
                                        Text(row.text.isEmpty ? "Thinking…" : row.text).textSelection(.enabled).frame(
                                            maxWidth: .infinity,
                                            alignment: .leading
                                        )
                                    }.id(row.id)
                                }
                            }.padding(28)
                        }.onChange(of: chat.rows.last?.text) {
                            if let id = chat.rows.last?.id { scroll.scrollTo(id, anchor: .bottom) }
                        }
                    }
                }
                if let failure = chat.failure {
                    HStack {
                        Text(failure).font(.callout).foregroundStyle(.secondary)
                        Button("Choose a model") { store.openPortal() }
                    }.padding()
                }
                Divider()
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("Ask Omnesis…", text: $chat.input, axis: .vertical).lineLimit(1 ... 6)
                        .textFieldStyle(.plain).onSubmit { Task { await chat.send() } }
                        .accessibilityIdentifier("chat-input")
                    if chat.busy {
                        Button("Stop", systemImage: "stop.circle") { Task { await chat.cancel() } }
                    } else {
                        Button("Send", systemImage: "arrow.up.circle.fill") { Task { await chat.send() } }
                            .disabled(chat.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("chat-send")
                    }
                }.padding(20)
            }
        }.navigationTitle("Ask Omnesis")
            .task {
                if let api = store.api { chat.attach(api) }
                if let question = DesktopActionRouter.shared.question {
                    await chat.open()
                    chat.input = question
                    DesktopActionRouter.shared.question = nil
                }
            }
            .onChange(of: chosenConversation) { if let id = chosenConversation { Task { await chat.open(id) } } }
            .onChange(of: DesktopActionRouter.shared.newConversation) {
                Task {
                    await chat.open()
                    if let question = DesktopActionRouter.shared.question {
                        chat.input = question
                        DesktopActionRouter.shared.question = nil
                    }
                }
            }
            .onDisappear { chat.detach() }
    }
}
