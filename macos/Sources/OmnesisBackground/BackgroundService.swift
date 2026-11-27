// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation

/// The native helper is the only launch parent; portable admission owns every store/intent decision.
@MainActor
final class BackgroundService {
    private let application: URL
    private let observation: @MainActor (URL?) -> Void
    private var origin: DesktopBackgroundApplicationOrigin.Record?
    private var presenter: ApplicationPresenter?
    private var pendingPresenter: ApplicationPresenter?
    private var originHandoff: DesktopBackgroundOriginHandoff?
    private var originGeneration = UUID()
    private var adoptingOrigin = false
    private let preparationGate = DesktopBackgroundPreparationGate()
    private(set) var runtime: URL?
    private var profile: DesktopBackgroundManagedProfile?
    private var usage: DesktopRuntimeUsageLease?
    private var control: DesktopBackgroundControlServer?
    private var child: DesktopBackgroundDaemonProcess?
    private var retirementChild: DesktopBackgroundDaemonProcess?
    private var ready: DesktopBackgroundDaemonProcess.Ready?
    private var starting: Task<DesktopBackgroundDaemonProcess.Ready?, Never>?
    private var activation: DesktopBackgroundLaunchProtocol.Activation?
    private var nearby: DesktopNearbyGatewayBrowser?
    private var nearbyClose: DesktopNearbyGatewayBrowser.CloseHandle?
    private var daemonDrain: DesktopBackgroundDrain?
    private var retirementDrain: DesktopBackgroundDrain?
    private var shutdownRequested = false
    private var queryCapableDaemon = false
    // Retain exact physical owners throughout a blocked DNS close, even after their exit callbacks.
    private var drainingChild: DesktopBackgroundDaemonProcess?
    private var lastDaemonExit: DesktopBackgroundDaemonProcess.Exit?
    private var drainingRetirement: DesktopBackgroundDaemonProcess?
    private var retry: Task<Void, Never>?
    private var failures = 0
    private var closing = false
    private var relinquishing = false
    private var desired = false

    init(application: URL, observation: @escaping @MainActor (URL?) -> Void) {
        self.application = application
        self.observation = observation
    }

    func prepare() async throws {
        let operation = try preparationGate.begin()
        let application = application
        let prepared = try await Task.detached(priority: .utility) {
            let runtime = try DesktopRuntimeBootstrap.prepare(appBundle: application)
            return try (runtime, DesktopRuntimeUsageLease.acquire(runtime: runtime), DesktopBackgroundManagedProfile.current())
        }.value
        // A refused result owns only its local lease, which releases on this throw.
        guard !closing, preparationGate.accepts(operation) else { throw CancellationError() }
        runtime = prepared.0
        usage = prepared.1
        profile = prepared.2
        let arguments = Array(CommandLine.arguments.dropFirst())
        if !arguments.isEmpty {
            guard arguments.count == 2,
                  arguments[0] == "--origin-handoff" else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
            let claim = try DesktopBackgroundOriginHandoff.decode(arguments[1])
            guard claim.scope.dataScope == prepared.2.scope,
                  claim.epoch == prepared.0.lastPathComponent else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
            originHandoff = claim
        } else {
            let captured = try await Task.detached(priority: .utility) {
                if try DesktopBackgroundApplicationOrigin.isRetained(application) { return DesktopBackgroundApplicationOrigin.Record?.none }
                return try DesktopBackgroundApplicationOrigin.capture(application)
            }.value
            guard !closing, preparationGate.accepts(operation) else { throw CancellationError() }
            if let captured { try await attachOrigin(captured) }
        }
        guard !closing, preparationGate.accepts(operation) else { throw CancellationError() }
        control = try DesktopBackgroundControlServer(binding: prepared.2.binding, released: {
            Task { @MainActor in NSApp.terminate(nil) }
        }) { [weak self] request, peer, deadline in
            guard let self else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
            return await self.handle(request, peer: peer, deadline: deadline)
        }
        // A missing profile remains idle, allowing the GUI to perform encrypted bootstrap.
        if origin != nil, (try? prepared.2.configured()) == true {
            Task { [weak self] in _ = await self?.ensure(activation: nil, automatic: true) }
        }
    }

