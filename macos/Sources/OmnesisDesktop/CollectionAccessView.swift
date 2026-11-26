// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import SwiftUI

struct DesktopCollectionAccessCard: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    let flow: DesktopCollectionAccessFlow
    let requirements: [DesktopPermissionRequirement]?
    let computer: String
    let local: Bool
    var checkLabel = "Check again"
    let check: () async -> Void
    var chooseFolder: (() -> Void)?
    var navigate: () -> DesktopPermissionSettings.NavigationResult = { DesktopPermissionSettings.open(.privacySecurity) }
    var continueUnverified: (() async -> Void)?
    @State private var confirmRestart = false

    private var declarations: [DesktopPermissionRequirement] {
        flow.observation?.requirements ?? requirements ?? []
    }

    private var checking: Bool {
        flow.state == .checking || flow.restarting
    }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                Label(
                    flow.restarting ? "Restarting collection" : title,
                    systemImage: flow.allowsCollection ? "checkmark.shield" : "lock.shield"
                )
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
                .foregroundStyle(flow.allowsCollection && !flow.memberAccessProblem ? DesktopTheme.teal : DesktopTheme.ink)
                Text("Computer: \(computer)").font(.callout).foregroundStyle(DesktopTheme.secondary)
                Text(explanation).foregroundStyle(DesktopTheme.secondary)
                ForEach(declarations) { requirement in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(requirement.summary).font(.callout.weight(.medium))
                        Text(requirement.scope).font(.callout).foregroundStyle(DesktopTheme.secondary)
                    }
                }
                if checking { ProgressView("Checking access on \(computer)…").controlSize(.small) }
                if let failure = flow.failure { Text(failure).foregroundStyle(DesktopTheme.danger) }
                if let message = flow.navigationMessage { Text(message).font(.callout).foregroundStyle(DesktopTheme.secondary) }
                if flow.memberAccessProblem {
                    Text(
                        "Collection still needs access to information inside this source. Checking the listed folders does not confirm every file inside; collection must succeed before this step is complete."
                    )
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
                if flow.unresolvedDenial, flow.state != .denied {
                    Text(
                        "The earlier access refusal has not been resolved. Check again after reviewing access; an unavailable check cannot clear that refusal."
                    )
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
                if flow.restartSuggested {
                    Text(
                        "The collection process may need to restart after a permission change. Reopening this window is not proof of access. Keep your source choices, then check again after restarting collection on this computer."
                    )
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
                if flow.observation?.target == "unverified", !flow.allowsCollection, flow.state != .notRequired {
                    Text(
                        "Omnesis has not confirmed which app macOS lists for this access. Do not grant an unrelated app broad access. Only review the files or folders listed above."
                    )
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
                HStack {
                    if hasRepairAction { settingsAction
                        folderAction
                        checkAction
                    } else { checkAction
                        settingsAction
                        folderAction
                    }
                }
                if declarations.contains(where: { $0.actions.contains(where: { $0.kind == .restart }) }),
                   !flow.allowsCollection || flow.memberAccessProblem {
                    if local {
                        Button("Restart collection on this Mac…") { confirmRestart = true }.buttonStyle(DesktopButtonStyle())
                            .disabled(checking || store.busy)
                    } else {
                        Button("I changed a permission; what next?") { flow.restartSuggested = true }.buttonStyle(DesktopButtonStyle())
                    }
                }
                if let continueUnverified, flow.observation != nil, !flow.unresolvedDenial, !flow.memberAccessProblem,
                   [.unavailable, .unsupported].contains(flow.state) {
                    if local, flow.hasManagedPublicationGuard,
                       let selected = flow.target?.deviceId, selected == store.api?.connection.collectorDeviceId {
                        Button("Try collection to check access") { Task { await continueUnverified() } }
                            .buttonStyle(DesktopButtonStyle()).disabled(checking)
                            .accessibilityIdentifier("collection-access-try")
                        Text(
                            "Setup stays incomplete until access is confirmed. Previously indexed information is kept if some information cannot be read."
                        )
                        .font(.caption).foregroundStyle(DesktopTheme.secondary)
                    } else {
                        Text(
                            "Update Omnesis on \(computer), then check access again before starting this source. This collection connection has not confirmed that it can safely try unverified access."
                        )
                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.onChange(of: scenePhase) {
            if scenePhase == .active, flow.target != nil, let api = store.api { Task { await flow.foreground(api: api) } }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification, object: NSApp)) { _ in
            if let api = store.api { Task { await flow.foreground(api: api) } }
        }
        .confirmationDialog("Restart collection on this Mac?", isPresented: $confirmRestart) {
            Button("Restart collection") {
                if let api = store.api { Task { await flow.restartCollector(api: api) { try await store.request("restartCollector") } } }
            }
        } message: {
            Text(
                "Active collection on this Mac will briefly stop. Your indexed information and setup choices are kept. Omnesis will check access again after its new collection connection is ready."
            )
        }
    }

    private var repairKind: DesktopPermissionAction.Kind? {
        guard local, flow.state == .denied || flow.unresolvedDenial || flow.memberAccessProblem else { return nil }
        return declarations.flatMap(\.actions).first { $0.kind == .settings || ($0.kind == .folder && chooseFolder != nil) }?.kind
    }

    private var hasRepairAction: Bool {
        repairKind != nil
    }

    private var checkAction: some View {
        Button(checkLabel) { Task { await check() } }.buttonStyle(DesktopButtonStyle(primary: !hasRepairAction && !flow.allowsCollection))
            .disabled(checking).accessibilityIdentifier("collection-access-check")
            .accessibilityLabel("\(checkLabel) for \(accessLabel)")
    }

    @ViewBuilder private var settingsAction: some View {
        if local, declarations.contains(where: { $0.actions.contains(where: { $0.kind == .settings }) }) {
            Button("Open Privacy & Security") { openSettings() }.buttonStyle(DesktopButtonStyle(primary: repairKind == .settings))
                .accessibilityIdentifier("collection-access-settings")
                .accessibilityLabel("Open Privacy & Security for \(accessLabel)")
        }
    }

    @ViewBuilder private var folderAction: some View {
        if local, let chooseFolder, declarations.contains(where: { $0.actions.contains(where: { $0.kind == .folder }) }) {
            Button("Review chosen folder", action: chooseFolder).buttonStyle(DesktopButtonStyle(primary: repairKind == .folder))
                .accessibilityIdentifier("collection-access-folder")
                .accessibilityLabel("Review chosen folder for \(accessLabel)")
        }
    }

    private var accessLabel: String {
        "\(flow.target?.accountId ?? flow.target?.descriptorId ?? "this source") on \(computer)"
    }

    private var title: String {
        switch flow.state {
        case .needed: "Access for this source"
        case .checking: "Checking access"
        case .available: "Required file access checked"
        case .notRequired: "No local permission needed"
        case .denied: "Access needs your attention"
        case .unavailable: "Access could not be checked"
        case .unsupported: "This access check is unavailable"
        }
    }

    private var explanation: String {
        switch flow.state {
        case .needed: "Only the access needed by your chosen source is checked. Collection waits until this computer can read the selected information."
        case .checking: "Checking access on \(computer). Your selected files and folders are kept."
        case .available: "The check passed for the folders or files listed below. This does not confirm every file inside or access to other information."
        case .notRequired: "This source does not require local file permissions. Its separate sign-in may still be needed."
        case .denied: local ?
            "macOS or another file-access rule refused this source. Review the requested access, then check again. Your indexed information and setup choices are kept." :
            "Review access on \(computer), then check again here. Opening Settings on this Mac cannot grant access on another computer."
        case .unavailable: "This is not proof that a permission was denied. The selected computer or information may be unavailable. Keep the computer awake and connected, then check again."
        case .unsupported: "This source or version cannot perform the quick access check. Access remains unverified; an update may add support."
        }
    }

    private func openSettings() {
        // Responsibility is not yet verified: show the general privacy pane, never a guessed grant target.
        let result = navigate()
        flow.navigationMessage = result == .unavailable
            ? "Open System Settings → Privacy & Security manually, then return and check again."
            : "Privacy & Security was opened. No permission has been confirmed; return here and check again after making your choice."
    }
}

struct DesktopAccessCoach: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var flows: [String: DesktopCollectionAccessFlow] = [:]
    @State private var ownedFlows: Set<String> = []
    @State private var draft: DesktopSourceFlow?
    private var targets: [DesktopAccessTarget] {
        if let focus = store.accessFocus { return [focus] }
        guard let local = store.api?.connection.collectorDeviceId else { return [] }
        return store.sources.filter { $0.enabled && DesktopSourceActionPolicy(source: $0, devices: store.devices).members.contains(local) }
            .map { DesktopAccessTarget(descriptorId: $0.type, deviceId: local, sourceId: $0.id, accountId: $0.accountId, params: [:]) }
    }

    private var context: String {
        store.permissionContext + targets.map(\.id).joined(separator: "|")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text(store.accessFocus == nil ? "Access on this Mac" : "Collection access").font(.title2.weight(.semibold))
                Spacer()
                Button("Done") { dismiss() }.buttonStyle(DesktopButtonStyle()).keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(
                        "Choose what Omnesis may collect. Reading or asking about a library on another Mac does not require access to this Mac’s protected files, screen or other apps."
                    )
                    .foregroundStyle(DesktopTheme.secondary)
                    if targets.isEmpty, !store.sourcesLoaded {
                        Text("Checking which sources collect on this Mac…").foregroundStyle(DesktopTheme.secondary)
                        Button("Check current sources") { Task { await store.refreshPrerequisiteMetadata() } }
                            .buttonStyle(DesktopButtonStyle())
                    } else if targets.isEmpty {
                        Label("No local source needs a permission check yet", systemImage: "shield")
                        Text(
                            "When you choose a source below, Omnesis explains its access before starting collection. Nothing is requested just because you opened this page."
                        )
                        .foregroundStyle(DesktopTheme.secondary)
                    } else {
                        let available = flows.values.filter { $0.allowsCollection && !$0.memberAccessProblem }.count
                        Text(available == targets
                            .count ? "Required file-access checks passed" : available > 0 ? "Some file-access checks still need attention" :
                            "Review access for your selected sources").font(.headline)
                        Text(
                            "Each check covers only the scope listed for that source. Sign-in, collection results and access to nested files are checked separately."
                        )
                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                        ForEach(targets) { target in
                            if let flow = flows[target.id] {
                                Text(target.accountId ?? store.descriptors.first(where: { $0.id == target.descriptorId })?
                                    .name ?? "Selected source").font(.headline)
                                DesktopCollectionAccessCard(
                                    flow: flow,
                                    requirements: target.deviceId == store.api?.connection.collectorDeviceId ?
                                        store.localDescriptors.first(where: { $0.id == target.descriptorId })?.permissionRequirements : nil,
                                    computer: store.devices.first(where: { $0.id == target.deviceId })?.name ?? "Selected computer",
                                    local: target.deviceId == store.api?.connection.collectorDeviceId,
                                    check: { if let api = store.api { await flow.check(api: api) } },
                                    chooseFolder: {
                                        store.sourceSettingsFocus = target
                                        store.destination = .sources
                                        store.presentAccess = false
                                    }
                                )
                            }
                        }
                    }
                    Divider()
                    Text("Choose a source to set up").font(.headline)
                    ForEach(store.descriptors
                        .filter {
                            $0.setupGuide == nil && $0.pushBased != true && $0.devices?
                                .contains(where: { $0.id == store.api?.connection.collectorDeviceId }) == true
                        }) { descriptor in
                            Button { if let api = store.api { draft = store.sourceDraft(descriptor, api: api) } } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(descriptor.name).font(.callout.weight(.medium))
                                    Text(descriptor.permissionRequirements?
                                        .isEmpty == true ? "No local file permission required" : descriptor
                                        .permissionRequirements?.first?.summary ?? "Access will be checked before collection")
                                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(DesktopButtonStyle())
                        }
                    Text(
                        "Source choices stay in this app while you remain connected to this library. Passwords and approval codes are not saved as a setup draft."
                    )
                    .font(.caption).foregroundStyle(DesktopTheme.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(28).frame(width: 680, height: 660).omnesisTheme()
            .task(id: context) {
                for key in ownedFlows {
                    flows[key]?.cancel()
                }
                flows = [:]
                ownedFlows = []
                guard let api = store.api else { return }
                for target in targets {
                    if let shared = store.collectionAccess.flows[target.id] { flows[target.id] = shared }
                    else { let flow = DesktopCollectionAccessFlow()
                        flow.configure(target, api: api)
                        flows[target.id] = flow
                        ownedFlows.insert(target.id)
                    }
                }
                while !Task.isCancelled {
                    for key in ownedFlows {
                        if let flow = flows[key] { await flow.check(api: api) }
                    }
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                }
            }
            .onChange(of: scenePhase) { if scenePhase == .active { Task { await checkAll() } } }
            .onDisappear { for key in ownedFlows {
                flows[key]?.cancel()
            } }
            .omnesisSheet(isPresented: Binding(get: { draft != nil }, set: { if !$0 { draft = nil } })) {
                if let draft { NavigationStack { SourceSetupView(flow: draft).environment(store).toolbar {
                    Button("Not now") { self.draft = nil }.buttonStyle(DesktopButtonStyle()).keyboardShortcut(.cancelAction)
                } }.frame(width: 680, height: 620) }
            }
    }

    private func checkAll() async {
        guard let api = store.api else { return }
        for flow in flows.values {
            guard !Task.isCancelled, store.api === api else { return }
            await flow.check(api: api)
        }
    }
}
