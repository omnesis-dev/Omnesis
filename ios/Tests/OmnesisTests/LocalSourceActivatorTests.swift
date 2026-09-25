// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Scripts the app operations an activation uses and records their order.
@MainActor
private final class ScriptedActivation {
    var gatewayReady = true
    var pairing: String? = "pairing-1"
    var connected = true
    var enabled: Set<String> = []
    var inspection: MobileSourceActivationOutcome = .ready
    var commitError: Error?
    var resumeResults: [LocalSourceResumeResult] = [.accepted]
    var registerFailure: String?
    var authorization: MobileSourceAuthorization = .granted(.full)
    /// Runs on each wait between retries.
    var onSleep: (() -> Void)?
    private(set) var calls: [String] = []
    private(set) var sleeps: [Duration] = []
    var holdsAuthorization = false
    var holdsAfterActivation = false
    var holdsRegister = false
    private var heldAuthorization: CheckedContinuation<Void, Never>?
    private var heldAfterActivation: [CheckedContinuation<Void, Never>] = []
    private var heldRegister: CheckedContinuation<Void, Never>?

    func releaseAuthorization() {
        heldAuthorization?.resume()
        heldAuthorization = nil
    }

    func releaseAfterActivation() {
        let held = heldAfterActivation
        heldAfterActivation = []
        for continuation in held {
            continuation.resume()
        }
    }

    func releaseRegister() {
        heldRegister?.resume()
        heldRegister = nil
    }

    func recordSleep(_ duration: Duration) {
        sleeps.append(duration)
        onSleep?()
    }

    /// Waits until `call` has happened, for at most a few seconds.
    func waitFor(_ call: String) async -> Bool {
        await eventually { self.calls.contains(call) }
    }

    var environment: LocalSourceActivationEnvironment {
        LocalSourceActivationEnvironment(
            isGatewayReady: { self.gatewayReady },
            pairingKey: { self.pairing },
            isConnected: { self.connected },
            isLocallyEnabled: { self.enabled.contains($0) },
            inspect: { _, _, _ in
                self.calls.append("inspect")
                return self.inspection
            },
            commit: { _, _, _ in
                self.calls.append("commit")
                if let error = self.commitError { throw error }
            },
            resume: { _ in
                self.calls.append("resume")
                return self.nextResume()
            },
            retryResume: { _ in
                self.calls.append("retry")
                return self.nextResume()
            },
            register: { _ in
                self.calls.append("register")
                if self.holdsRegister {
                    await withCheckedContinuation { self.heldRegister = $0 }
                }
                return self.registerFailure
            },
            startContributing: { _ in self.calls.append("sync") },
            completionEnded: { self.calls.append("ended:\($0)") },
            sleep: { duration in await self.recordSleep(duration) }
        )
    }

    func steps(for sourceId: String) -> MobileSourceActivationSteps {
        MobileSourceActivationSteps(
            authorize: {
                self.calls.append("authorize")
                if self.holdsAuthorization {
                    await withCheckedContinuation { self.heldAuthorization = $0 }
                }
                return self.authorization
            },
            activate: {
                self.calls.append("activate")
                self.enabled.insert(sourceId)
            },
            afterActivation: {
                self.calls.append("after-activation")
                if self.holdsAfterActivation {
                    await withCheckedContinuation { self.heldAfterActivation.append($0) }
                }
            }
        )
    }

    private func nextResume() -> LocalSourceResumeResult {
        resumeResults.count > 1 ? resumeResults.removeFirst() : resumeResults.first ?? .accepted
    }
}

/// Holds a value a task produces, for a test that must not wait on the task.
@MainActor
private final class Outcome<Value> {
    var value: Value?
}

@MainActor
final class LocalSourceActivatorTests: XCTestCase {
    private let photos = PhotosSetupStep.sourceId

    private func makeActivator(_ script: ScriptedActivation, defaults: DictionaryDefaults = DictionaryDefaults())
        -> LocalSourceActivator {
        let activator = LocalSourceActivator(defaults: defaults)
        activator.install(script.environment)
        return activator
    }