    private func handle(
        _ request: DesktopBackgroundLaunchProtocol.Request,
        peer: DesktopBackgroundPeerTrust.Peer,
        deadline: ContinuousClock.Instant
    ) async
        -> DesktopBackgroundLaunchProtocol.Reply {
        guard let runtime, let profile else { return .init(request: request, epoch: request.expectedEpoch, state: .ownerUnavailable) }
        let actualEpoch = runtime.lastPathComponent
        let evidence = await ownership(peer: peer, epoch: actualEpoch)
        if request.binding != profile.binding || request.expectedEpoch != actualEpoch {
            if request.action == .hello {
                return .init(
                    request: request,
                    binding: profile.binding,
                    epoch: actualEpoch,
                    state: request.binding != profile.binding ? .scopeMismatch : .epochMismatch,
                    applicationOwnership: evidence,
                    originStatus: currentOriginStatus(evidence)
                )
            }
            return .init(request: request, epoch: request.expectedEpoch, state: .ownerUnavailable)
        }
        if request.action == .verifyDaemon || request.action == .verifyRetirement {
            let retiring = request.action == .verifyRetirement
            let selected = retiring ? retirementChild : child
            let verified = request.owner.map { selected?.matchesOwner($0, retirement: retiring) == true } ?? false
            return .init(request: request, epoch: actualEpoch, state: verified ? .ownerVerified : .ownerUnavailable)
        }
        if request.action == .releaseOwner || request.action == .recoverOrigin {
            if request.action == .recoverOrigin {
                let status = currentOriginStatus(evidence)
                guard status.state != .verified, child?.running != true, starting == nil,
                      status.client?.isGone() != false else {
                    return .init(request: request, epoch: actualEpoch, state: .lifecycleBlocked)
                }
            } else if let pending = originHandoff,
                      !DesktopBackgroundOriginStatus.Client(pid: pending.clientPID, birth: pending.birth).isGone() {
                return .init(request: request, epoch: actualEpoch, state: .lifecycleBlocked)
            }
            guard retirementChild == nil, !closing || relinquishing || daemonDrain != nil else {
                return .init(request: request, epoch: actualEpoch, state: .lifecycleBlocked)
            }
            relinquishing = true
            shutdownRequested = true
            freezeStarts()
            guard await drainOwnership(until: deadline.advanced(by: .milliseconds(-100))) == .confirmed else {
                return .init(request: request, epoch: actualEpoch, state: .lifecycleBlocked)
            }
            let transfer = await transferableOrigin()
            guard ContinuousClock.now < deadline else {
                return .init(request: request, epoch: actualEpoch, state: .lifecycleBlocked)
            }
            return .init(request: request, epoch: actualEpoch, state: .ownerReleased, origin: transfer)
        }
        if closing { return .init(request: request, epoch: actualEpoch, state: .lifecycleBlocked) }
        if request.action == .adoptOrigin {
            guard !adoptingOrigin, let claim = originHandoff, let record = request.origin, let nonce = request.handoffNonce,
                  claim.matches(
                      peer: peer,
                      nonce: nonce,
                      scope: .init(
                          format: 1,
                          configDir: profile.configDir,
                          instance: profile.instance,
                          secretService: profile.secretService
                      ),
                      epoch: actualEpoch
                  ) else {
                return .init(request: request, epoch: actualEpoch, state: .ownerUnavailable)
            }
            adoptingOrigin = true
            defer { adoptingOrigin = false }
            do {
                try await attachOrigin(record)
                let attached = await ownership(peer: peer, epoch: actualEpoch, validatingAttachment: true)
                guard presenter?.isVerified == true,
                      attached.state == .verified else { throw DesktopBackgroundApplicationOrigin.Failure.changedObject }
                originHandoff = nil
                return .init(request: request, epoch: actualEpoch, state: .originAttached, applicationOwnership: attached)
            } catch { return .init(
                request: request,
                epoch: actualEpoch,
                state: .originRequired,
                applicationOwnership: evidence,
                originStatus: currentOriginStatus(evidence)
            ) }
        }
        guard originHandoff == nil, !adoptingOrigin, origin != nil, presenter?.isVerified == true, evidence.state == .verified else {
            return .init(
                request: request,
                epoch: actualEpoch,
                state: .originRequired,
                applicationOwnership: evidence,
                originStatus: currentOriginStatus(evidence)
            )
        }
        if request.action == .hello {
            return .init(
                request: request,
                binding: profile.binding,
                epoch: actualEpoch,
                state: ready != nil && child?.running == true ? .daemonOwned : .helperIdle,
                daemonPid: ready != nil && child?.running == true ? child?.pid : nil,
                applicationOwnership: evidence,
                originStatus: currentOriginStatus(evidence)
            )
        }
        if request.action == .nearbySnapshot {
            guard ContinuousClock.now < deadline else {
                return .init(request: request, epoch: actualEpoch, state: .lifecycleBlocked)
            }
            guard (try? profile.configuredJoined()) == true else {
                return .init(request: request, epoch: actualEpoch, state: .nearbySnapshot, nearby: .unavailable)
            }
            queryCapableDaemon = true
            if let closed = nearbyClose, closed.isConfirmed {
                nearby = nil
                nearbyClose = nil
            }
            guard nearbyClose == nil else {
                return .init(request: request, epoch: actualEpoch, state: .nearbySnapshot, nearby: .unavailable)
            }
            guard ContinuousClock.now < deadline else {
                return .init(request: request, epoch: actualEpoch, state: .lifecycleBlocked)
            }
            if nearby == nil {
                let provider = DesktopNearbyGatewayBrowser()
                nearby = provider
                provider.start()
            } else { nearby?.requestRetry() }
            return .init(request: request, epoch: actualEpoch, state: .nearbySnapshot, nearby: nearby?.snapshot() ?? .unavailable)
        }
        let outcome = await ensure(activation: request.activation, automatic: false)
        return .init(
            request: request,
            binding: profile.binding,
            epoch: actualEpoch,
            state: outcome == nil ? .lifecycleBlocked : .daemonOwned,
            daemonPid: outcome?.pid
        )
    }

