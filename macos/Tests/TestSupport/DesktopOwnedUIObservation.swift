// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import DesktopCore
import Foundation

/// Selected test observation only. No AppKit object or arbitrary control text enters the observer queue.
final class DesktopOwnedUIObservation: @unchecked Sendable {
    enum Case: String, Codable { case staleOffMac, currentOffMac, blockedDNS }
    enum Operation: String, Codable { case save, consent, consentAction, writeReceipt, acknowledgement, blockedDNS }
    struct Trigger {
        let deadline: ContinuousClock.Instant
        init(_ selected: Case, began: ContinuousClock.Instant) {
            deadline = began.advanced(by: selected == .blockedDNS ? .seconds(1) : .seconds(5))
        }

        func isDue(at time: ContinuousClock.Instant) -> Bool {
            time >= deadline
        }
    }

    enum Phase: String, Codable {
        case operation, layout, display, childrenModern, childrenLegacy, subviews, identifierModern, identifierLegacy
        case labelModern, labelLegacy, valueModern, valueLegacy, enabledModern, enabledLegacy, frame, roleModern, roleLegacy
        case actionNames, namedSelector, directSelector, namedDispatch, directDispatch, automaticDiagnostics
        case consentSheet, consentRoot, writeReceipt, acknowledgement, failureDiagnostics
        case observationQueued, observationFired, observationFinished
        case dnsFixture, fulfillment, snapshot, logicalClose, futureJoin, cancellation, explicitRelease, automaticRelease, physicalFinish
    }

    enum Return: String, Codable { case entered, returned, threw }
    struct Entry: Codable {
        let operation: UUID?
        let phase: Phase
        let result: Return
        let treePass: Int
        let ordinal: Int
        let elapsedMs: Int
    }

    struct Token: Equatable { let id: UUID }
    private struct Active { let token: Token
        let operation: Operation
        let trigger: Trigger
    }

