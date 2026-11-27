// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

public enum DesktopBackgroundControlClient {
    /// Call off the UI actor. This authenticates native code, not TCC authorization.
    public static func exchange(
        _ request: DesktopBackgroundLaunchProtocol.Request,
        expectedPID: Int32? = nil,
        expectedIdentity: DesktopBackgroundProcessIdentity? = nil
    ) throws
        -> DesktopBackgroundLaunchProtocol.Reply {
        let timeout: Duration = switch request.action {
        case .ensureDaemon, .releaseOwner, .recoverOrigin: .seconds(85)
        case .verifyDaemon, .verifyRetirement, .nearbySnapshot: .seconds(5)
        case .adoptOrigin: .seconds(30)
        case .hello: .seconds(30)
        }
        let reply = try exchange(request, expectedPID: expectedPID, timeout: timeout, verify: { descriptor in
            let peer = try DesktopBackgroundPeerTrust.peer(socket: descriptor, kind: .helper, expectedPID: expectedPID)
            if let expectedIdentity {
                guard try DesktopBackgroundProcessIdentity.read(peer.pid) == expectedIdentity
                else { throw DesktopBackgroundPeerTrust.Failure.untrustedPeer }
            }
        })
        if [.epochMismatch, .scopeMismatch].contains(reply.state), expectedPID == nil {
            throw DesktopBackgroundPeerTrust.Failure.untrustedPeer
        }
        return reply
    }

    /// Native clients can discover an actual signed helper independently of generation.
    public static func observation(_ request: DesktopBackgroundLaunchProtocol
        .Request) throws
        -> (reply: DesktopBackgroundLaunchProtocol.Reply, pid: Int32, identity: DesktopBackgroundProcessIdentity) {
        guard request.action == .hello else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
        var pid: Int32 = 0
        var identity: DesktopBackgroundProcessIdentity?
        let reply = try exchange(request, verify: { socket in
            pid = try DesktopBackgroundPeerTrust.peer(socket: socket, kind: .helper).pid
            identity = try DesktopBackgroundProcessIdentity.read(pid)
        })
        guard pid > 0, let identity,
              try DesktopBackgroundProcessIdentity.read(pid) == identity else { throw DesktopBackgroundPeerTrust.Failure.untrustedPeer }
        return (reply, pid, identity)
    }

    static func exchange(
        _ request: DesktopBackgroundLaunchProtocol.Request,
        expectedPID: Int32? = nil,
        timeout: Duration = .seconds(30),
        verify: (Int32) throws -> Void
    ) throws
        -> DesktopBackgroundLaunchProtocol.Reply {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        let path = try DesktopBackgroundSocket.path(request.binding)
        let bytes = try DesktopBackgroundLaunchProtocol.encode(request)
        _ = try DesktopBackgroundLaunchProtocol.decodeRequest(bytes)
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            var parent = stat()
            if lstat(path.deletingLastPathComponent().path, &parent) != 0, errno == ENOENT {
                usleep(25000)
                continue
            }
            try DesktopBackgroundSocket.directory(path.deletingLastPathComponent(), create: false)
            let raw = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard raw >= 0 else { throw DesktopBackgroundSocket.Failure.unavailable }
            let socket = try DesktopBackgroundSocket.Handle(raw)
            let connected = try DesktopBackgroundSocket.address(path) { Darwin.connect(raw, $0, $1) }
            if connected != 0 {
                if errno == ENOENT || errno == ECONNREFUSED { usleep(25000)
                    continue
                }
                guard errno == EINPROGRESS else { throw DesktopBackgroundSocket.Failure.unavailable }
                try DesktopBackgroundSocket.wait(socket, events: Int16(POLLOUT), deadline: deadline)
                var error: Int32 = 0
                var size = socklen_t(MemoryLayout<Int32>.size)
                guard getsockopt(raw, SOL_SOCKET, SO_ERROR, &error, &size) == 0,
                      error == 0 else { throw DesktopBackgroundSocket.Failure.unavailable }
            }
            try verify(raw)
            try DesktopBackgroundSocket.send(bytes, to: socket, deadline: deadline)
            let received = try DesktopBackgroundSocket.receive(socket, deadline: deadline)
            return try DesktopBackgroundLaunchProtocol.decodeReply(received, request: request)
        }
        throw DesktopBackgroundSocket.Failure.timeout
    }
}

