// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

struct DesktopSourceSettingsView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State var flow: DesktopSourceSettingsFlow
    @State private var confirmRemoval = false
    @State private var confirmDetach = false
    @State private var movingHost: DesktopDescriptor.Host?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if flow.removalComplete {
                        Label("Source removed", systemImage: "checkmark.circle.fill").font(.title2)
                        Text("Its managed information was removed from Omnesis. Your originals remain where they were.")
                    } else if flow.removalRequested {
                        Label("Removing managed information", systemImage: "clock").font(.title2)
                        Text(
                            "Omnesis has stopped this source. Cleanup continues on the library's home computer even if you close this window."
                        )
                        if flow.error == nil { ProgressView() }
                        else { Button("Check progress") { Task { await flow.observeRemoval()
                            await store.refresh()
                        } } }
                    } else if let source = flow.snapshot?.source {
                        Text(source.accountId).font(.headline).textSelection(.enabled)
                        Label(source.enabled ? "Enabled" : "Paused", systemImage: source.enabled ? "checkmark.circle" : "pause.circle")
                        Button(source.enabled ? "Pause and keep indexed information" : "Resume this source") {
                            Task { await flow.setEnabled(!source.enabled)
                                await store.refresh()
                            }
                        }.disabled(flow.busy)

                        if !flow.sharedParams.isEmpty {
                            GroupBox("Library settings") {
                                VStack(alignment: .leading, spacing: 14) {
                                    Text("These settings apply to the source across your library.").font(.callout)
                                        .foregroundStyle(.secondary)
                                    ForEach(flow.sharedParams) { param in
                                        SourceParameterField(
                                            param: param,
                                            value: sharedBinding(param.name),
                                            allowsFilePicker: isLocalSelectedDevice
                                        )
                                    }
                                    Button("Save library settings") { Task { await flow.saveShared()
                                        await store.refresh()
                                    } }
                                    .disabled(flow.busy)
                                }.padding(8)
                            }
                        }

                        GroupBox("Connected computers") {
                            VStack(alignment: .leading, spacing: 14) {
                                Picker("Settings on", selection: Binding(get: { flow.selectedDeviceId }, set: { id in
                                    Task { await flow.selectDevice(id) }
                                })) {
                                    ForEach(flow.memberIds, id: \.self) { id in Text(deviceName(id)).tag(id) }
                                }.disabled(flow.busy)
                                if !isLocalSelectedDevice {
                                    Text("Paths below refer to \(deviceName(flow.selectedDeviceId)), rather than this Mac.")
                                        .font(.callout).foregroundStyle(.secondary)
                                }
                                ForEach(flow.localParams) { param in
                                    SourceParameterField(
                                        param: param,
                                        value: localBinding(param.name),
                                        allowsFilePicker: isLocalSelectedDevice
                                    )
                                }
                                if !flow.localParams.isEmpty {
                                    Button("Save settings on this computer") { Task { await flow.saveLocal()
                                        await store.refresh()
                                    } }
                                    .disabled(flow.busy)
                                    Text("Saving a folder or local setting leaves the source's paused or enabled choice unchanged.")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                if ["replicated", "partitioned", "handoff"].contains(source.multiDeviceMode ?? ""),
                                   flow.memberIds.count > 1 {
                                    Button("Disconnect \(deviceName(flow.selectedDeviceId))", role: .destructive) { confirmDetach = true }
                                        .disabled(flow.busy)
                                } else if flow.memberIds.count == 1 {
                                    Text(
                                        "This is the source's only computer. Pause it to keep its indexed information, or remove the source below."
                                    )
                                    .font(.callout).foregroundStyle(.secondary)
                                }
                            }.padding(8)
                        }

                        if source.multiDeviceMode == "exclusive" {
                            GroupBox("Move this account") {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text(
                                        "Connect this same account on another computer. Omnesis asks before moving collection and keeps the information already in your library."
                                    )
                                    .font(.callout)
                                    let targets = (flow.descriptor.devices ?? []).filter { $0.id != source.deviceId }
                                    ForEach(targets) { host in
                                        Button("Set up on \(host.name ?? "the selected computer")") { movingHost = host }
                                            .disabled(flow.busy)
                                    }
                                    if targets.isEmpty {
                                        Text("Open Omnesis on the other computer first. It appears here when it can connect this source.")
                                            .font(.callout).foregroundStyle(.secondary)
                                    }
                                }.padding(8)
                            }
                        }

                        Divider()
                        Text(
                            "Removing a source deletes its managed information from Omnesis on all connected computers. Your originals stay where they are."
                        )
                        .font(.callout).foregroundStyle(.secondary)
                        Button("Remove this source…", role: .destructive) { confirmRemoval = true }.disabled(flow.busy)
                    } else if flow.busy {
                        ProgressView("Loading source settings…")
                    }
                    if let message = flow.message { Text(message).foregroundStyle(.secondary) }
                    if let error = flow.error {
                        Text(error).foregroundStyle(.red).textSelection(.enabled)
                        if !flow.removalRequested { Button("Refresh settings") { Task { await flow.load() } }.disabled(flow.busy) }
                    }
                    if flow.busy, flow.snapshot != nil { ProgressView("Saving source changes…") }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(flow.descriptor.name)
            .toolbar { Button("Done") { dismiss() }.disabled(flow.busy) }
        }
        .frame(width: 660, height: 650)
        .interactiveDismissDisabled(flow.busy)
        .task { if flow.snapshot == nil, flow.error == nil, !flow.removalRequested { await flow.load() } }
        .onDisappear { flow.cancelPresentation() }
        .confirmationDialog("Remove this source from your library?", isPresented: $confirmRemoval) {
            Button("Pause and keep indexed information") { Task { await flow.setEnabled(false)
                await store.refresh()
            } }
            Button("Remove managed information", role: .destructive) { Task { await flow.removeSource()
                await store.refresh()
            } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Removal stops collection and deletes this source's documents and analytics from Omnesis on all computers. Original files and accounts remain. Pausing keeps the information already indexed."
            )
        }
        .confirmationDialog("Disconnect \(deviceName(flow.selectedDeviceId))?", isPresented: $confirmDetach) {
            Button("Disconnect this computer", role: .destructive) { Task { await flow.detachSelectedDevice()
                await store.refresh()
            } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(flow.snapshot?.source.multiDeviceMode == "partitioned"
                ? "This removes only the information this computer contributed to this source. Other computers continue contributing. Original files and accounts remain."
                :
                "This computer stops contributing to this source. Information already indexed stays in the library, and the other connected computers continue.")
        }
        .sheet(item: $movingHost, onDismiss: { Task { await flow.load()
            await store.refresh()
        } }) { host in
            if let source = flow.snapshot?.source {
                NavigationStack {
                    SourceSetupView(flow: DesktopSourceFlow(
                        descriptor: flow.descriptor,
                        api: flow.api,
                        hostId: host.id,
                        movingSource: source
                    ))
                    .environment(store)
                    .toolbar { Button("Done") { movingHost = nil } }
                }.frame(width: 680, height: 620)
            }
        }
    }

    private var isLocalSelectedDevice: Bool {
        flow.selectedDeviceId == flow.api.connection.collectorDeviceId
    }

    private func deviceName(_ id: String) -> String {
        store.devices.first(where: { $0.id == id })?.name
            ?? flow.descriptor.devices?.first(where: { $0.id == id })?.name
            ?? "the selected computer"
    }

    private func sharedBinding(_ name: String) -> Binding<String> {
        Binding(get: { flow.sharedValues[name] ?? "" }, set: { flow.sharedValues[name] = $0 })
    }

    private func localBinding(_ name: String) -> Binding<String> {
        Binding(get: { flow.localValues[name] ?? "" }, set: { flow.localValues[name] = $0 })
    }
}

struct DesktopSourceMoveConfirmation: View {
    @Environment(DesktopStore.self) private var store
    let flow: DesktopSourceFlow
    let pending: DesktopSourceSettingsSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Move this account to \(targetName)?").font(.title2)
            Text(pending.source.accountId).font(.headline).textSelection(.enabled)
            Text(
                "Collection stops on the previous computer and starts on the selected one. Information already indexed stays in your library. Original files and credentials on the previous computer stay where they are."
            )
            if !pending.source.enabled {
                Label("This source is paused. Moving it keeps it paused until you choose Resume.", systemImage: "pause.circle")
            }
            HStack {
                Button("Keep current connection", role: .cancel) { flow.pendingMove = nil }.disabled(flow.busy)
                Spacer()
                Button("Move to \(targetName)") { Task { await flow.confirmMove()
                    await store.refresh()
                } }
                .buttonStyle(.borderedProminent).disabled(flow.busy)
            }
            if flow.busy { ProgressView("Moving account…") }
        }.padding(26).frame(width: 520)
            .interactiveDismissDisabled(flow.busy)
    }

    private var targetName: String {
        flow.descriptor.devices?.first(where: { $0.id == flow.deviceId })?.name ?? "the selected computer"
    }
}
