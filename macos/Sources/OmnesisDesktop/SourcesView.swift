// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

struct DesktopSourcesView: View {
    let context: DesktopAPIContext?
    @Environment(DesktopStore.self) private var store
    @State private var showPicker = false
    @State private var repairing: DesktopSourceRepair?
    @State private var managing: DesktopSource?
    @State private var managingDeviceId: String?
    @State private var health = DesktopSourceHealthMonitor()
    @State private var healthRevision = 0
    private let observeHealth: Bool
    init(initialHealth: DesktopSourceHealthMonitor? = nil, observeHealth: Bool = true, context: DesktopAPIContext? = nil) {
        self.context = context
        _health = State(initialValue: initialHealth ?? DesktopSourceHealthMonitor())
        self.observeHealth = observeHealth
    }

    private var checkHealth: (() -> Void)? {
        guard context?.isCurrent == true else { return nil }
        return {
            guard context?.isCurrent == true else { return }
            healthRevision += 1
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let failure = health.failure {
                Label(failure, systemImage: "wifi.exclamationmark")
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                    .padding().frame(maxWidth: .infinity, alignment: .leading)
            }
            Group {
                if store.sources.isEmpty, store.sourceRemovals.isEmpty {
                    ContentUnavailableView {
                        Label("Bring your information together", systemImage: "square.stack.3d.up")
                    } description: { Text("Connect an account or information on this Mac. Your originals stay where they are.") }
                        actions: { Button("Add a source") { showPicker = true }.buttonStyle(DesktopButtonStyle(primary: true)) }
                } else {
                    List {
                        Section("Your sources") {
                            ForEach(store.sources) { source in
                                let policy = DesktopSourceActionPolicy(source: source, devices: store.devices)
                                HStack(alignment: .top, spacing: 20) {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(store.descriptors.first(where: { $0.id == source.type })?.name ?? source.type).font(.headline)
                                        Text(source.accountId).foregroundStyle(DesktopTheme.secondary)
                                        ForEach(source.archivedDevices ?? []) { origin in
                                            Text("History from \(origin.name)").font(.caption).foregroundStyle(DesktopTheme.secondary)
                                        }
                                        DesktopSourceHealthView(
                                            source: source, status: health.statuses[source.id],
                                            current: health.loaded && health.failure == nil,
                                            devices: store.devices,
                                            canSignIn: store.descriptors.first(where: { $0.id == source.type })?.hasAuthFlow == true,
                                            reviewAccess: { device in
                                                let members = policy.members
                                                guard let target = device ?? (members.count == 1 ? members.first : nil)
                                                else { store.failure = "Refresh Sources to identify the computer that needs access."
                                                    return
                                                }
                                                store.accessFocus = DesktopAccessTarget(
                                                    descriptorId: source.type,
                                                    deviceId: target,
                                                    sourceId: source.id,
                                                    accountId: source.accountId,
                                                    params: [:]
                                                )
                                                store.presentAccess = true
                                            }, checkStatus: checkHealth, signIn: { deviceId in repairing = DesktopSourceRepair(
                                                source: source,
                                                deviceId: deviceId
                                            ) }
                                        )
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                    Menu("Actions") {
                                        Button("Sync now") {
                                            context?.run { scope in
                                                do { try await scope.mutateSourceCollection(source.id, sync: true)
                                                    await store.refresh()
                                                } catch { if scope.isCurrent { store.failure = error.localizedDescription } }
                                            }
                                        }.disabled(!policy.canSync)
                                        if store.descriptors.contains(where: { $0.id == source.type }) {
                                            Button("Source settings") { managing = source }
                                        }
                                        if let descriptor = store.descriptors.first(where: { $0.id == source.type }),
                                           descriptor.hasAuthFlow {
                                            ForEach(policy.eligibleMembers, id: \.self) { target in
                                                Button(policy.members.count > 1
                                                    ? "Sign in again on \(store.devices.first(where: { $0.id == target })?.name ?? "the selected computer")"
                                                    : "Sign in again") {
                                                        repairing = DesktopSourceRepair(source: source, deviceId: target)
                                                    }
                                            }
                                        }
                                        Button(source.enabled ? "Pause" : "Resume") {
                                            context?.run { scope in
                                                do {
                                                    try await scope.mutateSourceCollection(
                                                        source.id,
                                                        sync: false,
                                                        enabled: !source.enabled
                                                    )
                                                    await store.refresh()
                                                } catch { if scope.isCurrent { store.failure = error.localizedDescription } }
                                            }
                                        }.disabled(!source.enabled && !policy.canResume)
                                    }.menuStyle(.borderlessButton).tint(DesktopTheme.accent).fixedSize()
                                        .accessibilityLabel("Actions for \(source.accountId)")
                                }.padding(.vertical, 12).listRowSeparator(.visible)
                            }
                        }
                        if !store.sourceRemovals.isEmpty { Section("Removal in progress") {
                            ForEach(store.sourceRemovals) { removal in
                                HStack {
                                    ProgressView().controlSize(.small)
                                    VStack(alignment: .leading) {
                                        Text(store.descriptors.first(where: { $0.id == removal.type })?.name ?? removal.type)
                                        Text(removal.accountId).foregroundStyle(DesktopTheme.secondary)
                                        Text("Removing managed information…").font(.caption).foregroundStyle(DesktopTheme.secondary)
                                    }
                                }.padding(.vertical, 8)
                            }
                        } }
                    }.listStyle(.inset)
                }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).navigationTitle("Sources")
            .toolbar {
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await store.refresh()
                        healthRevision += 1
                    }
                }
                Button { showPicker = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus")
                        Text("Add a source").accessibilityIdentifier("add-source-title")
                    }
                }.accessibilityLabel("Add a source").accessibilityIdentifier("add-source")
            }
            .omnesisSheet(isPresented: $showPicker) { SourcePickerView().environment(store) }
            .onChange(of: store.api.map(ObjectIdentifier.init)) {
                managing = nil
                managingDeviceId = nil
                repairing = nil
                showPicker = false
            }
            .task(id: store.sourceSettingsFocus) {
                guard let focus = store.sourceSettingsFocus else { return }
                if !store.sourcesLoaded { await store.refreshPrerequisiteMetadata() }
                guard !Task.isCancelled, store.sourceSettingsFocus == focus else { return }
                store.sourceSettingsFocus = nil
                guard store.sourcesLoaded, let source = store.sources.first(where: {
                    $0.id == focus.sourceId && $0.type == focus.descriptorId && $0.accountId == focus.accountId
                }) else { store.failure = "This source has changed. Refresh Sources before reviewing its folders."
                    return
                }
                managingDeviceId = focus.deviceId
                managing = source
            }
            .omnesisSheet(item: $managing, onDismiss: { managingDeviceId = nil
                Task { await store.refresh() }
            }) { source in
                if let api = store.api, let descriptor = store.descriptors.first(where: { $0.id == source.type }) {
                    DesktopSourceSettingsView(flow: DesktopSourceSettingsFlow(
                        source: source,
                        descriptor: descriptor,
                        api: api,
                        focusDeviceId: managingDeviceId
                    ))
                    .environment(store).id(ObjectIdentifier(api))
                } else {
                    ContentUnavailableView(
                        "Reconnect to your library",
                        systemImage: "wifi.slash",
                        description: Text("Close these settings and connect to Omnesis again.")
                    )
                    .frame(width: 520, height: 300)
                }
            }
            .omnesisSheet(item: $repairing) { repair in
                let source = repair.source
                if let api = store.api, let descriptor = store.descriptors.first(where: { $0.id == source.type }) {
                    NavigationStack {
                        SourceSetupView(flow: DesktopSourceFlow(
                            descriptor: descriptor,
                            api: api,
                            accountId: source.accountId,
                            hostId: repair.deviceId,
                            repairSourceId: source.id
                        )).environment(store)
                            .toolbar { Button("Done") { repairing = nil }.keyboardShortcut(.cancelAction) }
                    }.frame(width: 680, height: 620)
                }
            }
            .task(id: SourceHealthRequest(api: store.api.map(ObjectIdentifier.init), revision: healthRevision)) {
                guard observeHealth else { return }
                await health.observe(api: store.api)
            }
    }
}

