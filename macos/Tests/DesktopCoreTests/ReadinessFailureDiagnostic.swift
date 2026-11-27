// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import DesktopCore
import Foundation

/// One post-failure observation per test process; it never grants extra readiness time.
enum DesktopReadinessFailureDiagnostic {
    struct Target: Sendable {
        let identity: DesktopBackgroundProcessIdentity
        let node: String

        /// The caller must have adopted this exact child from live kernel parent/UID/image/birth evidence.
        init(identity: DesktopBackgroundProcessIdentity, node: URL) {
            self.identity = identity
            self.node = node.path
        }

        init?(process: Process, runtime: URL) {
            guard let identity = try? DesktopBackgroundProcessIdentity.read(process.processIdentifier) else { return nil }
            self.identity = identity
            node = runtime.appendingPathComponent("node").path
        }
    }

    private struct Snapshot {
        var identityMatches = false
        var nodeImage = false
        var taskRead = false
        var userTime: UInt64 = 0
        var systemTime: UInt64 = 0
        var taskThreads: Int32 = 0
        var listRead = false
        var listed = 0
        var running = 0
        var stopped = 0
        var waiting = 0
        var uninterruptible = 0
        var halted = 0
        var readFailures = 0
        var unknownStates = 0

        var summary: String {
            "identity=\(identityMatches),node=\(nodeImage),taskRead=\(taskRead),taskThreads=\(taskThreads),listRead=\(listRead),listed=\(listed),running=\(running),stopped=\(stopped),waiting=\(waiting),uninterruptible=\(uninterruptible),halted=\(halted),readFailures=\(readFailures),unknownStates=\(unknownStates)"
        }
    }

    struct LiveObservationBudget {
        private(set) var spent = false
        mutating func claim(eligible: Bool) -> Bool {
            guard eligible, !spent else { return false }
            spent = true
            return true
        }
    }

    @MainActor private static var budget = LiveObservationBudget()

    @MainActor
    static func collect(target: Target?, captureReady: @Sendable () -> Bool) async -> String {
        guard !budget.spent else { return "postFailureSample=false" }
        guard let target else { return "postFailureSample=false,targetEligible=false" }
        let before = snapshot(target)
        guard budget.claim(eligible: before.identityMatches && before.nodeImage) else {
            return "postFailureSample=false,targetEligible=false,identityMatches=\(before.identityMatches),nodeImage=\(before.nodeImage)"
        }
        let readyBefore = captureReady()
        do { try await Task.sleep(for: .milliseconds(250)) }
        catch { return "postFailureSample=true,interrupted=true; before[\(before.summary)]" }
        let after = snapshot(target)
        let readyAfter = captureReady()
        let comparable = before.identityMatches && after.identityMatches && before.nodeImage && after.nodeImage &&
            before.taskRead && after.taskRead
        let stack = await sample(target)
        return "postFailureSample=true,targetCaptured=true,interrupted=false; stack[\(stack)]; before[\(before.summary)]; after[\(after.summary)]; cpuComparable=\(comparable),userAdvanced=\(comparable && after.userTime > before.userTime),systemAdvanced=\(comparable && after.systemTime > before.systemTime),captureReadyBefore=\(readyBefore),captureReadyAfter=\(readyAfter)"
    }

    static func nativeRefusalCode(_ text: String) -> String {
        let prefix = "The managed runtime lease could not be established: "
        let allowed: Set = [
            "inUse",
            "blocked",
            "missingAuthority",
            "unsafeRecord",
            "invalidScope",
            "legacyUnverified",
            "invalidPayload",
            "unsafeLock",
            "unsupportedInvocation",
            "cannotExecute",
            "nativeFailure",
            "invalidRequest",
        ]
        for line in text.suffix(8192).split(separator: "\n") where line.hasPrefix(prefix) {
            let value = String(line.dropFirst(prefix.count))
            return allowed.contains(value) ? value : "unknown"
        }
        return "none"
    }

    static let maximumStackBytes = 2 * 1024 * 1024

