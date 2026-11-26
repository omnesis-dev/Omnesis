// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation

/// One bounded, private frame per connection. Closing never reuses a descriptor while a worker owns it.
enum DesktopBackgroundSocket {
    enum Failure: Error { case unavailable, unsafePath, invalidFrame, timeout }
    final class Handle: @unchecked Sendable {
        let fd: Int32
        private let lock = NSLock()
        private var stopped = false
        init(_ fd: Int32) throws {
            self.fd = fd
            var enabled: Int32 = 1
            guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0,
                  fcntl(fd, F_SETFL, O_NONBLOCK) == 0,
                  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                Darwin.close(fd)
                throw Failure.unavailable
            }
        }

        var cancelled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return stopped
        }

        func cancel() {
            lock.lock()
            if !stopped { stopped = true
                _ = shutdown(fd, SHUT_RDWR)
            }
            lock.unlock()
        }

        deinit { Darwin.close(fd) }
    }

    static func path(_ binding: DesktopBackgroundLaunchProtocol.Binding) throws -> URL {
        let material = Data(binding.configDirHash.utf8)
        let suffix = SHA256.hash(data: material).prefix(12).map { String(format: "%02x", $0) }.joined()
        let temporary = try DesktopCanonicalPath.resolve("/tmp")
        return URL(fileURLWithPath: temporary, isDirectory: true)
            .appendingPathComponent("omnesis-background-\(getuid())-\(suffix)", isDirectory: true).appendingPathComponent("control.sock")
    }

    static func directory(_ url: URL, create: Bool) throws {
        if create, mkdir(url.path, 0o700) != 0, errno != EEXIST { throw Failure.unsafePath }
        var value = stat()
        guard lstat(url.path, &value) == 0, value.st_mode & S_IFMT == S_IFDIR,
              value.st_uid == getuid(), value.st_mode & 0o077 == 0,
              try DesktopCanonicalPath.resolve(url.path) == url.path else { throw Failure.unsafePath }
    }

    static func address<T>(_ path: URL, _ action: (UnsafePointer<sockaddr>, socklen_t) throws -> T) throws -> T {
        var value = sockaddr_un()
        let bytes = Array(path.path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: value.sun_path) else { throw Failure.unsafePath }
        value.sun_family = sa_family_t(AF_UNIX)
        value.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &value.sun_path) { target in
            for (index, byte) in bytes.enumerated() {
                target[index] = UInt8(bitPattern: byte)
            }
        }
        return try withUnsafePointer(to: &value) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { try action($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
    }

    static func wait(_ socket: Handle, events: Int16, deadline: ContinuousClock.Instant) throws {
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            guard !socket.cancelled else { throw Failure.unavailable }
            var descriptor = pollfd(fd: socket.fd, events: events, revents: 0)
            let result = Darwin.poll(&descriptor, 1, 50)
            if result < 0 { if errno == EINTR { continue }
                throw Failure.unavailable
            }
            if result > 0 { return }
        }
        throw Failure.timeout
    }

    static func send(_ bytes: Data, to socket: Handle, deadline: ContinuousClock.Instant) throws {
        guard bytes.count <= DesktopBackgroundLaunchProtocol.frameLimit else { throw Failure.invalidFrame }
        var frame = bytes
        frame.append(10)
        var offset = 0
        while offset < frame.count {
            // Darwin can report readable EOF without POLLOUT after the peer shuts down.
            // Observe that state before delivery so a completed release does not wait for its deadline.
            try wait(socket, events: Int16(POLLOUT | POLLIN), deadline: deadline)
            var incoming: UInt8 = 0
            let peeked = Darwin.recv(socket.fd, &incoming, 1, MSG_PEEK | MSG_DONTWAIT)
            if peeked == 0 { throw Failure.unavailable }
            if peeked > 0 { throw Failure.invalidFrame }
            if errno == EINTR { continue }
            guard errno == EAGAIN else { throw Failure.unavailable }
            let written = frame.withUnsafeBytes { data in Darwin.send(
                socket.fd,
                data.baseAddress!.advanced(by: offset),
                frame.count - offset,
                0
            ) }
            if written < 0 { if errno == EAGAIN || errno == EINTR { continue }
                throw Failure.unavailable
            }
            guard written > 0 else { throw Failure.unavailable }
            offset += written
        }
    }

    static func receive(_ socket: Handle, deadline: ContinuousClock.Instant) throws -> Data {
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while result.count <= DesktopBackgroundLaunchProtocol.frameLimit {
            try wait(socket, events: Int16(POLLIN), deadline: deadline)
            let count = Darwin.recv(socket.fd, &buffer, buffer.count, 0)
            if count < 0 { if errno == EAGAIN || errno == EINTR { continue }
                throw Failure.unavailable
            }
            guard count > 0 else { throw Failure.invalidFrame }
            result.append(contentsOf: buffer.prefix(count))
            if let newline = result.firstIndex(of: 10) {
                guard newline == result.index(before: result.endIndex),
                      newline <= DesktopBackgroundLaunchProtocol.frameLimit else { throw Failure.invalidFrame }
                return Data(result.prefix(upTo: newline))
            }
        }
        throw Failure.invalidFrame
    }
}
