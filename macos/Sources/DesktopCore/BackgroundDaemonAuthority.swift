// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Fixed native entry points. A descriptor is a correlation hint, never proof by itself.
public enum DesktopBackgroundDaemonAuthority {
    public struct Scope: Codable, Equatable, Sendable {
        public let format: Int
        public let configDir: String
        public let instance: String
        public let secretService: String
        public init(format: Int = 1, configDir: String, instance: String, secretService: String) {
            self.format = format
            self.configDir = configDir
            self.instance = instance
            self.secretService = secretService
        }

        public var dataScope: DesktopDataUsageLease.Scope {
            .init(configDir: configDir, instance: instance, secretService: secretService)
        }
    }

    public struct Descriptor: Codable, Equatable, Sendable {
        public let version: Int
        public let scope: Scope
        public let epoch: String
        public let activation: DesktopBackgroundLaunchProtocol.Activation?
        public let nonce: String?
    }

    public struct PipeIdentity: Codable, Equatable, Sendable { public let device: String
        public let inode: String
    }

    public struct Owner: Codable, Equatable, Sendable {
        public let format: Int
        public let scope: Scope
        public let epoch: String
        public let nonce: String
        public let helperPid: Int32
        public let daemonPid: Int32
        public let pipe: PipeIdentity
    }

    /// The helper chooses its own verified runtime and the private launch nonce.
    public static func descriptor(
        profile: DesktopBackgroundManagedProfile,
        epoch: String,
        activation: DesktopBackgroundLaunchProtocol.Activation?
    ) throws
        -> String {
        let value = Descriptor(
            version: 1,
            scope: .init(format: 1, configDir: profile.configDir, instance: profile.instance, secretService: profile.secretService),
            epoch: epoch,
            activation: activation,
            nonce: UUID().uuidString.lowercased()
        )
        return try encoded(value)
    }

    public static func decode(_ encoded: String, requiresNonce: Bool) throws -> Descriptor {
        let bytes = try bytes(encoded)
        let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        guard let object, Set(object.keys).isSubset(of: ["version", "scope", "epoch", "activation", "nonce"]),
              let scope = object["scope"] as? [String: Any],
              Set(scope.keys) == ["format", "configDir", "instance", "secretService"]
        else { throw DesktopDataUsageLease.Failure.invalidScope }
        let value = try JSONDecoder().decode(Descriptor.self, from: bytes)
        guard value.version == 1, value.scope.format == 1, digest(value.epoch),
              value.scope.configDir.hasPrefix("/"), !value.scope.configDir.utf8.contains(0),
              requiresNonce ? uuid(value.nonce) : value.nonce == nil else { throw DesktopDataUsageLease.Failure.invalidScope }
        if let activation = value.activation {
            guard uuid(activation.operationId), uuid(activation.attemptId),
                  activation.epoch == value.epoch else { throw DesktopDataUsageLease.Failure.invalidScope }
        }
        return value
    }

    /// Run only as the actual signed helper's direct child. It stays DATA-free.
    public static func invocation(
        encoded: String,
        runtime: URL,
        lease: DesktopRuntimeUsageLease,
        environment: [String: String],
        retirement: Bool = false
    ) throws
        -> DesktopRuntimeUsageLease.Invocation {
        guard lease.requiresDataUsage,
              environment["OMNESIS_DESKTOP_DATA_CONTEXT"] == nil else { throw DesktopDataUsageLease.Failure.missingAuthority }
        let descriptor = try decode(encoded, requiresNonce: true)
        let profile = try DesktopBackgroundManagedProfile.matching(descriptor.scope.dataScope)
        try profile.validateIdentity()
        guard descriptor.epoch == runtime.lastPathComponent else { throw DesktopDataUsageLease.Failure.blocked }
        if retirement {
            guard descriptor.activation == nil else { throw DesktopDataUsageLease.Failure.invalidScope }
        } else {
            guard try profile.configured() else { throw DesktopDataUsageLease.Failure.blocked }
        }
        let parent = try DesktopBackgroundPeerTrust.helperParent()
        guard let nonce = descriptor.nonce else { throw DesktopDataUsageLease.Failure.invalidScope }
        let owner = try Owner(
            format: 1,
            scope: descriptor.scope,
            epoch: descriptor.epoch,
            nonce: nonce,
            helperPid: parent.pid,
            daemonPid: getpid(),
            pipe: pipeIdentity()
        )
        let script = runtime.appendingPathComponent("packages/cli/dist/index.js").path
        var arguments = ["--node", script, "desktop", retirement ? "system-retire" : "daemon", "--background-owner"]
        if let activation = descriptor.activation {
            let data = try JSONEncoder().encode(activation)
            guard let json = String(data: data, encoding: .utf8) else { throw DesktopDataUsageLease.Failure.invalidScope }
            arguments += ["--restore-start", json]
        }
        let base = try lease.invocation(arguments: arguments)
        guard base.arguments.count >= 3, base.arguments[1] == "--import",
              var preload = URLComponents(string: base.arguments[2]),
              preload.query == nil else { throw DesktopRuntimeUsageLease.Failure.invalidPayload }
        preload.queryItems = try [URLQueryItem(name: retirement ? "background-retirement" : "background-owner", value: self.encoded(owner))]
        guard let url = preload.string else { throw DesktopDataUsageLease.Failure.invalidScope }
        var selected = base.arguments
        selected[2] = url
        return DesktopRuntimeUsageLease.Invocation(executable: base.executable, arguments: selected)
    }

