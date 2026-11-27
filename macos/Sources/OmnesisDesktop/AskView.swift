// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import SwiftUI

struct DesktopDraftObservation: Equatable {
    let context: ObjectIdentifier?
    let request: UUID?
}

struct DesktopModelObservation: Equatable {
    let api: ObjectIdentifier?
    let revision: Int
    var context: ObjectIdentifier?
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
    @State private var historyTask: Task<Void, Never>?
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
        let context = store.apiContext
        GeometryReader { geometry in
            let layout = DesktopChatLayout(width: geometry.size.width, historyRequested: showHistory, sourcesRequested: showSources)
            HStack(spacing: 0) {
                if layout.showsHistory {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 4) {
                            Text("Conversations").font(.callout.weight(.semibold)).accessibilityAddTraits(.isHeader)
                            Spacer(minLength: 4)
                            Button("New conversation", systemImage: "square.and.pencil") { startConversation() }
                                .labelStyle(.iconOnly).buttonStyle(.borderless).frame(width: 28, height: 28)
                                .foregroundStyle(DesktopTheme.secondary).accessibilityLabel("New conversation")
                                .accessibilityIdentifier("chat-history-new").help("New conversation")
                            Button("Refresh history", systemImage: "arrow.clockwise") { requestHistory(in: context) }
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
                    }.background(DesktopTheme.panel).frame(width: DesktopChatLayout.historyWidth).frame(maxHeight: .infinity)
                    Rectangle().fill(DesktopTheme.border).frame(width: DesktopChatLayout.separatorWidth)
                }
                VStack(spacing: 0) {
                    if chat.rows.isEmpty {
                        VStack(spacing: 18) {
                            DesktopBrandMark(size: 52)
                            Text(chat
                                .needsModel ?
                                (chat.model?.configured == true ? "Your model needs attention" : "Choose how Omnesis answers") :
                                "Ask about your information")
                                .font(.system(size: 28, weight: .semibold))
                                .accessibilityIdentifier("chat-empty-title")
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
                                Button("Check model connection") { chat.requestModelCheck(in: context) }
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
                            if let id = chat.conversationId ?? chat.sessionId {
                                Button("Reopen conversation") { chat.requestOpen(id, in: context) }.buttonStyle(DesktopButtonStyle())
                            } else {
                                Button("Check connection") { chat.requestModelCheck(in: context) }.buttonStyle(DesktopButtonStyle())
                            }
                        }.padding()
                    }
                    if let failure = chat.modelCheckFailure {
                        HStack {
                            Text(failure).font(.callout).foregroundStyle(DesktopTheme.secondary)
                            Button("Check again") { chat.requestModelCheck(in: context) }
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
                            Button("Check again") { chat.requestModelCheck(in: context) }
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
                            .textFieldStyle(.plain).onSubmit { chat.requestSend(in: context) }
                            .focused($composerFocused)
                            .accessibilityLabel("Message to Omnesis")
                            .frame(minHeight: 36, alignment: .center)
                            .accessibilityIdentifier("chat-input")
                        if chat.busy {
                            Button { chat.requestCancel(in: context) } label: { Image(systemName: "stop.fill").font(.system(
                                size: 13,
                                weight: .semibold
                            )) }
                            .buttonStyle(DesktopButtonStyle(iconOnly: true)).accessibilityLabel("Stop response").disabled(chat.opening)
                            .accessibilityIdentifier("chat-stop")
                        } else {
                            Button { chat.requestSend(in: context) } label: { Image(systemName: "arrow.up").font(.system(
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
                }.frame(width: layout.readingWidth).frame(maxHeight: .infinity)
                    .clipped().opacity(layout.showsReading ? 1 : 0)
                    .accessibilityHidden(!layout.showsReading).allowsHitTesting(layout.showsReading).disabled(!layout.showsReading)
                if layout.showsSources {
                    if layout.showsReading {
                        Rectangle().fill(DesktopTheme.border).frame(width: DesktopChatLayout.separatorWidth)
                    }
                    DesktopChatSourcesView(references: chat.references) { showSources = false }.environment(store)
                        .frame(width: layout.sourcesWidth).frame(maxHeight: .infinity).clipped()
                }
            }.frame(width: geometry.size.width, height: geometry.size.height)
                .onChange(of: layout.showsReading, initial: true) { if !layout.showsReading { composerFocused = false } }
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
                        Button("Conversation history", systemImage: "clock") {
                            if showSources, !layout.showsHistory {
                                showSources = false
                                showHistory = true
                            } else { showHistory.toggle() }
                        }
                        .accessibilityIdentifier("chat-history")
                        .help(layout.showsHistory ? "Hide conversation history" : "Show conversation history")
                        Button("New conversation", systemImage: "square.and.pencil") { startConversation() }
                            .accessibilityIdentifier("chat-new").help("New conversation")
                    }
                }
                .task(id: DesktopModelObservation(
                    api: context.map { ObjectIdentifier($0.api) }, revision: store.modelConfigurationRevision,
                    context: context.map(ObjectIdentifier.init)
                )) {
                    composerFocused = layout.showsReading
                    guard let context, context.isCurrent, store.apiContext === context else { return }
                    chat.attach(context.api, context: context)
                    async let history: Void = store.refreshConversationHistory(in: context)
                    await chat.checkModel(context.api)
                    await history
                }
                .onChange(of: chosenConversation) { if let id = chosenConversation,
                                                       id != chat.conversationId { chat.requestOpen(id, in: context) }
                }
                .onChange(of: showHistory) { if showHistory {
                    requestHistory(in: context)
                } }
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
                .onChange(of: chat.historyRevision) {
                    requestHistory(in: context)
                }
                .onChange(of: chat.announcementRevision) { AccessibilityNotification.Announcement(chat.announcement).post() }
                .onChange(of: scenePhase) {
                    if scenePhase == .active { chat.requestModelCheck(in: context) }
                }
                .onChange(of: DesktopDraftObservation(
                    context: context.map(ObjectIdentifier.init), request: DesktopActionRouter.shared.pending?.id
                ), initial: true) {
                    guard let context = store.apiContext, context.isCurrent else { chat.detach()
                        return
                    }
                    chat.attach(context.api, context: context)
                    guard let request = DesktopActionRouter.shared.pending else { return }
                    chat.prepareLocalDraft(question: request.question)
                    chosenConversation = nil
                    showSources = false
                    composerFocused = layout.showsReading
                    DesktopActionRouter.shared.consume(request)
                }
                .onDisappear {
                    historyTask?.cancel()
                    chat.detach()
                }
        }
    }

    private func requestHistory(in context: DesktopAPIContext?) {
        guard let context, context.isCurrent, store.apiContext === context else { return }
        historyTask?.cancel()
        historyTask = context.run { scope in await store.refreshConversationHistory(in: scope) }
    }

    private func startConversation() {
        DesktopActionRouter.shared.enqueue(question: nil)
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