    private func activate(_ activator: LocalSourceActivator, _ script: ScriptedActivation) async -> MobileSourceEnableResult {
        await activator.activate(
            photos,
            mode: .partitioned,
            copy: PhotosSetupStep.copy,
            choice: nil,
            steps: script.steps(for: photos)
        )
    }

    func testTheSourceIsOnOnceSwitchedOnWhileASlowCollectorRebuildContinues() async {
        let script = ScriptedActivation()
        script.authorization = .granted(.limited)
        script.holdsAfterActivation = true
        let activator = makeActivator(script)

        let outcome = Outcome<MobileSourceEnableResult>()
        let running = Task { outcome.value = await self.activate(activator, script) }
        let returned = await eventually { outcome.value != nil }
        if !returned {
            XCTFail("turning the source on waited for the collector rebuild")
            script.releaseAfterActivation()
        }
        await running.value

        XCTAssertEqual(outcome.value, .enabled(.limited), "on as soon as the commit and local switch land")
        XCTAssertEqual(Array(script.calls.prefix(4)), ["inspect", "authorize", "commit", "activate"])
        XCTAssertFalse(script.calls.contains("register"))
        XCTAssertEqual(activator.pendingRegistrations, [photos], "unregistered until the gateway accepts it")

        let rebuilding = await script.waitFor("after-activation")
        XCTAssertTrue(rebuilding)
        script.releaseAfterActivation()
        await activator.waitForBackgroundWork()

        XCTAssertEqual(script.calls.suffix(4), ["after-activation", "resume", "register", "sync"])
        XCTAssertTrue(activator.pendingRegistrations.isEmpty)
        XCTAssertNil(activator.issues[photos])
    }

    func testLiveStatusSaysGettingReadyThenWaitingForTheGateway() async {
        let script = ScriptedActivation()
        script.holdsAfterActivation = true
        script.holdsRegister = true
        let activator = makeActivator(script)

        _ = await activate(activator, script)
        XCTAssertEqual(activator.preparing, [photos], "the collector is being rebuilt")
        XCTAssertEqual(activator.pendingRegistrations, [photos])

        let rebuilding = await script.waitFor("after-activation")
        XCTAssertTrue(rebuilding)
        script.releaseAfterActivation()
        let registering = await script.waitFor("register")
        XCTAssertTrue(registering)
        XCTAssertTrue(activator.preparing.isEmpty, "the rebuild is done")
        XCTAssertEqual(activator.pendingRegistrations, [photos], "registration is still pending")

        script.releaseRegister()
        await activator.waitForBackgroundWork()
        XCTAssertTrue(activator.pendingRegistrations.isEmpty)
        XCTAssertTrue(activator.preparing.isEmpty)
    }

    func testTurningOffWhileTheSourceIsStillBeingTurnedOnHostsNothing() async {
        let script = ScriptedActivation()
        script.holdsAfterActivation = true
        let activator = makeActivator(script)
        _ = await activate(activator, script)
        let rebuilding = await script.waitFor("after-activation")
        XCTAssertTrue(rebuilding)

        activator.abandon(photos)
        let callsAtTurnOff = script.calls
        script.releaseAfterActivation()
        await activator.waitForBackgroundWork()
        _ = await eventually(timeout: .milliseconds(200)) { false }

        XCTAssertEqual(script.calls, callsAtTurnOff, "no resume, registration or sync after turning off")
        XCTAssertTrue(activator.pendingRegistrations.isEmpty)
        XCTAssertTrue(activator.preparing.isEmpty)
    }

    func testASourceSwitchedOffDuringItsBackgroundWorkIsNotHosted() async {
        let script = ScriptedActivation()
        script.holdsAfterActivation = true
        let activator = makeActivator(script)
        _ = await activate(activator, script)
        let rebuilding = await script.waitFor("after-activation")
        XCTAssertTrue(rebuilding)

        script.enabled.remove(photos)
        script.releaseAfterActivation()
        await activator.waitForBackgroundWork()

        XCTAssertFalse(script.calls.contains("resume"))
        XCTAssertFalse(script.calls.contains("register"))
        XCTAssertFalse(script.calls.contains("sync"))
        XCTAssertEqual(script.calls.last, "ended:\(photos)")
        XCTAssertTrue(activator.pendingRegistrations.isEmpty)
    }

