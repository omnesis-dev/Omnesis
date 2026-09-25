// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// Tallies for the Settings row that reopens setup.
public struct PhoneSetupSourceSummary: Equatable, Sendable {
    public let enabled: Int
    public let available: Int
}

/// Runs phone setup: whether it appears, what the user selected, where they
/// are, and how each step ended. It also holds the presentation gate every
/// automatic presenter checks, and the queue those presenters take turns in
/// once the gate opens.
@available(iOS 17.0, *)
@MainActor
@Observable
public final class PhoneSetupCoordinator {
    public enum Presentation: Equatable, Sendable {
        /// Shown in place of home after pairing, opening on Connected.
        case firstRun
        /// Reopened from Settings, opening on Choose.
        case settings
        /// One step, opened by turning its source on in Settings. Closes once
        /// the step is answered.
        case settingsStep
    }

    public private(set) var presentation: Presentation?
    public private(set) var isGateActive = false
    public private(set) var flow = PhoneSetupFlow(includesConnected: true) {
        didSet { countSuccessDraws(from: oldValue) }
    }

    /// How many times each step's outcome has become a success. A step's
    /// outcome mark takes this as its identity, so every success appears, and
    /// draws its ring in, afresh.
    public private(set) var successDraws: [String: Int] = [:]
    public private(set) var busyStepId: String?
    /// Bumped after live state is re-read, so views that derive rows from
    /// operating-system state render again.
    public private(set) var revision = 0
    public private(set) var deferredPresentations = DeferredPresentationQueue()

    @ObservationIgnored public private(set) var steps: [any PhoneSetupStep] = []
    @ObservationIgnored public private(set) weak var host: (any PhoneSetupHost)?
    /// Whether the cover of a run opened from Settings has appeared.
    @ObservationIgnored public private(set) var hasAppeared = false
    /// How long a cover opened from Settings may take to appear once the scene
    /// is active. It closes when this expires.
    @ObservationIgnored public var settingsPresentationTimeout: Duration = .seconds(2)
    @ObservationIgnored private var isSceneActive = true
    /// Set while a cover waits for the scene to be active before its timeout starts.
    @ObservationIgnored private var isWatchdogPending = false
    @ObservationIgnored private let progressStore: PhoneSetupProgressStore
    @ObservationIgnored private var deviceId: String?
    @ObservationIgnored private var runToken: UUID?
    /// The step whose outcome sent the user to iOS Settings, until they return.
    @ObservationIgnored private var settingsRoundTripStepId: String?
    /// The running step's enable, cancelled when the user leaves the step.
    @ObservationIgnored private var runTask: Task<PhoneSetupOutcome, Never>?
    /// Automatic steps the user declined in this run, never added again in it.
    @ObservationIgnored var declinedStepIds: Set<String> = []
    /// Presentations answered in the flow, held back until the app next leaves
    /// the foreground.
    @ObservationIgnored var answeredPresentations: Set<DeferredPresenter> = []
    @ObservationIgnored private var presentationAttempt = 0

    public init(progressStore: PhoneSetupProgressStore = PhoneSetupProgressStore()) {
        self.progressStore = progressStore
    }

    public func install(host: any PhoneSetupHost, steps: [any PhoneSetupStep]) {
        self.host = host
        self.steps = steps
    }

    // MARK: - Reading

    public func step(id: String) -> (any PhoneSetupStep)? {
        steps.first { $0.id == id }
    }

    public var currentStep: (any PhoneSetupStep)? {
        flow.currentStepId.flatMap { step(id: $0) }
    }

    /// Sources that are on, out of those that are on or could be turned on. A
    /// source that is on counts even while its row is unavailable.
    public var sourceSummary: PhoneSetupSourceSummary {
        let sources = steps.filter { $0.group == .source }
        return PhoneSetupSourceSummary(
            enabled: sources.filter(\.isOn).count,
            available: sources.filter { $0.isOn || $0.rowState == .selectable }.count
        )
    }

    /// Whether any source is on for this device now, whatever the run recorded.
    public var isContributing: Bool {
        steps.contains { $0.group == .source && $0.isOn }
    }

    /// An example question from a source that is on now, preferring one
    /// chosen in this run.
    public var suggestedQuestion: String? {
        let onSources = steps.filter { $0.group == .source && $0.isOn }
        let source = onSources.first { flow.isSelected($0.id) } ?? onSources.first
        return source?.copy.ask
    }

