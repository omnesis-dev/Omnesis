// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import Foundation
import Security

/// Secrets cross only the private input/output pipe, never process arguments or environment.
public enum DesktopKeyRecoveryKeychain {
    public struct Request: Decodable {
        let version: Int
        let operation: String
        let account: String?
        let value: String?
    }

    public struct Reply: Encodable {
        public let code: Int
        public let stdout: String
        public let stderr: String
    }

    enum Lookup { case missing, found(Data?), refused }
    /// Internal metadata only. The native entry still emits its fixed sanitized failure.
    enum InputFailure: Error {
        case channelValidation, emptyEOF, oversize
        case deadline(count: Int)
        case read(count: Int, code: Int32)
        case poll(count: Int, code: Int32)
    }

    struct Store {
        let find: (String, Bool) -> Lookup
        let add: (String, Data) throws -> Bool
    }

    /// Constructed only from a live selected-runtime Node parent, never caller metadata.
    public struct ParentProof {
        fileprivate let runtime: URL
        fileprivate let pid: pid_t
        fileprivate let seconds: UInt64
        fileprivate let microseconds: UInt64
        fileprivate init(runtime: URL, pid: pid_t, seconds: UInt64, microseconds: UInt64) {
            self.runtime = runtime
            self.pid = pid
            self.seconds = seconds
            self.microseconds = microseconds
        }
    }

    /// Both directions must remain private before an operation may handle key material.
    public static func validatePrivateChannel(_ descriptor: Int32) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        switch metadata.st_mode & S_IFMT {
        case S_IFIFO:
            guard metadata.st_nlink == 0, metadata.st_uid == getuid() else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        case S_IFSOCK:
            try validateSocketPair(descriptor)
        default: throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
    }