    /// Finite mentions only, never raw stack symbols, paths, process headers or tool messages.
    static func stackFacts(_ bytes: Data) -> String {
        guard bytes.count <= maximumStackBytes else { return "bounded=false" }
        let text = String(decoding: bytes, as: UTF8.self)
        return "bounded=true,dyldMention=\(text.contains("dyld")),nodeMention=\(text.contains("node::")),tlsMention=\(text.contains("SSL_")),securityMention=\(text.contains("SecTrust")),kernelMention=\(text.contains("mach_msg"))"
    }

    static func verifies(_ target: Target, identity: DesktopBackgroundProcessIdentity?, image: String?) -> Bool {
        identity == target.identity && image == target.node
    }

    static func refusal(bytes: Int64, elapsed: Duration, ownedFile: Bool) -> String? {
        if !ownedFile || bytes < 0 { return "file-refused" }
        if bytes > maximumStackBytes { return "oversize" }
        if elapsed >= .seconds(5) { return "deadline" }
        return nil
    }

    /// Fixed scalar observations only. These facts never grant signal or publication authority.
    struct SamplerReceipt {
        enum SignalOutcome: String { case sent, missing, denied, other }
        private(set) var spawnMs = -1, metadataMs = -1, ownerWriteMs = -1, ownerSyncMs = -1
        private(set) var firstWaitMs = -1, firstBindingMs = -1, firstRefusalMs = -1, firstNonzeroMs = -1
        private(set) var running = 0, joined = 0, interrupted = 0, lost = 0
        private(set) var maxGapMs = 0, maxIterationMs = 0, lastBytes = -1, maxBytes = 0
        private(set) var fileRefused = false
        private(set) var refusal = "none", exit = "unobserved"
        private(set) var termMs = -1, killMs = -1, joinMs = -1
        private(set) var termOutcome = "unobserved", killOutcome = "unobserved"
        private var lastWaitMs: Int?

        static func milliseconds(_ duration: Duration) -> Int {
            guard duration > .zero else { return 0 }
            guard duration < .seconds(60) else { return 60000 }
            let components = duration.components
            return Int(components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000)
        }

        mutating func preloop(spawn: Duration? = nil, metadata: Duration? = nil, write: Duration? = nil, sync: Duration? = nil) {
            if let spawn { spawnMs = Self.milliseconds(spawn) }
            if let metadata { metadataMs = Self.milliseconds(metadata) }
            if let write { ownerWriteMs = Self.milliseconds(write) }
            if let sync { ownerSyncMs = Self.milliseconds(sync) }
        }

        mutating func observe(_ observation: SamplerLifecycle.Observation, elapsed: Duration) {
            let now = Self.milliseconds(elapsed)
            if firstWaitMs < 0 { firstWaitMs = now }
            if let lastWaitMs { maxGapMs = max(maxGapMs, max(0, now - lastWaitMs)) }
            lastWaitMs = now
            switch observation {
            case .running: running = min(1024, running + 1)
            case .joined: joined = min(1024, joined + 1)
            case .interrupted: interrupted = min(1024, interrupted + 1)
            case .ownershipLost: lost = min(1024, lost + 1)
            }
        }

        mutating func iteration(_ duration: Duration, bound: Bool, elapsed: Duration, reason: String?) {
            maxIterationMs = max(maxIterationMs, Self.milliseconds(duration))
            if bound, firstBindingMs < 0 { firstBindingMs = Self.milliseconds(elapsed) }
            if let reason, firstRefusalMs < 0 {
                firstRefusalMs = Self.milliseconds(elapsed)
                let allowed = [
                    "file-refused",
                    "oversize",
                    "deadline",
                    "cancelled",
                    "identity-changed",
                    "owner-refused",
                    "sampler-unverified",
                    "sampler-identity-refused",
                    "sampler-parent-refused",
                    "sampler-identity-reappeared",
                ]
                refusal = allowed.contains(reason) ? reason : "other"
            }
        }

        mutating func file(bytes: Int64?, elapsed: Duration) {
            guard let bytes, bytes >= 0 else { fileRefused = true
                lastBytes = -1
                return
            }
            lastBytes = Int(min(bytes, Int64(maximumStackBytes + 1)))
            maxBytes = max(maxBytes, lastBytes)
            if bytes > 0, firstNonzeroMs < 0 { firstNonzeroMs = Self.milliseconds(elapsed) }
        }