    private static let budgetLock = NSLock()
    private static var sampledCases: Set<Case> = []
    private let selected: Case
    private let began = ContinuousClock.now
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "dev.omnesis.test.owned-ui-observation", qos: .utility)
    private let target = DesktopOwnedUISelfSampler.Target.captureSelf()
    private var active: Active?
    private var timer: DispatchWorkItem?
    private var entries: [Entry] = []
    private var pass = 0
    private var ordinal = 0
    private var spent = false
    private var running = false
    private var closing = false
    private var joined = true
    // Receipt only: a retained PID never authorizes later adoption or signals after the worker ends.
    private var unconfirmedSampler: (pid: Int32, identity: DesktopBackgroundProcessIdentity?, directory: URL)?
    private var waiters: [CheckedContinuation<Bool, Never>] = []

    init(_ selected: Case) {
        self.selected = selected
    }

    func begin(_ operation: Operation) -> Token {
        let token = Token(id: UUID())
        let accepted = lock.withLock { () -> Bool in
            guard !closing else { return false }
            timer?.cancel()
            active = Active(token: token, operation: operation, trigger: Trigger(selected, began: .now))
            return !spent
        }
        record(.operation, .entered)
        if accepted {
            let work = DispatchWorkItem { [self] in fire(token) }
            let remaining = lock.withLock { () -> Duration? in
                guard !closing, let active, active.token == token, !spent else { return nil }
                timer = work
                return ContinuousClock.now.duration(to: active.trigger.deadline)
            }
            if let remaining {
                let parts = remaining.components
                let seconds = max(0, Double(parts.seconds) + Double(parts.attoseconds) / 1e18)
                record(.observationQueued, .entered)
                queue.asyncAfter(deadline: .now() + seconds, execute: work)
            }
        }
        return token
    }

    func end(_ token: Token) {
        lock.withLock {
            guard active?.token == token else { return }
            timer?.cancel()
            timer = nil
            append(.operation, .returned)
            active = nil
        }
    }

    func nextTreePass() {
        lock.withLock { pass = min(4096, pass + 1)
            ordinal = 0
        }
    }

    func node(_ index: Int) {
        lock.withLock { ordinal = max(0, min(4096, index)) }
    }

    func record(_ phase: Phase, _ result: Return) {
        lock.withLock { if !closing { append(phase, result) } }
        if selected == .blockedDNS {
            // Fixed scalar facts only. Closing stops journal mutation, but final fixture
            // disposal still needs its own before/after receipt after the sampler joins.
            let elapsed = began.duration(to: .now).components
            let ms = Int(max(0, min(7200, elapsed.seconds))) * 1000 + Int(max(0, elapsed.attoseconds) / 1_000_000_000_000_000)
            let line = "browser-observation:\(phase.rawValue):\(result.rawValue):ms=\(ms)\n"
            FileHandle.standardError.write(Data(line.utf8))
        }
    }

    private func append(_ phase: Phase, _ result: Return) {
        let elapsed = began.duration(to: .now).components
        let ms = Int(max(0, min(7200, elapsed.seconds))) * 1000 + Int(max(0, elapsed.attoseconds) / 1_000_000_000_000_000)
        entries.append(Entry(operation: active?.token.id, phase: phase, result: result, treePass: pass, ordinal: ordinal, elapsedMs: ms))
        if entries.count > 128 { entries.removeFirst(entries.count - 128) }
    }

    private func fire(_ token: Token) {
        let before = lock.withLock { () -> (Active, [Entry])? in
            guard !closing, !spent, let active, active.token == token, active.trigger.isDue(at: .now),
                  Self.budgetLock.withLock({ Self.sampledCases.insert(selected).inserted }) else { return nil }
            spent = true
            running = true
            return (active, entries)
        }
        guard let before else { return }
        record(.observationFired, .entered)
        var physical = true
        var atSpawn: Entry?
        var atJoin: Entry?
        var spawnMs: Int?
        var joinMs: Int?
        func elapsedMs() -> Int {
            let elapsed = began.duration(to: .now).components
            return Int(max(0, min(7200, elapsed.seconds))) * 1000 + Int(max(0, elapsed.attoseconds) / 1_000_000_000_000_000)
        }
        let result: String = if let target { DesktopOwnedUISelfSampler.sample(target, physical: { confirmed in
            physical = confirmed
            lock.withLock {
                if confirmed { atJoin = entries.last
                    joinMs = elapsedMs()
                    unconfirmedSampler = nil
                } else { atSpawn = entries.last
                    spawnMs = elapsedMs()
                }
            }
        }, retainOwner: { pid, identity, directory in
            lock.withLock { unconfirmedSampler = (pid, identity, directory) }
        }) } else { "result=target-refused,joined=true" }
        record(.observationFinished, .returned)
        let after = lock.withLock { (active?.token.id, entries) }
        // The journal is finite metadata. Raw sample publication is independently gated by
        // target identity, zero exit, exact physical join and retained private file checks.
        try? writeJournal(
            operation: before.0,
            before: before.1,
            after: after.1,
            sameOperation: after.0 == token.id,
            physical: physical,
            result: result,
            atSpawn: atSpawn,
            atJoin: atJoin,
            spawnMs: spawnMs,
            joinMs: joinMs
        )
        let pending = lock.withLock { () -> [CheckedContinuation<Bool, Never>] in
            running = false
            joined = physical
            let pending = waiters
            waiters.removeAll()
            return pending
        }
        for waiter in pending {
            waiter.resume(returning: physical)
        }
    }

    func close() async -> Bool {
        await withCheckedContinuation { continuation in
            lock.lock()
            closing = true
            timer?.cancel()
            timer = nil
            active = nil
            if running { waiters.append(continuation)
                lock.unlock()
            } else { let confirmed = joined
                lock.unlock()
                continuation.resume(returning: confirmed)
            }
        }
    }

    private func writeJournal(
        operation: Active,
        before: [Entry],
        after: [Entry],
        sameOperation: Bool,
        physical: Bool,
        result: String,
        atSpawn: Entry?,
        atJoin: Entry?,
        spawnMs: Int?,
        joinMs: Int?
    ) throws {
        struct Journal: Encodable {
            let selected: Case
            let operation: Operation
            let generation: UUID
            let sameOperationAfterSample: Bool
            let samplerJoined: Bool
            let samplerResult: String
            let phaseAtSamplerSpawn: Entry?
            let phaseAtSamplerJoin: Entry?
            let samplerSpawnMs: Int?
            let samplerJoinMs: Int?
            let before: [Entry]
            let after: [Entry]
        }
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 4 {
            repository.deleteLastPathComponent()
        }
        let manager = FileManager.default
        var directory = repository
        for component in ["evidence", "readiness-diagnostics"] {
            directory.appendPathComponent(component, isDirectory: true)
            if !manager.fileExists(atPath: directory.path) {
                try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            }
            try DesktopOwnedUISelfSampler.privateDirectory(directory)
        }
        directory.appendPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try DesktopOwnedUISelfSampler.privateDirectory(directory)
        let data = try JSONEncoder().encode(Journal(
            selected: selected,
            operation: operation.operation,
            generation: operation.token.id,
            sameOperationAfterSample: sameOperation,
            samplerJoined: physical,
            samplerResult: result,
            phaseAtSamplerSpawn: atSpawn,
            phaseAtSamplerJoin: atJoin,
            samplerSpawnMs: spawnMs,
            samplerJoinMs: joinMs,
            before: before,
            after: after
        ))
        guard data.count <= 128 * 1024 else { return }
        let file = directory.appendingPathComponent("owned-ui-observation.json")
        let fd = Darwin.open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return }
        defer { Darwin.close(fd) }
        let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        var info = stat()
        guard count == data.count, fstat(fd, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              info.st_nlink == 1, info.st_size == data.count else { return }
        _ = fsync(fd)
    }
}