    private func currentOriginStatus(_ evidence: DesktopBackgroundApplicationOrigin.Evidence) -> DesktopBackgroundOriginStatus {
        if originHandoff == nil, !adoptingOrigin, origin != nil, presenter?.isVerified == true,
           evidence.state == .verified { return .init(state: .verified) }
        if let pending = originHandoff { return .init(state: .pending, client: .init(pid: pending.clientPID, birth: pending.birth)) }
        return .init(state: .unavailable)
    }

    private func transferableOrigin() async -> DesktopBackgroundApplicationOrigin.Record? {
        guard let selected = origin else { return nil }
        do {
            _ = try await Task.detached { try DesktopBackgroundApplicationOrigin.resolve(selected) }.value
            return origin == selected ? selected : nil
        } catch { return nil }
    }

    private func attachOrigin(_ record: DesktopBackgroundApplicationOrigin.Record) async throws {
        let generation = originGeneration
        let application = try await Task.detached(priority: .utility) { try DesktopBackgroundApplicationOrigin.resolve(record) }.value
        guard !closing, generation == originGeneration else { throw CancellationError() }
        let candidate = ApplicationPresenter(application: application) { [weak self] attachment, eventGeneration, location in
            Task { @MainActor [weak self] in await self?.originObserved(
                attachment: attachment,
                eventGeneration: eventGeneration,
                location: location,
                record: record
            ) }
        }
        pendingPresenter?.stop()
        pendingPresenter = candidate
        var committed = false
        defer {
            if !committed { candidate.stop() }
            if pendingPresenter === candidate { pendingPresenter = nil }
        }
        // Registration happens before a coordinated re-resolution and exact object/epoch check.
        // The presenter has a private serial queue; the UI actor never synchronously waits on it.
        _ = try await Task.detached(priority: .utility) { try candidate.verify(record) }.value
        guard !closing, generation == originGeneration, pendingPresenter === candidate,
              candidate.isVerified else { throw CancellationError() }
        let previous = presenter
        invalidateNearby()
        origin = record
        presenter = candidate
        originGeneration = UUID()
        committed = true
        previous?.stop()
    }

    private func originObserved(
        attachment: UUID,
        eventGeneration: UInt64,
        location: URL?,
        record: DesktopBackgroundApplicationOrigin.Record
    ) async {
        // A rejected candidate or a queued callback from a replaced registration cannot alter its successor.
        guard let selected = presenter, selected.id == attachment else { return }
        // Deletion remains fail-closed for this attachment. Superseded moves/changes cannot stop a newer location.
        guard location == nil || selected.isCurrent(event: eventGeneration) else { return }
        invalidateNearby()
        originGeneration = UUID()
        let event = originGeneration
        guard let location else {
            origin = nil
            observation(nil)
            return
        }
        let matches = await (try? Task.detached {
            let resolved = try selected.verify(record)
            return try resolved.path == (DesktopCanonicalPath.resolve(location.path))
        }.value) == true
        guard presenter === selected, originGeneration == event, selected.isCurrent(event: eventGeneration) else { return }
        guard matches, selected.isVerified else {
            if await shutdown(until: ContinuousClock.now.advanced(by: .seconds(80))) == .confirmed {
                NSApp.terminate(nil)
            }
            return
        }
        observation(location)
    }