    func testTurningOnAgainAfterTurningOffMidwaySucceeds() async {
        let script = ScriptedActivation()
        script.holdsAfterActivation = true
        let activator = makeActivator(script)
        _ = await activate(activator, script)
        let rebuilding = await script.waitFor("after-activation")
        XCTAssertTrue(rebuilding)
        activator.abandon(photos)
        script.enabled.remove(photos)
        script.holdsAfterActivation = false
        script.releaseAfterActivation()

        let again = await activate(activator, script)
        await activator.waitForBackgroundWork()

        XCTAssertEqual(again, .enabled(.full))
        XCTAssertEqual(script.calls.filter { $0 == "register" }.count, 1)
        XCTAssertNil(activator.issues[photos])
    }

    func testTurningOnAgainWhileTheFirstStillFinishesReplacesItsWork() async {
        let script = ScriptedActivation()
        script.holdsAfterActivation = true
        let activator = makeActivator(script)
        _ = await activate(activator, script)
        let rebuilding = await script.waitFor("after-activation")
        XCTAssertTrue(rebuilding)

        script.holdsAfterActivation = false
        let again = await activate(activator, script)
        script.releaseAfterActivation()
        await activator.waitForBackgroundWork()
        _ = await eventually(timeout: .milliseconds(200)) { false }

        XCTAssertEqual(again, .enabled(.full), "not refused as already activating")
        XCTAssertEqual(script.calls.filter { $0 == "register" }.count, 1, "the replaced work registers nothing")
    }

    func testWithoutTheGatewayClientNothingIsAskedOfIOS() async {
        let script = ScriptedActivation()
        script.gatewayReady = false
        let activator = makeActivator(script)

        let result = await activate(activator, script)

        XCTAssertEqual(result, .failed(message: LocalSourceActivator.notConnectedMessage))
        XCTAssertTrue(script.calls.isEmpty)
        XCTAssertEqual(activator.issues[photos], LocalSourceActivator.notConnectedMessage)
    }

    func testRefusedAccessChangesNothingOnTheGatewayAndRecordsTheIssue() async {
        let script = ScriptedActivation()
        script.authorization = .notAllowed
        let activator = makeActivator(script)

        let result = await activate(activator, script)

        XCTAssertEqual(result, .notAllowed)
        XCTAssertEqual(script.calls, ["inspect", "authorize"])
        XCTAssertEqual(activator.issues[photos], PhotosSetupStep.copy.outcomeBody(.notAllowed))

        script.authorization = .granted(.full)
        _ = await activate(activator, script)
        await activator.waitForBackgroundWork()
        XCTAssertNil(activator.issues[photos], "a later success clears the issue")
    }

    func testAnActivationCancelledBeforeItFinishesRecordsNoIssue() async {
        let script = ScriptedActivation()
        script.authorization = .notAllowed
        script.holdsAuthorization = true
        let activator = makeActivator(script)

        let running = Task { await self.activate(activator, script) }
        let asking = await script.waitFor("authorize")
        XCTAssertTrue(asking)
        running.cancel()
        script.releaseAuthorization()
        _ = await running.value

        XCTAssertTrue(activator.issues.isEmpty)
        XCTAssertTrue(activator.inFlight.isEmpty)
    }

    func testAGatewayRefusalStopsBeforeTheSourceIsSwitchedOn() async {
        let script = ScriptedActivation()
        script.commitError = MobileSourceActivationError.hostChanged
        let activator = makeActivator(script)

        let result = await activate(activator, script)

        XCTAssertEqual(result, .failed(message: MobileSourceActivationError.hostChanged.errorDescription))
        XCTAssertEqual(script.calls, ["inspect", "authorize", "commit"])
    }

