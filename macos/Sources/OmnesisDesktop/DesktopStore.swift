// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Observation
import Omnesis
import SwiftUI

@MainActor @Observable
final class DesktopStore {
    enum Destination: String, CaseIterable, Identifiable {
        case ask = "Ask", search = "Search", sources = "Sources", devices = "Devices", assistants = "Assistants", setup = "Setup"
        var id: Self {
            self
        }

        var symbol: String {
            switch self {
            case .ask: "bubble.left.and.bubble.right"
            case .search: "magnifyingglass"
            case .sources: "square.stack.3d.up"
            case .devices: "laptopcomputer.and.iphone"
            case .assistants: "link"
            case .setup: "checklist"
            }
        }
    }

    var state = DesktopState(phase: .welcome)
    var destination: Destination? = .ask
    var interaction: RuntimeInteraction?
    var failure: String?
    var presentRemoval = false
    var removalPlan: DesktopRemovalPlan?
    var removalOutcome: DesktopRemovalOutcome?
    var busy: Bool {
        requests.busy
    }

    private var requests = BridgeCommandTracker()
    private var statusTask: Task<Void, Never>?
    var api: DesktopAPI?
    var sources: [DesktopSource] = []
    var devices: [DesktopDevice] = []
    var descriptors: [DesktopDescriptor] = []
    var conversations: [ConversationSummary] = []
    private let runtime = RuntimeBridge()
    private var configuredConnection: DesktopConnection?

    init(startRuntime: Bool = true) {
        runtime.onEnvelope = { [weak self] in self?.receive($0) }
        runtime.onFailure = { [weak self] message in
            self?.failure = message
            self?.requests = BridgeCommandTracker()
            self?.statusTask?.cancel()
            self?.statusTask = nil
        }
        if startRuntime { start() }
    }

    func start() {
        Task {
            do {
                try await runtime.start()
                command("status")
                startStatusUpdates()
            } catch { failure = error.localizedDescription }
        }
    }

    func command(_ name: String, params: [String: BridgeValue] = [:]) {
        guard requests.canSubmit(name) else { return }
        failure = nil
        do {
            let id = try runtime.send(name, params: params)
            requests.submitted(id: id, command: name)
        } catch { failure = error.localizedDescription }
    }

    private func startStatusUpdates() {
        guard statusTask == nil else { return }
        statusTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                guard let self else { return }
                guard self.interaction == nil, self.requests.canPoll else { continue }
                do {
                    let id = try self.runtime.send("status")
                    self.requests.submitted(id: id, command: "status")
                } catch { self.failure = error.localizedDescription }
            }
        }
    }

    private func receive(_ envelope: BridgeEnvelope) {
        if let error = envelope.error { failure = error.message }
        let command = envelope.id.flatMap { requests.command(for: $0) }
        if let id = envelope.id { requests.completed(id: id) }
        if command == "remove", envelope.ok == false { removalPlan = nil }
        if envelope.ok == true, command == "removePreview" {
            guard let plan = envelope.removalPlan else { failure = "Omnesis could not review this removal. Try again."
                return
            }
            removalPlan = plan
        }
        if envelope.ok == true, command == "remove" {
            guard let outcome = envelope.removalOutcome else { failure = "Omnesis could not confirm the removal outcome. Keep the app and try again."
                return
            }
            removalOutcome = outcome
            removalPlan = nil
            configuredConnection = nil
            api = nil
            sources = []
            devices = []
            descriptors = []
            conversations = []
            state = DesktopState(phase: .waiting, message: outcome.message, retired: true)
        }
        if let prompt = envelope.interaction { interaction = prompt }
        if let next = envelope.state ?? envelope.result {
            state = next
            if requests.canPoll { interaction = nil }
            if next.phase == .error { failure = next.message }
            if next.canOpenLibrary, let connection = next.connection, connection != configuredConnection {
                configuredConnection = connection
                do {
                    api = try DesktopAPI(connection: connection)
                    Task { await refresh() }
                } catch { failure = error.localizedDescription
                    configuredConnection = nil
                    api = nil
                }
            } else if !next.canOpenLibrary {
                configuredConnection = nil
                api = nil
                sources = []
                devices = []
                descriptors = []
                conversations = []
            }
        }
    }

    func respond(_ value: String) {
        guard let prompt = interaction else { return }
        command("respond", params: ["interactionId": .string(prompt.id), "value": .string(value)])
        interaction = nil
    }

    func openBrowser(_ url: URL) {
        let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host?.lowercased() ?? "")
        guard url.scheme == "https" || (url.scheme == "http" && local),
              url.user == nil, url.password == nil else {
            failure = "Omnesis received an invalid sign-in link. Try starting sign-in again."
            return
        }
        NSWorkspace.shared.open(url)
    }

    func refresh() async {
        guard let api else { return }
        do {
            async let sourceRows = api.sources()
            async let deviceRows = api.devices()
            async let sourceTypes = api.descriptors()
            let result = try await (sourceRows, deviceRows, sourceTypes)
            sources = result.0
            devices = result.1
            descriptors = result.2
            conversations = await (try? api.agent.listConversations()) ?? []
        } catch { failure = error.localizedDescription }
    }

    func openPortal() {
        command("openPortal")
    }

    static func preview(phase: DesktopPhase = .welcome) -> DesktopStore {
        let store = DesktopStore(startRuntime: false)
        store.state = DesktopState(phase: phase, message: phase == .waiting ? "Open Omnesis on your other Mac, then try again." : nil)
        return store
    }
}