    private func ownership(
        peer: DesktopBackgroundPeerTrust.Peer,
        epoch: String,
        validatingAttachment: Bool = false
    ) async
        -> DesktopBackgroundApplicationOrigin.Evidence {
        let committed = originHandoff == nil && !adoptingOrigin
        let selected = presenter?.isVerified == true && (committed || validatingAttachment) ? origin : nil
        let generation = originGeneration
        let awaiting = originHandoff != nil || origin == nil
        let application = peer.kind == .observer ? peer.executable.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent() : nil
        let evidence = try? await Task.detached(priority: .utility) {
            try DesktopBackgroundApplicationOrigin.evidence(
                record: selected,
                codeEpoch: epoch,
                presentationApplication: application,
                awaitingHandoff: awaiting
            )
        }.value
        guard generation == originGeneration, let evidence else {
            return .init(state: .unavailable, codeEpoch: epoch, originEpoch: nil, presentation: .unknown, installation: .unknown)
        }
        return evidence
    }

    private func ensure(
        activation requested: DesktopBackgroundLaunchProtocol.Activation?,
        automatic: Bool
    ) async
        -> DesktopBackgroundDaemonProcess.Ready? {
        guard !closing, originHandoff == nil, !adoptingOrigin, let selected = presenter, let record = origin, selected.isVerified,
              let profile, let runtime else { return nil }
        let generation = originGeneration
        do {
            _ = try await Task.detached(priority: .utility) { try selected.verify(record) }.value
            guard !closing, generation == originGeneration, presenter === selected, selected.isVerified else { return nil }
            try profile.validateIdentity()
            guard try profile.configured() else { return nil }
        } catch { return nil }
        if let starting { return activation == requested ? await starting.value : nil }
        if let ready, child?.running == true { return requested == nil || activation == requested ? ready : nil }
        if !automatic { failures = 0 }
        desired = requested == nil
        activation = requested
        let encoded: String
        do { encoded = try DesktopBackgroundDaemonAuthority.descriptor(
            profile: profile,
            epoch: runtime.lastPathComponent,
            activation: requested
        ) } catch { return nil }
        let task = Task { [weak self] in await self?.launch(runtime: runtime, descriptor: encoded) }
        starting = task
        let result = await task.value
        starting = nil
        return result
    }

    private func launch(runtime: URL, descriptor: String) async -> DesktopBackgroundDaemonProcess.Ready? {
        let process: DesktopBackgroundDaemonProcess
        do { process = try .launch(runtime: runtime, descriptor: descriptor) }
        catch { scheduleRetry()
            return nil
        }
        child = process
        // Remember query capability even if its install record disappears during later cleanup.
        if (try? profile?.configuredJoined()) != false { queryCapableDaemon = true }
        lastDaemonExit = nil
        let identity = ObjectIdentifier(process)
        process.onExit = { [weak self] exit in
            Task { @MainActor [weak self] in self?.exited(identity, exit: exit) }
        }
        do {
            let acknowledged = try await process.ready()
            guard !closing, child === process, process.running, !Task.isCancelled else { throw CancellationError() }
            ready = acknowledged
            return acknowledged
        } catch {
            let result = await process.stopAndJoin()
            if child === process { lastDaemonExit = result
                child = nil
                ready = nil
            }
            if result.clean { desired = false }
            else { scheduleRetry() }
            return nil
        }
    }

    private func exited(_ identity: ObjectIdentifier, exit: DesktopBackgroundDaemonProcess.Exit) {
        guard let child, ObjectIdentifier(child) == identity else { return }
        lastDaemonExit = exit
        self.child = nil
        ready = nil
        if exit.clean { desired = false }
        else if starting == nil { scheduleRetry() }
    }