/// A fixed self target and fresh POSIX child; never Foundation Process, enumeration or PID adoption.
enum DesktopOwnedUISelfSampler {
    struct Target {
        let identity: DesktopBackgroundProcessIdentity
        let uid: uid_t
        let imagePath: String
        static func captureSelf() -> Target? {
            guard let identity = try? DesktopBackgroundProcessIdentity.read(getpid()),
                  let path = DesktopOwnedUISelfSampler.image(getpid()) else { return nil }
            return Target(identity: identity, uid: getuid(), imagePath: path)
        }
    }

    static let maximumStackBytes = 2 * 1024 * 1024
    static func stackFacts(_ bytes: Data) -> String {
        guard bytes.count <= maximumStackBytes else { return "bounded=false" }
        let text = String(decoding: bytes, as: UTF8.self)
        return "bounded=true,appKitMention=\(text.contains("AppKit")),swiftUIMention=\(text.contains("SwiftUI")),accessibilityMention=\(text.contains("accessibility")),runLoopMention=\(text.contains("CFRunLoop"))"
    }

    static func refusal(bytes: Int64, elapsed: Duration, ownedFile: Bool) -> String? {
        if !ownedFile || bytes < 0 { return "file-refused" }
        if bytes > maximumStackBytes { return "oversize" }
        if elapsed >= .seconds(5) { return "deadline" }
        return nil
    }

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
                if !DesktopOwnedUISelfSampler.verifiesSampler(initial: binding, current: identity, image: image) {
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
        target.identity.pid == getpid() && getuid() == target.uid &&
            (try? DesktopBackgroundProcessIdentity.read(getpid())) == target.identity && image(getpid()) == target.imagePath
    }

    static func privateDirectory(_ directory: URL) throws {
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              try DesktopCanonicalPath.resolve(directory.path) == directory.path else { throw SampleFailure.refused }
    }

    private enum SampleFailure: Error { case refused }