    /// A separate native process checks the real calling Node process and its real parent.
    /// FD0 must be inherited by the verifier; JSON cannot manufacture that signed parent.
    public static func verifyOwner(_ encoded: String, runtime: URL, environment: [String: String], retirement: Bool = false) throws {
        guard environment["OMNESIS_DESKTOP_DATA_CONTEXT"] == nil else { throw DesktopDataUsageLease.Failure.missingAuthority }
        let data = try bytes(encoded)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["format", "scope", "epoch", "nonce", "helperPid", "daemonPid", "pipe"],
              let scope = object["scope"] as? [String: Any], Set(scope.keys) == ["format", "configDir", "instance", "secretService"],
              let pipe = object["pipe"] as? [String: Any],
              Set(pipe.keys) == ["device", "inode"] else { throw DesktopDataUsageLease.Failure.invalidScope }
        let owner = try JSONDecoder().decode(Owner.self, from: data)
        guard owner.format == 1, owner.scope.format == 1, owner.epoch == runtime.lastPathComponent,
              uuid(owner.nonce), owner.daemonPid == getppid(), owner.helperPid > 0,
              try pipeIdentity() == owner.pipe else { throw DesktopDataUsageLease.Failure.missingAuthority }
        let before = try DesktopBackgroundProcessIdentity.information(owner.daemonPid)
        var executable = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(owner.daemonPid, &executable, UInt32(executable.count)) > 0,
              try DesktopCanonicalPath.resolve(String(cString: executable)) == runtime.appendingPathComponent("node").path else {
            throw DesktopDataUsageLease.Failure.missingAuthority
        }
        guard before.pbi_ppid == UInt32(owner.helperPid) else { throw DesktopDataUsageLease.Failure.missingAuthority }
        _ = try DesktopBackgroundPeerTrust.helper(pid: owner.helperPid)
        let profile = try DesktopBackgroundManagedProfile.matching(owner.scope.dataScope)
        try profile.validateIdentity()
        let request = DesktopBackgroundLaunchProtocol.Request(
            action: retirement ? .verifyRetirement : .verifyDaemon, binding: profile.binding,
            expectedEpoch: owner.epoch, owner: owner
        )
        let acknowledgement = try DesktopBackgroundControlClient.exchange(request, expectedPID: owner.helperPid)
        guard acknowledgement.state == .ownerVerified else { throw DesktopDataUsageLease.Failure.missingAuthority }
        let after = try DesktopBackgroundProcessIdentity.information(owner.daemonPid)
        guard after.pbi_ppid == before.pbi_ppid, after.pbi_start_tvsec == before.pbi_start_tvsec,
              after.pbi_start_tvusec == before.pbi_start_tvusec else { throw DesktopDataUsageLease.Failure.missingAuthority }
    }

    private static func pipeIdentity() throws -> PipeIdentity {
        var value = stat()
        guard fstat(STDIN_FILENO, &value) == 0,
              value.st_mode & S_IFMT == S_IFIFO else { throw DesktopDataUsageLease.Failure.missingAuthority }
        return .init(device: String(UInt64(bitPattern: Int64(value.st_dev))), inode: String(value.st_ino))
    }

    private static func bytes(_ value: String) throws -> Data {
        guard !value.isEmpty, value.utf8.count <= 8192, !value.contains("="),
              let decoded = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/") + String(
                      repeating: "=",
                      count: (4 - value.count % 4) % 4
                  )),
              decoded.count <= 4096, base64(decoded) == value else { throw DesktopDataUsageLease.Failure.invalidScope }
        return decoded
    }

    private static func encoded(_ value: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(value)
        guard data.count <= 4096 else { throw DesktopDataUsageLease.Failure.invalidScope }
        return base64(data)
    }

    private static func base64(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(
                of: "/",
                with: "_"
            ).replacingOccurrences(of: "=", with: "")
    }

    private static func uuid(_ value: String?) -> Bool {
        value.map { $0 == $0.lowercased() && UUID(uuidString: $0) != nil } ?? false
    }

    private static func digest(_ value: String) -> Bool {
        value.count == 64 && value.utf8
            .allSatisfy { (48 ... 57).contains($0) || (97 ... 102).contains($0) }
    }
}
