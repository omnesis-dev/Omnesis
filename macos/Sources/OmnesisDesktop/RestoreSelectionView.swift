// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import SwiftUI
import UniformTypeIdentifiers

/// Selection reads metadata only. The runtime owns encrypted ingestion and archive validation.
struct DesktopRestoreSelectionView: View {
    let maximumBytes: Int64
    let selected: DesktopRestoreFileSelection?
    let onSelect: (DesktopRestoreFileSelection) -> Void
    @State private var reading = false
    @State private var error: String?
    @State private var selectionTask: Task<Void, Never>?
    @State private var generation = UUID()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Choose a saved Omnesis backup").font(.headline)
            Text("Your selected archive is read without changing the original. Omnesis keeps temporary imported contents encrypted.")
                .foregroundStyle(.secondary)
            if let selected {
                Text(URL(fileURLWithPath: selected.path).lastPathComponent).privacySensitive()
                Text(ByteCountFormatter.string(fromByteCount: selected.bytes, countStyle: .file))
                    .font(.callout).foregroundStyle(.secondary)
            }
            Button(selected == nil ? "Choose backup archive…" : "Choose another backup…") { chooseArchive() }
                .disabled(reading)
            if reading {
                ProgressView("Checking selected file…")
                Button("Cancel selection") { cancel() }
            }
            if let error { Text(error).foregroundStyle(DesktopTheme.danger) }
        }.onDisappear { cancel() }
    }

    private func cancel() {
        generation = UUID()
        selectionTask?.cancel()
        selectionTask = nil
        reading = false
    }

    private func chooseArchive() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType(filenameExtension: "tar") ?? .data]
        panel.message = "Choose the TAR archive saved from Omnesis Backups."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let id = UUID()
        generation = id
        reading = true
        error = nil
        let bound = maximumBytes
        selectionTask = Task {
            let task = Task.detached(priority: .userInitiated) {
                try Task.checkCancellation()
                return try DesktopRestoreFileSelection.read(url, maxBytes: bound)
            }
            do {
                let value = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
                try Task.checkCancellation()
                guard generation == id else { return }
                reading = false
                onSelect(value)
            } catch is CancellationError {
                if generation == id { reading = false }
            } catch {
                guard generation == id else { return }
                reading = false
                self.error = "This file could not be selected safely. Choose a regular backup archive that you own, within the available storage limit."
            }
        }
    }
}

struct DesktopRestoreRecoveryInput: View {
    @Binding var code: String
    @Binding var envelope: BridgeValue?
    @State private var filename: String?
    @State private var error: String?
    @State private var reading = false
    @State private var readTask: Task<Void, Never>?
    @State private var generation = UUID()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Unlock this backup").font(.headline)
            Text("Use the recovery code saved for this backup. This does not replace the key already protecting this Mac’s library.")
                .foregroundStyle(.secondary)
            SecureField("Backup recovery code", text: $code).privacySensitive()
            if code.count > 512 { Text("This recovery code is too long. Check the code saved with this backup.").foregroundStyle(DesktopTheme.danger) }
            Button("Choose a separate recovery file…") { chooseRecoveryFile() }.disabled(reading)
            Text("A separate file is needed only if the backup does not contain its recovery file.")
                .font(.callout).foregroundStyle(.secondary)
            if let filename { Text(filename).privacySensitive() }
            if reading { ProgressView("Reading recovery file…") }
            if let error { Text(error).foregroundStyle(DesktopTheme.danger) }
        }.onDisappear {
            generation = UUID()
            readTask?.cancel()
            code = ""
        }
    }

    private func chooseRecoveryFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let id = UUID()
        generation = id
        reading = true
        error = nil
        readTask = Task {
            let task = Task.detached(priority: .userInitiated) { try DesktopRecoveryFile.read(url) }
            do {
                let value = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
                try Task.checkCancellation()
                guard generation == id else { return }
                envelope = value
                filename = url.lastPathComponent
                reading = false
            } catch {
                guard generation == id else { return }
                reading = false
                self.error = "The selected recovery file could not be read. Choose its original JSON file and try again."
            }
        }
    }
}
