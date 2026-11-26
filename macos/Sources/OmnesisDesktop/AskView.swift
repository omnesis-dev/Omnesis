// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation
import Omnesis
import SwiftUI

struct DesktopModelObservation: Equatable {
    let api: ObjectIdentifier?
    let revision: Int
}

@MainActor @Observable
final class DesktopChat {
    struct Row: Identifiable { let id: String
        let role: String
        var text: String
    }

    var rows: [Row] = []
    var sessionId: String?
    private(set) var conversationId: String?
    private(set) var references: [AgentDocRef] = []
    private(set) var opening = false
    private(set) var terminalFailure: String?
    private var openGeneration = UUID()
    private var snapshotCursor: Int?
    private(set) var announcement = ""
    private(set) var announcementRevision = 0
    private var lastAnnouncedTerminal: String?
    var input = ""
    var busy = false
    var failure: String?
    private(set) var historyRevision = 0
    private(set) var model: ModelDisplay?
    private(set) var checkingModel = false
    private(set) var modelCheckFailure: String?
    private var modelGeneration = UUID()
    private(set) var lastAnswerStopped = false
    var needsModel: Bool {
        model.map { !$0.configured || !$0.available } ?? false
    }

    private var client: AgentClient?
    private var streamTask: Task<Void, Never>?
    private var cursor: String?

    func attach(_ api: DesktopAPI) {
        guard client !== api.agent || streamTask == nil else { return }
        streamTask?.cancel()
        if client !== api.agent {
            rows = []
            sessionId = nil
            conversationId = nil
            references = []
            terminalFailure = nil
            snapshotCursor = nil
            busy = false
            input = ""
            model = nil
            modelCheckFailure = nil
            lastAnswerStopped = false
        }
        client = api.agent
        cursor = nil
        streamTask = Task { [weak self] in await self?.listen(api.agent) }
    }

    func open(_ id: String? = nil) async {
        guard let client else { return }
        guard id != nil || (!needsModel && !checkingModel && modelCheckFailure == nil) else { return }
        let generation = UUID()
        openGeneration = generation
        opening = true
        defer { if openGeneration == generation { opening = false } }
        failure = nil
        do {
            let session = try await client.createSession(resumeFromId: id)
            guard !Task.isCancelled, self.client === client, openGeneration == generation else { return }
            sessionId = session.sessionId
            conversationId = session.conversationId ?? session.sessionId
            terminalFailure = session.terminalFailure?.message
            lastAnswerStopped = !session.busy && session.lastTurnFailure?.code == "canceled"
            if !session.busy, !lastAnswerStopped, let lastFailure = session.lastTurnFailure { failure = lastFailure.message }
            busy = session.busy
            snapshotCursor = session.eventCursor
            rows = Self.project(session.messages)
            references = DesktopChatEvidence.references(in: session.messages)
            for event in session.replayEvents {
                observeEvidence(event)
            }
            historyRevision += 1
        } catch {
            guard self.client === client, openGeneration == generation, !Task.isCancelled else { return }
            failure = error.localizedDescription
        }
    }

    func checkModel(_ api: DesktopAPI) async {
        let generation = UUID()
        modelGeneration = generation
        checkingModel = true
        defer { if modelGeneration == generation { checkingModel = false } }
        do {
            let display: ModelDisplay = try await api.request("GET", "agent/model")
            guard !Task.isCancelled, client === api.agent, modelGeneration == generation else { return }
            model = display
            modelCheckFailure = nil
        } catch is CancellationError {} catch {
            guard client === api.agent, modelGeneration == generation, !Task.isCancelled else { return }
            model = nil
            modelCheckFailure = "Could not check your answer model. Check the connection and try again."
        }
    }

