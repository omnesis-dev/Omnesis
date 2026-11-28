// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Omnesis
import SwiftUI

struct DesktopDocumentSelection: Identifiable {
    let id: String
    let title: String
    let originalURL: URL?
}

struct DesktopChatSourcesView: View {
    @Environment(DesktopStore.self) private var store
    let references: [AgentDocRef]
    let close: () -> Void
    @State private var selected: AgentDocRef?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Documents used").font(DesktopDesignTokens.Typography.body.weight(.medium))
                    .accessibilityIdentifier("chat-sources-title").accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Close sources", systemImage: "xmark", action: close).labelStyle(.iconOnly)
                    .buttonStyle(DesktopButtonStyle(iconOnly: true)).help("Close sources")
                    .accessibilityIdentifier("chat-sources-close")
            }.padding(DesktopDesignTokens.Space.large)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(references) { ref in
                        Button { selected = ref } label: {
                            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                                Text(ref.title ?? "Source document").font(DesktopDesignTokens.Typography.body.weight(.medium))
                                    .foregroundStyle(DesktopTheme.ink).multilineTextAlignment(.leading)
                                Text(store.descriptors.first(where: { $0.id == ref.sourceType })?.name ?? ref.sourceType)
                                    .font(DesktopDesignTokens.Typography.metadata).foregroundStyle(DesktopTheme.secondary)
                                if let snippet = ref.snippet, !snippet.isEmpty {
                                    Text(snippet).font(DesktopDesignTokens.Typography.secondary).lineLimit(3)
                                        .foregroundStyle(DesktopTheme.secondary)
                                        .multilineTextAlignment(.leading)
                                }
                                Text("Read document").font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.primary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(DesktopDesignTokens.Space.large)
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("chat-document-" + ref.documentId)
                        Divider().padding(.horizontal, DesktopDesignTokens.Space.large)
                    }
                    Text("Only documents explicitly cited in this conversation appear here.")
                        .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                        .padding(DesktopDesignTokens.Space.large)
                }
            }
        }.background(DesktopTheme.panel)
            .omnesisSheet(item: $selected) { ref in
                DesktopDocumentView(selection: DesktopDocumentSelection(
                    id: ref.documentId,
                    title: ref.title ?? "Source document",
                    originalURL: ref.url.flatMap(URL.init(string:))
                ), context: store.apiContext).environment(store)
            }
    }
}

private struct DesktopDocumentRequest: Equatable {
    let id: String
    let api: ObjectIdentifier?
}

struct DesktopDocumentView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let selection: DesktopDocumentSelection
    var context: DesktopAPIContext?
    @State private var document: DocumentDetail?
    @State private var error: String?
    @State private var loading = false
    @State private var requestGeneration = UUID()
    @State private var bodyHeight: CGFloat?
    private static let maximumBodyHeight: CGFloat = 360

    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
            HStack(alignment: .top) {
                Text("Source document").font(DesktopDesignTokens.Typography.section).accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("chat-document-heading")
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).accessibilityIdentifier("chat-document-done")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
                    if loading { ProgressView("Opening the source document…").accessibilityIdentifier("chat-document-loading") }
                    if let error {
                        Label(error, systemImage: "exclamationmark.circle").foregroundStyle(DesktopTheme.secondary)
                            .accessibilityIdentifier("chat-document-error")
                    }
                    Text(document?.title ?? selection.title).font(DesktopDesignTokens.Typography.section).accessibilityAddTraits(.isHeader)
                        .textSelection(.enabled).accessibilityIdentifier("chat-document-title")
                    if let document {
                        DesktopAnswerText(text: document.content).padding(.trailing, DesktopDesignTokens.Space.medium)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: DocumentReaderBodyHeight.self, value: geometry.size.height)
                    })
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(bodyHeight ?? Self.maximumBodyHeight, Self.maximumBodyHeight))
            .onPreferenceChange(DocumentReaderBodyHeight.self) { height in
                if let height, height.isFinite, height >= 0 { bodyHeight = height }
            }
            .accessibilityIdentifier("chat-document-content")
            if document != nil {
                if let url = selection.originalURL, DesktopAnswerBlock.allowsLink(url) {
                    Link("Open original", destination: url).desktopTextLink()
                        .accessibilityIdentifier("chat-document-original")
                }
            }
        }.padding(DesktopDesignTokens.Space.section).frame(width: 680).fixedSize(horizontal: false, vertical: true).omnesisTheme()
            .task(id: DesktopDocumentRequest(id: selection.id, api: context.map { ObjectIdentifier($0.api) })) {
                let generation = UUID()
                requestGeneration = generation
                document = nil
                error = nil
                guard let context, context.isCurrent else { error = "Reconnect to your library to read this document."
                    return
                }
                loading = true
                defer { if requestGeneration == generation { loading = false } }
                do {
                    let loaded = try await context.perform { api in
                        let client = SearchClient(baseURL: api.connection.url, token: api.connection.token, session: api.session)
                        return try await client.getDocument(id: selection.id)
                    }
                    guard !Task.isCancelled, context.isCurrent else { return }
                    guard loaded.id == selection.id else { error = "The library returned a different document. Reconnect and try again."
                        return
                    }
                    document = loaded
                } catch is CancellationError {} catch {
                    guard context.isCurrent, !Task.isCancelled else { return }
                    self.error = "This document could not be opened. It may have been removed, or your connection may be interrupted."
                }
            }
    }
}

private struct DocumentReaderBodyHeight: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        guard let next = nextValue() else { return }
        value = value.map { max($0, next) } ?? next
    }
}