/// A socket owner never substitutes for the daemon's runtime/data/kernel ownership.
public final class DesktopBackgroundControlServer: @unchecked Sendable {
    public typealias Handler = @Sendable (
        DesktopBackgroundLaunchProtocol.Request,
        DesktopBackgroundPeerTrust.Peer,
        ContinuousClock.Instant
    ) async throws
        -> DesktopBackgroundLaunchProtocol.Reply
    private let binding: DesktopBackgroundLaunchProtocol.Binding
    private let handler: Handler
    private let released: @Sendable () -> Void
    private let verify: @Sendable (Int32, DesktopBackgroundLaunchProtocol.Action?) throws -> DesktopBackgroundPeerTrust.Peer
    private let path: URL
    private let listener: DesktopBackgroundSocket.Handle
    private let owner: Int32
    private let socketIdentity: (dev_t, ino_t)
    private let lock = NSLock()
    private var clients: [ObjectIdentifier: DesktopBackgroundSocket.Handle] = [:]
    private var stopped = false
    private var releaseCompleted = false

    public convenience init(
        binding: DesktopBackgroundLaunchProtocol.Binding,
        released: @escaping @Sendable () -> Void = {},
        handler: @escaping Handler
    ) throws {
        try self.init(binding: binding, verify: { descriptor, action in
            do { return try DesktopBackgroundPeerTrust.peer(socket: descriptor, kind: .client) }
            catch {
                guard action == nil || action == .hello else { throw error }
                return try DesktopBackgroundPeerTrust.peer(socket: descriptor, kind: .observer)
            }
        }, released: released, handler: handler)
    }

