// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Omnesis
import SwiftUI

struct DesktopAssistantsView: View {
    var context: DesktopAPIContext?
    @Environment(DesktopStore.self) private var store
    @State private var connections = DesktopConnections()
    @State private var authorization = DesktopAgentAuthorization()
    @State private var assistantStatus = DesktopAssistantConnections()
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.section) {
                Text("Connect an assistant").font(DesktopDesignTokens.Typography.pageTitle).accessibilityAddTraits(.isHeader)
                Text(
                    "Use ChatGPT or another assistant to ask about your information. You choose which sources it can use and whether it receives reviewed answers or reads source material directly."
                )
                .foregroundStyle(DesktopTheme.secondary)
                DesktopAssistantStatusView(model: assistantStatus)
                Button("Check assistant connections") { context?.run { scope in await assistantStatus.refresh(context: scope) } }
                if let mcp = connections.mcpURL {
                    DesktopChatGPTInstructions(mcpURL: mcp)
                    GroupBox {
                        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
                            Text("2. Confirm the connection").font(DesktopDesignTokens.Typography.body.weight(.medium))
                            Text(
                                "Start connecting in your assistant. When its sign-in window shows a short confirmation code, enter that code here. Only approve a connection you started yourself."
                            )
                            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.xSmall) {
                                Text("Confirmation code").font(DesktopDesignTokens.Typography.secondary.weight(.medium))
                                    .accessibilityIdentifier("assistant-comparison-code-label")
                                HStack {
                                    TextField("Confirmation code", text: $authorization.code).textFieldStyle(.roundedBorder)
                                        .accessibilityIdentifier("assistant-comparison-code")
                                    Button("Find request") {
                                        if let context, let overview = connections.overview {
                                            authorization.requestLookup(context: context, overview: overview, expectedResource: mcp)
                                        }
                                    }
                                    .disabled(authorization.code.trimmingCharacters(in: .whitespacesAndNewlines)
                                        .isEmpty || authorization.busy)
                                }
                            }
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if let request = authorization.request, let requestID = authorization.requestID, let overview = connections.overview {
                    authorizationForm(request, requestID: requestID, overview: overview)
                }
                if let decision = authorization.decision {
                    DesktopAssistantDecisionView(decision: decision)
                }
                if let failure = authorization.failure ?? connections.failure {
                    Text(failure).foregroundStyle(DesktopTheme.danger).textSelection(.enabled)
                    Button("Check my account connection") { context?.run { scope in await connections.load(context: scope) } }
                }
                if connections.loading || authorization.busy { ProgressView("Checking your connection…") }
            }.padding(DesktopDesignTokens.Layout.wideMargin).frame(maxWidth: DesktopDesignTokens.Layout.readingWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
        }.navigationTitle("Assistants")
            .task(id: context?.id) { if let context { await connections.load(context: context) } }
            .task(id: context?.id) { await assistantStatus.observe(context) }
            .onChange(of: scenePhase) { if scenePhase == .active { context?.run { scope in
                await assistantStatus.refresh(context: scope)
            } } }
    }

    private func authorizationForm(_ envelope: AccessAuthorizationLookupEnvelope, requestID: UUID, overview: AccessOverview) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.regular) {
                Text("3. Choose what to share").font(DesktopDesignTokens.Typography.body.weight(.medium))
                LabeledContent("Assistant", value: envelope.request.clientName)
                LabeledContent("Returns to", value: envelope.request.redirectOrigin)
                Text("The app name is supplied by the connecting app. Check it matches the connection you started.")
                    .font(DesktopDesignTokens.Typography.secondary)
                    .foregroundStyle(DesktopTheme.secondary)
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
                        .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.warning)
                    }
                }
                Toggle("Let this assistant read original source material", isOn: $authorization.allowDirect)
                if authorization.allowDirect {
                    Text(
                        "The assistant can receive source text directly, without Omnesis reviewing each answer. Share only sources you want this assistant to read."
                    )
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.warning)
                }
                Text("Sources to share").font(DesktopDesignTokens.Typography.body.weight(.medium))
                ForEach(overview.sources.filter(\.available)) { source in
                    Toggle(source.name, isOn: Binding(get: { authorization.allowedSources.contains(source.id) }, set: { enabled in
                        if enabled { authorization.allowedSources.insert(source.id) }
                        else { authorization.allowedSources.remove(source.id) }
                    }))
                }
                Toggle("Also include sources I connect in future", isOn: $authorization.includeFutureSources)
                HStack {
                    Button("Deny", role: .destructive) {
                        context?.run { scope in
                            await authorization.decide(approve: false, requestID: requestID, context: scope, overview: overview)
                            if authorization.decision != nil { await assistantStatus.refresh(context: scope) }
                        }
                    }
                    Spacer()
                    Button("Allow this connection") {
                        context?.run { scope in
                            await authorization.decide(approve: true, requestID: requestID, context: scope, overview: overview)
                            if authorization.decision != nil { await assistantStatus.refresh(context: scope) }
                        }
                    }.buttonStyle(DesktopButtonStyle(primary: true))
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
    var context: DesktopAPIContext?
    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
            Text("Connect your phone").font(DesktopDesignTokens.Typography.pageTitle).accessibilityAddTraits(.isHeader)
            Text("Install Omnesis on your phone and sign in with the same account. You can also scan a one-time code below.")
                .foregroundStyle(DesktopTheme.secondary)
            Picker("Phone", selection: $pairing.kind) {
                Text("iPhone").tag("ios")
                Text("Android").tag("android")
            }.pickerStyle(.segmented).disabled(pairing.pending != nil || pairing.working)
            if pairing.kind == "ios" {
                Link("Get Omnesis for iPhone", destination: URL(string: "https://testflight.apple.com/join/KpMV6HTy")!).desktopTextLink()
            } else {
                Link("Join the Android test group", destination: URL(string: "https://groups.google.com/g/omnesis-alpha-testers")!)
                    .desktopTextLink()
                Link("Get Omnesis on Google Play", destination: URL(string: "https://play.google.com/apps/testing/dev.omnesis.android")!)
                    .desktopTextLink()
            }
            if let payload = pairing.payload, let pending = pairing.pending {
                HStack { Spacer()
                    QRCodeView(payload: payload)
                    Spacer()
                }
                Text("In the Omnesis phone app, choose Scan a code and point the camera here.")
                Text("The code includes your secure Omnesis address. It works at home and away.")
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                Text("Expires \(Date(timeIntervalSince1970: Double(pending.expiresAt) / 1000).formatted(date: .omitted, time: .shortened))")
                    .font(DesktopDesignTokens.Typography.metadata).foregroundStyle(DesktopTheme.secondary)
                Text("After scanning, finish connecting in the phone app. This window cannot confirm which phone used this code.")
                    .foregroundStyle(DesktopTheme.secondary)
            }
            if !pairing.observedPhones.isEmpty {
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                    Text("Phones currently connected to your library").font(DesktopDesignTokens.Typography.body.weight(.medium))
                        .accessibilityAddTraits(.isHeader)
                    ForEach(pairing.observedPhones) { phone in
                        Label(phone.name, systemImage: "iphone")
                    }
                }
            }
            if let failure = pairing.failure ?? connections.failure {
                Text(failure).foregroundStyle(DesktopTheme.danger).textSelection(.enabled)
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
                Group {
                    Button(pairing.pending == nil ? "Create a scan code" : "Create a new code") {
                        context?.run { scope in
                            await pairing.cancel()
                            guard scope.isCurrent else { return }
                            await connections.load(context: scope)
                            if let origin = connections.gatewayOrigin, scope.isCurrent { await pairing.start(
                                context: scope,
                                gatewayOrigin: origin
                            ) }
                        }
                    }.buttonStyle(DesktopButtonStyle(primary: true)).disabled(pairing.working || connections.loading)
                }
            }
        }.padding(DesktopDesignTokens.Space.section).frame(width: 500)
            .task(id: context?.id) { if let context { await connections.load(context: context) } }
            .onDisappear { Task { await pairing.cancel() } }
            .onChange(of: pairing.observedPhones.map(\.id)) { Task { await store.refresh() } }
    }
}

struct DesktopAssistantDecisionView: View {
    let decision: DesktopAgentAuthorization.Decision
    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
            Label(
                decision == .approved ? "Permission saved. Return to your assistant’s sign-in window to finish." :
                    "Connection denied. No access was granted.",
                systemImage: decision == .approved ? "checkmark.shield" : "hand.raised"
            )
            if decision == .approved { DesktopChatGPTFinishInstructions() }
        }
    }
}