    public static func readInput(descriptor: Int32 = STDIN_FILENO, parent: ParentProof? = nil) throws -> Data {
        do {
            var metadata = stat()
            guard fstat(descriptor, &metadata) == 0 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
            if metadata.st_mode & S_IFMT == S_IFSOCK {
                try validateSocketPair(descriptor, closedInputParent: parent)
            } else { try validatePrivateChannel(descriptor) }
        } catch { throw InputFailure.channelValidation }
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 512)
        while ContinuousClock.now < deadline {
            var item = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let status = Darwin.poll(&item, 1, 50)
            if status < 0 { if errno == EINTR { continue }
                throw InputFailure.poll(count: bytes.count, code: errno)
            }
            if status == 0 { continue }
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count < 0 { if errno == EINTR || errno == EAGAIN { continue }
                throw InputFailure.read(count: bytes.count, code: errno)
            }
            if count == 0 {
                guard !bytes.isEmpty else { throw InputFailure.emptyEOF }
                return bytes
            }
            bytes.append(contentsOf: buffer.prefix(count))
            guard bytes.count <= 4096 else { throw InputFailure.oversize }
        }
        throw InputFailure.deadline(count: bytes.count)
    }

    /// The production fixed entry additionally verifies its actual selected-runtime Node parent.
    @discardableResult public static func validateParent(runtime: URL) throws -> ParentProof {
        let pid = getppid()
        let before = try DesktopBackgroundProcessIdentity.information(pid)
        var path = [CChar](repeating: 0, count: 4096)
        guard before.pbi_uid == getuid(), proc_pidpath(pid, &path, UInt32(path.count)) > 0,
              try DesktopCanonicalPath.resolve(String(cString: path)) == runtime.appendingPathComponent("node").path else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        let after = try DesktopBackgroundProcessIdentity.information(pid)
        guard getppid() == pid, before.pbi_start_tvsec == after.pbi_start_tvsec,
              before.pbi_start_tvusec == after.pbi_start_tvusec else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        return .init(runtime: runtime, pid: pid, seconds: before.pbi_start_tvsec, microseconds: before.pbi_start_tvusec)
    }

    private static func validateSocketPair(_ descriptor: Int32, closedInputParent: ParentProof? = nil) throws {
        var type: Int32 = 0, typeBytes = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &typeBytes) == 0, type == SOCK_STREAM else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        var peerDisconnected = false
        for peer in [false, true] {
            var address = sockaddr_un(), count = socklen_t(MemoryLayout<sockaddr_un>.size)
            var failure: Int32 = 0
            let status = withUnsafeMutablePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    let result = peer ? getpeername(descriptor, $0, &count) : getsockname(descriptor, $0, &count)
                    failure = result == 0 ? 0 : errno
                    return result
                }
            }
            // XNU getpeername reports EINVAL after full shutdown, before testing connection.
            // Either candidate still needs the exact disconnected PID/retained credential path below.
            if peer, status != 0, failure == ENOTCONN || failure == EINVAL, closedInputParent != nil {
                peerDisconnected = true
                continue
            }
            let unnamed = withUnsafeBytes(of: address.sun_path) { $0.allSatisfy { $0 == 0 } }
            guard status == 0, address.sun_family == sa_family_t(AF_UNIX), unnamed else {
                throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
            }
        }
        var uid: uid_t = 0, gid: gid_t = 0
        guard getpeereid(descriptor, &uid, &gid) == 0 else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        var peerPID: pid_t = 0, count = socklen_t(MemoryLayout<pid_t>.size)
        let status = getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &count)
        if status == 0 {
            guard !peerDisconnected, count == socklen_t(MemoryLayout<pid_t>.size), peerPID >= 0 else {
                throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
            }
            try validatePeer(uid: uid, pid: peerPID == 0 ? nil : peerPID, parent: getppid())
        } else if errno == ENOTCONN, let expected = closedInputParent {
            // XNU retains LOCAL_PEERCRED after disconnect, but drops the live peer address/PID.
            // This input-only exception composes that credential with a current Node parent and
            // a separately connected output channel; it makes no claim about a former peer name.
            var info = stat()
            guard fstat(descriptor, &info) == 0, info.st_uid == getuid() else {
                throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
            }
            try validatePeer(uid: uid, pid: nil, parent: expected.pid)
            let current = try validateParent(runtime: expected.runtime)
            guard current.pid == expected.pid, current.seconds == expected.seconds,
                  current.microseconds == expected.microseconds else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
            try validatePrivateChannel(STDOUT_FILENO)
        } else {
            guard !peerDisconnected, errno == ENOPROTOOPT || errno == EINVAL || errno == ENOTSUP else {
                throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
            }
            try validatePeer(uid: uid, pid: nil, parent: getppid())
        }
    }

    static func validatePeer(uid: uid_t, pid: pid_t?, parent: pid_t) throws {
        guard uid == getuid(), parent > 1, pid == nil || pid == parent else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
    }

    public static func perform(
        input: Data,
        context: DesktopKeyRecoveryAuthority.Context,
        epoch: String,
        lease: DesktopDataUsageLease
    ) throws
        -> Reply {
        let request = try decode(input, context: context)
        try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch)
        let backend = try SecurityRecoveryStore(context: context, lease: lease) {
            try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch)
        }
        return try perform(request, context: context, epoch: epoch, store: backend.store) {
            try DesktopKeyRecoveryAuthority.validate(context, epoch: epoch)
        }
    }

    static func decode(_ input: Data, context: DesktopKeyRecoveryAuthority.Context) throws -> Request {
        guard !input.isEmpty, input.count <= 4096,
              let object = try JSONSerialization.jsonObject(with: input) as? [String: Any],
              Set(object.keys).isSubset(of: ["version", "operation", "account", "value"]) else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        let request = try JSONDecoder().decode(Request.self, from: input)
        guard request.version == 1 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        if request.operation == "probe" {
            guard object.count == 2 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
            return request
        }
        guard let account = request.account, DesktopDataUsageLease.isKeychainRead(context.scope, account: account) else {
            throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        switch request.operation {
        case "find", "read":
            guard object.count == 3 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        case "insert-root":
            guard object.count == 4, account == "install-root-key-v1", let value = request.value,
                  let bytes = rootBytes(value) else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
            if let restore = context.restore {
                let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
                guard digest == restore.targetKeyDigest else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
            }
        case "repair-marker":
            guard object.count == 4, account != "install-root-key-v1", request.value == "required" else {
                throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
            }
        default: throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
        return request
    }

    static func perform(
        _ request: Request,
        context: DesktopKeyRecoveryAuthority.Context,
        epoch: String,
        store: Store,
        validate: () throws -> Void
    ) throws
        -> Reply {
        try validate()
        if request.operation == "probe" { return success() }
        guard let account = request.account else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        switch request.operation {
        case "find", "read":
            switch store.find(account, request.operation == "read") {
            case .missing: return .init(code: 44, stdout: "", stderr: "Keychain item is absent.")
            case .refused: return refused()
            case .found(let data):
                if request.operation == "find" { return success() }
                guard let data, data.count <= 4096, let value = String(data: data, encoding: .utf8) else { return refused() }
                return .init(code: 0, stdout: value + "\n", stderr: "")
            }
        case "insert-root":
            guard let value = request.value else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
            // Only absent-only insertion is exposed: a concurrent insertion cannot be overwritten.
            switch store.find(account, false) {
            case .missing:
                try validate()
                return try store.add(account, Data(value.utf8)) ? success() : refused()
            case .found, .refused: return refused()
            }
        case "repair-marker":
            let required = Data("required".utf8)
            switch store.find(account, true) {
            case .found(let existing): return existing == required ? success() : refused()
            case .refused: return refused()
            case .missing:
                try validate()
                if try store.add(account, required) { return success() }
                // A racing identical insert is harmless; different/locked remains refused.
                if case .found(let current) = store.find(account, true), current == required { return success() }
                return refused()
            }
        default: throw DesktopKeyRecoveryAuthority.Failure.invalidRequest
        }
    }

    private static func success() -> Reply {
        .init(code: 0, stdout: "", stderr: "")
    }

    private static func refused() -> Reply {
        .init(code: 1, stdout: "", stderr: "Keychain refused recovery. Unlock your Mac and retry.")
    }

    private static func rootBytes(_ value: String) -> Data? {
        let prefix = "omn_root_v1_"
        guard value.hasPrefix(prefix) else { return nil }
        let encoded = String(value.dropFirst(prefix.count))
        guard encoded.utf8.count == 43,
              encoded.utf8
              .allSatisfy({ (48 ... 57).contains($0) || (65 ... 90).contains($0) || (97 ... 122).contains($0) || $0 == 45 || $0 == 95 }),
              let bytes = Data(base64Encoded: encoded.replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/") + "="),
              bytes.count == 32,
              bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
              .replacingOccurrences(
                  of: "=",
                  with: ""
              ) == encoded else { return nil }
        return bytes
    }
}

/// The ordinary User-domain file Keychain, with explicit compatibility for its existing security-tool reader.
/// No Data Protection Keychain, ACL rewrite, delete, update, or user-preference mutation is used.
private final class SecurityRecoveryStore {
    private let keychain: SecKeychain
    private let context: DesktopKeyRecoveryAuthority.Context
    private let lease: DesktopDataUsageLease
    private let validate: () throws -> Void
    init(context: DesktopKeyRecoveryAuthority.Context, lease: DesktopDataUsageLease, validate: @escaping () throws -> Void) throws {
        guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess
        else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        var selected: SecKeychain?
        guard SecKeychainCopyDomainDefault(.user, &selected) == errSecSuccess, let selected else {
            throw DesktopKeyRecoveryAuthority.Failure.keychainRefused
        }
        self.context = context
        self.lease = lease
        self.validate = validate
        keychain = selected
    }

    var store: DesktopKeyRecoveryKeychain.Store {
        .init(find: { [self] in find($0, secret: $1) }, add: { [self] in try add($0, bytes: $1) })
    }

    private func find(_ account: String, secret: Bool) -> DesktopKeyRecoveryKeychain.Lookup {
        do {
            try validate()
            let held = try lease.keyRecoveryDescriptor(scope: context.scope)
            defer { Darwin.close(held) }
            let result = try DesktopKeyRecoveryReadOnly.run(account: account, scope: context.scope, secret: secret, dataDescriptor: held)
            try validate() // A joined physical read cannot publish stale-scope output.
            if result.code == 44 { return .missing }
            guard result.code == 0 else { return .refused }
            return .found(secret ? result.bytes : nil)
        } catch { return .refused }
    }

    private func add(_ account: String, bytes: Data) throws -> Bool {
        var path = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
        var count = UInt32(path.count)
        guard SecKeychainGetPath(keychain, &count, &path) == errSecSuccess,
              count > 0, count < UInt32(path.count), let selectedPath = String(validatingUTF8: path) else { return false }
        try validate()
        let held = try lease.keyRecoveryDescriptor(scope: context.scope)
        defer { Darwin.close(held) }
        let result = try DesktopKeyRecoveryWriteOnly.run(
            account: account, scope: context.scope, value: bytes, keychainPath: selectedPath,
            dataDescriptor: held, validate: validate
        )
        guard result.joined else { throw DesktopKeyRecoveryAuthority.Failure.keychainRefused }
        try validate()
        guard result.success else { return false }
        // A joined CLI success is insufficient unless the ordinary scoped reader confirms it.
        if case .found(let current) = find(account, secret: true) { return current == bytes }
        return false
    }
}
