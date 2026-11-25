// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import SwiftUI

struct DesktopMemoryView: View {
    @Environment(DesktopStore.self) private var store
    @State private var automatic = true
    @State private var budget = "2048"
    @State private var analyticsAutomatic = true
    @State private var analyticsBudget = "512"
    @State private var residentBytes: Int64?
    @State private var working = false
    @State private var restartConfirmation = false
    @State private var awaitingRestart = false
    @State private var saved = false
    @State private var restarted = false
    @State private var error: String?
    var body: some View {
        Form {
            Section("Library memory") {
                if let residentBytes {
                    LabeledContent(
                        "Current library process",
                        value: ByteCountFormatter.string(fromByteCount: residentBytes, countStyle: .memory)
                    )
                } else { LabeledContent("Current library process", value: "Not measured") }
                Text(
                    "These settings control the library process on the Mac that stores it. Connected source apps and downloaded AI models may use additional memory."
                )
                .foregroundStyle(.secondary)
                Toggle("Choose the library memory budget automatically", isOn: $automatic)
                if !automatic { TextField("Library budget (MiB, at least 256)", text: $budget) }
                Toggle("Choose the analytics memory budget automatically", isOn: $analyticsAutomatic)
                if !analyticsAutomatic { TextField("Analytics budget (MiB, at least 256)", text: $analyticsBudget) }
                Text(
                    "Smaller budgets can reduce semantic search and move analytics work to disk. They are startup settings, not an immediate limit on total app memory."
                )
                .font(.callout).foregroundStyle(.secondary)
                Button("Save memory settings") { Task { await save() } }.disabled(working || store.busy || !valid)
                if saved {
                    Text(restarted ? "Omnesis restarted and is healthy. The saved memory settings are shown above." :
                        "Settings saved. Restart the library to use them.")
                    if store.state.mode == "home" {
                        Button("Restart this library…") { restartConfirmation = true }.disabled(store.busy || working)
                    } else {
                        Text(
                            "Restart Omnesis on the Mac that stores your library. Restarting this connected Mac does not apply the library’s memory settings."
                        )
                        if let name = store.state.homeName { LabeledContent("Library Mac", value: name) }
                    }
                }
                Button("Refresh memory reading") { Task { await load() } }.disabled(working || store.busy)
            }.disabled(working || store.busy)
            if working ||
                (awaitingRestart && store.busy) { ProgressView(awaitingRestart ? "Restarting the library…" : "Reading memory settings…") }
            if let error = error ?? store.failure { Text(error).foregroundStyle(.red) }
        }.formStyle(.grouped)
            .task { await load() }
            .onChange(of: [automatic ? "automatic" : budget, analyticsAutomatic ? "automatic" : analyticsBudget]) { _, _ in
                saved = false
                restarted = false
            }
            .onChange(of: store.restartGeneration) { _, _ in
                guard awaitingRestart else { return }
                awaitingRestart = false
                restarted = true
                Task { await load(preserveSaved: true) }
            }
            .confirmationDialog("Restart the library on this Mac?", isPresented: $restartConfirmation) {
                Button("Restart library") { awaitingRestart = true
                    restarted = false
                    store.command("restart")
                }
            } message: {
                Text(
                    "Search, questions and source syncing will be unavailable while this library restarts. Other devices reconnect afterward."
                )
            }
    }

    private var valid: Bool {
        (automatic || DesktopMemorySettings.mebibytes(budget) != nil) &&
            (analyticsAutomatic || DesktopMemorySettings.mebibytes(analyticsBudget) != nil)
    }

    private func load(preserveSaved: Bool = false) async {
        guard let api = store.api else { error = "Connect to your library first."
            return
        }
        working = true
        residentBytes = nil
        defer { working = false }
        do {
            let reply: ConfigReply = try await api.request("GET", "admin/config")
            automatic = reply.config.gateway?.memoryLimitMb == nil
            analyticsAutomatic = reply.config.gateway?.analyticsMemoryLimitMb == nil
            budget = String(reply.config.gateway?.memoryLimitMb ?? 2048)
            analyticsBudget = String(reply.config.gateway?.analyticsMemoryLimitMb ?? 512)
            if !preserveSaved { saved = false
                restarted = false
            }
            let reading: Vitals = try await api.request("GET", "admin/process-vitals?window=10")
            residentBytes = reading.memory.current?.rssBytes
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        guard let api = store.api, valid else { return }
        working = true
        defer { working = false }
        let memory: Any
        let analytics: Any
        if automatic { memory = NSNull() }
        else if let value = DesktopMemorySettings.mebibytes(budget) { memory = value }
        else { return }
        if analyticsAutomatic { analytics = NSNull() }
        else if let value = DesktopMemorySettings.mebibytes(analyticsBudget) { analytics = value }
        else { return }
        do {
            let _: ConfigReply = try await api.request(
                "PATCH",
                "admin/config",
                body: ["gateway": ["memoryLimitMb": memory, "analyticsMemoryLimitMb": analytics]]
            )
            saved = true
            restarted = false
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private struct ConfigReply: Decodable {
        let config: Config
        struct Config: Decodable { let gateway: Gateway? }
        struct Gateway: Decodable { let memoryLimitMb: Int?
            let analyticsMemoryLimitMb: Int?
        }
    }

    private struct Vitals: Decodable {
        let memory: Memory
        struct Memory: Decodable { let current: Current? }
        struct Current: Decodable { let rssBytes: Int64 }
    }
}
