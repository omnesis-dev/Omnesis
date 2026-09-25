// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// Where a request to host a source on this device stands with the gateway.
public enum LocalSourceResumeResult: Equatable, Sendable {
    case accepted
    /// Not answered yet: the request stays queued and retries.
    case deferred
    /// Refused for good; `message` explains why when known.
    case refused(message: String?)
}

/// The app operations one activation uses, injected so the order and every
/// failure path can be tested without the operating system or a gateway.
struct LocalSourceActivationEnvironment {
    /// Whether the pairing and its gateway client exist.
    var isGatewayReady: @MainActor () -> Bool
    /// Identifies the current pairing, so work started under one pairing can
    /// tell when it has been replaced or removed.
    var pairingKey: @MainActor () -> String?
    /// Whether the device socket is connected, so a retry has a chance.
    var isConnected: @MainActor () -> Bool
    var isLocallyEnabled: @MainActor (String) -> Bool
    var inspect: @MainActor (String, SourceMultiDeviceMode, MobileSourceActivationChoice?) async throws
        -> MobileSourceActivationOutcome
    var commit: @MainActor (String, SourceMultiDeviceMode, MobileSourceActivationChoice?) async throws -> Void
    /// Asks the gateway to have this device host the source.
    var resume: @MainActor (String) async -> LocalSourceResumeResult
    /// Carries out queued membership work again and reports where the source stands.
    var retryResume: @MainActor (String) async -> LocalSourceResumeResult
    /// Registers the source, creating its row if needed. Returns why it could not.
    var register: @MainActor (String) async -> String?
    /// Starts the first sync and permission check, without waiting for them.
    var startContributing: @MainActor (String) -> Void
    /// A source's background work stopped short of contributing: the gateway
    /// refused it, registration failed, or the source was turned off.
    var completionEnded: @MainActor (String) -> Void
    var sleep: @Sendable (Duration) async -> Void
}

/// Turns phone-hosted sources on through the one path Settings and phone setup
/// share: resolve who hosts the source, ask the operating system, commit the
/// gateway change and switch it on. The source is on from that moment. The
/// rest continues in the background: rebuilding the collector (which waits for
/// any sync already running), having the gateway accept this device,
/// registering the source and starting its first sync. The activator keeps the
/// reason an attempt left a source off, and remembers sources that are on but
/// not registered yet, so they are registered once the gateway accepts them.
@available(iOS 17.0, *)
@MainActor
@Observable
public final class LocalSourceActivator {
    public static let notConnectedMessage = "Omnesis is still connecting to your gateway. Try again in a moment."
    public static let alreadyActivatingMessage = "Omnesis is already turning this on."
    static let pendingRegistrationsKey = "omnesis.localSource.pendingRegistrations"

    /// Why the last attempt to turn on a source left it off, by source id.
    public private(set) var issues: [String: String] = [:]
    /// Sources an activation is running for.
    public private(set) var inFlight: Set<String> = []
    /// Sources that are on while the collector is rebuilt around them.
    public private(set) var preparing: Set<String> = []
    /// Sources that are on here but not registered with the gateway yet. Kept
    /// across launches.
    public private(set) var pendingRegistrations: Set<String>