    /// Why a step cannot be opened right now, when its row is unavailable.
    public func unavailableReason(for stepId: String) -> String? {
        guard case .unavailable(let reason) = step(id: stepId)?.rowState else { return nil }
        return reason
    }

    // MARK: - Presentation

    /// Holds the presentation gate from the moment a pairing loads until
    /// `evaluateAutomaticPresentation` has decided, so nothing presents in the
    /// window where setup may still appear. A device that has already been
    /// through setup is never held.
    public func holdForEvaluation(deviceId: String) {
        guard presentation == nil, progressStore.completedForDeviceId != deviceId else { return }
        isGateActive = true
    }

    /// Offers setup for a freshly paired or relaunched device, resuming an
    /// unfinished run where it stopped.
    public func evaluateAutomaticPresentation(deviceId: String, anyPhoneSourceEnabled: Bool) {
        guard presentation == nil else { return }
        // A run naming a step this build no longer has cannot resume.
        let saved = progressStore.progress(for: deviceId)
            .flatMap { run in run.selection.allSatisfy { step(id: $0) != nil } ? run : nil }
        let decision = PhoneSetupPresentationPolicy.decide(
            completedForDeviceId: progressStore.completedForDeviceId,
            deviceId: deviceId,
            // A saved run turned sources on itself; it resumes rather than
            // counting as a device someone set up in Settings.
            anyPhoneSourceEnabled: anyPhoneSourceEnabled && saved == nil
        )
        switch decision {
        case .none:
            isGateActive = false
        case .completeSilently:
            progressStore.completedForDeviceId = deviceId
            progressStore.clearProgress()
            isGateActive = false
        case .present:
            self.deviceId = deviceId
            var resumed = saved ?? PhoneSetupFlow(includesConnected: true)
            reconcile(&resumed)
            flow = resumed
            present(.firstRun)
            syncAutomaticSteps()
        }
    }

    public func presentFromSettings(deviceId: String) {
        guard presentation == nil else { return }
        self.deviceId = deviceId
        flow = PhoneSetupFlow(includesConnected: false)
        present(.settings)
    }

    /// Opens the page for one source that is off, as its Settings switch does.
    public func presentStep(_ stepId: String, deviceId: String) {
        guard presentation == nil, step(id: stepId)?.rowState == .selectable else { return }
        self.deviceId = deviceId
        var single = PhoneSetupFlow(includesConnected: false)
        single.toggle(stepId, order: [stepId])
        single.startSteps()
        flow = single
        present(.settingsStep)
    }

    /// Records that a Settings run's cover is on screen.
    public func presentationDidAppear() {
        hasAppeared = true
        isWatchdogPending = false
    }

    /// Tells the coordinator whether the scene is active. A cover's timeout only
    /// runs while it is, since nothing presents in the background.
    public func sceneDidChange(isActive: Bool) {
        isSceneActive = isActive
        guard isActive, isWatchdogPending else { return }
        isWatchdogPending = false
        scheduleWatchdog()
    }

    /// Releases the presentation gate once a Settings run's cover has finished
    /// dismissing, so work that waited behind it can present.
    public func presentationDidEnd() {
        guard presentation == nil else { return }
        isGateActive = false
    }

    /// Ends the run from Skip for now, Start asking, or the last step of a run
    /// opened from Settings. Only the first-run offer records that this device
    /// has been through setup.
    public func complete() {
        guard presentation == .firstRun else {
            close()
            return
        }
        if let deviceId {
            progressStore.completedForDeviceId = deviceId
        }
        progressStore.clearProgress()
        close()
    }

    /// Forgets setup for the device being unpaired, so the next pairing is
    /// offered it again.
    public func resetForUnpair() {
        progressStore.reset()
        endForPairingLoss()
    }

    /// Ends whatever setup is showing when the pairing goes away, keeping
    /// what this device has already been through.
    public func endForPairingLoss() {
        presentationAttempt &+= 1
        presentation = nil
        flow = PhoneSetupFlow(includesConnected: true)
        busyStepId = nil
        runToken = nil
        runTask?.cancel()
        runTask = nil
        settingsRoundTripStepId = nil
        isWatchdogPending = false
        hasAppeared = false
        isGateActive = false
        deviceId = nil
        deferredPresentations = DeferredPresentationQueue()
        answeredPresentations = []
        declinedStepIds = []
    }

    // MARK: - Navigation

    public func continueFromConnected() {
        flow.showChoose()
        persist()
    }

