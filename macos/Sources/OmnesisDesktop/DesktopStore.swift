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

    var state = DesktopState(phase: .welcome) {
        didSet {
            let identityChanged = oldValue.installationId != nil && oldValue.installationId != state.installationId
            let roleChanged = oldValue.mode != nil && oldValue.mode != state.mode
            if let api, identityChanged || roleChanged || api.connection != state.connection {
                configuredConnection = nil
                self.api = nil
            }
            homeServices.receive(state)
            refreshApplicationInstallation()
            prerequisiteMonitor?.reconcile()
        }
    }

    let homeServices = DesktopHomeServiceReadiness()
    var destination: Destination? = .ask
    var settingsTab = "general"
    private(set) var nativeOwnerReady = false
    private(set) var applicationOwnership: DesktopBackgroundApplicationOrigin.Evidence?
    private(set) var applicationInstallationCurrent = false
    private var injectedNativeOwner = false
    var backgroundStartupBlock: DesktopBackgroundObserver.StartupBlock? {
        didSet {
            guard backgroundStartupBlock != nil else { return }
            nativeOwnerReady = false
            automaticStartupTask?.cancel()
            automaticStartupTask = nil
            startupInstallation = nil
            if !canRetainVerifiedReads() {
                automaticStartup.bindInstallation(nil)
                invalidateVerifiedReads()
            }
        }
    }

    var presentAccess = false
    var accessFocus: DesktopAccessTarget?
    var sourceSettingsFocus: DesktopAccessTarget?
    let automaticStartup: DesktopAutomaticStartup
    let serverPower: DesktopMacServerPowerFlow
    let collectionAccess = DesktopCollectionAccessRegistry()
    let collectionHealth = DesktopSourceHealthMonitor()
    private(set) var sourceContextRevision = 0 {
        didSet { prerequisiteMonitor?.reconcile() }
    }

    private var prerequisiteMonitor: DesktopPrerequisiteMonitor?
    private var sourceDrafts: [String: DesktopSourceFlow] = [:]
    private let allowsAutomaticStartup: Bool
    private var automaticStartupTask: Task<Void, Never>?
    private var startupInstallation: String?
    private var metadataGeneration = UUID()
    private var sourceScopeDigest: String?
    private var metadataTask: Task<Void, Never>?
    private var metadataTaskID = UUID()
    private(set) var sourceMetadataFailure: String?
    var reviewModelsAfterRestore = false
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
        requests.busy || launchingRuntime || cleaningUpdateInstaller || automaticStartup.working
    }

    private var requests = BridgeCommandTracker()
    private var statusTask: Task<Void, Never>?
    private(set) var apiContext: DesktopAPIContext?
    private(set) var apiContextEpoch: UInt64 = 0
    private var drainingAPIContext: DesktopAPIContext?
    var api: DesktopAPI? {
        didSet {
            if oldValue !== api {
                let previousContext = apiContext ?? drainingAPIContext
                previousContext?.invalidate()
                apiContextEpoch += 1
                apiContext = api.map { DesktopAPIContext(api: $0, id: apiContextEpoch, predecessor: previousContext) }
                drainingAPIContext = api == nil ? previousContext : nil
                verifiedReadScope = nil
                sources = []
                sourceRemovals = []
                devices = []
                descriptors = []
                conversations = []
                conversationHistoryGeneration = UUID()
                conversationHistoryFailure = nil
                collectionHealth.invalidate(clear: true)
                sourcesLoaded = false
                for draft in sourceDrafts.values {
                    draft.invalidatePresentation()
                }
                sourceDrafts = [:]
                sourceSettingsFocus = nil
                accessFocus = nil
                presentAccess = false
                metadataGeneration = UUID()
                sourceScopeDigest = nil
                metadataTask?.cancel()
                metadataTask = nil
                metadataTaskID = UUID()
                sourceMetadataFailure = nil
                localDescriptors = []
            }
            rememberVerifiedReads()
            prerequisiteMonitor?.reconcile()
        }
    }

    var localCollectionSources: [DesktopSource] {
        guard let local = api?.connection.collectorDeviceId else { return [] }
        return sources.filter { $0.enabled && DesktopSourceActionPolicy(source: $0, devices: devices).members.contains(local) }
    }

    var requiredAccessTargets: [DesktopAccessTarget] {
        guard let local = api?.connection.collectorDeviceId else { return [] }
        return localCollectionSources
            .filter { source in localDescriptors.first(where: { $0.id == source.type })?.permissionRequirements?.isEmpty != true }
            .map { DesktopAccessTarget(descriptorId: $0.type, deviceId: local, sourceId: $0.id, accountId: $0.accountId, params: [:]) }
    }

    var permissionContext: String {
        String(describing: api.map(ObjectIdentifier.init)) +
            ":\(apiContextEpoch):\(state.installationId ?? ""):\(state.mode ?? ""):\(state.retired == true):\(sourceContextRevision):" +
            requiredAccessTargets
            .map(\.id).sorted()
            .joined(separator: ":")
    }

    var sourceAccessReady: Bool {
        guard sourcesLoaded, sources.isEmpty || api?.connection.collectorDeviceId != nil else { return false }
        guard localSourceDescriptorsReady else { return false }
        return requiredAccessTargets.isEmpty || (collectionAccess.context == permissionContext && collectionAccess.ready)
    }

    var localSourceDescriptorsReady: Bool {
        sourcesLoaded && localCollectionSources.allSatisfy { source in localDescriptors.contains { $0.id == source.type } }
    }

    var installationIdentityReady: Bool {
        state.installationId?.range(of: "^desktop-[a-f0-9]{16}$", options: .regularExpression) != nil
    }

    var localCollectionIdentityReady: Bool {
        guard sourcesLoaded else { return false }
        guard !sources.isEmpty else { return true }
        guard api?.connection.collectorDeviceId != nil else { return false }
        guard !localCollectionSources.isEmpty else { return true }
        return devices
            .contains { $0.id == api?.connection.collectorDeviceId && $0.revokedAt == nil && $0.needsPairing != true && $0.online == true }
    }

    var startupRepairRequired: Bool {
        !state.canOpenLibrary && state.retired != true && failure != nil &&
            [.disabled, .approvalRequired].contains(automaticStartup.status)
    }

    var requiredSetupReady: Bool {
        state.canOpenLibrary && state
            .encrypted == true && installationIdentityReady && nativeOwnerReady && applicationInstallationCurrent &&
            backgroundStartupBlock ==
            nil && automaticStartup
            .ready &&
            (state.mode != "home" || (serverPower.ready && homeServices.storage == .ready && homeServices.route == .ready)) &&
            sourceAccessReady && localCollectionIdentityReady && sourceConnectionsReady
    }

    var requiredSetupNeedsAction: Bool {
        backgroundStartupBlock != nil || applicationOwnership?.installation == .recoveredVersionInstallNeeded ||
            [.disabled, .approvalRequired, .unavailable].contains(automaticStartup.status) ||
            (state.mode == "home" && [.sleepEnabled, .onBattery, .unavailable].contains(serverPower.status)) ||
            (state.mode == "home" && (homeServices.storage == .blocked || homeServices.storage == .unavailable ||
                    homeServices.route == .unavailable)) ||
            collectionAccess.flows.values
            .contains { $0.memberAccessProblem || $0.unresolvedDenial || [.denied, .unavailable, .unsupported].contains($0.state) } ||
            (sourcesLoaded && !localSourceDescriptorsReady) ||
            (collectionHealth.loaded && (!sourceConnectionsReady || !localCollectionIdentityReady)) || collectionHealth
            .failure != nil || sourceMetadataFailure != nil
    }

    var menuStatusLabel: String {
        guard state.canOpenLibrary else { return state.statusLabel }
        if requiredSetupReady { return "Ready" }
        return requiredSetupNeedsAction ? "Setup needs attention" : "Checking required settings"
    }

    var sourceConnectionsReady: Bool {
        guard !localCollectionSources.isEmpty else { return true }
        guard collectionHealth.loaded, collectionHealth.failure == nil, let local = api?.connection.collectorDeviceId else { return false }
        return localCollectionSources.allSatisfy { source in
            guard let report = collectionHealth.statuses[source.id] else { return false }
            let members = report.members ?? []
            let own = members.isEmpty ? report : members.first(where: { $0.deviceId == local })
            guard let own,
                  own.deviceId == local || DesktopSourceActionPolicy(source: source, devices: devices).members == [local]
            else { return false }
            return !own.needsSignIn && !own.needsAttention && ["idle", "syncing", "synced", "completed"].contains(own.state)
        }
    }

    private(set) var sourcesLoaded = false
    var sources: [DesktopSource] = []
    var sourceRemovals: [DesktopPendingSourceRemoval] = []
    var devices: [DesktopDevice] = []
    var descriptors: [DesktopDescriptor] = []
    private(set) var localDescriptors: [DesktopDescriptor] = []
    var conversations: [ConversationSummary] = []
    private(set) var conversationHistoryFailure: String?
    private(set) var modelConfigurationRevision = 0
    private var observedAnswerAssignment: ResolvedAssignment?
    private var observedAnswerDisplay: ModelDisplay?
    private var conversationHistoryGeneration = UUID()
    private let runtime: RuntimeBridge
    private var startupTask: Task<Void, Never>?
    private struct VerifiedReadScope {
        let installationId: String
        let connection: DesktopConnection
    }

    private var verifiedReadScope: VerifiedReadScope?
    private var configuredConnection: DesktopConnection?
    private var replyWaiter: DesktopBridgeReplyWaiter?

    init(
        startRuntime: Bool = true,
        runtimeBridge: RuntimeBridge? = nil,
        automaticStartup: DesktopAutomaticStartup? = nil,
        serverPower: DesktopMacServerPowerFlow? = nil,
        nativeOwnerVerified: Bool = false,
        monitorPrerequisites: Bool? = nil,
        monitoringIntervals: DesktopPrerequisiteMonitor.Intervals = .init(),
        monitoringNotifications: NotificationCenter = .default
    ) {
        self.allowsAutomaticStartup = startRuntime && automaticStartup == nil
        self.automaticStartup = automaticStartup ?? DesktopAutomaticStartup()
        self.serverPower = serverPower ?? DesktopMacServerPowerFlow()
        runtime = runtimeBridge ?? RuntimeBridge()
        nativeOwnerReady = nativeOwnerVerified
        injectedNativeOwner = nativeOwnerVerified
        applicationInstallationCurrent = nativeOwnerVerified
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
        runtime.onApplicationOwnership = { [weak self] evidence in
            guard let self else { return }
            applicationOwnership = evidence
            refreshApplicationInstallation()
            if !applicationInstallationCurrent {
                automaticStartupTask?.cancel()
                automaticStartupTask = nil
                startupInstallation = nil
                self.automaticStartup.bindInstallation(nil)
            }
        }
        runtime.onStartupBlocked = { [weak self] block in
            self?.backgroundStartupBlock = block
            self?.nativeOwnerReady = block == nil
            self?.automaticStartup.refresh()
        }
        runtime.onFailure = { [weak self] message in
            guard let self else { return }
            nativeOwnerReady = false
            applicationOwnership = nil
            applicationInstallationCurrent = false
            automaticStartupTask?.cancel()
            automaticStartupTask = nil
            startupInstallation = nil
            self.automaticStartup.bindInstallation(nil)
            recoveryDraft = nil
            replyWaiter?.failAll(message)
            updateInteractionTask?.cancel()
            failure = message
            requests = BridgeCommandTracker()
            statusTask?.cancel()
            statusTask = nil
            if canRetainVerifiedReads() {
                // A stopped control channel does not revoke this already verified HTTP read connection.
                backgroundStartupBlock = backgroundStartupBlock ?? .helperUnavailable
                return
            }
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
        collectionHealth.onUpdate = { [weak self] in self?.applyCollectionHealthEvidence() }
        if monitorPrerequisites ?? startRuntime {
            prerequisiteMonitor = DesktopPrerequisiteMonitor(
                store: self,
                intervals: monitoringIntervals,
                notifications: monitoringNotifications
            )
        }
        if startRuntime { start() }
    }

    func stopPrerequisiteMonitoring() async {
        let monitor = prerequisiteMonitor
        prerequisiteMonitor = nil
        await monitor?.stop()
    }

    func cancelPrerequisiteMetadata() {
        metadataGeneration = UUID()
        metadataTask?.cancel()
        sourcesLoaded = false
    }

    func applyCollectionHealthEvidence() {
        guard collectionHealth.loaded, collectionHealth.failure == nil else { return }
        for report in collectionHealth.statuses.values {
            let members = report.members ?? []
            for member in members.isEmpty ? [report] : members {
                if ["synced", "completed"].contains(member.state), !member.needsAccessRecovery {
                    for flow in collectionAccess.flows.values
                        where flow.target?.sourceId == member.sourceId && flow.target?.deviceId == member.deviceId {
                        flow.observeSuccessfulCollection()
                    }
                }
                guard let evidence = member.remediation?.access, evidence.status == "denied",
                      evidence.target == "unverified" else { continue }
                for flow in collectionAccess.flows.values
                    where flow.target?.sourceId == member.sourceId && flow.target?.deviceId == member.deviceId {
                    flow.observeDenial(scopeDigest: evidence.scopeDigest, checkedAt: evidence.checkedAt)
                }
            }
        }
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
            } catch {
                automaticStartup.refresh()
                failure = error.localizedDescription
            }
        }
    }

    func cancelStartup() async {
        guard launchingRuntime, !cancellingStartup else { return }
        cancellingStartup = true
        automaticStartupTask?.cancel()
        automaticStartupTask = nil
        startupInstallation = nil
        automaticStartup.bindInstallation(nil)
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

    private func rememberVerifiedReads() {
        guard nativeOwnerReady, backgroundStartupBlock == nil, originAllowsReads(state), state.canOpenLibrary, installationIdentityReady,
              let identity = state.installationId, let connection = state.connection, api?.connection == connection else { return }
        verifiedReadScope = VerifiedReadScope(installationId: identity, connection: connection)
    }

    private func originAllowsReads(_ proposed: DesktopState) -> Bool {
        guard let evidence = applicationOwnership else { return injectedNativeOwner }
        return evidence.state == .verified && evidence.installationId != nil && evidence.installationId == proposed.installationId
    }

    private func refreshApplicationInstallation() {
        guard let evidence = applicationOwnership else { applicationInstallationCurrent = injectedNativeOwner
            return
        }
        applicationInstallationCurrent = originAllowsReads(state) && evidence.installation == .current &&
            evidence.presentation == .installedOrigin && evidence.originEpoch == evidence.codeEpoch
    }

    private func canRetainVerifiedReads(proposed: DesktopState? = nil) -> Bool {
        guard let scope = verifiedReadScope, state.canOpenLibrary,
              state.installationId == scope.installationId, state.connection == scope.connection,
              api?.connection == scope.connection else { return false }
        guard let proposed else { return true }
        return proposed.retired != true && proposed.installationId == scope.installationId && proposed.connection == scope.connection
    }

    private func invalidateVerifiedReads(proposed: DesktopState? = nil) {
        verifiedReadScope = nil
        configuredConnection = nil
        api = nil
        state = DesktopState(
            phase: .waiting,
            mode: proposed?.mode ?? state.mode,
            homeName: state.homeName,
            retired: proposed?.retired ?? state.retired,
            retirement: proposed?.retirement ?? state.retirement
        )
    }

    private func receive(_ envelope: BridgeEnvelope) {
        if let next = envelope.state ?? envelope.result, next.canOpenLibrary,
           backgroundStartupBlock != nil || !nativeOwnerReady || !originAllowsReads(next) {
            let message = "Finish the required background connection or recovery before confirming this Mac’s setup."
            if !canRetainVerifiedReads(proposed: next) { invalidateVerifiedReads(proposed: next) }
            if let id = envelope.id { requests.completed(id: id) }
            replyWaiter?.failAll(message)
            failure = message
            return // A blocked new projection cannot open a different library or certify setup.
        }
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
            automaticStartupTask?.cancel()
            automaticStartupTask = nil
            startupInstallation = nil
            automaticStartup.bindInstallation(nil)
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
            let identity = next.canOpenLibrary && next.encrypted == true ? next.installationId : nil
            automaticStartup.bindInstallation(identity)
            if startupInstallation != identity {
                automaticStartupTask?.cancel()
                automaticStartupTask = nil
                startupInstallation = identity
            }
            // A verified owned ready profile is durable evidence of the earlier explicit setup,
            // including an interrupted first launch. The receipt precedes the OS request.
            if allowsAutomaticStartup, applicationInstallationCurrent, automaticStartupTask == nil, let identity {
                automaticStartupTask = Task {
                    await automaticStartup.ensureForExplicitSetup(installationId: identity)
                    if !Task.isCancelled, startupInstallation == identity { automaticStartupTask = nil }
                }
            }
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
                verifiedReadScope = nil
                configuredConnection = nil
                api = nil
                sources = []
                sourceRemovals = []
                devices = []
                descriptors = []
                conversations = []
            }
            rememberVerifiedReads()
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

    func observeModelOverview(_ overview: ModelsOverview) {
        let assignment = overview.inference.assignments["agent"]
        let display = overview.assignmentDisplays["agent"]
        guard assignment != observedAnswerAssignment || display != observedAnswerDisplay else { return }
        observedAnswerAssignment = assignment
        observedAnswerDisplay = display
        modelConfigurationRevision += 1
    }

    func sourceDraft(_ descriptor: DesktopDescriptor, api: DesktopAPI) -> DesktopSourceFlow {
        if let draft = sourceDrafts[descriptor.id], draft.api === api, !draft.complete { return draft }
        let draft = DesktopSourceFlow(descriptor: descriptor, api: api)
        let context = apiContext
        draft.isCurrentAPI = { [weak self, weak api, weak context] in
            api != nil && self?.api === api && context?.isCurrent == true
        }
        sourceDrafts[descriptor.id] = draft
        return draft
    }

    func refreshConversationHistory(in expectedContext: DesktopAPIContext? = nil) async {
        guard !Task.isCancelled else { return }
        guard let context = expectedContext ?? apiContext else {
            if expectedContext == nil { conversationHistoryFailure = nil }
            return
        }
        guard context.isCurrent, apiContext === context else { return }
        let generation = UUID()
        conversationHistoryGeneration = generation
        do {
            let rows = try await context.perform { try await $0.agent.listConversations() }
            guard !Task.isCancelled, context.isCurrent, apiContext === context, conversationHistoryGeneration == generation else { return }
            conversations = rows
            conversationHistoryFailure = nil
        } catch is CancellationError {} catch {
            // Keep the last observed history if a refresh fails; never imply that it was erased.
            guard !Task.isCancelled, context.isCurrent, apiContext === context, conversationHistoryGeneration == generation else { return }
            conversationHistoryFailure = "Conversation history could not be refreshed. Your saved conversations are kept."
        }
    }

    func refreshPrerequisiteMetadata() async {
        if let metadataTask { await metadataTask.value
            return
        }
        let operation = UUID()
        metadataTaskID = operation
        let task = Task { await refresh(includeHistory: false, reportFailure: false) }
        metadataTask = task
        await task.value
        if metadataTaskID == operation { metadataTask = nil }
    }

    func refresh(includeHistory: Bool = true, reportFailure: Bool = true) async {
        guard let api else { return }
        let operation = UUID()
        metadataGeneration = operation
        sourcesLoaded = false
        do {
            async let sourceRows = api.sourcePage()
            async let deviceRows = api.devices()
            async let sourceTypes = api.descriptors()
            let result = try await (sourceRows, deviceRows, sourceTypes)
            guard !Task.isCancelled, self.api === api, metadataGeneration == operation else { return }
            let localSources = result.0.items.filter { source in
                guard let local = api.connection.collectorDeviceId else { return false }
                return source.enabled && DesktopSourceActionPolicy(source: source, devices: result.1).members.contains(local)
            }
            let selectedTypes: [DesktopDescriptor]
            if let local = api.connection.collectorDeviceId, !localSources.isEmpty {
                guard result.1.contains(where: { $0.id == local && $0.revokedAt == nil && $0.needsPairing != true }) else {
                    throw DesktopAPIError.message("Repair this Mac’s collection connection before checking its source settings.")
                }
                selectedTypes = try await api.descriptors(deviceId: local)
                guard !Task.isCancelled, self.api === api, metadataGeneration == operation else { return }
            } else { selectedTypes = [] }
            let scope = try DesktopSourcePermissionContext.digest(sources: result.0.items, devices: result.1, descriptors: selectedTypes)
            sources = result.0.items
            sourceRemovals = result.0.pendingRemovals ?? []
            devices = result.1
            descriptors = result.2
            localDescriptors = selectedTypes
            sourcesLoaded = true
            if sourceScopeDigest != scope { sourceScopeDigest = scope
                sourceContextRevision += 1
            }
            sourceMetadataFailure = nil
            if includeHistory { await refreshConversationHistory() }
        } catch {
            guard !Task.isCancelled, self.api === api, metadataGeneration == operation else { return }
            sourceMetadataFailure = "The current source and computer settings could not be checked. Check the library connection and try again."
            if reportFailure { failure = error.localizedDescription }
        }
    }

    func openPortal() {
        command("openPortal")
    }

    static func preview(phase: DesktopPhase = .welcome) -> DesktopStore {
        let store = DesktopStore(
            startRuntime: false,
            automaticStartup: DesktopAutomaticStartup(read: { .enabled }, register: {}),
            serverPower: DesktopMacServerPowerFlow(probe: { DesktopMacServerPowerObservation(status: .ready) }),
            nativeOwnerVerified: true
        )
        store.state = DesktopState(phase: phase, message: phase == .waiting ? "Start Omnesis on your library server, then try again." : nil)
        return store
    }
}