        mutating func signal(kill: Bool, elapsed: Duration, result: Int32, error: Int32) {
            let outcome: SignalOutcome = result == 0 ? .sent : error == ESRCH ? .missing : error == EPERM ? .denied : .other
            if kill { killMs = Self.milliseconds(elapsed)
                killOutcome = outcome.rawValue
            } else { termMs = Self.milliseconds(elapsed)
                termOutcome = outcome.rawValue
            }
        }

        mutating func didJoin(status: Int32, elapsed: Duration) {
            joinMs = Self.milliseconds(elapsed)
            let signal = status & 0x7F
            if signal == 0 { exit = (status >> 8) & 0xFF == 0 ? "exit0" : "exitNonzero" }
            else if signal == SIGTERM { exit = "term" }
            else if signal == SIGKILL { exit = "kill" }
            else { exit = "other" }
        }

        var summary: String {
            "spawnMs=\(spawnMs),metadataMs=\(metadataMs),ownerWriteMs=\(ownerWriteMs),ownerSyncMs=\(ownerSyncMs),firstWaitMs=\(firstWaitMs),bindingEverAcquired=\(firstBindingMs >= 0),firstBindingMs=\(firstBindingMs),running=\(running),joined=\(joined),interrupted=\(interrupted),lost=\(lost),maxGapMs=\(maxGapMs),maxIterationMs=\(maxIterationMs),firstRefusalMs=\(firstRefusalMs),refusal=\(refusal),firstNonzeroMs=\(firstNonzeroMs),lastBytes=\(lastBytes),maxBytes=\(maxBytes),fileRefused=\(fileRefused),termMs=\(termMs),term=\(termOutcome),killMs=\(killMs),kill=\(killOutcome),joinMs=\(joinMs),exit=\(exit)"
        }
    }

    /// Only the function that freshly posix_spawn'ed the child may use this state.
    /// WNOHANG == 0 proves it is still our unreaped child. No other code reaps it;
    /// its PID cannot be reused between that observation and a cleanup signal.
    struct SamplerLifecycle {
        enum Observation: Equatable { case running, joined, ownershipLost, interrupted }
        enum Action: Equatable { case wait, terminate, kill, joined, unconfirmed, finished }
        private(set) var finished = false
        private var terminatedAt: Duration?
        private var killed = false

        mutating func advance(_ observation: Observation, elapsed: Duration, refused: Bool) -> Action {
            if finished { return .finished }
            switch observation {
            case .joined: finished = true
                return .joined
            case .ownershipLost: finished = true
                return .unconfirmed
            case .running, .interrupted: break
            }
            // A bounded refusal is not physical closure. Retain private ownership evidence.
            if elapsed >= .seconds(7) { finished = true
                return .unconfirmed
            }
            guard case .running = observation else { return .wait }
            if terminatedAt == nil, refused || elapsed >= .seconds(5) {
                terminatedAt = elapsed
                return .terminate
            }
            if let terminatedAt, elapsed - terminatedAt >= .seconds(1), !killed {
                killed = true
                return .kill
            }
            return .wait
        }
    }

    static func permitsSoleWaiter(defaultHandler: Bool, autoReaps: Bool) -> Bool {
        defaultHandler && !autoReaps
    }

    private static func permitsSoleWaiter() -> Bool {
        var disposition = sigaction()
        guard sigaction(SIGCHLD, nil, &disposition) == 0 else { return false }
        // Darwin SIG_DFL is the null handler; custom handlers might reap our child.
        return permitsSoleWaiter(
            defaultHandler: disposition.__sigaction_u.__sa_handler == nil,
            autoReaps: disposition.sa_flags & SA_NOCLDWAIT != 0
        )
    }

    static func verifiesSampler(
        initial: DesktopBackgroundProcessIdentity?,
        current: DesktopBackgroundProcessIdentity?,
        image: String?
    )
        -> Bool {
        initial != nil && initial == current && image == "/usr/bin/sample"
    }

