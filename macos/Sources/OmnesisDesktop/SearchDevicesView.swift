// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Omnesis
import SwiftUI

struct DesktopSearchView: View {
    let context: DesktopAPIContext?
    @Environment(DesktopStore.self) private var store
    @State private var query = ""
    @State private var results: [SearchResultItem] = []
    @State private var searching = false
    @State private var error: String?
    @State private var completedQuery: String?
    @State private var selectedDocument: DesktopDocumentSelection?
    @FocusState private var searchFocused: Bool
    init(initialQuery: String = "", initialCompletedQuery: String? = nil, context: DesktopAPIContext? = nil) {
        self.context = context
        _query = State(initialValue: initialQuery)
        _completedQuery = State(initialValue: initialCompletedQuery)
    }

    var body: some View {
        VStack {
            HStack {
                TextField("Search your library", text: $query).textFieldStyle(.roundedBorder)
                    .onSubmit { context?.run { _ in await search() } }
                    .focused($searchFocused).accessibilityLabel("Search your library")
                    .accessibilityIdentifier("library-search-input")
                Button("Search") { context?.run { _ in await search() } }
                    .disabled(searching || query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("library-search-submit")
            }.padding()
            if searching { ProgressView("Searching…") }
            if let error { Text(error).foregroundStyle(DesktopTheme.danger).padding() }
            if results.isEmpty, !searching, error == nil {
                if let completedQuery {
                    ContentUnavailableView(
                        "No results for “\(completedQuery)”",
                        systemImage: "magnifyingglass",
                        description: Text(
                            "Try fewer words or a different phrase. Check Sources to see whether your information has finished collecting."
                        )
                    )
                } else {
                    ContentUnavailableView(
                        "Search your information",
                        systemImage: "magnifyingglass",
                        description: Text("Find information across connected sources. Search works without a cloud AI subscription.")
                    )
                }
            } else {
                List(results) { result in
                    VStack(alignment: .leading, spacing: 8) {
                        Button(result.title) {
                            selectedDocument = DesktopDocumentSelection(
                                id: result.documentId,
                                title: result.title,
                                originalURL: (result.sourceUrl ?? result.appUrl).flatMap(URL.init(string:))
                            )
                        }.font(.headline).buttonStyle(.plain).accessibilityLabel("Read \(result.title)")
                            .accessibilityIdentifier("search-document-" + result.documentId)
                        Text(result.chunkText).lineLimit(4).textSelection(.enabled)
                        if let link = result.appUrl ?? result.sourceUrl, let url = URL(string: link), DesktopAnswerBlock.allowsLink(url) {
                            Link("Open original", destination: url).font(.caption)
                        }
                    }.padding(.vertical, 10)
                }
            }
        }.navigationTitle("Search").onAppear { searchFocused = true }
            .omnesisSheet(item: $selectedDocument) { selection in
                DesktopDocumentView(selection: selection, context: context).environment(store)
            }
            .toolbar { Button("Focus search", systemImage: "magnifyingglass") { searchFocused = true }.keyboardShortcut("f") }
    }

    private func search() async {
        guard let context, context.isCurrent else { return }
        let searched = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !searched.isEmpty, !searching else { return }
        searching = true
        error = nil
        results = []
        defer { searching = false }
        do {
            let response = try await context.perform { api in
                let client = SearchClient(baseURL: api.connection.url, token: api.connection.token, session: api.session)
                return try await client.search(text: searched, limit: 30, verbose: false)
            }
            guard !Task.isCancelled, context.isCurrent else { return }
            results = response.results
            completedQuery = searched
        } catch {
            guard !Task.isCancelled, context.isCurrent else { return }
            self.error = error.localizedDescription
        }
    }
}

struct DesktopDevicesView: View {
    @Environment(DesktopStore.self) private var store
    @State private var pairingPhone = false
    @State private var repairDevice: DesktopDevice?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Your devices").font(.largeTitle.bold())
            Text(
                "Connect your other computers to the same library. Keep your library server running and awake so your devices can connect."
            )
            .foregroundStyle(DesktopTheme.secondary)
            List(store.devices.filter { $0.revokedAt == nil || $0.needsPairing == true }) { device in
                HStack(spacing: 14) {
                    Image(systemName: device.kind == "collector" ? "desktopcomputer" : "iphone")
                    VStack(alignment: .leading, spacing: 4) {
                        Text(device.name).font(.headline)
                        if device.needsPairing == true {
                            Text("Needs pairing").foregroundStyle(DesktopTheme.accent)
                            Button("Repair instructions") { repairDevice = device }.font(.callout)
                        } else { Text(device.online == true ? "Connected" : "Not connected").foregroundStyle(DesktopTheme.secondary) }
                    }
                    Spacer()
                }.padding(.vertical, 8)
            }
            HStack {
                Link("Connect another computer", destination: URL(string: "https://omnesis.dev/docs/setup#collector")!)
                Link("Get the iPhone app", destination: URL(string: "https://omnesis.dev/docs/apps")!)
                Link("Get the Android app", destination: URL(string: "https://omnesis.dev/docs/apps")!)
                Spacer()
                Button("Connect a phone") { pairingPhone = true }
            }
        }.padding(28).navigationTitle("Devices")
            .alert(
                "Repair this device",
                isPresented: Binding(get: { repairDevice != nil }, set: { if !$0 { repairDevice = nil } }),
                presenting: repairDevice
            ) { _ in
                Button("Open the web portal") { store.openPortal()
                    repairDevice = nil
                }
                Button("Cancel", role: .cancel) { repairDevice = nil }
            } message: { device in
                Text(
                    "In the web portal, choose Settings → Devices. Open the actions for \(device.name) and choose Repair device. Use its repair code on that device to preserve its existing sources."
                )
            }
            .omnesisSheet(isPresented: $pairingPhone) {
                DesktopPhonePairingView(context: store.apiContext).environment(store).id(store.apiContextEpoch)
            }
            .toolbar { Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refresh() } } }
    }
}
