// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Omnesis
import SwiftUI

struct DesktopLibraryConnectionView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var flow = DesktopLibraryConnectionFlow()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Your library’s connection").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Text(
                    "This connection lets your other devices reach the library on this Mac. Your local information remains available while the connection is repaired."
                )
                .foregroundStyle(DesktopTheme.secondary)
                if store.state.mode != "home" {
                    Text("Review this setting on the Mac that keeps your library.").foregroundStyle(DesktopTheme.secondary)
                } else {
                    if let status = flow.status {
                        LabeledContent("Account", value: CloudRelayPresentation.accountLinked(status) ? "Signed in" : "Sign-in needed")
                        LabeledContent("Connection", value: status.tunnel?.state == "online" ? "Online" : "Not confirmed online")
                        LabeledContent(
                            "Connection protection",
                            value: ["valid", "expiring"].contains(status.certificate?.state ?? "") ? "Certificate available" : "Needs checking"
                        )
                        if !CloudRelayPresentation.accountLinked(status) {
                            Text("Your library’s account sign-in needs attention. Return to Setup to review it before reconnecting.")
                                .font(.callout).foregroundStyle(DesktopTheme.secondary)
                            Button("Review setup") { store.destination = .setup
                                store.command("status")
                                dismiss()
                            }
                            .buttonStyle(DesktopButtonStyle())
                        }
                    }
                    if let failure = flow.failure { Text(failure).foregroundStyle(DesktopTheme.danger) }
                    if flow.working { ProgressView("Checking the library connection…") }
                    if flow.recheckRequested {
                        Text("Reconnection was requested. Setup stays incomplete until Omnesis confirms that your library can be reached.")
                            .font(.callout).foregroundStyle(DesktopTheme.secondary)
                    }
                    HStack {
                        Button("Reconnect") { let api = store.api
                            Task { await flow.reconnect {
                                guard store.state.mode == "home", let api, store.api === api else { return }
                                store.command("status")
                            } }
                        }.buttonStyle(DesktopButtonStyle(primary: true))
                            .disabled(flow.working || store.api == nil || flow.status
                                .map { !CloudRelayPresentation.accountLinked($0) } != false)
                            .accessibilityIdentifier("library-connection-reconnect")
                        Button("Check again") { Task { await flow.load()
                            store.command("status")
                        } }
                        .buttonStyle(DesktopButtonStyle()).disabled(flow.working || store.api == nil)
                    }
                }
                HStack { Spacer()
                    Button("Done") { dismiss() }.buttonStyle(DesktopButtonStyle()).keyboardShortcut(.cancelAction)
                }
            }.padding(24)
        }.frame(width: 560).frame(maxHeight: 620)
            .task(id: store.api.map(ObjectIdentifier.init)) {
                flow.bind(store.state.mode == "home" ? store.api : nil)
                await flow.load()
            }
            .onDisappear { flow.cancel()
                if store.state.mode == "home", store.api != nil { store.command("status") }
            }
    }
}