    struct SamplerIdentityAcquisition {
        enum Phase: String, Equatable { case awaitingIdentity, verified, awaitingOwnedExit, joinedOwnedExit, refused }
        private(set) var phase = Phase.awaitingIdentity
        private(set) var binding: DesktopBackgroundProcessIdentity?
        private(set) var refusal: String?
        private var awaitingExitObservations = 0
        private let parent: Int32
        private let firstRead: Bool
        private let firstParent: Bool
        private let firstImageRead: Bool
        private let firstImageMatch: Bool
        private var currentRead = false
        private var currentParent = false
        private var currentImageRead = false
        private var currentImageMatch = false

        init(parent: Int32, firstIdentity: DesktopBackgroundProcessIdentity?, firstImage: String?) {
            self.parent = parent
            firstRead = firstIdentity != nil
            firstParent = firstIdentity?.parent == parent
            firstImageRead = firstImage != nil
            firstImageMatch = firstImage == "/usr/bin/sample"
        }

        mutating func observe(identity: DesktopBackgroundProcessIdentity?, image: String?, ownedUnreaped: Bool, elapsed: Duration) {
            guard phase != .refused else { return }
            currentRead = identity != nil // The public read already enforces current UID.
            currentParent = identity?.parent == parent
            currentImageRead = image != nil
            currentImageMatch = image == "/usr/bin/sample"
            if !ownedUnreaped { reject("sampler-relationship-refused")
                return
            }
            if elapsed >= .seconds(5) { reject("deadline")
                return
            }
            if let binding {
                if !DesktopReadinessFailureDiagnostic.verifiesSampler(initial: binding, current: identity, image: image) {
                    reject("sampler-identity-refused")
                }
                return
            }
            if identity != nil, !currentParent { reject("sampler-parent-refused")
                return
            }
            // Initial exec/image metadata may not yet be visible. Only our same fresh,
            // WNOHANG-confirmed unreaped child can acquire its FIRST binding later.
            if let identity, currentParent, currentImageMatch {
                binding = identity
                phase = .verified
            }
        }

        /// Called only after this function's sole waitpid owner observed its freshly
        /// spawned, still-unreaped child running. Missing metadata may race actual exit.
        mutating func observeRunning(
            identity: DesktopBackgroundProcessIdentity?, image: String?, elapsed: Duration,
            observeExit: () -> SamplerLifecycle.Observation
        )
            -> SamplerLifecycle.Observation {
            if phase == .awaitingOwnedExit || (phase == .verified && binding != nil && identity == nil && image == nil) {
                currentRead = identity != nil
                currentParent = identity?.parent == parent
                currentImageRead = image != nil
                currentImageMatch = image == "/usr/bin/sample"
                // XNU may hide an exiting process before it becomes waitable. This
                // sticky state grants no publication or new PID/binding authority.
                if elapsed >= .seconds(5) { reject("deadline") }
                else if identity != nil || image != nil { reject("sampler-identity-reappeared") }
                else {
                    phase = .awaitingOwnedExit
                    awaitingExitObservations = min(700, awaitingExitObservations + 1)
                }
                return .running
            }
            let missing = identity == nil || image == nil
            let consistent = (identity == nil || identity == binding) && (image == nil || image == "/usr/bin/sample")
            if phase == .verified, binding != nil, missing, consistent {
                let exit = observeExit()
                if exit == .joined {
                    // Physical waitpid join, not metadata absence, establishes exit.
                    // Preserve only the binding already verified while it was alive.
                    currentRead = identity != nil
                    currentParent = identity?.parent == parent
                    currentImageRead = image != nil
                    currentImageMatch = image == "/usr/bin/sample"
                    return .joined
                }
                observe(identity: identity, image: image, ownedUnreaped: exit == .running, elapsed: elapsed)
                return exit
            }
            // Any nonnil changed identity/image remains fatal without an exit exception.
            observe(identity: identity, image: image, ownedUnreaped: true, elapsed: elapsed)
            return .running
        }

        /// Invoked only after this exact freshly spawned child's physical waitpid join.
        mutating func observeJoined(status: Int32, elapsed: Duration) {
            guard phase == .awaitingOwnedExit else { return }
            guard binding != nil else { reject("sampler-unverified")
                return
            }
            guard elapsed < .seconds(5) else { reject("deadline")
                return
            }
            guard status == 0 else { reject("tool-refused")
                return
            }
            phase = .joinedOwnedExit
        }