    func testHostingDecisionsReturnBeforeAnyPrompt() async {
        let script = ScriptedActivation()
        let activator = makeActivator(script)

        script.inspection = .choiceRequired(.exclusive)
        let choice = await activate(activator, script)
        script.inspection = .keptOther
        let kept = await activate(activator, script)
        script.inspection = .incompatible(current: .replicated, desired: .partitioned)
        let incompatible = await activate(activator, script)

        XCTAssertEqual(choice, .choiceRequired(.exclusive))
        XCTAssertEqual(kept, .keptOther)
        XCTAssertEqual(
            incompatible,
            .failed(message: MobileSourceActivationError.incompatibleMode(.replicated, .partitioned).errorDescription)
        )
        XCTAssertEqual(script.calls, ["inspect", "inspect", "inspect"])
        XCTAssertNotNil(activator.issues[photos], "an incompatible mode is an issue")
    }

    func testARefusedResumeLeavesTheGatewaysReasonAndTellsTheApp() async {
        let script = ScriptedActivation()
        script.resumeResults = [.refused(message: "Another device already syncs that source.")]
        let activator = makeActivator(script)

        _ = await activate(activator, script)
        await activator.waitForBackgroundWork()

        XCTAssertEqual(activator.issues[photos], "Another device already syncs that source.")
        XCTAssertFalse(script.calls.contains("register"))
        XCTAssertEqual(script.calls.last, "ended:\(photos)")
        XCTAssertTrue(activator.pendingRegistrations.isEmpty)
    }

    func testADeferredResumeThatSettlesInTimeRegisters() async {
        let script = ScriptedActivation()
        script.resumeResults = [.deferred, .deferred, .accepted]
        let activator = makeActivator(script)

        let result = await activate(activator, script)
        await activator.waitForBackgroundWork()

        XCTAssertEqual(result, .enabled(.full))
        XCTAssertEqual(script.calls.suffix(5), ["resume", "retry", "retry", "register", "sync"])
        XCTAssertEqual(script.sleeps, [.seconds(1), .seconds(2)], "retries back off")
        XCTAssertTrue(activator.pendingRegistrations.isEmpty)
    }

    func testAnUnconfirmedSourceStaysOnAndRegistersWhenAPassSettlesIt() async {
        let script = ScriptedActivation()
        script.resumeResults = [.deferred]
        let defaults = DictionaryDefaults()
        let activator = makeActivator(script, defaults: defaults)

        let result = await activate(activator, script)
        await activator.waitForBackgroundWork()

        XCTAssertEqual(result, .enabled(.full))
        XCTAssertNil(activator.issues[photos])
        XCTAssertEqual(script.sleeps, [.seconds(1), .seconds(2), .seconds(4), .seconds(8)])
        XCTAssertFalse(script.calls.contains("register"), "registration waits for the gateway")
        XCTAssertEqual(LocalSourceActivator(defaults: defaults).pendingRegistrations, [photos], "remembered across launches")

        await activator.settlePendingRegistrations(stillPending: [photos], refused: [])
        XCTAssertFalse(script.calls.contains("register"), "still pending: nothing to register yet")

        await activator.settlePendingRegistrations(stillPending: [], refused: [])
        XCTAssertEqual(script.calls.suffix(2), ["register", "sync"])
        XCTAssertTrue(activator.pendingRegistrations.isEmpty)
    }

    func testRetriesWaitWhileThereIsNoConnection() async {
        let script = ScriptedActivation()
        script.resumeResults = [.deferred]
        script.connected = false
        let activator = makeActivator(script)

        _ = await activate(activator, script)
        await activator.waitForBackgroundWork()

        XCTAssertFalse(script.calls.contains("retry"))
        XCTAssertEqual(activator.pendingRegistrations, [photos])
    }

    func testAPairingChangeDuringTheWaitEndsItWithoutAnIssue() async {
        let script = ScriptedActivation()
        script.resumeResults = [.deferred]
        script.onSleep = { script.pairing = "pairing-2" }
        let activator = makeActivator(script)

        _ = await activate(activator, script)
        await activator.waitForBackgroundWork()

        XCTAssertFalse(script.calls.contains("retry"))
        XCTAssertFalse(script.calls.contains("register"))
        XCTAssertTrue(activator.issues.isEmpty)
    }

    func testAResetWhileAnActivationRunsWritesNoIssue() async {
        let script = ScriptedActivation()
        script.authorization = .notAllowed
        script.holdsAuthorization = true
        let activator = makeActivator(script)

        let running = Task { await self.activate(activator, script) }
        let asking = await script.waitFor("authorize")
        XCTAssertTrue(asking)
        activator.reset()
        script.releaseAuthorization()
        _ = await running.value

        XCTAssertTrue(activator.issues.isEmpty)
    }