    func send() async {
        guard let client else { return }
        let question = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !busy, !opening, terminalFailure == nil, !needsModel, !checkingModel,
              modelCheckFailure == nil else { return }
        if sessionId == nil { await open() }
        guard let sessionId, !busy, self.client === client else { return }
        failure = nil
        busy = true
        do {
            _ = try await client.sendMessage(sessionId: sessionId, text: question)
            guard self.client === client, self.sessionId == sessionId else { return }
            if input.trimmingCharacters(in: .whitespacesAndNewlines) == question { input = "" }
            historyRevision += 1
        } catch {
            guard self.client === client, self.sessionId == sessionId else { return }
            // Do not resend automatically: the server may already have accepted it.
            failure = "Your message may not have reached Omnesis. Reopen this conversation before trying again. \(error.localizedDescription)"
            busy = false
        }
    }

    func cancel() async {
        guard let client, let sessionId, !opening else { return }
        do { try await client.cancel(sessionId: sessionId) }
        catch {
            guard self.client === client, self.sessionId == sessionId else { return }
            failure = error.localizedDescription
        }
    }

    func detach() {
        streamTask?.cancel()
        streamTask = nil
        openGeneration = UUID()
        modelGeneration = UUID()
        opening = false
        client = nil
    }

    private func listen(_ client: AgentClient) async {
        while !Task.isCancelled {
            do {
                for try await item in client.events(lastEventId: cursor) {
                    try Task.checkCancellation()
                    if let id = item.id { cursor = id }
                    if let sequence = item.id.flatMap(Int.init), let snapshotCursor, sequence <= snapshotCursor { continue }
                    if case .resync = item.event {
                        if let id = conversationId ?? sessionId { await open(id) }
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
        observeEvidence(event)
        switch event {
        case .userMessage(_, let id, let text, _):
            if !rows.contains(where: { $0.id == id }) { rows.append(Row(id: id, role: "user", text: text)) }
        case .messageStart(_, let id):
            busy = true
            failure = nil
            lastAnswerStopped = false
            if !rows.contains(where: { $0.id == id }) { rows.append(Row(id: id, role: "assistant", text: "")) }
        case .textDelta(_, let id, let delta):
            if let index = rows.firstIndex(where: { $0.id == id }) { rows[index].text += delta }
            else if busy, let index = rows.indices.last, rows[index].role == "assistant", rows[index].id.hasPrefix("saved-"),
                    snapshotCursor != nil {
                rows[index] = Row(id: id, role: "assistant", text: rows[index].text + delta)
            }
        case .messageEnd(let session, let message, let reason, _):
            let key = session + ":" + message + ":" + reason
            if key != lastAnnouncedTerminal {
                lastAnnouncedTerminal = key
                announcement = reason == "end_turn" ? "Omnesis finished answering." : reason == "canceled" ?
                    "Response stopped. The answer is incomplete." : "The response was interrupted. Review the conversation before trying again."
                announcementRevision += 1
            }
            lastAnswerStopped = reason == "canceled" || reason == "cancelled"
            busy = false
            if let id = conversationId ?? sessionId { await open(id) }
        case .outputTruncated, .contextWindowExceeded:
            busy = false
            if let id = conversationId ?? sessionId { await open(id) }
        case .error(_, _, _, let message, _):
            busy = false
            failure = message
        default: break
        }
    }

    private func observeEvidence(_ event: AgentEvent) {
        switch event {
        case .citation(_, _, _, let ref, _, _, _, _):
            references = DesktopChatEvidence.merging(references, [ref])
        case .citationsUpdate(_, let added, let removed):
            references = DesktopChatEvidence.merging(references, added, removing: removed)
        case .toolResult(_, _, _, let result, _):
            references = DesktopChatEvidence.merging(references, DesktopChatEvidence.annotations(in: result))
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
    @Environment(\.desktopContrast) private var contrast
    @Environment(\.displayScale) private var displayScale
    @Environment(\.openSettings) private var openSettings
    @Environment(\.scenePhase) private var scenePhase
    @State private var chat: DesktopChat
    @State private var chosenConversation: String?
    @State private var showHistory = false
    @State private var showSources = false
    @FocusState private var composerFocused: Bool
    @State private var scrollGeometry: DesktopChatScrollGeometry?
    @State private var scrollTarget: String? = "chat-bottom"
    private func followsLatest(_ context: DesktopChatScrollObservation.Kind) -> Bool {
        let geometry = scrollGeometry
        let follows = geometry?.nearLatest ?? true
        scrollObservation?(DesktopChatScrollObservation(kind: context, prior: geometry, followsLatest: follows))
        return follows
    }

    private let scrollObservation: (@Sendable (DesktopChatScrollObservation) -> Void)?

    @MainActor init(initialChat: DesktopChat? = nil, scrollObservation: (@Sendable (DesktopChatScrollObservation) -> Void)? = nil) {
        _chat = State(initialValue: initialChat ?? DesktopChat())
        self.scrollObservation = scrollObservation
    }

    var body: some View {
        HSplitView {
            if showHistory {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 4) {
                        Text("Conversations").font(.callout.weight(.semibold)).accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 4)
                        Button("New conversation", systemImage: "square.and.pencil") { startConversation() }
                            .labelStyle(.iconOnly).buttonStyle(.borderless).frame(width: 28, height: 28)
                            .foregroundStyle(DesktopTheme.secondary).accessibilityLabel("New conversation")
                            .accessibilityIdentifier("chat-history-new").help("New conversation")
                        Button("Refresh history", systemImage: "arrow.clockwise") { Task { await store.refreshConversationHistory() } }
                            .labelStyle(.iconOnly).buttonStyle(.borderless).frame(width: 28, height: 28)
                            .foregroundStyle(DesktopTheme.secondary).accessibilityLabel("Refresh history")
                            .accessibilityIdentifier("chat-history-refresh").help("Refresh history")
                    }.padding(.horizontal, 12).padding(.top, 12)
                    if let failure = store.conversationHistoryFailure {
                        Text(failure).font(.callout).foregroundStyle(DesktopTheme.secondary).padding(.horizontal, 12)
                    }
                    List(selection: $chosenConversation) {
                        ForEach(store.conversations) { conversation in
                            Text(conversation.title.isEmpty ? "Conversation" : conversation.title)
                                .font(.callout).foregroundStyle(DesktopTheme.ink).lineLimit(2).tag(conversation.sessionId)
                                .listRowSeparator(.hidden)
                                .listRowBackground(chosenConversation == conversation.sessionId ? DesktopTheme.selected : Color.clear)
                                .overlay(alignment: .leading) {
                                    if chosenConversation == conversation.sessionId {
                                        Capsule().fill(DesktopTheme.primary)
                                            .frame(width: contrast == .increased ? 4 : 3, height: contrast == .increased ? 22 : 16)
                                            .offset(x: -10)
                                    }
                                }
                        }
                    }.listStyle(.sidebar).scrollContentBackground(.hidden)
                }.background(DesktopTheme.panel).frame(width: 190).frame(maxHeight: .infinity)
            }
            VStack(spacing: 0) {
                if chat.rows.isEmpty {
                    VStack(spacing: 18) {
                        DesktopBrandMark(size: 52)
                        Text(chat
                            .needsModel ? (chat.model?.configured == true ? "Your model needs attention" : "Choose how Omnesis answers") :
                            "Ask about your information")
                            .font(.system(size: 28, weight: .semibold))
                        Text(chat.needsModel
                            ?
                            (chat.model?
                                .configured == true ?
                                "Your selected model is unavailable. Check its connection or choose another model in Settings." :
                                "Connect an AI provider in Settings to ask questions. You can search your library without one.")
                            : emptyDescription)
                            .font(.system(size: 14)).lineSpacing(4)
                            .foregroundStyle(DesktopTheme.secondary).multilineTextAlignment(.center).frame(maxWidth: 360)
                        if chat.needsModel {
                            Button("Set up answers") { store.settingsTab = "ai"
                                openSettings()
                            }
                            .buttonStyle(DesktopButtonStyle(primary: true)).accessibilityIdentifier("chat-setup-model")
                            Button("Check model connection") { if let api = store.api { Task { await chat.checkModel(api) } } }
                                .buttonStyle(DesktopButtonStyle()).disabled(chat.checkingModel)
                        }
                        if chat.checkingModel { ProgressView("Checking your answer model…").controlSize(.small) }
                        if !chat.needsModel, store.sourcesLoaded, store.sources.isEmpty {
                            Button("Add a source") { store.destination = .sources }.buttonStyle(DesktopButtonStyle(primary: true))
                        }
                    }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    VStack(spacing: 0) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 22) {
                                ForEach(chat.rows) { row in
                                    message(row).id(row.id)
                                }
                                Color.clear.frame(height: 1).id("chat-bottom")
                            }.scrollTargetLayout().padding(.horizontal, 32).padding(.vertical, 24)
                                .onGeometryChange(for: DesktopChatScrollGeometry.self) { geometry in
                                    DesktopChatScrollGeometry(
                                        contentEnd: geometry.frame(in: .named("chat-scroll")).maxY,
                                        viewportHeight: geometry.bounds(of: .named("chat-scroll"))?.height
                                    )
                                } action: { raw in
                                    let prior = scrollGeometry
                                    let candidate = raw.normalized(displayScale: displayScale)
                                    let decision: DesktopChatScrollObservation
                                        .Decision = candidate == nil ? .invalid : candidate == prior ? .unchanged : .assignmentRequested
                                    scrollObservation?(DesktopChatScrollObservation(
                                        kind: .geometry,
                                        raw: raw,
                                        prior: prior,
                                        candidate: candidate,
                                        decision: decision,
                                        displayScale: displayScale
                                    ))
                                    if let candidate, candidate != prior { scrollGeometry = candidate }
                                }
                                .frame(maxWidth: 724).frame(maxWidth: .infinity)
                        }.scrollPosition(id: $scrollTarget, anchor: .bottom)
                            .accessibilityIdentifier("chat-transcript").coordinateSpace(name: "chat-scroll")
                            .onChange(of: chat.rows.last?.text) {
                                if followsLatest(.streamEvaluation), scrollTarget != "chat-bottom" { scrollTarget = "chat-bottom" }
                            }
                        HStack {
                            Spacer()
                            if !followsLatest(.footerEvaluation) {
                                Button("Jump to latest", systemImage: "arrow.down") {
                                    scrollTarget = "chat-bottom"
                                }.buttonStyle(DesktopButtonStyle())
                                    .background(DesktopTheme.panel, in: RoundedRectangle(cornerRadius: 8))
                                    .accessibilityIdentifier("chat-jump-latest")
                                    .help("Return to the latest message")
                            }
                        }.frame(height: 34).padding(.horizontal, 24).padding(.bottom, 8)
                    }
                }
                if chat.lastAnswerStopped { Label("Response stopped · this answer is incomplete", systemImage: "stop.circle")
                    .font(.callout).foregroundStyle(DesktopTheme.secondary).padding(.horizontal, 24).padding(.bottom, 12)
                }
                if chat.opening { ProgressView("Opening conversation…").controlSize(.small).padding(.horizontal, 24) }
                if let failure = chat.failure, chat.modelCheckFailure == nil {
                    HStack {
                        Text(failure).font(.callout).foregroundStyle(DesktopTheme.secondary)
                        Button("Reopen conversation") { Task { await chat.open(chat.conversationId ?? chat.sessionId) } }
                            .buttonStyle(DesktopButtonStyle())
                    }.padding()
                }
                if let failure = chat.modelCheckFailure {
                    HStack {
                        Text(failure).font(.callout).foregroundStyle(DesktopTheme.secondary)
                        Button("Check again") { if let api = store.api { Task { await chat.checkModel(api) } } }
                    }.padding(.horizontal, 24).padding(.bottom, 12)
                }
                if chat.needsModel, !chat.rows.isEmpty {
                    HStack {
                        Text("Choose an available model before asking another question.").font(.callout)
                            .foregroundStyle(DesktopTheme.secondary)
                        Button("Set up answers") { store.settingsTab = "ai"
                            openSettings()
                        }
                        .buttonStyle(DesktopButtonStyle())
                        Button("Check again") { if let api = store.api { Task { await chat.checkModel(api) } } }
                            .buttonStyle(DesktopButtonStyle())
                    }.padding(.horizontal, 24).padding(.bottom, 12)
                }
                if let failure = chat.terminalFailure {
                    HStack {
                        Text(failure).font(.callout).foregroundStyle(DesktopTheme.secondary)
                        Button("Start a new conversation") { startConversation() }
                    }.padding(.horizontal, 24).padding(.bottom, 12)
                }
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("Ask Omnesis…", text: $chat.input, axis: .vertical).lineLimit(1 ... 6)
                        .textFieldStyle(.plain).onSubmit { Task { await chat.send() } }
                        .focused($composerFocused)
                        .accessibilityLabel("Message to Omnesis")
                        .frame(minHeight: 36, alignment: .center)
                        .accessibilityIdentifier("chat-input")
                    if chat.busy {
                        Button { Task { await chat.cancel() } } label: { Image(systemName: "stop.fill").font(.system(
                            size: 13,
                            weight: .semibold
                        )) }
                        .buttonStyle(DesktopButtonStyle(iconOnly: true)).accessibilityLabel("Stop response").disabled(chat.opening)
                        .accessibilityIdentifier("chat-stop")
                    } else {
                        Button { Task { await chat.send() } } label: { Image(systemName: "arrow.up").font(.system(
                            size: 16,
                            weight: .semibold
                        )) }
                        .buttonStyle(DesktopButtonStyle(primary: true, iconOnly: true)).accessibilityLabel("Send message")
                        .disabled(chat.needsModel || chat.checkingModel || chat.opening || chat.terminalFailure != nil || chat
                            .modelCheckFailure != nil || chat.input
                            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("chat-send")
                    }
                }.padding(16).background(DesktopTheme.panel, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(
                        composerFocused ? DesktopTheme.primary : contrast == .increased ? DesktopTheme.secondary : DesktopTheme.border,
                        lineWidth: composerFocused || contrast == .increased ? 2 : 1
                    ))
                    .frame(maxWidth: 720).padding(.horizontal, 24).padding(.bottom, 24)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .omnesisTheme()
            .foregroundStyle(DesktopTheme.ink).tint(DesktopTheme.primary).background(DesktopTheme.canvas)
            .navigationTitle("Ask Omnesis")
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    if !chat.references.isEmpty {
                        Button("Documents used", systemImage: "doc.text.magnifyingglass") { showSources.toggle() }
                            .accessibilityIdentifier("chat-evidence").help("Read the documents used in this conversation")
                            .disabled(chat.opening)
                    }
                    Button("Conversation history", systemImage: "clock") { showHistory.toggle() }
                        .accessibilityIdentifier("chat-history")
                        .help(showHistory ? "Hide conversation history" : "Show conversation history")
                    Button("New conversation", systemImage: "square.and.pencil") { startConversation() }
                        .accessibilityIdentifier("chat-new").help("New conversation")
                }
            }
            .inspector(isPresented: $showSources) {
                DesktopChatSourcesView(references: chat.references) { showSources = false }.environment(store)
                    .inspectorColumnWidth(min: 260, ideal: 320, max: 400)
            }
            .task(id: DesktopModelObservation(api: store.api.map(ObjectIdentifier.init), revision: store.modelConfigurationRevision)) {
                composerFocused = true
                guard let api = store.api else { chat.detach()
                    return
                }
                chat.attach(api)
                async let history: Void = store.refreshConversationHistory()
                await chat.checkModel(api)
                if let question = DesktopActionRouter.shared.question {
                    await chat.open()
                    chat.input = question
                    DesktopActionRouter.shared.question = nil
                }
                await history
            }
            .onChange(of: chosenConversation) { if let id = chosenConversation, id != chat.conversationId { Task { await chat.open(id) } } }
            .onChange(of: showHistory) { if showHistory { Task { await store.refreshConversationHistory() } } }
            .onChange(of: chat.conversationId) {
                chosenConversation = chat.conversationId
                scrollTarget = "chat-bottom"
                scrollObservation?(DesktopChatScrollObservation(kind: .conversationReset))
                scrollGeometry = nil
            }
            .onChange(of: store.api.map(ObjectIdentifier.init)) {
                scrollObservation?(DesktopChatScrollObservation(kind: .apiReset))
                scrollGeometry = nil
            }
            .onChange(of: chat.opening) { if chat.opening { showSources = false } }
            .onChange(of: chat.historyRevision) { Task { await store.refreshConversationHistory() } }
            .onChange(of: chat.announcementRevision) { AccessibilityNotification.Announcement(chat.announcement).post() }
            .onChange(of: scenePhase) { if scenePhase == .active, let api = store.api { Task { await chat.checkModel(api) } } }
            .onChange(of: DesktopActionRouter.shared.newConversation) {
                Task {
                    chosenConversation = nil
                    await chat.open()
                    composerFocused = true
                    if let question = DesktopActionRouter.shared.question {
                        chat.input = question
                        DesktopActionRouter.shared.question = nil
                    }
                }
            }
            .onDisappear { chat.detach() }
    }