        var hasVerifiedOutputBinding: Bool {
            binding != nil && (phase == .verified || phase == .joinedOwnedExit)
        }

        private mutating func reject(_ reason: String) {
            phase = .refused
            refusal = reason
        }

        func summary(elapsed: Duration) -> String {
            let value = elapsed.components
            let milliseconds = max(0, min(7000, Int(min(7, max(0, value.seconds))) * 1000 + Int(value.attoseconds / 1_000_000_000_000_000)))
            return "phase=\(phase.rawValue),firstRead=\(firstRead),firstParentMatch=\(firstParent),firstImageRead=\(firstImageRead),firstImageMatch=\(firstImageMatch),currentRead=\(currentRead),currentParentMatch=\(currentParent),currentImageRead=\(currentImageRead),currentImageMatch=\(currentImageMatch),awaitingExitObservations=\(awaitingExitObservations),elapsedMs=\(milliseconds)"
        }
    }

    private static func image(_ pid: Int32) -> String? {
        var path = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
        return String(cString: path)
    }

    private static func verifies(_ target: Target) -> Bool {
        verifies(target, identity: try? DesktopBackgroundProcessIdentity.read(target.identity.pid), image: image(target.identity.pid))
    }

    private static func privateDirectory(_ directory: URL) throws {
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              try DesktopCanonicalPath.resolve(directory.path) == directory.path else { throw SampleFailure.refused }
    }

    private enum SampleFailure: Error { case refused }