    static func sample(
        _ target: Target,
        physical: (Bool) -> Void,
        retainOwner: (Int32, DesktopBackgroundProcessIdentity?, URL) -> Void
    )
        -> String {
        guard verifies(target) else { return "result=identity-refused" }
        guard permitsSoleWaiter() else { return "result=reaper-refused" }
        let manager = FileManager.default
        var temporary: URL?
        do {
            let parent = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(manager.temporaryDirectory.path), isDirectory: true)
            let directory = parent.appendingPathComponent("omnesis-owned-ui-sample-" + UUID().uuidString, isDirectory: true)
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
            let spawned = argv.withUnsafeBufferPointer { args in environment.withUnsafeBufferPointer { env in
                posix_spawn(&pid, command, &actions, nil, args.baseAddress!, env.baseAddress!)
            } }
            guard spawned == 0, pid > 1 else { return "result=spawn-refused" }
            physical(false)
            retainOwner(pid, nil, directory)
            // Optional image/birth metadata gates evidence; cleanup authority is the
            // fresh direct child plus the sole waitpid owner's unreaped relationship.
            let began = ContinuousClock.now
            let sampler = try? DesktopBackgroundProcessIdentity.read(pid)
            retainOwner(pid, sampler, directory)
            var acquisition = SamplerIdentityAcquisition(parent: getpid(), firstIdentity: sampler, firstImage: image(pid))
            var exitReconciled = false
            func diagnostic(_ result: String) -> String {
                result + "; exitReconciled=\(exitReconciled); sampler[" + acquisition.summary(elapsed: began.duration(to: .now)) + "]"
            }
            var reason: String?, status: Int32 = 0
            // Retain only this spawned child's kernel binding if join cannot be confirmed.
            // A receipt is diagnostic evidence, never permission to adopt or signal a PID.
            let ownership = Data(
                "{\"format\":1,\"pid\":\(pid),\"parent\":\(sampler?.parent ?? -1),\"seconds\":\(sampler?.startedSeconds ?? 0),\"microseconds\":\(sampler?.startedMicroseconds ?? 0)}\n"
                    .utf8
            )
            let written = ownership.withUnsafeBytes { Darwin.write(ownerFD, $0.baseAddress, $0.count) }
            if written != ownership.count || fsync(ownerFD) != 0 { reason = "owner-refused" }
            var lifecycle = SamplerLifecycle(), didJoin = false
            while !lifecycle.finished {
                guard permitsSoleWaiter() else { return diagnostic("result=reaper-changed,joined=false,privateRetained=true") }
                // This is the sole waitpid owner, from successful spawn until join/loss.
                let waited = waitpid(pid, &status, WNOHANG)
                var observation: SamplerLifecycle.Observation = waited == pid ? .joined :
                    waited == 0 ? .running : errno == EINTR ? .interrupted : .ownershipLost
                let state = fileState()
                reason = reason ?? refusal(bytes: Int64(state?.st_size ?? -1), elapsed: began.duration(to: .now), ownedFile: state != nil)
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
                        return rechecked == pid ? .joined :
                            rechecked == 0 ? .running : errno == EINTR ? .interrupted : .ownershipLost
                    }
                    exitReconciled = observation == .joined
                    reason = reason ?? acquisition.refusal
                }
                if observation == .joined {
                    acquisition.observeJoined(status: status, elapsed: began.duration(to: .now))
                    exitReconciled = exitReconciled || acquisition.phase == .joinedOwnedExit
                    reason = reason ?? acquisition.refusal
                }
                switch lifecycle.advance(observation, elapsed: began.duration(to: .now), refused: reason != nil) {
                case .terminate: _ = Darwin.kill(pid, SIGTERM)
                case .kill: _ = Darwin.kill(pid, SIGKILL)
                case .joined: didJoin = true
                    physical(true)
                case .unconfirmed: return diagnostic("result=join-unconfirmed,joined=false,privateRetained=true")
                case .wait, .finished: break
                }
                if !lifecycle.finished {
                    usleep(10000)
                }
            }
            guard didJoin else { return diagnostic("result=join-unconfirmed,joined=false,privateRetained=true") }
            guard acquisition.hasVerifiedOutputBinding else {
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
            return diagnostic("result=collected,joined=true; " + stackFacts(Data(bytes.prefix(count))))
        } catch {
            return "result=io-refused,privateRetained=\(temporary != nil)"
        }
    }
}