    func testAPendingRegistrationIsDroppedWhenRefusedOrTurnedOff() async {
        let script = ScriptedActivation()
        script.resumeResults = [.deferred]
        let activator = makeActivator(script)
        activator.confirmationBackoff = []
        _ = await activate(activator, script)
        await activator.waitForBackgroundWork()

        script.enabled.remove(photos)
        await activator.settlePendingRegistrations(stillPending: [], refused: [])

        XCTAssertFalse(script.calls.contains("register"))
        XCTAssertTrue(activator.pendingRegistrations.isEmpty)
    }

    func testOverlappingSettlesRegisterASourceOnce() async {
        let script = ScriptedActivation()
        script.enabled = [photos]
        script.holdsRegister = true
        let defaults = DictionaryDefaults(values: [LocalSourceActivator.pendingRegistrationsKey: [photos]])
        let activator = makeActivator(script, defaults: defaults)

        let first = Task { await activator.settlePendingRegistrations(stillPending: [], refused: []) }
        let registering = await script.waitFor("register")
        XCTAssertTrue(registering)
        await activator.settlePendingRegistrations(stillPending: [], refused: [])
        script.releaseRegister()
        await first.value

        XCTAssertEqual(script.calls.filter { $0 == "register" }.count, 1)
    }

    func testASettleLeavesASourceStillBeingTurnedOnToItsOwnWork() async {
        let script = ScriptedActivation()
        script.holdsAfterActivation = true
        let activator = makeActivator(script)
        _ = await activate(activator, script)
        let rebuilding = await script.waitFor("after-activation")
        XCTAssertTrue(rebuilding)

        await activator.settlePendingRegistrations(stillPending: [], refused: [])
        XCTAssertFalse(script.calls.contains("register"))

        script.releaseAfterActivation()
        await activator.waitForBackgroundWork()
        XCTAssertEqual(script.calls.filter { $0 == "register" }.count, 1)
    }

    func testARejectedRegistrationLeavesAnIssue() async {
        let script = ScriptedActivation()
        script.registerFailure = "This source is still being removed. Wait for gateway cleanup to finish, then enable it again."
        let activator = makeActivator(script)

        _ = await activate(activator, script)
        await activator.waitForBackgroundWork()

        XCTAssertEqual(activator.issues[photos], script.registerFailure)
        XCTAssertFalse(script.calls.contains("sync"))
        XCTAssertEqual(script.calls.last, "ended:\(photos)")
    }

    func testASecondActivationWhileOneRunsReturnsAtOnce() async {
        let script = ScriptedActivation()
        script.holdsAuthorization = true
        let activator = makeActivator(script)

        let first = Task { await self.activate(activator, script) }
        let asking = await script.waitFor("authorize")
        XCTAssertTrue(asking)
        XCTAssertEqual(activator.inFlight, [photos])
        let second = await activate(activator, script)
        script.releaseAuthorization()
        let firstResult = await first.value
        await activator.waitForBackgroundWork()

        XCTAssertEqual(second, .failed(message: LocalSourceActivator.alreadyActivatingMessage))
        XCTAssertEqual(firstResult, .enabled(.full))
        XCTAssertEqual(script.calls.filter { $0 == "authorize" }.count, 1)
        XCTAssertTrue(activator.inFlight.isEmpty)
        XCTAssertNil(activator.issues[photos], "the refused duplicate records no issue")
    }

    func testIssuesClearForSourcesThatAreOnAndOnReset() async {
        let script = ScriptedActivation()
        script.authorization = .notAllowed
        let activator = makeActivator(script)
        _ = await activate(activator, script)

        activator.clearIssues(forEnabled: [])
        XCTAssertNotNil(activator.issues[photos])
        activator.clearIssues(forEnabled: [photos])
        XCTAssertNil(activator.issues[photos])

        _ = await activate(activator, script)
        activator.reset()
        XCTAssertTrue(activator.issues.isEmpty)
    }
}