    /// One fixed public tool, only after a failed assertion. Raw output remains outside upload
    /// until target identity, actual sampler join and the retained-file bound all validate.
    @MainActor
    static func sample(_ target: Target, didPublish: ((URL) -> Void)? = nil) async -> String {
        guard verifies(target) else { return "result=identity-refused" }
        guard permitsSoleWaiter() else { return "result=reaper-refused" }
        let manager = FileManager.default
        var temporary: URL?
        var receipt = SamplerReceipt()
        do {
            let parent = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(manager.temporaryDirectory.path), isDirectory: true)
            let directory = parent.appendingPathComponent("omnesis-owned-readiness-" + UUID().uuidString, isDirectory: true)
            try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            temporary = directory
            try privateDirectory(directory)
            let output = directory.appendingPathComponent("stack.txt")
            let fd = Darwin.open(output.path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw SampleFailure.refused }
            defer { Darwin.close(fd) }
            var original = stat()
            guard fstat(fd, &original) == 0 else { throw SampleFailure.refused }
            func fileState() -> stat? {
                var info = stat(), published = stat()
                guard fstat(fd, &info) == 0, lstat(output.path, &published) == 0,
                      info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
                      info.st_mode & 0o077 == 0, info.st_nlink == 1,
                      info.st_dev == original.st_dev, info.st_ino == original.st_ino,
                      info.st_dev == published.st_dev, info.st_ino == published.st_ino else { return nil }
                return info
            }
            let owner = directory.appendingPathComponent("sampler-owner.json")
            let ownerFD = Darwin.open(owner.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard ownerFD >= 0 else { throw SampleFailure.refused }
            defer { Darwin.close(ownerFD) }
            var actions: posix_spawn_file_actions_t?
            guard posix_spawn_file_actions_init(&actions) == 0 else { throw SampleFailure.refused }
            defer { posix_spawn_file_actions_destroy(&actions) }
            for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
                guard posix_spawn_file_actions_addopen(
                    &actions,
                    descriptor,
                    "/dev/null",
                    descriptor == STDIN_FILENO ? O_RDONLY : O_WRONLY,
                    0
                ) == 0 else { throw SampleFailure.refused }
            }
            let command = "/usr/bin/sample"
            let argumentStrings: [String] = [command, String(target.identity.pid), "1", "-file", output.path]
            let environmentStrings = ["PATH=/usr/bin:/bin"]
            let argv: [UnsafeMutablePointer<CChar>?] = argumentStrings.map { value in
                value.withCString { strdup($0) }
            } + [nil]
            let environment: [UnsafeMutablePointer<CChar>?] = environmentStrings.map { value in
                value.withCString { strdup($0) }
            } + [nil]
            defer { argv.forEach { free($0) }
                environment.forEach { free($0) }
            }
            guard argv.dropLast().allSatisfy({ $0 != nil }), environment.dropLast().allSatisfy({ $0 != nil }),
                  verifies(target) else { throw SampleFailure.refused }
            var pid: pid_t = 0
            let spawnBegan = ContinuousClock.now
            let spawned = argv.withUnsafeBufferPointer { args in environment.withUnsafeBufferPointer { env in
                posix_spawn(&pid, command, &actions, nil, args.baseAddress!, env.baseAddress!)
            } }
            guard spawned == 0, pid > 1 else { return "result=spawn-refused" }
            // Optional image/birth metadata gates evidence; cleanup authority is the
            // fresh direct child plus the sole waitpid owner's unreaped relationship.
            let began = ContinuousClock.now
            receipt.preloop(spawn: spawnBegan.duration(to: began))
            let sampler = try? DesktopBackgroundProcessIdentity.read(pid)
            var acquisition = SamplerIdentityAcquisition(parent: getpid(), firstIdentity: sampler, firstImage: image(pid))
            receipt.preloop(metadata: began.duration(to: .now))
            var exitReconciled = false
            func diagnostic(_ result: String) -> String {
                result + "; exitReconciled=\(exitReconciled); sampler[" + acquisition
                    .summary(elapsed: began.duration(to: .now)) + "]; receipt[" + receipt.summary + "]"
            }
            var reason: String?, status: Int32 = 0
            // Retain only this spawned child's kernel binding if join cannot be confirmed.
            // A receipt is diagnostic evidence, never permission to adopt or signal a PID.
            let ownership = Data(
                "{\"format\":1,\"pid\":\(pid),\"parent\":\(sampler?.parent ?? -1),\"seconds\":\(sampler?.startedSeconds ?? 0),\"microseconds\":\(sampler?.startedMicroseconds ?? 0)}\n"
                    .utf8
            )
            let written = ownership.withUnsafeBytes { Darwin.write(ownerFD, $0.baseAddress, $0.count) }
            receipt.preloop(write: began.duration(to: .now))
            if written != ownership.count { reason = "owner-refused" }
            else {
                let syncBegan = ContinuousClock.now
                let synced = fsync(ownerFD)
                receipt.preloop(sync: syncBegan.duration(to: .now))
                if synced != 0 { reason = "owner-refused" }
            }
            var lifecycle = SamplerLifecycle(), didJoin = false
            while !lifecycle.finished {
                guard permitsSoleWaiter() else { return diagnostic("result=reaper-changed,joined=false,privateRetained=true") }
                let iterationBegan = ContinuousClock.now
                // This is the sole waitpid owner, from successful spawn until join/loss.
                let waited = waitpid(pid, &status, WNOHANG)
                var observation: SamplerLifecycle.Observation = waited == pid ? .joined :
                    waited == 0 ? .running : errno == EINTR ? .interrupted : .ownershipLost
                receipt.observe(observation, elapsed: began.duration(to: .now))
                let state = fileState()
                receipt.file(bytes: state.map { Int64($0.st_size) }, elapsed: began.duration(to: .now))
                reason = reason ?? refusal(bytes: Int64(state?.st_size ?? -1), elapsed: began.duration(to: .now), ownedFile: state != nil)
                if Task.isCancelled { reason = reason ?? "cancelled" }
                if !verifies(target) { reason = reason ?? "identity-changed" }
                // Initial identity acquisition shares the SAME overall five-second budget.
                // Both metadata reads may disappear before XNU makes exit waitable.
                // Await only this already-bound owned child's exit within the same budget.
                if case .running = observation {
                    observation = acquisition.observeRunning(
                        identity: try? DesktopBackgroundProcessIdentity.read(pid),
                        image: image(pid),
                        elapsed: began.duration(to: .now)
                    ) {
                        // Still the same fresh child's sole waiter. Reap only this PID;
                        // ECHILD/lost ownership never grants signal or publication authority.
                        let rechecked = waitpid(pid, &status, WNOHANG)
                        let reobservation: SamplerLifecycle.Observation = rechecked == pid ? .joined :
                            rechecked == 0 ? .running : errno == EINTR ? .interrupted : .ownershipLost
                        receipt.observe(reobservation, elapsed: began.duration(to: .now))
                        return reobservation
                    }
                    exitReconciled = observation == .joined
                    reason = reason ?? acquisition.refusal
                }
                if observation == .joined {
                    acquisition.observeJoined(status: status, elapsed: began.duration(to: .now))
                    exitReconciled = exitReconciled || acquisition.phase == .joinedOwnedExit
                    reason = reason ?? acquisition.refusal
                }
                receipt.iteration(
                    iterationBegan.duration(to: .now),
                    bound: acquisition.binding != nil,
                    elapsed: began.duration(to: .now),
                    reason: reason
                )
                switch lifecycle.advance(observation, elapsed: began.duration(to: .now), refused: reason != nil) {
                case .terminate:
                    let result = Darwin.kill(pid, SIGTERM)
                    let error = errno
                    receipt.signal(kill: false, elapsed: began.duration(to: .now), result: result, error: error)
                case .kill:
                    let result = Darwin.kill(pid, SIGKILL)
                    let error = errno
                    receipt.signal(kill: true, elapsed: began.duration(to: .now), result: result, error: error)
                case .joined:
                    didJoin = true
                    receipt.didJoin(status: status, elapsed: began.duration(to: .now))
                case .unconfirmed: return diagnostic("result=join-unconfirmed,joined=false,privateRetained=true")
                case .wait, .finished: break
                }
                if !lifecycle.finished {
                    do { try await Task.sleep(for: .milliseconds(10)) }
                    catch { usleep(10000) }
                }
            }
            guard didJoin else { return diagnostic("result=join-unconfirmed,joined=false,privateRetained=true") }
            guard acquisition.hasVerifiedOutputBinding else {
                receipt.iteration(
                    .zero,
                    bound: acquisition.binding != nil,
                    elapsed: began.duration(to: .now),
                    reason: acquisition.refusal ?? "sampler-unverified"
                )
                return diagnostic("result=\(acquisition.refusal ?? "sampler-unverified"),joined=true,privateRetained=true")
            }
            var observed = stat()
            let observedFile = lstat(output.path, &observed) == 0
            let outputFacts = "outputPresent=\(observedFile),regular=\(observedFile && observed.st_mode & S_IFMT == S_IFREG),owned=\(observedFile && observed.st_uid == getuid()),private=\(observedFile && observed.st_mode & 0o077 == 0),singleLink=\(observedFile && observed.st_nlink == 1),initialInode=\(observedFile && observed.st_dev == original.st_dev && observed.st_ino == original.st_ino),bytes=\(observedFile ? max(0, min(Int64(observed.st_size), Int64(maximumStackBytes + 1))) : -1)"
            guard verifies(target),
                  let final = fileState()
            else { return diagnostic("result=identity-or-file-refused,joined=true,privateRetained=true; " + outputFacts) }
            reason = reason ?? refusal(bytes: Int64(final.st_size), elapsed: began.duration(to: .now), ownedFile: true)
            if let reason {
                receipt.iteration(.zero, bound: acquisition.binding != nil, elapsed: began.duration(to: .now), reason: reason)
                if reason == "oversize" { try manager.removeItem(at: output)
                    try manager.removeItem(at: owner)
                    try manager.removeItem(at: directory)
                }
                return diagnostic("result=\(reason),joined=true")
            }
            guard status == 0 else { return diagnostic("result=tool-refused,joined=true,privateRetained=true") }
            var bytes = [UInt8](repeating: 0, count: maximumStackBytes + 1)
            let count = Darwin.pread(fd, &bytes, bytes.count, 0)
            guard count > 0, count == final.st_size, count <= maximumStackBytes,
                  fileState()?.st_size == final.st_size else { return diagnostic("result=read-refused,joined=true,privateRetained=true") }
            // Derive only the owned checkout, never an operator-selected output or another process.
            var repository = URL(fileURLWithPath: #filePath)
            for _ in 0 ..< 4 {
                repository.deleteLastPathComponent()
            }
            var destination = repository
            for name in ["evidence", "readiness-diagnostics"] {
                destination.appendPathComponent(name, isDirectory: true)
                if !manager.fileExists(atPath: destination.path) {
                    try manager.createDirectory(at: destination, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                }
                try privateDirectory(destination)
            }
            destination.appendPathComponent(UUID().uuidString, isDirectory: true)
            try manager.createDirectory(at: destination, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try privateDirectory(destination)
            guard verifies(target), fileState()?.st_size == final.st_size else { throw SampleFailure.refused }
            let published = destination.appendingPathComponent("stack.txt")
            // Never copy across filesystems or expose an unchecked replacement inode.
            guard Darwin.rename(output.path, published.path) == 0 else { throw SampleFailure.refused }
            var retained = stat()
            guard lstat(published.path, &retained) == 0, retained.st_dev == original.st_dev,
                  retained.st_ino == original.st_ino, retained.st_mode & S_IFMT == S_IFREG,
                  retained.st_uid == getuid(), retained.st_mode & 0o077 == 0,
                  retained.st_nlink == 1, retained.st_size == final.st_size else { throw SampleFailure.refused }
            try manager.removeItem(at: owner)
            try manager.removeItem(at: directory)
            didPublish?(published)
            return diagnostic("result=collected,joined=true; " + stackFacts(Data(bytes.prefix(count))))
        } catch {
            return "result=io-refused,privateRetained=\(temporary != nil); receipt[" + receipt.summary + "]"
        }
    }

    private static func snapshot(_ target: Target) -> Snapshot {
        var result = Snapshot()
        guard (try? DesktopBackgroundProcessIdentity.read(target.identity.pid)) == target.identity else { return result }
        result.identityMatches = true
        var executable = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(target.identity.pid, &executable, UInt32(executable.count)) > 0,
              String(cString: executable) == target.node else { return result }
        result.nodeImage = true
        var task = proc_taskinfo()
        let taskSize = Int32(MemoryLayout<proc_taskinfo>.size)
        if proc_pidinfo(target.identity.pid, PROC_PIDTASKINFO, 0, &task, taskSize) == taskSize {
            result.taskRead = true
            result.userTime = task.pti_total_user
            result.systemTime = task.pti_total_system
            result.taskThreads = task.pti_threadnum
        }
        var threads = [UInt64](repeating: 0, count: 64)
        let bytes = threads.withUnsafeMutableBytes { buffer in
            proc_pidinfo(target.identity.pid, PROC_PIDLISTTHREADS, 0, buffer.baseAddress, Int32(buffer.count))
        }
        if bytes > 0, Int(bytes) <= 64 * MemoryLayout<UInt64>.size, Int(bytes) % MemoryLayout<UInt64>.size == 0 {
            result.listRead = true
            result.listed = Int(bytes) / MemoryLayout<UInt64>.size
            for thread in threads.prefix(result.listed) {
                var info = proc_threadinfo()
                let size = Int32(MemoryLayout<proc_threadinfo>.size)
                // PROC_PIDLISTTHREADS returns legacy handles, not unique thread IDs.
                guard proc_pidinfo(target.identity.pid, PROC_PIDTHREADINFO, thread, &info, size) == size else {
                    result.readFailures += 1
                    continue
                }
                switch info.pth_run_state {
                case TH_STATE_RUNNING: result.running += 1
                case TH_STATE_STOPPED: result.stopped += 1
                case TH_STATE_WAITING: result.waiting += 1
                case TH_STATE_UNINTERRUPTIBLE: result.uninterruptible += 1
                case TH_STATE_HALTED: result.halted += 1
                default: result.unknownStates += 1
                }
            }
        }
        // Reject a PID incarnation or exec change during these bounded metadata reads.
        let identityMatches = (try? DesktopBackgroundProcessIdentity.read(target.identity.pid)) == target.identity
        let nodeImage = proc_pidpath(target.identity.pid, &executable, UInt32(executable.count)) > 0 &&
            String(cString: executable) == target.node
        guard identityMatches, nodeImage else {
            var rejected = Snapshot()
            rejected.identityMatches = identityMatches
            rejected.nodeImage = nodeImage
            return rejected
        }
        return result
    }
}