    private func startConversation() {
        chosenConversation = nil
        Task {
            await chat.open()
            composerFocused = true
        }
    }

    private var emptyDescription: String {
        guard store.sourcesLoaded else { return "Ask about information in your library. Check Sources to see what is available." }
        if store.sources
            .isEmpty { return "Add your first source to give Omnesis information to search. Your originals stay where they are." }
        return "Ask about the information your sources have collected. You can follow collection progress in Sources."
    }

    @ViewBuilder private func message(_ row: DesktopChat.Row) -> some View {
        if row.role == "user" {
            HStack {
                Spacer(minLength: 40)
                Text(row.text).font(.system(size: 15)).lineSpacing(4).textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .background(DesktopTheme.selected, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(
                        contrast == .increased ? DesktopTheme.secondary : .clear,
                        lineWidth: 1
                    ))
                    .frame(maxWidth: 440, alignment: .trailing)
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) { DesktopBrandMark(size: 18)
                    Text("Omnesis").font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(DesktopTheme.secondary)
                DesktopAnswerText(text: row.text.isEmpty ? "Thinking…" : row.text)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct DesktopChatScrollGeometry: Equatable, Sendable {
    var contentEnd: CGFloat?
    var viewportHeight: CGFloat?

    var nearLatest: Bool? {
        guard let contentEnd, let viewportHeight else { return nil }
        return contentEnd <= viewportHeight + 44
    }

    func normalized(displayScale: CGFloat) -> Self? {
        guard let contentEnd, contentEnd.isFinite, let viewportHeight, viewportHeight.isFinite, viewportHeight > 0,
              displayScale.isFinite, displayScale > 0 else { return nil }
        let endPixels = contentEnd * displayScale, heightPixels = viewportHeight * displayScale
        guard endPixels.isFinite, heightPixels.isFinite else { return nil }
        let end = endPixels.rounded() / displayScale, height = heightPixels.rounded() / displayScale
        guard end.isFinite, height.isFinite, height > 0 else { return nil }
        return Self(contentEnd: end, viewportHeight: height)
    }
}

struct DesktopChatScrollObservation: Sendable {
    enum Kind: String, Sendable { case geometry, footerEvaluation, streamEvaluation, conversationReset, apiReset }
    enum Decision: String, Sendable { case invalid, unchanged, assignmentRequested }
    let kind: Kind
    var raw: DesktopChatScrollGeometry?
    var prior: DesktopChatScrollGeometry?
    var candidate: DesktopChatScrollGeometry?
    var decision: Decision?
    var displayScale: CGFloat?
    var followsLatest: Bool?
}
