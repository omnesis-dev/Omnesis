// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import SwiftUI
import UniformTypeIdentifiers

struct DesktopRecoveryView: View {
    var loadStatus = true
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var importing = false
    @State private var importFile: BridgeValue?
    @State private var importFileName: String?
    @State private var importCode = ""
    @State private var replaceExisting = false
    @State private var revealed = false
    @State private var fileSaved = false
    @State private var codeSaved = false
    @State private var keptSeparately = false
    @State private var error: String?
    @State private var bodyHeight: CGFloat?
    private static let maximumBodyHeight: CGFloat = 360
    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.regular) {
            Text("Recovery protection").font(DesktopDesignTokens.Typography.pageTitle).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("recovery-protection-title")
            ScrollView {
                recoveryContent.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: RecoveryProtectionBodyHeight.self, value: geometry.size.height)
                    })
            }
            .scrollBounceBehavior(.basedOnSize)
            // Reserve room for the heading and dismissal action in a small window.
            .frame(height: min(bodyHeight ?? Self.maximumBodyHeight, Self.maximumBodyHeight))
            .onPreferenceChange(RecoveryProtectionBodyHeight.self) { height in
                if let height, height.isFinite, height >= 0 { bodyHeight = height }
            }
            .accessibilityIdentifier("recovery-protection-content")
            HStack {
                Spacer()
                Button(store.recoverySaved ? "Done" : "Cancel") {
                    if importing, store.busy { store.command("cancel") }
                    importCode = ""
                    cancel()
                    dismiss()
                }.disabled(store.busy && !importing).keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("recovery-protection-dismiss")
            }
        }.buttonStyle(DesktopButtonStyle()).padding(DesktopDesignTokens.Space.section).frame(width: 520)
            .fixedSize(horizontal: false, vertical: true)
            .interactiveDismissDisabled(store.busy)
            .task(id: store.recoveryDraft?.draftId) {
                guard let draft = store.recoveryDraft else { return }
                let remaining = max(0, draft.expiresAt / 1000 - Date().timeIntervalSince1970)
                do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
                while store.busy {
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                }
                guard store.recoveryDraft?.draftId == draft.draftId else { return }
                store.command("recoveryCancel", params: ["draftId": .string(draft.draftId)])
                store.recoveryDraft = nil
                revealed = false
                fileSaved = false
                codeSaved = false
                error = "This recovery draft expired. Prepare another before confirming."
            }
            .onAppear { if loadStatus { store.command("recoveryStatus") } }
            .onAppear { store.recoveryImportOutcome = nil }
            .onDisappear { importCode = ""
                importFile = nil
                cancel()
            }
    }

    private var recoveryContent: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.regular) {
            if let outcome = store.recoveryImportOutcome, outcome.verified {
                Label(
                    outcome.status == "restored" ? "Library access restored" : "This Mac already has the matching protection",
                    systemImage: "checkmark.shield"
                )
                Text(
                    "The library’s recovery key and required encryption protection have been checked. Keep your recovery file and code in their separate safe places."
                )
                Button("Reconnect to your library") { store.command("connect")
                    dismiss()
                }
            } else if importing {
                Text(
                    "Choose the recovery file for the library already stored on this Mac, then enter its code. Keep the file and code in their separate safe places afterward."
                )
                Button("Choose recovery file…") { chooseRecoveryFile() }.disabled(store.busy)
                if let importFileName { LabeledContent("Selected file", value: importFileName) }
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.xSmall) {
                    Text("Recovery code").font(DesktopDesignTokens.Typography.secondary.weight(.medium))
                        .accessibilityIdentifier("recovery-import-code-label")
                    SecureField("Recovery code", text: $importCode).privacySensitive().disabled(store.busy)
                        .accessibilityIdentifier("recovery-import-code")
                }
                Button("Restore library access") {
                    guard let importFile else { return }
                    store.command("recoveryImport", params: ["envelope": importFile, "recoveryCode": .string(importCode)])
                    importCode = ""
                }.buttonStyle(DesktopButtonStyle(primary: true))
                    .disabled(importFile == nil || importCode.isEmpty || importCode.count > 512 || store.busy)
                Button("Back") { importCode = ""
                    importing = false
                }.disabled(store.busy)
            } else if store.recoverySaved {
                Label("Recovery protection saved", systemImage: "checkmark.shield")
                Text(
                    "Keep your recovery file and its code in separate safe places. Both are needed to unlock a backup if this Mac’s key is lost."
                )
            } else if let draft = store.recoveryDraft {
                Text(
                    "Save both items before confirming. This draft expires after five minutes. Your current recovery protection stays in place until you confirm."
                )
                Button("Save recovery file…") { saveEnvelope(draft) }.disabled(store.busy)
                if fileSaved { Label("Recovery file saved", systemImage: "checkmark") }
                Button(revealed ? "Hide recovery code" : "Reveal recovery code") { revealed.toggle() }
                    .accessibilityIdentifier("recovery-protection-reveal")
                if revealed { Text(draft.recoveryCode).font(.body.monospaced()).privacySensitive()
                    .accessibilityIdentifier("recovery-protection-code")
                }
                Button("Save code separately…") { saveCode(draft) }.disabled(store.busy)
                if codeSaved { Label("Recovery code saved", systemImage: "checkmark") }
                Toggle("I have kept the code separate from the recovery file", isOn: $keptSeparately)
                Button("Confirm recovery protection") {
                    guard !draft.expired else { error = "This draft expired. Close this window and create another."
                        return
                    }
                    store.command("recoveryCommit", params: ["draftId": .string(draft.draftId)])
                }.buttonStyle(DesktopButtonStyle(primary: true)).disabled(!fileSaved || !codeSaved || !keptSeparately || store.busy)
                    .accessibilityIdentifier("recovery-protection-confirm")
            } else if let status = store.recoveryStatus {
                if status.available {
                    Text(
                        "Recovery protection lets you unlock an encrypted backup if this Mac’s key is lost. It does not make a copy of your library. Save a backup separately."
                    )
                    if status.hasEnvelope {
                        Text(status
                            .envelopeValid ? "Recovery protection already exists." : "An existing recovery file could not be validated.")
                        Toggle("Replace the existing recovery protection", isOn: $replaceExisting)
                        Text(
                            "Future backups will include the new recovery file. Keep older codes for older backups. Replacement does not invalidate recovery files or codes you saved before."
                        )
                        .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                    }
                    Button("Restore access with a recovery file…") {
                        store.recoveryImportOutcome = nil
                        importing = true
                    }.disabled(store.busy)
                    Button("Prepare recovery protection") {
                        store.command("recoveryPrepare", params: ["replaceExisting": .bool(replaceExisting)])
                    }.disabled(store.busy || (status.hasEnvelope && !replaceExisting))
                } else {
                    Text(
                        "Recovery protection belongs to your library server. Use Omnesis Desktop’s recovery settings there, or the server’s command-line recovery tools."
                    )
                    if let name = store.state.homeName { LabeledContent("Library server", value: name) }
                }
            } else { ProgressView("Checking recovery protection…") }
            if let message = error ?? store.failure { Text(message).foregroundStyle(DesktopTheme.danger)
                .accessibilityIdentifier("recovery-protection-error")
            }
        }
    }

    private func chooseRecoveryFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            importFile = try DesktopRecoveryFile.read(url)
            importFileName = url.lastPathComponent
            error = nil
        } catch {
            importFile = nil
            importFileName = nil
            self.error = "Choose a valid Omnesis recovery JSON file smaller than 16 KiB."
        }
    }

    private func saveEnvelope(_ draft: DesktopRecoveryDraft) {
        do { fileSaved = try save(draft.envelopeData(), name: "Omnesis-recovery.json", type: .json) }
        catch { self.error = error.localizedDescription }
    }

    private func saveCode(_ draft: DesktopRecoveryDraft) {
        do { codeSaved = try save(Data((draft.recoveryCode + "\n").utf8), name: "Omnesis-recovery-code.txt", type: .plainText) }
        catch { self.error = error.localizedDescription }
    }

    private func cancel() {
        if let draft = store.recoveryDraft, !store.busy {
            store.command("recoveryCancel", params: ["draftId": .string(draft.draftId)])
            store.recoveryDraft = nil
        }
    }

    /// Create only a new owner-readable file; never follow or overwrite another file.
    private func save(_ data: Data, name: String, type: UTType) throws -> Bool {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [type]
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        let file = try PrivateSaveFile(url: url)
        do {
            try file.append(data)
            try file.finish()
            error = nil
            return true
        } catch {
            file.discard()
            throw error
        }
    }
}

private struct RecoveryProtectionBodyHeight: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        guard let next = nextValue() else { return }
        value = value.map { max($0, next) } ?? next
    }
}