    public func toggle(_ id: String) {
        guard busyStepId == nil, step(id: id)?.rowState == .selectable else { return }
        flow.toggle(id, order: steps.map(\.id))
        persist()
    }

    /// Starts the chosen steps, with the automatic steps they call for.
    public func startSelectedSteps() {
        guard flow.selection.contains(where: { step(id: $0)?.group != .automatic }) else { return }
        var started = flow
        applyAutomaticSteps(&started)
        guard started.startSteps() else { return }
        flow = started
        persist()
    }

    public func next() {
        guard busyStepId == nil else { return }
        if presentation == .settingsStep, flow.isOnLastStep {
            close()
            return
        }
        flow.advance()
        persist()
    }

    /// Goes back a page. A step still waiting on iOS is abandoned: its late
    /// result is discarded, so a prompt that never answers cannot trap the page.
    public func back() {
        busyStepId = nil
        runToken = nil
        runTask?.cancel()
        runTask = nil
        if presentation == .settingsStep, flow.currentStepIndex == 0 {
            close()
            return
        }
        flow.back()
        // Choose lists only what the user picks; the flow adds its own steps
        // again when the run restarts.
        if case .choose = flow.screen {
            flow.dropSteps(automaticStepIds)
        }
        persist()
    }

    // MARK: - Steps

    /// Runs the current step and records its outcome. A step that needs no
    /// page of its own moves straight on.
    public func runCurrentStep(choice: MobileSourceActivationChoice? = nil) async {
        guard let run = beginRun() else { return }
        await finishRun(run, choice: choice)
    }

    /// Records that the current step's outcome opened iOS Settings, so the
    /// step can carry on by itself when the user comes back with more access.
    public func didOpenSettings() {
        settingsRoundTripStepId = currentStep?.id
    }

    /// Whether access `authorization` is more than `recorded` had: refused
    /// access now granted, or limited access now full.
    static func accessImproved(from recorded: PhoneSetupOutcome, to authorization: MobileSourceAuthorization?) -> Bool {
        guard case .granted(let grant) = authorization else { return false }
        switch recorded {
        case .notAllowed: return true
        case .partial, .limited: return grant == .full
        case .on, .unavailable, .choiceRequired, .failed, .skipped: return false
        }
    }

    private struct StepRun {
        let step: any PhoneSetupStep
        let token: UUID
    }

    /// Marks the current step busy, synchronously, so nothing else starts it
    /// or reconciles its outcome while it runs.
    private func beginRun() -> StepRun? {
        guard busyStepId == nil, let step = currentStep else { return nil }
        let token = UUID()
        busyStepId = step.id
        runToken = token
        return StepRun(step: step, token: token)
    }

    private func finishRun(_ run: StepRun, choice: MobileSourceActivationChoice?) async {
        let id = run.step.id
        let task = Task { await run.step.enable(choice: choice) }
        runTask = task
        let outcome = await task.value
        guard runToken == run.token else { return }
        runTask = nil
        busyStepId = nil
        runToken = nil
        guard presentation != nil, flow.currentStepId == id else { return }
        flow.record(outcome, for: id)
        if outcome == .skipped {
            if presentation == .settingsStep {
                close()
                return
            }
            flow.advance()
        }
        persist()
        // A step's outcome decides whether an automatic step is now needed.
        syncAutomaticSteps()
    }

    /// Re-reads operating-system state, typically on returning from iOS
    /// Settings, and updates the outcomes that state decides.
    public func refreshLiveState() async {
        for step in steps {
            await step.refresh()
        }
        continueAfterSettings()
        reconcileRecordedOutcomes()
        syncAutomaticSteps()
    }

    /// Brings recorded outcomes in line with the device without re-reading
    /// anything, as when a source's background work ends with a refusal.
    public func reconcileRecordedOutcomes() {
        var refreshed = flow
        reconcile(&refreshed)
        if refreshed != flow {
            flow = refreshed
            persist()
        }
        revision &+= 1
    }

    /// Back from iOS Settings with more access than the recorded outcome had,
    /// the step carries on by itself instead of showing its page again: a
    /// source that is already on takes the outcome its access now implies, and
    /// one that is off is turned on.
    private func continueAfterSettings() {
        guard let id = settingsRoundTripStepId else { return }
        settingsRoundTripStepId = nil
        guard let step = currentStep, step.id == id else { return }
        guard let recorded = flow.outcomes[id] else {
            // A page that sent the user to Settings shows what the device says now.
            if step.introduction == .openSettings {
                flow.record(step.currentOutcome() ?? .notAllowed, for: id)
                persist()
            }
            return
        }
        guard Self.accessImproved(from: recorded, to: step.authorization) else { return }
        if step.isOn {
            if let live = step.currentOutcome() {
                flow.record(live, for: id)
                persist()
            }
            return
        }
        guard let run = beginRun() else { return }
        Task { await finishRun(run, choice: nil) }
    }