    @ObservationIgnored var environment: LocalSourceActivationEnvironment?
    /// The waits between membership retries while the background work waits
    /// for the gateway's acceptance.
    @ObservationIgnored var confirmationBackoff: [Duration] = [.seconds(1), .seconds(2), .seconds(4), .seconds(8)]
    @ObservationIgnored private let defaults: KeyValueDefaults
    /// Bumped by `reset()`, so work that outlives it writes nothing.
    @ObservationIgnored private var generation = 0
    /// The background work of sources that are already on, by source id.
    @ObservationIgnored private var completions: [String: Task<Void, Never>] = [:]
    /// Identifies each source's current background work, so work that was
    /// replaced or abandoned writes nothing.
    @ObservationIgnored private var completionTokens: [String: UUID] = [:]

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
        pendingRegistrations = Set((defaults.object(forKey: Self.pendingRegistrationsKey) as? [String]) ?? [])
    }

    func install(_ environment: LocalSourceActivationEnvironment) {
        self.environment = environment
    }

    /// Turns `sourceId` on. Background work left from an earlier turn-on is
    /// replaced by this one's.
    public func activate(
        _ sourceId: String,
        mode: SourceMultiDeviceMode,
        copy: PhoneSetupCopy,
        choice: MobileSourceActivationChoice?,
        steps: MobileSourceActivationSteps
    ) async
        -> MobileSourceEnableResult {
        guard !inFlight.contains(sourceId) else { return .failed(message: Self.alreadyActivatingMessage) }
        endCompletion(sourceId)
        inFlight.insert(sourceId)
        defer { inFlight.remove(sourceId) }
        issues[sourceId] = nil
        guard let environment else { return .failed(message: Self.notConnectedMessage) }
        let generation = generation
        let pairing = environment.pairingKey()
        let result = await resolve(sourceId, mode: mode, choice: choice, steps: steps, environment: environment)
        // A step left while this ran records nothing.
        guard !Task.isCancelled else { return .failed(message: nil) }
        // Unpairing or pairing again while this ran makes its outcome moot.
        guard generation == self.generation, environment.pairingKey() == pairing else {
            return .failed(message: Self.notConnectedMessage)
        }
        switch result {
        case .enabled:
            startCompletion(sourceId, copy: copy, steps: steps, pairing: pairing, environment: environment)
        case .notAllowed, .unavailable, .failed:
            issues[sourceId] = copy.outcomeBody(PhoneSetupOutcome(result))
        case .keptOther, .choiceRequired:
            break
        }
        return result
    }

    /// Stops everything still turning `sourceId` on, as turning it off does:
    /// its background work, its pending registration and its issue. Called
    /// before the source's detach is recorded, so nothing hosts it again.
    public func abandon(_ sourceId: String) {
        endCompletion(sourceId)
        inFlight.remove(sourceId)
        issues[sourceId] = nil
        forgetPendingRegistration(sourceId)
    }

    /// The order every source is turned on in: gateway membership is not
    /// touched until the operating system has granted access, and the source
    /// is switched on locally only once the gateway change is committed.
    static func runSequence(
        _ steps: MobileSourceActivationSteps,
        commit: () async throws -> Void
    ) async
        -> MobileSourceEnableResult {
        let grant: MobileSourceGrant
        switch await steps.authorize() {
        case .granted(let granted): grant = granted
        case .notAllowed: return .notAllowed
        case .unavailable(let reason): return .unavailable(reason: reason)
        case .failed(let message): return .failed(message: message)
        }
        do {
            try await commit()
        } catch {
            return .failed(message: message(for: error))
        }
        await steps.activate()
        return .enabled(grant)
    }

    /// Registers sources whose deferred acceptance a membership pass has
    /// since settled, and forgets those refused or turned off meanwhile.
    public func settlePendingRegistrations(stillPending: Set<String>, refused: Set<String>) async {
        guard let environment else { return }
        let generation = generation
        for sourceId in pendingRegistrations.sorted() {
            // An earlier pass may have taken this source while this one
            // awaited, and a source still being turned on registers itself.
            guard generation == self.generation, pendingRegistrations.contains(sourceId),
                  !inFlight.contains(sourceId), completions[sourceId] == nil else { continue }
            guard !refused.contains(sourceId), environment.isLocallyEnabled(sourceId) else {
                forgetPendingRegistration(sourceId)
                continue
            }
            guard !stillPending.contains(sourceId) else { continue }
            forgetPendingRegistration(sourceId)
            let failure = await environment.register(sourceId)
            guard generation == self.generation else { return }
            if let failure {
                issues[sourceId] = failure
            } else {
                environment.startContributing(sourceId)
            }
        }
    }

    /// Drops issues for sources that are on now.
    public func clearIssues(forEnabled enabled: Set<String>) {
        issues = issues.filter { !enabled.contains($0.key) }
    }

    /// Forgets every issue, pending registration and background work, as
    /// unpairing does.
    public func reset() {
        generation &+= 1
        for sourceId in Array(completions.keys) {
            endCompletion(sourceId)
        }
        issues = [:]
        pendingRegistrations = []
        defaults.removeObject(forKey: Self.pendingRegistrationsKey)
    }

    /// Waits for the background work of sources that were turned on.
    func waitForBackgroundWork() async {
        while let completion = completions.values.first {
            await completion.value
        }
    }

    #if DEBUG
    public func installPreviewIssues(_ issues: [String: String]) {
        self.issues = issues
    }
    #endif

    private func resolve(
        _ sourceId: String,
        mode: SourceMultiDeviceMode,
        choice: MobileSourceActivationChoice?,
        steps: MobileSourceActivationSteps,
        environment: LocalSourceActivationEnvironment
    ) async
        -> MobileSourceEnableResult {
        // Without the gateway client the source could not be registered, so
        // nothing is asked of the operating system either.
        guard environment.isGatewayReady() else { return .failed(message: Self.notConnectedMessage) }
        let inspection: MobileSourceActivationOutcome
        do {
            inspection = try await environment.inspect(sourceId, mode, choice)
        } catch {
            return .failed(message: Self.message(for: error))
        }
        switch inspection {
        case .choiceRequired(let current): return .choiceRequired(current)
        case .keptOther: return .keptOther
        case .incompatible(let current, let desired):
            return .failed(message: MobileSourceActivationError.incompatibleMode(current, desired).errorDescription)
        case .ready: break
        }
        return await Self.runSequence(steps) { try await environment.commit(sourceId, mode, choice) }
    }

    /// Starts the work that follows switching a source on. The source is
    /// remembered as unregistered from the start, so a launch that interrupts
    /// the work still registers it later.
    private func startCompletion(
        _ sourceId: String,
        copy: PhoneSetupCopy,
        steps: MobileSourceActivationSteps,
        pairing: String?,
        environment: LocalSourceActivationEnvironment
    ) {
        rememberPendingRegistration(sourceId)
        preparing.insert(sourceId)
        let token = UUID()
        let run = CompletionRun(sourceId: sourceId, token: token, generation: generation, pairing: pairing)
        completionTokens[sourceId] = token
        completions[sourceId] = Task { [weak self] in
            await steps.afterActivation()
            await self?.complete(run, copy: copy, environment: environment)
        }
    }

    private struct CompletionRun {
        let sourceId: String
        let token: UUID
        let generation: Int
        let pairing: String?
    }

    private func complete(
        _ run: CompletionRun,
        copy: PhoneSetupCopy,
        environment: LocalSourceActivationEnvironment
    ) async {
        let sourceId = run.sourceId
        defer {
            if completionTokens[sourceId] == run.token {
                endCompletion(sourceId)
            }
        }
        func isCurrent() -> Bool {
            !Task.isCancelled && completionTokens[sourceId] == run.token
                && generation == run.generation && environment.pairingKey() == run.pairing
        }
        guard isCurrent() else { return }
        preparing.remove(sourceId)
        // A source turned off while this ran is not hosted again.
        guard environment.isLocallyEnabled(sourceId) else {
            stopTurnedOff(sourceId, environment: environment)
            return
        }
        let acceptance = await confirmAcceptance(sourceId, pairing: run.pairing, environment: environment)
        guard isCurrent() else { return }
        guard environment.isLocallyEnabled(sourceId) else {
            stopTurnedOff(sourceId, environment: environment)
            return
        }
        switch acceptance {
        case .accepted: break
        // Still on here; a later membership pass registers it.
        case .deferred: return
        case .refused(let message):
            forgetPendingRegistration(sourceId)
            issues[sourceId] = copy.outcomeBody(.failed(message: message))
            environment.completionEnded(sourceId)
            return
        }
        let failure = await environment.register(sourceId)
        guard isCurrent() else { return }
        forgetPendingRegistration(sourceId)
        if let failure {
            issues[sourceId] = failure
            environment.completionEnded(sourceId)
            return
        }
        environment.startContributing(sourceId)
    }

    private func stopTurnedOff(_ sourceId: String, environment: LocalSourceActivationEnvironment) {
        forgetPendingRegistration(sourceId)
        environment.completionEnded(sourceId)
    }

    private func endCompletion(_ sourceId: String) {
        completions[sourceId]?.cancel()
        completions[sourceId] = nil
        completionTokens[sourceId] = nil
        preparing.remove(sourceId)
    }

    /// Waits a bounded time for the gateway to accept this device as a host,
    /// retrying with growing gaps and only while connected. A source still
    /// unconfirmed after that stays remembered, so it is registered once a
    /// later membership pass settles it. A pairing change or the source being
    /// turned off ends the wait.
    private func confirmAcceptance(
        _ sourceId: String,
        pairing: String?,
        environment: LocalSourceActivationEnvironment
    ) async
        -> LocalSourceResumeResult {
        var result = await environment.resume(sourceId)
        guard result == .deferred else { return result }
        for delay in confirmationBackoff {
            await environment.sleep(delay)
            guard environment.pairingKey() == pairing else { return .refused(message: nil) }
            guard environment.isLocallyEnabled(sourceId), !Task.isCancelled else { return .deferred }
            guard environment.isConnected() else { continue }
            result = await environment.retryResume(sourceId)
            guard environment.pairingKey() == pairing else { return .refused(message: nil) }
            if result != .deferred { break }
        }
        return result
    }

    private func rememberPendingRegistration(_ sourceId: String) {
        pendingRegistrations.insert(sourceId)
        defaults.set(pendingRegistrations.sorted(), forKey: Self.pendingRegistrationsKey)
    }

    private func forgetPendingRegistration(_ sourceId: String) {
        pendingRegistrations.remove(sourceId)
        if pendingRegistrations.isEmpty {
            defaults.removeObject(forKey: Self.pendingRegistrationsKey)
        } else {
            defaults.set(pendingRegistrations.sorted(), forKey: Self.pendingRegistrationsKey)
        }
    }

    /// Readable copy for an error that stopped an activation. Transport and
    /// gateway errors carry no user-facing text, so they get a sentence.
    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription
            ?? "Couldn't reach your gateway to turn this on. Nothing was changed."
    }
}
