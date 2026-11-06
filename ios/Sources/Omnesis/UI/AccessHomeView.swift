// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct AccessHomeView: View {
    @Environment(AppStore.self) private var store
    @State private var overview: AccessOverview?
    @State private var error: Error?
    @State private var creating = false
    @State private var connecting = false

    init(previewOverview: AccessOverview? = nil) {
        _overview = State(initialValue: previewOverview)
    }

    var body: some View {
        Group {
            if let overview {
                List {
                    Section("Access levels") {
                        ForEach(overview.levels) { level in
                            NavigationLink {
                                AccessLevelEditorView(level: level, overview: overview, saved: { Task { await load() } })
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(level.name)
                                    Text("\(level.connectionCount) connections")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        Button("New access level") { creating = true }
                    }
                    Section("Connections") {
                        ForEach(overview.principals.filter { $0.revokedAt == nil }) { principal in
                            VStack(alignment: .leading) {
                                Text(principal.name)
                                ForEach(principal.grants.filter { $0.revokedAt == nil }) { grant in
                                    Text(overview.levels.first { $0.id == grant.levelId }?.name ?? grant.name)
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        Button("Connect an agent") { connecting = true }
                    }
                }
                .sheet(isPresented: $creating) {
                    NavigationStack {
                        AccessLevelEditorView(level: nil, overview: overview, saved: { Task { await load() } })
                    }
                }
                .refreshable { await load() }
            } else if let error {
                GatewayErrorView(context: "load access levels", error: error, onRetry: { Task { await load() } })
            } else { ProgressView("Loading access…") }
        }
        .navigationTitle("Access")
        .task { if overview == nil { await load() } }
        .sheet(isPresented: $connecting) { AccessAuthorizationSheet() }
    }

    private func load() async {
        guard let client = store.access else { return }
        do {
            let value = try await client.overview()
            try Task.checkCancellation()
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            overview = value
            error = nil
        } catch is CancellationError {} catch { self.error = error }
    }
}

#if DEBUG
#Preview("Access") { NavigationStack { AccessHomeView(previewOverview: PreviewMocks.scopeEditorOverview) }.environment(AppStore.preview()) }
#endif

#endif