    /// Brings recorded outcomes in line with the device, and gives a selected
    /// step that never ran the outcome its state already implies, so a source
    /// that is already on is not activated again.
    private func reconcile(_ flow: inout PhoneSetupFlow) {
        for id in flow.selection where id != busyStepId {
            guard let step = step(id: id) else { continue }
            let live = step.currentOutcome()
            if let recorded = flow.outcomes[id] {
                // A source that went off after it was turned on, with a reason
                // such as the gateway refusing this device, says so.
                if recorded.isContributing, !step.isOn,
                   let issue = step.statusSourceId.flatMap({ host?.enableIssue(sourceId: $0) }) {
                    flow.record(.failed(message: issue), for: id)
                } else {
                    flow.record(step.reconciled(recorded, live: live), for: id)
                }
            } else if let live {
                flow.record(live, for: id)
            }
        }
    }

    private func close() {
        let closing = presentation
        presentationAttempt &+= 1
        settingsRoundTripStepId = nil
        runTask?.cancel()
        runTask = nil
        presentation = nil
        busyStepId = nil
        runToken = nil
        isWatchdogPending = false
        // First-run setup is the root's content, so nothing dismisses when it
        // closes; a cover that never appeared never dismisses either.
        if closing == .firstRun || !hasAppeared {
            isGateActive = false
        }
    }

    private func present(_ presentation: Presentation) {
        self.presentation = presentation
        declinedStepIds = []
        isGateActive = true
        guard presentation != .firstRun else {
            // First-run setup takes the root from whatever the root presents: a
            // consent sheet it had up waits for its turn again.
            deferredPresentations.stepAsideForSetup()
            return
        }
        beginPresentationAttempt()
    }

    private func beginPresentationAttempt() {
        hasAppeared = false
        presentationAttempt &+= 1
        if isSceneActive {
            scheduleWatchdog()
        } else {
            isWatchdogPending = true
        }
    }

    private func scheduleWatchdog() {
        let attempt = presentationAttempt
        let timeout = settingsPresentationTimeout
        Task { [weak self] in
            try? await Task.sleep(for: timeout)
            self?.presentationTimedOut(attempt)
        }
    }

    /// A cover opened from Settings that has not appeared closes, so the next
    /// switch can open another.
    private func presentationTimedOut(_ attempt: Int) {
        guard attempt == presentationAttempt, presentation != nil, !hasAppeared else { return }
        close()
    }

    private func persist() {
        guard presentation == .firstRun, let deviceId else { return }
        // Added steps follow live state, so a resumed run adds them again itself.
        progressStore.saveProgress(flow.removingSteps(automaticStepIds), deviceId: deviceId)
    }

    #if DEBUG
    /// Shows `flow` as if the user had navigated there, without persisting.
    public func installPreview(flow: PhoneSetupFlow, presentation: Presentation = .firstRun, busyStepId: String? = nil) {
        self.flow = flow
        self.presentation = presentation
        self.busyStepId = busyStepId
        isGateActive = true
    }
    #endif
}

// MARK: - Deferred presentations

extension PhoneSetupCoordinator {
    /// Queues `presenter`, unless the user answered the same question in the
    /// flow during this visit to the app.
    public func requestDeferredPresentation(_ presenter: DeferredPresenter) {
        guard !answeredPresentations.contains(presenter) else { return }
        deferredPresentations.request(presenter)
    }

    public func withdrawDeferredPresentation(_ presenter: DeferredPresenter) {
        deferredPresentations.withdraw(presenter)
    }

    /// The presenter whose turn it is, if the gate is open and the screen free.
    public func nextDeferredPresentation(screenIsFree: Bool) -> DeferredPresenter? {
        deferredPresentations.next(gateOpen: !isGateActive, screenIsFree: screenIsFree)
    }

    public func finishDeferredPresentation(_ presenter: DeferredPresenter) {
        deferredPresentations.finish(presenter)
    }

