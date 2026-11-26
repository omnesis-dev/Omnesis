// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import SwiftUI
import UniformTypeIdentifiers

struct DesktopBackupsView: View {
    @Environment(DesktopStore.self) private var store
    @State private var artifacts: [DesktopArtifact] = []
    @State private var kind = "backup"
    @State private var format = "json"
    @State private var backupStatus: GenerationStatus?
    @State private var exportStatus: GenerationStatus?
    @State private var loading = false
    @State private var error: String?
    @State private var saving: DesktopArtifact?
    @State private var downloadID: UUID?
    @State private var download: Task<Void, Never>?
    @State private var downloadedBytes: Int64 = 0
    @State private var savedURL: URL?
    @State private var readableConsent: DesktopArtifact?
    @State private var saveReadableExport = false
    private let downloader = DesktopArtifactDownloader()
    var body: some View {
        Form {
            Section("Back up your library") {
                Text(
                    "A backup preserves library stores for restoration. An export provides the saved information in JSON or CSV form. Keep a separate recovery file and code for encrypted backups."
                )
                .foregroundStyle(.secondary)
                Picker("Create", selection: $kind) {
                    Text("Library backup").tag("backup")
                    Text("Data export").tag("export")
                }
                if kind == "export" {
                    Picker("Format", selection: $format) {
                        Text("JSON (full document content)").tag("json")
                        Text("CSV (document index and analytics)").tag("csv")
                    }
                }
                Button(kind == "backup" ? "Create backup" : "Create export") { Task { await create() } }
                    .disabled(store
                        .api == nil || loading || saving != nil || (kind == "backup" ? backupStatus?.running : exportStatus?.running) ==
                        true)
                generation(backupStatus, label: "Backup")
                generation(exportStatus, label: "Export")
            }
            Section("Save a completed backup or export") {
                Text("These files are on the Mac that stores your library. Save downloads a copy to a location you choose on this Mac.")
                    .font(.callout).foregroundStyle(.secondary)
                ForEach(artifacts) { artifact in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(
                            "\(artifact.kind == "backup" ? "Backup" : "Export") · \(artifact.createdDate?.formatted(date: .abbreviated, time: .shortened) ?? "Date unavailable")"
                        )
                        .font(.headline)
                        Text(ByteCountFormatter.string(fromByteCount: artifact.bytes, countStyle: .file) + " of stored contents")
                        Text(artifact.protectionLabel).font(.callout).foregroundStyle(.secondary)
                        Button("Save a copy…") {
                            saveReadableExport = false
                            if artifact.requiresReadableContentConsent { readableConsent = artifact }
                            else { chooseDestination(artifact) }
                        }.disabled(saving != nil || !artifact.valid)
                        if artifact.kind == "export", artifact.encrypted {
                            Button("Save readable export…") {
                                saveReadableExport = true
                                readableConsent = artifact
                            }.disabled(saving != nil || !artifact.valid)
                            Text(
                                "Readable exports contain JSON Lines or CSV files inside a TAR archive. Anyone with the saved file can read its contents."
                            )
                            .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                }
                if artifacts.isEmpty { Text("No completed backups or exports are available.").foregroundStyle(.secondary) }
                Button("Refresh list") { Task { await refresh() } }.disabled(loading || saving != nil)
            }
            DesktopRecoveryCopiesSection()
            if let saving {
                ProgressView(
                    "Saving \(saving.kind)… \(ByteCountFormatter.string(fromByteCount: downloadedBytes, countStyle: .file)) downloaded"
                )
                Button("Cancel download") { download?.cancel() }
            }
            if let savedURL {
                Label("Copy saved on this Mac", systemImage: "checkmark")
                Button("Show saved copy in Finder") { NSWorkspace.shared.activateFileViewerSelecting([savedURL]) }
            }
            if let error { Text(error).foregroundStyle(DesktopTheme.danger) }
        }.formStyle(.grouped)
            .task { await refresh() }
            .task(id: backupStatus?.running == true || exportStatus?.running == true) {
                while backupStatus?.running == true || exportStatus?.running == true {
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                    if !loading { await refresh() }
                }
            }
            .confirmationDialog(
                saveReadableExport ? "Save a readable data export?" : "Save a copy with readable contents?",
                isPresented: Binding(get: { readableConsent != nil }, set: { if !$0 { readableConsent = nil } })
            ) {
                if let artifact = readableConsent {
                    Button("Choose where to save") { readableConsent = nil
                        chooseDestination(artifact, readableExport: saveReadableExport)
                    }
                }
            } message: {
                Text(
                    saveReadableExport ?
                        "This creates a readable copy of private information in JSON Lines or CSV files. Anyone with the saved archive can read it without a recovery code. Choose a safe location. The library keeps its stored files encrypted." :
                        "Some stored contents are not encrypted. Anyone with this downloaded file may be able to read them. Choose a safe location. Saving does not change their protection."
                )
            }
            .onDisappear { download?.cancel() }
    }

    @ViewBuilder private func generation(_ status: GenerationStatus?, label: String) -> some View {
        if status?.running == true { ProgressView("\(label) is being created on your library Mac…") }
        else if let result = status?.lastResult, !result.ok { Text(result.error ?? "\(label) could not finish.").foregroundStyle(DesktopTheme.danger) }
    }

    private func refresh() async {
        guard let api = store.api else { error = "Connect to your library first."
            return
        }
        loading = true
        defer { loading = false }
        do {
            async let catalog: Catalog = api.request("GET", "admin/artifacts")
            async let backup: GenerationStatus = api.request("GET", "admin/backup/status")
            async let exported: GenerationStatus = api.request("GET", "admin/export/status")
            let results = try await (catalog, backup, exported)
            artifacts = results.0.items
            backupStatus = results.1
            exportStatus = results.2
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func create() async {
        guard let api = store.api else { return }
        loading = true
        do {
            let _: Started = try await api.request(
                "POST",
                kind == "backup" ? "admin/backup" : "admin/export",
                body: kind == "backup" ? [:] : ["format": format]
            )
            error = nil
        } catch { self.error = error.localizedDescription }
        loading = false
        let operationError = error
        await refresh()
        if let operationError { error = operationError }
    }

    private func chooseDestination(_ artifact: DesktopArtifact, readableExport: Bool = false) {
        guard let api = store.api, artifact.valid, saving == nil else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = readableExport ? artifact.suggestedFilename
            .replacingOccurrences(of: ".tar", with: "-readable.tar") : artifact.suggestedFilename
        panel.allowedContentTypes = [UTType(filenameExtension: "tar") ?? .data]
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        let operationID = UUID()
        downloadID = operationID
        saving = artifact
        downloadedBytes = 0
        savedURL = nil
        error = nil
        download = Task {
            do {
                try await downloader.save(artifact, api: api, destination: destination, readableExport: readableExport) { count in
                    Task { @MainActor in if downloadID == operationID { downloadedBytes = count } }
                }
                savedURL = destination
            } catch is CancellationError { error = "Download cancelled. No copy was saved." }
            catch { self.error = "The copy was not saved. \(error.localizedDescription)" }
            saving = nil
            downloadID = nil
            download = nil
        }
    }

    private struct Catalog: Decodable { let items: [DesktopArtifact] }
    private struct Started: Decodable { let backupId: String?
        let exportId: String?
    }

    private struct GenerationStatus: Decodable {
        let running: Bool
        let lastResult: Result?
        struct Result: Decodable { let ok: Bool
            let error: String?
        }
    }
}
