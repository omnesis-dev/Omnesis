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
                Text("Documents used").font(.headline)
                Spacer()
                Button("Close sources", systemImage: "xmark", action: close).labelStyle(.iconOnly)
            }.padding(20)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(references) { ref in
                        Button { selected = ref } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(ref.title ?? "Source document").font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(DesktopTheme.ink).multilineTextAlignment(.leading)
                                Text(store.descriptors.first(where: { $0.id == ref.sourceType })?.name ?? ref.sourceType)
                                    .font(.caption).foregroundStyle(DesktopTheme.secondary)
                                if let snippet = ref.snippet, !snippet.isEmpty {
                                    Text(snippet).font(.callout).lineLimit(3).foregroundStyle(DesktopTheme.secondary)
                                        .multilineTextAlignment(.leading)
                                }
                                Text("Read document").font(.callout).foregroundStyle(DesktopTheme.primary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(20).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("chat-document-" + ref.documentId)
                        Divider().padding(.horizontal, 20)
                    }
                    Text("Only documents explicitly cited in this conversation appear here.")
                        .font(.callout).foregroundStyle(DesktopTheme.secondary).padding(20)
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
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                Text(document?.title ?? selection.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).accessibilityIdentifier("chat-document-done")
            }
            if loading { ProgressView("Opening the source document…") }
            if let error { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(DesktopTheme.secondary) }
            if let document {
                ScrollView { DesktopAnswerText(text: document.content).padding(.trailing, 12) }
                    .accessibilityIdentifier("chat-document-content")
                if let url = selection.originalURL, DesktopAnswerBlock.allowsLink(url) {
                    Link("Open original", destination: url)
                }
            }
            Spacer(minLength: 0)
        }.padding(28).frame(width: 680, height: 600).omnesisTheme()
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
