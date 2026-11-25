// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Omnesis
import SwiftUI

struct DesktopAssistantsView: View {
    @Environment(DesktopStore.self) private var store
    @State private var connections = DesktopConnections()
    @State private var authorization = DesktopAgentAuthorization()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Connect an assistant").font(.largeTitle.bold())
                Text(
                    "Use ChatGPT or another assistant to ask about your information. You choose which sources it can use and whether it receives reviewed answers or reads source material directly."
                )
                .foregroundStyle(.secondary)
                if let mcp = connections.mcpURL {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("1. Add Omnesis in your assistant").font(.headline)
                            Text(
                                "In your assistant’s connected apps settings, add a custom MCP connection named Omnesis. Use this address and choose OAuth sign-in."
                            )
                            HStack {
                                Text(mcp.absoluteString).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                                Spacer()
                                Button("Copy address", systemImage: "doc.on.doc") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(mcp.absoluteString, forType: .string)
                                }.accessibilityIdentifier("copy-mcp-address")
                            }
                            Text("This secure address works both at home and away. You do not need a token or an IP address.")
                                .font(.callout).foregroundStyle(.secondary)
                            Link(
                                "ChatGPT setup guide",
                                destination: URL(string: "https://developers.openai.com/api/docs/guides/developer-mode")!
                            )
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    GroupBox {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("2. Confirm the connection").font(.headline)
                            Text(
                                "Start connecting in your assistant. When its sign-in window shows a short confirmation code, enter that code here. Only approve a connection you started yourself."
                            )
                            HStack {
                                TextField("Confirmation code", text: $authorization.code).textFieldStyle(.roundedBorder)
                                    .accessibilityIdentifier("assistant-comparison-code")
                                Button("Find request") {
                                    Task { if let api = store.api, let overview = connections.overview { await authorization.lookup(
                                        api: api,
                                        overview: overview,
                                        expectedResource: mcp
                                    ) } }
                                }.disabled(authorization.code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || authorization.busy)
                            }
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if let request = authorization.request, let overview = connections.overview {
                    authorizationForm(request, overview: overview)
                }
                if authorization.completed {
                    Label(
                        "Your decision was saved. Return to your assistant’s sign-in window to finish.",
                        systemImage: "checkmark.circle.fill"
                    )
                    .foregroundStyle(.green)
                }
                if let failure = authorization.failure ?? connections.failure {
                    Text(failure).foregroundStyle(.red).textSelection(.enabled)
                    Button("Check my account connection") { if let api = store.api { Task { await connections.load(api: api) } } }
                }
                if connections.loading || authorization.busy { ProgressView("Checking your connection…") }
            }.padding(32).frame(maxWidth: 780, alignment: .leading).frame(maxWidth: .infinity)
        }.navigationTitle("Assistants")
            .task { if let api = store.api { await connections.load(api: api) } }
    }

    private func authorizationForm(_ envelope: AccessAuthorizationLookupEnvelope, overview: AccessOverview) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 18) {
                Text("3. Choose what to share").font(.headline)
                LabeledContent("Assistant", value: envelope.request.clientName)
                LabeledContent("Returns to", value: envelope.request.redirectOrigin)
                Text("The app name is supplied by the connecting app. Check it matches the connection you started.").font(.callout)
                    .foregroundStyle(.secondary)
                Toggle("I started this connection myself", isOn: $authorization.personallyStarted)
                Divider()
                Toggle("Let this assistant ask Omnesis questions", isOn: $authorization.allowAnswers)
                    .disabled(envelope.request.requiresAnswer)
                if authorization.allowAnswers {
                    Toggle("Review answers against my privacy policy", isOn: $authorization.reviewedAnswers)
                        .disabled(overview.policyFamilies.isEmpty)
                    if authorization.reviewedAnswers {
                        Picker("Privacy policy", selection: $authorization.policyFamilyId) {
                            ForEach(overview.policyFamilies) { policy in Text(policy.name).tag(policy.id) }
                        }
                    } else {
                        Text(
                            "Answers can leave Omnesis without a privacy review. The selected sources below still limit what the assistant can ask about."
                        )
                        .font(.callout).foregroundStyle(.orange)
                    }
                }
                Toggle("Let this assistant read original source material", isOn: $authorization.allowDirect)
                if authorization.allowDirect {
                    Text(
                        "The assistant can receive source text directly, without Omnesis reviewing each answer. Share only sources you want this assistant to read."
                    )
                    .font(.callout).foregroundStyle(.orange)
                }
                Text("Sources to share").font(.headline)
                ForEach(overview.sources.filter(\.available)) { source in
                    Toggle(source.name, isOn: Binding(get: { authorization.allowedSources.contains(source.id) }, set: { enabled in
                        if enabled { authorization.allowedSources.insert(source.id) }
                        else { authorization.allowedSources.remove(source.id) }
                    }))
                }
                Toggle("Also include sources I connect in future", isOn: $authorization.includeFutureSources)
                HStack {
                    Button("Deny", role: .destructive) {
                        Task { if let api = store.api { await authorization.decide(approve: false, api: api, overview: overview) } }
                    }
                    Spacer()
                    Button("Allow this connection") {
                        Task { if let api = store.api { await authorization.decide(approve: true, api: api, overview: overview) } }
                    }.buttonStyle(.borderedProminent)
                        .disabled(!authorization.personallyStarted || authorization.allowedSources
                            .isEmpty || (!authorization.allowAnswers && !authorization.allowDirect))
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        }.disabled(authorization.busy)
    }
}