private struct SourceHealthRequest: Equatable {
    let api: ObjectIdentifier?
    let revision: Int
}

struct SourcePickerView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var selected: String?
    var body: some View {
        NavigationStack {
            List(store.descriptors.filter { $0.hasCompanionGuide || $0.pushBased != true }) { descriptor in
                NavigationLink {
                    if let api = store
                        .api { SourceSetupView(flow: store.sourceDraft(descriptor, api: api)).environment(store).id(ObjectIdentifier(api)) }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(descriptor.name).font(.headline)
                        Text(descriptor.description).font(.callout).foregroundStyle(DesktopTheme.secondary)
                    }.padding(.vertical, 6)
                }
            }.overlay {
                if store.descriptors.isEmpty { ContentUnavailableView(
                    "Finding available sources",
                    systemImage: "clock",
                    description: Text("Keep this Mac connected. Sources appear once Omnesis has finished starting.")
                ) }
            }
            .navigationTitle("Add a source")
            .toolbar { Button("Done") { dismiss() }.keyboardShortcut(.cancelAction) }
        }.frame(width: 680, height: 620)
    }
}

struct SourceSetupView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var flow: DesktopSourceFlow
    var body: some View {
        let hasSignInRetry = flow.auth?.state == "error" && flow.canRetryAuthentication
        let hasCredentialReview = flow.auth?.state == "error" && flow.descriptor.credentials != nil
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(flow.descriptor.description).foregroundStyle(DesktopTheme.secondary)
                if !flow.complete, flow.descriptorDeviceId == flow.deviceId, !flow.descriptor.hasCompanionGuide,
                   flow.descriptor.permissionRequirements?.isEmpty != true {
                    DesktopCollectionAccessCard(
                        flow: flow.access,
                        requirements: flow.descriptor.permissionRequirements,
                        computer: store.devices.first(where: { $0.id == flow.deviceId })?.name ?? flow
                            .advertisedHosts.first(where: { $0.id == flow.deviceId })?.name ?? "Selected computer",
                        local: flow.deviceId == flow.api.connection.collectorDeviceId,
                        checkLabel: "Check access and continue",
                        check: { await flow.continueAfterAccess() },
                        chooseFolder: {
                            flow.access
                                .navigationMessage =
                                "Review the folder field below. Your account and other setup choices are kept."
                        },
                        continueUnverified: { await flow.tryCollectionToCheckAccess() }
                    )
                }
                if !flow.complete, !flow.descriptor.hasCompanionGuide, flow.descriptorDeviceId != flow.deviceId {
                    Text("Check source settings on the selected computer before continuing.").foregroundStyle(DesktopTheme.secondary)
                    if flow.advertisedHosts.count > 1, flow.canChooseHost {
                        Picker("Connect from", selection: Binding(get: { flow.deviceId }, set: { flow.selectHost($0) })) {
                            ForEach(flow.advertisedHosts) { host in Text(host.name ?? "Selected computer").tag(host.id) }
                        }
                    }
                    Button("Check source settings") { Task { await flow.prepareSelectedDevice() } }.buttonStyle(DesktopButtonStyle())
                } else if flow.complete {
                    Label {
                        Text("Added").accessibilityIdentifier("source-setup-added")
                    } icon: {
                        Image(systemName: "checkmark.circle.fill")
                    }.font(.title2).foregroundStyle(.green)
                    Text("The source is added to your library. It will sync when the source and its device are available.")
                    if flow
                        .keptPausedAfterMove {
                        Text("This source remains paused. Choose Resume in Sources when you are ready to collect.")
                            .foregroundStyle(DesktopTheme.secondary)
                    }
                } else if flow.descriptor.hasCompanionGuide {
                    SourceCompanionGuideView(
                        descriptor: flow.descriptor,
                        openLink: { store.openBrowser($0) },
                        openPortal: { store.openPortal() }
                    )
                } else if flow.needsCredentials {
                    SourceCredentialsView(flow: flow)
                } else if let auth = flow.auth {
                    authView(auth)
                } else if !flow.accounts.isEmpty {
                    Text("Choose the accounts to connect").font(.headline)
                    ForEach(flow.accounts, id: \.self) { account in
                        Toggle(account, isOn: Binding(get: { flow.selectedAccounts.contains(account) }, set: { selected in
                            if selected { flow.selectedAccounts.insert(account) } else { flow.selectedAccounts.remove(account) }
                        }))
                    }
                    if flow.canAuthenticateAnotherAccount {
                        Button("Sign in to another account") { Task { await flow.authenticateAnotherAccount() } }
                    }
                    Button("Connect selected accounts") { Task { await flow.add()
                        await store.refresh()
                    } }.buttonStyle(DesktopButtonStyle(primary: true))
                } else {
                    if flow.advertisedHosts.count > 1, flow.canChooseHost {
                        Picker("Connect from", selection: Binding(get: { flow.deviceId }, set: { flow.selectHost($0) })) {
                            ForEach(flow.advertisedHosts) { host in Text(host.name ?? "My Mac").tag(host.id) }
                        }
                    }
                    ForEach(flow.descriptor.params ?? []) { param in
                        SourceParameterField(
                            param: param,
                            value: binding(flow.params, key: param.name) { flow.params = $0 },
                            allowsFilePicker: flow.deviceId == flow.api.connection.collectorDeviceId
                        )
                    }
                    Button("Continue") { Task { await flow.begin() } }.buttonStyle(DesktopButtonStyle(primary: true))
                }
                ForEach(Array(flow.notices.enumerated()), id: \.offset) { _, notice in
                    Label(notice.title, systemImage: "info.circle")
                    if let detail = notice.detail { Text(detail).foregroundStyle(DesktopTheme.secondary) }
                }
                if let error = flow.error {
                    Label {
                        Text(error).accessibilityIdentifier("source-setup-error")
                    } icon: {
                        Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
                    }
                    .foregroundStyle(DesktopTheme.ink).textSelection(.enabled)
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(DesktopTheme.raised, in: RoundedRectangle(cornerRadius: 10))
                    if flow.auth?.state == "error" {
                        if flow.canRetryAuthentication {
                            Button("Try sign-in again") { Task { await flow.retry() } }
                                .buttonStyle(DesktopButtonStyle(primary: !flow.needsDescriptorReview))
                                .accessibilityIdentifier("source-recovery-sign-in")
                        }
                        if flow.descriptor
                            .credentials != nil {
                            Button("Review account access") { Task { await flow.reviewCredentials() } }
                                .buttonStyle(DesktopButtonStyle(primary: !flow.needsDescriptorReview && !hasSignInRetry))
                                .accessibilityIdentifier("source-recovery-credentials")
                        }
                    }
                    if flow.offersRegistrationRetry {
                        Button("Try connecting again") { Task { await flow.add()
                            await store.refresh()
                        } }.buttonStyle(DesktopButtonStyle(primary: true))
                            .accessibilityIdentifier("source-recovery-registration")
                    }
                    if flow.offersAnotherAccountAfterFailure {
                        Button("Choose another account") { Task { await flow.authenticateAnotherAccount() } }
                            .buttonStyle(DesktopButtonStyle(primary: !flow.needsDescriptorReview && !hasSignInRetry &&
                                    !hasCredentialReview && !flow.offersRegistrationRetry))
                            .accessibilityIdentifier("source-recovery-account")
                    }
                }
                if flow.needsDescriptorReview {
                    Button("Review updated source settings") { Task { await flow.reviewUpdatedSettings() } }
                        .buttonStyle(DesktopButtonStyle(primary: true)).accessibilityIdentifier("source-review-updated-settings")
                }
                if flow.auth != nil, flow.error != nil || flow.auth?.state == "error" { cancelSignIn }
                if flow.busy { ProgressView("Connecting…").accessibilityIdentifier("source-setup-progress") }
                if !flow.descriptor.hasCompanionGuide {
                    Button("Open advanced setup") { store.openPortal() }.font(.callout)
                        .accessibilityIdentifier("source-advanced-setup")
                }
            }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }.navigationTitle(flow.descriptor.name).disabled(flow.busy || store.api !== flow.api)
            .onAppear {
                let context = store.apiContext
                flow.isCurrentAPI = { [weak owner = store, weak api = flow.api, weak context] in
                    api != nil && owner?.api === api && context?.isCurrent == true
                }
            }
            .onChange(of: store.api.map(ObjectIdentifier.init)) {
                if store.api !== flow.api { flow.invalidatePresentation()
                    dismiss()
                }
            }
            .task(id: flow.deviceId) { await flow.prepareSelectedDevice() }
            .environment(\.openURL, OpenURLAction { url in
                store.openBrowser(url)
                return .handled
            })
            .onChange(of: flow.complete) { if flow.complete { Task { await store.refresh() } } }
            .onDisappear { Task { await flow.cancel() } }
            .omnesisSheet(item: Binding(get: { flow.pendingMove }, set: { flow.pendingMove = $0 })) { pending in
                DesktopSourceMoveConfirmation(flow: flow, pending: pending).environment(store)
            }
    }

    @ViewBuilder private func authView(_ auth: AuthSnapshot) -> some View {
        SourceSetupAuthHeading(state: auth.state, hasFailure: flow.error != nil)
        if auth.state != "error", auth.state != "completed" {
            if let widget = auth.widget {
                SourceWidgetView(flow: flow, widget: widget)
            } else if let challenge = auth.pendingChallenge?.challenge, challenge.kind == "widget",
                      let renderer = challenge.renderer, let payload = challenge.payload {
                SourceWidgetView(flow: flow, widget: AuthSnapshot.Widget(kind: renderer, payload: payload))
            } else if let pending = auth.pendingChallenge {
                let challenge = pending.challenge
                Text(challenge.title).font(.headline)
                if let instructions = challenge.instructions { Text(.init(instructions)) }
                if challenge.via == "loopback", flow.deviceId != flow.api.connection.collectorDeviceId {
                    Label(
                        "This sign-in finishes on the device hosting this source. You can complete it there, or paste the completed link below.",
                        systemImage: "desktopcomputer"
                    )
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
                if let url = challenge
                    .url { Button("Continue in your browser") { store.openBrowser(url) }.buttonStyle(DesktopButtonStyle(primary: true)) }
                if let data = challenge.data { QRCodeView(payload: data) }
                if let schema = challenge.schema {
                    ForEach(schema.keys.sorted(), id: \.self) { name in
                        if let field = schema[name] {
                            SourceChallengeField(field: field, value: binding(flow.answer, key: name) { flow.answer = $0 })
                        }
                    }
                }
                ForEach(challenge.fields ?? []) { param in
                    SourceParameterField(
                        param: param,
                        value: binding(flow.answer, key: param.name) { flow.answer = $0 },
                        allowsFilePicker: false
                    )
                }
                if pending.expectsAnswer, ["redirect", "code", "fields"].contains(challenge.kind) {
                    if challenge.kind == "code" || challenge.kind == "redirect" {
                        let answerLabel = challenge.kind == "code" ? "Confirmation code" : "Completed sign-in link"
                        VStack(alignment: .leading, spacing: 6) {
                            Text(answerLabel).font(.callout)
                            SecureField(
                                answerLabel,
                                text: binding(flow.answer, key: challenge.kind == "code" ? "code" : "url") { flow.answer = $0 }
                            )
                            .accessibilityLabel(answerLabel)
                            .accessibilityIdentifier("source-auth-answer")
                        }
                    }
                    Button("Continue") { Task { await flow.submitAnswer() } }.buttonStyle(DesktopButtonStyle(primary: true))
                } else if challenge.kind != "widget", flow.error == nil {
                    ProgressView("Waiting for confirmation…").accessibilityIdentifier("source-auth-waiting")
                }
            } else {
                if let url = auth.authUrl { Button("Continue in your browser") { store.openBrowser(url) } }
                if let data = auth.qrData { QRCodeView(payload: data) }
                if flow.descriptor.acceptsAuthCode == true {
                    SecureField("Completed sign-in link or confirmation code", text: binding(flow.answer, key: "code") { flow.answer = $0 })
                    Button("Continue") { Task { await flow.submitLegacyCode() } }
                }
                if flow.error == nil {
                    if let message = auth.message { Text(message).foregroundStyle(DesktopTheme.secondary) }
                    ProgressView("Waiting for confirmation…").accessibilityIdentifier("source-auth-waiting")
                }
            }
        }
        if auth.state != "error", flow.error == nil { cancelSignIn }
    }

    private var cancelSignIn: some View {
        Button("Cancel sign-in") { Task { await flow.cancel() } }
            .buttonStyle(DesktopButtonStyle())
            .accessibilityIdentifier("source-cancel-sign-in")
    }

    private func binding(_ values: [String: String], key: String, update: @escaping ([String: String]) -> Void) -> Binding<String> {
        Binding(get: { values[key] ?? "" }, set: { value in var next = values
            next[key] = value
            update(next)
        })
    }
}