    /// Ends a turn whose presentation is no longer on `screen`.
    public func settleDeferredPresentations(on screen: DeferredPresentationScreen) {
        deferredPresentations.settle(on: screen)
    }

    public func markDeferredPresenting(_ presenter: DeferredPresenter, now: Date = Date()) {
        deferredPresentations.markPresenting(presenter, now: now)
    }

    public func deferredPresentationDidAppear(_ presenter: DeferredPresenter) {
        deferredPresentations.didAppear(presenter)
    }

    /// Gives back the turn of a sheet that never appeared; see
    /// `DeferredPresentationQueue.expireUnappeared(on:now:)`.
    public func expireUnappearedDeferredPresentation(
        on screen: DeferredPresentationScreen,
        now: Date = Date()
    )
        -> DeferredPresenter? {
        deferredPresentations.expireUnappeared(on: screen, now: now)
    }
}

// MARK: - Automatic steps

@available(iOS 17.0, *)
extension PhoneSetupCoordinator {
    /// A step's value line, which for an automatic step names the steps it is
    /// there for.
    public func value(for step: any PhoneSetupStep) -> String {
        step.value(alongside: relevantSteps(in: flow)) ?? step.copy.value
    }

    /// Operating-system state the steps read changed while setup is up, such
    /// as Background App Refresh or Low Power Mode: pages render again and the
    /// automatic steps follow.
    public func hostStateDidChange() {
        revision &+= 1
        syncAutomaticSteps()
    }

    /// The app left the foreground: a question answered in the flow may be
    /// asked outside it again on a later visit, which asks for it once more.
    public func appDidEnterBackground() {
        answeredPresentations = []
    }

    private func countSuccessDraws(from old: PhoneSetupFlow) {
        for (id, outcome) in flow.outcomes where PhoneSetupSuccessDraw.drawsIn(from: old.outcomes[id], to: outcome) {
            successDraws[id, default: 0] += 1
        }
    }

    /// Adds the automatic steps the run now calls for and drops those it no
    /// longer does, never behind the page on screen. A run opened for one
    /// source from Settings has none, and Choose lists none.
    public func syncAutomaticSteps() {
        guard presentation != nil, presentation != .settingsStep else { return }
        switch flow.screen {
        case .connected, .choose: return
        case .step, .finish: break
        }
        var updated = flow
        applyAutomaticSteps(&updated)
        guard updated != flow else { return }
        flow = updated
        persist()
    }

    /// Answers the page on screen with the step's own work, such as a decision
    /// it asks for, and records `outcome`, which the page then shows. The
    /// presentation outside the flow that the step stands in for is withdrawn
    /// and held back for the rest of this visit to the app.
    public func answerCurrentStep(outcome: PhoneSetupOutcome, _ work: @MainActor () async throws -> Void) async throws {
        guard let run = beginRun() else { return }
        do {
            try await work()
        } catch {
            if runToken == run.token {
                busyStepId = nil
                runToken = nil
            }
            throw error
        }
        guard runToken == run.token else { return }
        busyStepId = nil
        runToken = nil
        if let presenter = run.step.answeredPresentation {
            deferredPresentations.withdraw(presenter)
            answeredPresentations.insert(presenter)
        }
        if !outcome.isContributing {
            declinedStepIds.insert(run.step.id)
        }
        guard presentation != nil, flow.currentStepId == run.step.id else { return }
        flow.record(outcome, for: run.step.id)
        persist()
    }

    private var automaticStepIds: Set<String> {
        Set(steps.filter { $0.group == .automatic }.map(\.id))
    }

    /// The steps an automatic step can be there for: those the run turned on
    /// successfully, and those already on. A chosen step that ended off
    /// doesn't count.
    private func relevantSteps(in flow: PhoneSetupFlow) -> [any PhoneSetupStep] {
        steps.filter { $0.group != .automatic && ($0.isOn || flow.outcomes[$0.id]?.isContributing == true) }
    }

    private func applyAutomaticSteps(_ flow: inout PhoneSetupFlow) {
        let automatic = steps.filter { $0.group == .automatic }
        guard !automatic.isEmpty else { return }
        let relevant = relevantSteps(in: flow)
        // A step being answered stays, even while its answer changes what it depends on.
        let wanted = automatic.filter { step in
            step.id == busyStepId || (!declinedStepIds.contains(step.id) && step.isIncluded(alongside: relevant))
        }
        .map(\.id)
        flow.setAutomaticSteps(Set(wanted), automatic: automaticStepIds, order: steps.map(\.id))
    }
}