struct DesktopPhonePairingView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var connections = DesktopConnections()
    @State private var pairing = DesktopPhonePairing()
    @State private var pairedAPI: DesktopAPI?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Connect your phone").font(.title.bold())
            Text("Install Omnesis on your phone and sign in with the same account. You can also scan a one-time code below.")
                .foregroundStyle(.secondary)
            Picker("Phone", selection: $pairing.kind) {
                Text("iPhone").tag("ios")
                Text("Android").tag("android")
            }.pickerStyle(.segmented).disabled(pairing.pending != nil || pairing.working)
            if pairing.kind == "ios" {
                Link("Get Omnesis for iPhone", destination: URL(string: "https://testflight.apple.com/join/KpMV6HTy")!)
            } else {
                Link("Join the Android test group", destination: URL(string: "https://groups.google.com/g/omnesis-alpha-testers")!)
                Link("Get Omnesis on Google Play", destination: URL(string: "https://play.google.com/apps/testing/dev.omnesis.android")!)
            }
            if let phone = pairing.connectedPhone {
                Label("\(phone.name) is connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else if let payload = pairing.payload, let pending = pairing.pending {
                HStack { Spacer()
                    QRCodeView(payload: payload)
                    Spacer()
                }
                Text("In the Omnesis phone app, choose Scan a code and point the camera here.")
                Text("The code includes your secure Omnesis address. It works at home and away.").font(.callout).foregroundStyle(.secondary)
                Text("Expires \(Date(timeIntervalSince1970: Double(pending.expiresAt) / 1000).formatted(date: .omitted, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
                ProgressView("Waiting for your phone to connect…")
            }
            if let failure = pairing.failure ?? connections.failure {
                Text(failure).foregroundStyle(.red).textSelection(.enabled)
            }
            if pairing.needsBrowserConfirmation, let origin = connections.gatewayOrigin {
                Button("Confirm it’s you on your library’s page") {
                    store.openBrowser(origin.appendingPathComponent("portal/settings/devices"))
                }
            }
            if pairing.working || connections.loading { ProgressView("Preparing a secure connection…") }
            HStack {
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                if pairing.connectedPhone == nil {
                    Button(pairing.pending == nil ? "Create a scan code" : "Create a new code") {
                        Task {
                            guard let api = store.api else { return }
                            await pairing.cancel(api: api)
                            await connections.load(api: api)
                            if let origin = connections.gatewayOrigin { await pairing.start(api: api, gatewayOrigin: origin) }
                        }
                    }.buttonStyle(.borderedProminent).disabled(pairing.working || connections.loading)
                }
            }
        }.padding(30).frame(width: 500)
            .task { if let api = store.api { pairedAPI = api
                await connections.load(api: api)
            } }
            .onDisappear { if let api = pairedAPI { Task { await pairing.cancel(api: api)
                await store.refresh()
            } } }
            .onChange(of: pairing.connectedPhone?.id) { if pairing.connectedPhone != nil { Task { await store.refresh() } } }
    }
}