private struct SourceSetupAuthHeading: View {
    let state: String
    let hasFailure: Bool
    var body: some View {
        if hasFailure || state == "error" {
            Text(state == "completed" ? "Connection needs attention" : "Sign-in needs attention")
                .font(.headline).accessibilityIdentifier("source-auth-attention")
        } else if state == "completed" {
            Text("Sign-in complete").font(.headline).accessibilityIdentifier("source-auth-complete")
        }
    }
}

#Preview("Source registration needs attention") {
    SourceSetupAuthHeading(state: "completed", hasFailure: true).padding(28).omnesisTheme()
}

#Preview("Source sign-in needs attention") {
    SourceSetupAuthHeading(state: "awaiting-user", hasFailure: true).padding(28).omnesisTheme()
}

#Preview("Source sign-in complete") {
    SourceSetupAuthHeading(state: "completed", hasFailure: false).padding(28).omnesisTheme()
}

struct SourceParameterField: View {
    let param: DesktopDescriptor.Param
    @Binding var value: String
    let allowsFilePicker: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(param.label)
            if param.type == "secret" { SecureField(param.placeholder ?? param.label, text: $value).accessibilityLabel(param.label) }
            else if param.type == "select" {
                Picker(param.label, selection: $value) {
                    Text("Choose…").tag("")
                    ForEach(param.options ?? []) { option in Text(option.label).tag(option.value) }
                }.labelsHidden()
            } else {
                HStack {
                    TextField(param.placeholder ?? param.label, text: $value)
                        .accessibilityLabel(param.label)
                    if param.type == "path", allowsFilePicker {
                        Button("Choose…") {
                            let panel = NSOpenPanel()
                            panel.canChooseDirectories = param.mustExist != "file"
                            panel.canChooseFiles = param.mustExist != "directory"
                            if panel.runModal() == .OK, let url = panel.url { value = url.path }
                        }
                    }
                }
            }
            if let help = param.help { Text(help).font(.caption).foregroundStyle(DesktopTheme.secondary) }
        }.textFieldStyle(.roundedBorder)
    }
}

struct QRCodeView: View {
    let payload: String
    var body: some View {
        if let image {
            Image(nsImage: image).interpolation(.none).resizable().frame(width: 220, height: 220)
                .padding(14).background(.white).clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Scan this code with the app you are connecting")
        }
    }

    private var image: NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: output.extent.width, height: output.extent.height))
    }
}