    init(
        binding: DesktopBackgroundLaunchProtocol.Binding,
        verify: @escaping @Sendable (Int32, DesktopBackgroundLaunchProtocol.Action?) throws -> DesktopBackgroundPeerTrust.Peer,
        released: @escaping @Sendable () -> Void = {},
        handler: @escaping Handler
    ) throws {
        self.binding = binding
        self.handler = handler
        self.released = released
        self.verify = verify
        let selectedPath = try DesktopBackgroundSocket.path(binding)
        let parent = selectedPath.deletingLastPathComponent()
        try DesktopBackgroundSocket.directory(parent, create: true)
        let leasePath = parent.appendingPathComponent("owner.lock")
        let lease = Darwin.open(leasePath.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard lease >= 0 else { throw DesktopBackgroundSocket.Failure.unsafePath }
        var held = stat(), published = stat()
        guard fstat(lease, &held) == 0, lstat(leasePath.path, &published) == 0,
              held.st_mode & S_IFMT == S_IFREG, held.st_uid == getuid(), held.st_mode & 0o077 == 0,
              held.st_nlink == 1, held.st_dev == published.st_dev, held.st_ino == published.st_ino,
              flock(lease, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(lease)
            throw DesktopBackgroundSocket.Failure.unsafePath
        }
        var committed = false
        defer { if !committed { Darwin.close(lease) } }
        var prior = stat()
        if lstat(selectedPath.path, &prior) == 0 {
            guard prior.st_mode & S_IFMT == S_IFSOCK, prior.st_uid == getuid(),
                  unlink(selectedPath.path) == 0 else { throw DesktopBackgroundSocket.Failure.unsafePath }
        } else if errno != ENOENT { throw DesktopBackgroundSocket.Failure.unsafePath }
        let raw = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard raw >= 0 else { throw DesktopBackgroundSocket.Failure.unavailable }
        let selectedListener = try DesktopBackgroundSocket.Handle(raw)
        guard try DesktopBackgroundSocket.address(selectedPath, { Darwin.bind(raw, $0, $1) }) == 0,
              chmod(selectedPath.path, 0o600) == 0, Darwin.listen(raw, 4) == 0 else { throw DesktopBackgroundSocket.Failure.unavailable }
        var socket = stat()
        guard lstat(selectedPath.path, &socket) == 0, socket.st_mode & S_IFMT == S_IFSOCK,
              socket.st_uid == getuid() else { throw DesktopBackgroundSocket.Failure.unsafePath }
        path = selectedPath
        listener = selectedListener
        socketIdentity = (socket.st_dev, socket.st_ino)
        owner = lease
        committed = true
        let listener = selectedListener
        DispatchQueue.global(qos: .utility).async { [weak self, listener] in
            while !listener.cancelled {
                var descriptor = pollfd(fd: listener.fd, events: Int16(POLLIN), revents: 0)
                let count = Darwin.poll(&descriptor, 1, 100)
                if count <= 0 { continue }
                let accepted = Darwin.accept(listener.fd, nil, nil)
                if accepted < 0 { continue }
                guard let self else { Darwin.close(accepted)
                    return
                }
                self.accept(accepted)
            }
        }
    }

    public func stop() {
        lock.lock()
        guard !stopped else { lock.unlock()
            return
        }
        stopped = true
        let active = Array(clients.values)
        lock.unlock()
        listener.cancel()
        for client in active {
            client.cancel()
        }
        var current = stat()
        if lstat(path.path, &current) == 0, current.st_dev == socketIdentity.0, current.st_ino == socketIdentity.1,
           current.st_mode & S_IFMT == S_IFSOCK, current.st_uid == getuid() { _ = unlink(path.path) }
    }

    private func accept(_ descriptor: Int32) {
        guard let socket = try? DesktopBackgroundSocket.Handle(descriptor) else { return }
        lock.lock()
        guard !stopped, clients.count < 4 else { lock.unlock()
            return
        }
        clients[ObjectIdentifier(socket)] = socket
        lock.unlock()
        Task.detached(priority: .utility) { [weak self, socket] in
            guard let self else { return }
            defer { self.remove(socket) }
            do {
                _ = try self.verify(socket.fd, nil)
                let admitted = ContinuousClock.now
                let deadline = admitted.advanced(by: .seconds(80))
                let bytes = try DesktopBackgroundSocket.receive(socket, deadline: deadline)
                let request = try DesktopBackgroundLaunchProtocol.decodeRequest(bytes)
                let peer = try self.verify(socket.fd, request.action)
                // Nearby reads share a five-second window from receipt admission, including
                // identity checks. A slow guard cannot initiate discovery after that window.
                let operationDeadline = request.action == .nearbySnapshot ? admitted.advanced(by: .seconds(5)) : deadline
                guard request.binding.configDirHash == self.binding.configDirHash, self.running,
                      ContinuousClock.now < operationDeadline else { return }
                let reply = try await self.handler(request, peer, operationDeadline)
                // A release is committed only after the handler has joined its owned child.
                // Delivery failure cannot strand that committed owner in its frozen state.
                defer {
                    if [.releaseOwner, .recoverOrigin].contains(request.action), reply.state == .ownerReleased {
                        self.completeRelease()
                    }
                }
                guard self.running else { return }
                try DesktopBackgroundSocket.send(DesktopBackgroundLaunchProtocol.encode(reply), to: socket, deadline: operationDeadline)
            } catch { /* No raw exception or caller values cross this metadata channel. */ }
            socket.cancel()
        }
    }

    private func completeRelease() {
        lock.lock()
        let notify = !releaseCompleted
        releaseCompleted = true
        lock.unlock()
        if notify { released() }
    }

    private var running: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !stopped
    }

    private func remove(_ socket: DesktopBackgroundSocket.Handle) {
        lock.lock()
        clients.removeValue(forKey: ObjectIdentifier(socket))
        lock.unlock()
    }

    deinit { stop()
        Darwin.close(owner)
    }
}
