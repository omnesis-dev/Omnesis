// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreFoundation
import Darwin
import DesktopCore
import Foundation

/// Test-only ownership of one explicitly spawned catalog child. A receipt is only a PID hint.
final class CatalogFixtureChild {
    enum Failure: Error {
        case uncertainOwnership, uncertainDrain, unsafeReceipt
        case uncertainChildObservation(probeStatus: Int32, probeError: Int32)
    }

    private let parent: Process
    private let parentIdentity: DesktopBackgroundProcessIdentity
    private let receipt: URL
    private let images: Set<String>
    private let joined: () -> Bool
    let node: URL
    private(set) var identity: DesktopBackgroundProcessIdentity?
    private var orphaned = false
    private var cleanupConfirmed = false
    private var exitRequested = false
    private(set) var ageAtAdoptionMilliseconds: Int?

    init(parent: Process, receipt: URL, images: Set<String>, node: URL, joined: @escaping () -> Bool) throws {
        self.parent = parent
        parentIdentity = try DesktopBackgroundProcessIdentity.read(parent.processIdentifier)
        self.receipt = receipt
        self.images = images
        self.joined = joined
        self.node = node
    }

    /// Called within the existing readiness deadline, never with another startup budget.
    func tryAdopt() throws {
        guard identity == nil else { return }
        guard parent.isRunning, try DesktopBackgroundProcessIdentity.read(parentIdentity.pid) == parentIdentity else {
            throw Failure.uncertainOwnership
        }
        let fd = Darwin.open(receipt.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0, errno == ENOENT { return }
        guard fd >= 0 else { throw Failure.unsafeReceipt }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o777 == 0o600,
              info.st_uid == getuid(), info.st_nlink == 1, info.st_size > 0, info.st_size <= 128 else { throw Failure.unsafeReceipt }
        var bytes = [UInt8](repeating: 0, count: 129)
        let count = Darwin.read(fd, &bytes, bytes.count)
        guard count > 0, count <= 128,
              let object = try JSONSerialization.jsonObject(with: Data(bytes.prefix(count))) as? [String: Any],
              Set(object.keys) == ["pid"], let number = object["pid"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue == Double(number.int32Value), number.int32Value > 1 else {
            throw Failure.unsafeReceipt
        }
        let child = try DesktopBackgroundProcessIdentity.read(number.int32Value)
        var image = [CChar](repeating: 0, count: 4096)
        guard child.parent == parentIdentity.pid,
              proc_pidpath(child.pid, &image, UInt32(image.count)) > 0, images.contains(String(cString: image)),
              try DesktopBackgroundProcessIdentity.read(child.pid) == child,
              parent.isRunning, try DesktopBackgroundProcessIdentity.read(parentIdentity.pid) == parentIdentity else {
            throw Failure.uncertainOwnership
        }
        identity = child
        ageAtAdoptionMilliseconds = ageMilliseconds()
    }

    /// Relative age only; no absolute birth timestamp or process identifier is reported.
    func ageMilliseconds() -> Int? {
        guard let identity else { return nil }
        let seconds = Date().timeIntervalSince1970 - Double(identity.startedSeconds) - Double(identity.startedMicroseconds) / 1e6
        guard seconds >= 0 else { return nil }
        return Int(min(60000, seconds * 1000))
    }

    /// The original test may orphan only an adopted child that already owns its socket.
    func killControllerAfterReady() throws {
        guard let identity, parent.isRunning,
              try DesktopBackgroundProcessIdentity.read(identity.pid) == identity,
              try DesktopBackgroundProcessIdentity.read(parentIdentity.pid) == parentIdentity else { throw Failure.uncertainOwnership }
        guard Darwin.kill(parentIdentity.pid, SIGKILL) == 0 else { throw Failure.uncertainOwnership }
        orphaned = true
    }

    func cleanup(sendExit: () throws -> Void) async throws {
        guard !cleanupConfirmed else { return }
        let drain = Drain()
        if !orphaned, parent.isRunning {
            guard try DesktopBackgroundProcessIdentity.read(parentIdentity.pid) == parentIdentity,
                  Darwin.kill(parentIdentity.pid, SIGTERM) == 0 else { throw Failure.uncertainOwnership }
            try await drain.waitForParent { !parent.isRunning && joined() }
            parent.waitUntilExit()
            if identity != nil { try await drain.waitForChild(observe: observeChild) }
        } else if !orphaned, !parent.isRunning, joined() {
            parent.waitUntilExit()
            if identity != nil { try await drain.waitForChild(observe: observeChild) }
        } else {
            // Unexpected parent death before adoption supplies no authority to signal a guessed orphan.
            guard identity != nil else { throw Failure.uncertainOwnership }
            try await drain.waitForParent { !parent.isRunning }
            parent.waitUntilExit()
            try await drain.waitForChild(observe: observeChild) {
                guard !exitRequested else { return }
                exitRequested = true
                try sendExit()
            }
        }
        try drain.checkDeadline()
        // A confirmed original incarnation cannot become live again after PID reuse.
        cleanupConfirmed = true
    }

    enum ChildObservation: Equatable {
        case live, gone
        case unknown(probeStatus: Int32, probeError: Int32)
    }

    static func childObservation(
        expected: DesktopBackgroundProcessIdentity,
        current: DesktopBackgroundProcessIdentity?,
        probeStatus: Int32 = 0,
        probeError: Int32 = 0
    )
        -> ChildObservation {
        if let current {
            return current.startedSeconds == expected.startedSeconds && current.startedMicroseconds == expected
                .startedMicroseconds ? .live : .gone
        }
        return probeStatus == -1 && probeError == ESRCH ? .gone : .unknown(probeStatus: probeStatus, probeError: probeError)
    }

    private func observeChild() throws -> ChildObservation {
        guard let identity else { throw Failure.uncertainOwnership }
        if let current = try? DesktopBackgroundProcessIdentity.read(identity.pid) {
            return Self.childObservation(expected: identity, current: current)
        }
        let status = Darwin.kill(identity.pid, 0)
        let probeError = status == -1 ? errno : 0
        return Self.childObservation(expected: identity, current: nil, probeStatus: status, probeError: probeError)
    }

    /// Parent join and child observations spend one cleanup budget; uncertainty grants no signal authority.
    struct Drain {
        private let deadline: ContinuousClock.Instant
        private let now: () -> ContinuousClock.Instant
        private let pause: () async throws -> Void

        init(
            now: @escaping () -> ContinuousClock.Instant = { .now },
            pause: @escaping () async throws -> Void = { try await Task.sleep(for: .milliseconds(10)) }
        ) {
            self.now = now
            self.pause = pause
            deadline = now().advanced(by: .seconds(5))
        }

        func checkDeadline() throws {
            guard now() < deadline else { throw Failure.uncertainDrain }
        }

        func waitForParent(joined: () -> Bool) async throws {
            while now() < deadline {
                let confirmed = joined()
                try checkDeadline()
                if confirmed { return }
                try await pause()
            }
            throw Failure.uncertainDrain
        }

        func waitForChild(observe: () throws -> ChildObservation, sendExit: () throws -> Void = {}) async throws {
            var requested = false
            var last = ChildObservation.live
            observation: while now() < deadline {
                last = try observe()
                guard now() < deadline else { break }
                switch last {
                case .gone: return
                case .live:
                    if !requested {
                        requested = true
                        try sendExit()
                        guard now() < deadline else { break observation }
                    }
                case .unknown: break
                }
                try await pause()
            }
            if case .unknown(let status, let error) = last {
                throw Failure.uncertainChildObservation(probeStatus: status, probeError: error)
            }
            throw Failure.uncertainDrain
        }
    }

    static func script(
        command: String?,
        arguments: [String],
        receipt: URL,
        socket: String?,
        inheritDataDescriptor: Bool = false
    ) throws
        -> String {
        func literal(_ value: some Encodable) throws -> String {
            try String(decoding: JSONEncoder().encode(value), as: UTF8.self)
        }
        // A host script participates in its runtime hash, so it uses its captured execPath,
        // rather than embedding the not-yet-created runtime path. FD7 is mapped only for EX.
        let executable = try command.map { try literal($0) } ?? "process.execPath"
        let stdio = inheritDataDescriptor ? "['ignore','ignore',2,'ignore','ignore','ignore','ignore',7]" : "['ignore','ignore',2]"
        return try """
        import {spawn} from 'node:child_process';
        import {writeFileSync,renameSync,existsSync} from 'node:fs';
        function stage(name,done){process.stderr.write('fixture-stage:'+name+'\\nfixture-uptime:'+name+':'+Math.min(60000,Math.floor(process.uptime()*1000))+'\\n',done);}
        let child=null,closing=false,closed=false,timer=null,killer=null;
        function joined(){if(killer)clearTimeout(killer);if(timer)clearInterval(timer);stage('catalog-child-joined',()=>process.exit(0));}
        function stop(){if(closing)return;closing=true;if(timer)clearInterval(timer);if(!child||closed){joined();return;}child.kill('SIGTERM');killer=setTimeout(()=>{if(!closed)child.kill('SIGKILL')},1000);}
        process.on('SIGTERM',stop);
        stage('catalog-parent-enter');
        child=spawn(\(executable),\(literal(arguments)),{stdio:\(stdio)});
        child.once('close',()=>{closed=true;if(closing)joined();else stop();});
        child.once('error',()=>{stage('catalog-child-error');stop();});
        child.once('spawn',()=>{try{writeFileSync(\(literal(receipt
                .path + ".partial")),JSON.stringify({pid:child.pid}),{mode:0o600,flag:'wx'});renameSync(\(literal(receipt
                .path + ".partial")),\(literal(receipt
                .path)));stage('catalog-child-spawned');}catch{stop();}});
        const socket=\(literal(socket));
        if(socket)timer=setInterval(()=>{if(!closing&&existsSync(socket)){clearInterval(timer);timer=null;stage('catalog-socket-observed');process.stdout.write('ready',()=>stage('catalog-ready-written'))}},5);
        process.stdin.resume();
        """
    }
}
