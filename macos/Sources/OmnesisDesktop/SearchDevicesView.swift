// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Omnesis
import SwiftUI

struct DesktopSearchView: View {
    @Environment(DesktopStore.self) private var store
    @State private var query = ""
    @State private var results: [SearchResultItem] = []
    @State private var searching = false
    @State private var error: String?
    var body: some View {
        VStack {
            HStack {
                TextField("Search your library", text: $query).textFieldStyle(.roundedBorder).onSubmit { Task { await search() } }
                Button("Search") { Task { await search() } }
                    .disabled(searching || query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding()
            if searching { ProgressView("Searching…") }
            if let error { Text(error).foregroundStyle(.red).padding() }
            if results.isEmpty, !searching {
                ContentUnavailableView(
                    "Search your information",
                    systemImage: "magnifyingglass",
                    description: Text("Find information across connected sources. Search works without a cloud AI subscription.")
                )
            } else {
                List(results) { result in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(result.title).font(.headline)
                        Text(result.chunkText).lineLimit(4).textSelection(.enabled)
                        if let link = result.appUrl ?? result.sourceUrl, let url = URL(string: link) {
                            Link("Open original", destination: url).font(.caption)
                        }
                    }.padding(.vertical, 10)
                }
            }
        }.navigationTitle("Search")
    }

    private func search() async {
        guard let api = store.api else { return }
        searching = true
        error = nil
        defer { searching = false }
        do {
            let client = SearchClient(baseURL: api.connection.url, token: api.connection.token, session: api.session)
            results = try await client.search(text: query, limit: 30, verbose: false).results
        } catch { self.error = error.localizedDescription }
    }
}

struct DesktopDevicesView: View {
    @Environment(DesktopStore.self) private var store
    @State private var pairingPhone = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Your devices").font(.largeTitle.bold())
            Text(
                "Install Omnesis on another Mac and sign in with the same account. Keep the Mac that stores your library awake so your other devices can connect."
            )
            .foregroundStyle(.secondary)
            List(store.devices.filter { $0.revokedAt == nil }) { device in
                HStack(spacing: 14) {
                    Image(systemName: device.kind == "collector" ? "desktopcomputer" : "iphone")
                    VStack(alignment: .leading, spacing: 4) {
                        Text(device.name).font(.headline)
                        Text(device.online == true ? "Connected" : "Not connected").foregroundStyle(.secondary)
                    }
                    Spacer()
                }.padding(.vertical, 8)
            }
            HStack {
                Link("Get the iPhone app", destination: URL(string: "https://omnesis.dev/docs/apps")!)
                Link("Get the Android app", destination: URL(string: "https://omnesis.dev/docs/apps")!)
                Spacer()
                Button("Connect a phone") { pairingPhone = true }
            }
        }.padding(28).navigationTitle("Devices")
            .sheet(isPresented: $pairingPhone) { DesktopPhonePairingView().environment(store) }
            .toolbar { Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refresh() } } }
    }
}
