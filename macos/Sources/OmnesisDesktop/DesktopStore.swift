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
    var settingsTab = "general"
    var interaction: RuntimeInteraction?
    var failure: String?
    var restartGeneration = 0
    var update: DesktopUpdatePresentation?
    var updateBytes: Int64 = 0
    var updateTotalBytes: Int64?
    private var updateInstaller: DesktopUpdateInstaller?
    private var updateInteractionTask: Task<Void, Never>?
    private var cleaningUpdateInstaller = false
    var presentRecovery = false
    var recoveryImportOutcome: DesktopRecoveryImportOutcome?
    var recoveryStatus: DesktopRecoveryStatus?
    var recoveryDraft: DesktopRecoveryDraft?
    var recoverySaved = false
    var presentRemoval = false
    var removalPlan: DesktopRemovalPlan?
    var removalOutcome: DesktopRemovalOutcome?
    private(set) var launchingRuntime = false
    private(set) var cancellingStartup = false
    private(set) var startupCancelled = false
    var busy: Bool {
        requests.busy || launchingRuntime || cleaningUpdateInstaller
    }

    private var requests = BridgeCommandTracker()
    private var statusTask: Task<Void, Never>?
    var api: DesktopAPI?
    var sources: [DesktopSource] = []
    var sourceRemovals: [DesktopPendingSourceRemoval] = []
    var devices: [DesktopDevice] = []
    var descriptors: [DesktopDescriptor] = []
    var conversations: [ConversationSummary] = []
    private let runtime: RuntimeBridge
    private var startupTask: Task<Void, Never>?
    private var configuredConnection: DesktopConnection?
    private var replyWaiter: DesktopBridgeReplyWaiter?

    init(startRuntime: Bool = true, runtimeBridge: RuntimeBridge? = nil) {
        runtime = runtimeBridge ?? RuntimeBridge()
        replyWaiter = DesktopBridgeReplyWaiter { [weak self] name, params in
            guard let self else { throw DesktopBridgeReplyWaiter.Failure("Reopen Omnesis to continue.") }
            guard self.requests.canSubmit(name), !self.cleaningUpdateInstaller else {
                throw DesktopBridgeReplyWaiter.Failure("Wait for the current operation to finish, then try again.")
            }
            let id = try self.runtime.send(name, params: params)
            self.requests.submitted(id: id, command: name)
            return id
        }
        runtime.onEnvelope = { [weak self] in self?.receive($0) }
        runtime.onFailure = { [weak self] message in
            guard let self else { return }
            recoveryDraft = nil
            replyWaiter?.failAll(message)
            updateInteractionTask?.cancel()
            failure = message
            requests = BridgeCommandTracker()
            statusTask?.cancel()
            statusTask = nil
            configuredConnection = nil
            api = nil
            sources = []
            sourceRemovals = []
            devices = []
            descriptors = []
            conversations = []
            state = DesktopState(
                phase: .waiting,
                mode: state.mode,
                message: message,
                homeName: state.homeName,
                retired: state.retired,
                retirement: state.retirement
            )
        }
        if startRuntime { start() }
    }

    func start() {
        guard !launchingRuntime else { return }
        launchingRuntime = true
        startupCancelled = false
        startupTask = Task {
            defer { launchingRuntime = false }
            do {
                try await runtime.start()
                try Task.checkCancellation()
                command("status")
                startStatusUpdates()
            } catch is CancellationError {
                failure = "App preparation was cancelled. Choose Retry when you’re ready."
            } catch { failure = error.localizedDescription }
        }
    }

    func cancelStartup() async {
        guard launchingRuntime, !cancellingStartup else { return }
        cancellingStartup = true
        defer { cancellingStartup = false }
        statusTask?.cancel()
        statusTask = nil
        startupTask?.cancel()
        runtime.disconnect()
        await startupTask?.value
        requests = BridgeCommandTracker()
        configuredConnection = nil
        api = nil
        sources = []
        sourceRemovals = []
        devices = []
        descriptors = []
        conversations = []
        interaction = nil
        state = DesktopState(phase: .welcome)
        startupCancelled = true
    }

    func command(_ name: String, params: [String: BridgeValue] = [:]) {
        guard requests.canSubmit(name) else { return }
        if name == "cancel" { updateInteractionTask?.cancel() }
        if name == "updateDownload" { updateBytes = 0
            updateTotalBytes = nil
        }
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
        replyWaiter?.receive(envelope)
        if let error = envelope.error { failure = error.message }
        let command = envelope.id.flatMap { requests.command(for: $0) }
        if let id = envelope.id { requests.completed(id: id) }
        if envelope.ok == true, command == "restart", envelope.result?.canOpenLibrary == true {
            restartGeneration += 1
        }
        if envelope.ok == true, let command, command.hasPrefix("recovery") {
            switch command {
            case "recoveryImport":
                guard let outcome = envelope.recoveryImportOutcome, outcome.verified else {
                    failure = "Omnesis could not verify recovery. Keep your recovery file and try again."
                    return
                }
                recoveryImportOutcome = outcome
            case "recoveryStatus":
                recoveryStatus = envelope.recoveryStatus
                if recoveryStatus == nil { failure = "Omnesis could not check recovery protection." }
            case "recoveryPrepare":
                recoveryDraft = envelope.recoveryDraft
                recoverySaved = false
                if recoveryDraft == nil { failure = "Omnesis could not prepare recovery protection." }
            case "recoveryCommit":
                recoverySaved = envelope.recoveryCommit?.saved == true
                if recoverySaved { recoveryDraft = nil }
                else { failure = "Omnesis could not confirm that recovery protection was saved." }
            case "recoveryCancel": recoveryDraft = nil
            default: break
            }
        }
        if command == "recoveryImport", envelope.ok == false {
            failure = "Recovery was not completed. Unlock your Mac, check that the recovery file and code belong to this library, and try again. Keep your recovery file and code."
        }
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
            sourceRemovals = []
            devices = []
            descriptors = []
            conversations = []
            state = DesktopState(phase: .waiting, message: outcome.message, retired: true)
        }
        if let command, command.hasPrefix("update"), envelope.ok == true {
            if let update = envelope.update, update.verified { self.update = update }
            else { update = nil
                failure = "Omnesis could not verify the update response. Check its status again before continuing."
            }
        }
        if let prompt = envelope.interaction {
            if prompt.kind == "desktopUpdateProgress" {
                if case .number(let bytes)? = prompt.payload["bytes"], bytes >= 0, bytes < Double(Int64.max) {
                    updateBytes = Int64(bytes)
                }
                if case .number(let total)? = prompt.payload["totalBytes"], total > 0, total < Double(Int64.max) {
                    updateTotalBytes = Int64(total)
                }
                self.command("respond", params: ["interactionId": .string(prompt.id), "value": .string("continue")])
            } else if DesktopUpdateInteraction.supported.contains(prompt.kind) {
                handleUpdateInteraction(prompt)
            } else { interaction = prompt }
        }
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
                sourceRemovals = []
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

    func request(_ name: String, params: [String: BridgeValue] = [:]) async throws -> BridgeValue {
        try Task.checkCancellation()
        guard requests.canSubmit(name), !launchingRuntime, !cleaningUpdateInstaller else {
            throw DesktopBridgeReplyWaiter.Failure("Wait for the current operation to finish, then try again.")
        }
        guard let replyWaiter else { throw DesktopBridgeReplyWaiter.Failure("Reopen Omnesis to continue.") }
        if name == "restoreApply" || name == "restoreRecover" {
            configuredConnection = nil
            api = nil
            sources = []
            devices = []
            descriptors = []
            conversations = []
            state = DesktopState(phase: .waiting, mode: state.mode, message: "Restoring your library…", homeName: state.homeName)
        }
        return try await replyWaiter.request(name, params: params)
    }

    private func handleUpdateInteraction(_ prompt: RuntimeInteraction) {
        guard let selected = runtime.selectedRuntime else {
            command("cancel", params: ["interactionId": .string(prompt.id)])
            return
        }
        if updateInstaller == nil { updateInstaller = DesktopUpdateInstaller(application: Bundle.main.bundleURL, runtime: selected) }
        guard let installer = updateInstaller else { return }
        updateInteractionTask?.cancel()
        updateInteractionTask = Task {
            do {
                let value = try await DesktopUpdateInteraction.respond(to: prompt, installer: installer)
                try Task.checkCancellation()
                command("respond", params: ["interactionId": .string(prompt.id), "value": value])
                if prompt.kind == "openPreviousDesktopApplication" { NSApp.terminate(nil) }
            } catch {
                command("cancel", params: ["interactionId": .string(prompt.id)])
                failure = error.localizedDescription
            }
        }
    }

    func cleanUpUpdateInstaller() async throws {
        if updateInstaller == nil, let selected = runtime.selectedRuntime {
            updateInstaller = DesktopUpdateInstaller(application: Bundle.main.bundleURL, runtime: selected)
        }
        try await updateInstaller?.cleanup()
    }

    func performUpdateCommand(_ name: String, params: [String: BridgeValue] = [:]) async {
        guard !busy else { return }
        if name == "updateFinish" {
            cleaningUpdateInstaller = true
            do { try await cleanUpUpdateInstaller() }
            catch {
                cleaningUpdateInstaller = false
                failure = error.localizedDescription
                return
            }
            cleaningUpdateInstaller = false
        }
        command(name, params: params)
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
            async let sourceRows = api.sourcePage()
            async let deviceRows = api.devices()
            async let sourceTypes = api.descriptors()
            let result = try await (sourceRows, deviceRows, sourceTypes)
            sources = result.0.items
            sourceRemovals = result.0.pendingRemovals ?? []
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