    private func scheduleRetry() {
        guard !closing, desired, retry == nil, failures < 5 else { return }
        let delay = min(30, 1 << failures)
        failures += 1
        retry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, !closing else { return }
            retry = nil
            _ = await ensure(activation: nil, automatic: true)
        }
    }

    /// Refuse new launch requests before portable retirement starts draining its own runtime.
    func freezeStarts() {
        closing = true
        invalidateNearby()
        preparationGate.close()
        retry?.cancel()
        retry = nil
    }

    func registerRetirement(_ child: DesktopBackgroundDaemonProcess?) {
        retirementChild = child
    }

    private func invalidateNearby() {
        if nearbyClose == nil { nearbyClose = nearby?.beginClose() }
    }

    var retirementGeneration: UUID {
        originGeneration
    }

    func canLaunchRetirement(generation: UUID) -> Bool {
        !shutdownRequested && generation == originGeneration && retirementChild == nil
    }

    /// Trash preparation can close the daemon, but an explicit shutdown wins any later launch.
    func prepareRetirement(until deadline: ContinuousClock.Instant) async -> DesktopBackgroundDrain.Result {
        let generation = originGeneration
        freezeStarts()
        guard canLaunchRetirement(generation: generation) else { return .blocked }
        guard await drainOwnership(until: deadline) == .confirmed else { return .blocked }
        guard canLaunchRetirement(generation: generation), ContinuousClock.now < deadline else { return .blocked }
        return .confirmed
    }

    private func beginDaemonDrain() -> DesktopBackgroundDrain {
        if let daemonDrain { return daemonDrain }
        starting?.cancel()
        let pending = starting
        drainingChild = child
        let requiresClean = queryCapableDaemon || (try? profile?.configuredJoined()) != false
        let drain = DesktopBackgroundDrain { [self] in
            // A startup task owns its launch-failure join; do not signal that same child twice.
            if let pending { _ = await pending.value }
            if let current = child { drainingChild = current }
            let outcome = await Self.join(drainingChild)
            // Joined parents own query subprocesses. Forced/nonzero root exit cannot certify
            // that cohort, even though Process has physically joined the parent itself.
            return !requiresClean || (outcome?.clean ?? lastDaemonExit?.clean ?? true)
        }
        daemonDrain = drain
        return drain
    }

    private static func join(_ process: DesktopBackgroundDaemonProcess?) async -> DesktopBackgroundDaemonProcess.Exit? {
        guard let process else { return nil }
        return await process.stopAndJoin()
    }

    private func drainOwnership(until deadline: ContinuousClock.Instant) async -> DesktopBackgroundDrain.Result {
        freezeStarts()
        let drain = beginDaemonDrain()
        async let daemon = drain.join(until: deadline)
        async let dns = joinNearby(until: deadline)
        async let retirement = joinRetirement(until: deadline)
        let outcomes = await (daemon, dns, retirement)
        guard outcomes.0 == .confirmed, outcomes.1 == .confirmed, outcomes.2 == .confirmed,
              ContinuousClock.now < deadline else { return .blocked }
        return .confirmed
    }

    private func joinRetirement(until deadline: ContinuousClock.Instant) async -> DesktopBackgroundDrain.Result {
        guard shutdownRequested else { return retirementChild == nil ? .confirmed : .blocked }
        if retirementDrain == nil, let process = retirementChild {
            drainingRetirement = process
            retirementDrain = DesktopBackgroundDrain { _ = await process.stopAndJoin()
                return true
            }
        }
        guard let retirementDrain else { return .confirmed }
        return await retirementDrain.join(until: deadline)
    }

    private func joinNearby(until deadline: ContinuousClock.Instant) async -> DesktopBackgroundDrain.Result {
        guard let nearbyClose else { return .confirmed }
        return await nearbyClose.join(until: deadline) == .confirmed ? .confirmed : .blocked
    }

    func shutdown(until deadline: ContinuousClock.Instant) async -> DesktopBackgroundDrain.Result {
        shutdownRequested = true
        guard await drainOwnership(until: deadline) == .confirmed else { return .blocked }
        child = nil
        ready = nil
        starting = nil
        control?.stop()
        control = nil
        retirementChild = nil
        drainingChild = nil
        drainingRetirement = nil
        presenter?.stop()
        presenter = nil
        pendingPresenter?.stop()
        pendingPresenter = nil
        origin = nil
        originGeneration = UUID()
        nearby = nil
        nearbyClose = nil
        // Release CODE only after both daemon ownership and native callbacks physically joined.
        usage = nil
        return .confirmed
    }
}
