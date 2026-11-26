// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Darwin
import Foundation

/// Portable lifecycle policy authorizes this operation. Native code only drains and replaces a verified owner.
public enum DesktopBackgroundRebind {
    public struct Birth: Codable, Equatable, Sendable {
        public let seconds: String
        public let microseconds: String
    }

    public struct Observation: Codable, Equatable, Sendable {
        public let version: Int
        public let scope: DesktopBackgroundDaemonAuthority.Scope
        public let epoch: String
        public let pid: Int32
        public let birth: Birth
        public let origin: DesktopBackgroundOriginStatus
    }

    public struct Selection: Sendable {
        public let target: DesktopBackgroundDaemonAuthority.Descriptor
        public let expected: Observation?
    }

    public static func decode(_ encoded: String, replacing: Bool) throws -> Selection {
        guard encoded.count <= 8192, !encoded.contains("="),
              let bytes = Data(base64Encoded: encoded.replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/") + String(
                      repeating: "=",
                      count: (4 - encoded.count % 4) % 4
                  )),
              bytes.count <= 4096, base64(bytes) == encoded,
              var object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == (replacing ? ["version", "scope", "epoch", "expected"] : ["version", "scope", "epoch"])
        else { throw DesktopDataUsageLease.Failure.invalidScope }
        let expected: Observation?
        if replacing {
            guard let value = object.removeValue(forKey: "expected") as? [String: Any], Set(value.keys) == [
                "scope",
                "epoch",
                "pid",
                "birth", "origin",
            ],
                let birth = value["birth"] as? [String: Any], Set(birth.keys) == ["seconds", "microseconds"],
                let scope = value["scope"] as? [String: Any],
                Set(scope.keys) == ["format", "configDir", "instance", "secretService"] else {
                throw DesktopDataUsageLease.Failure.invalidScope
            }
            try DesktopBackgroundOriginStatus.validate(value["origin"])
            var complete = value
            complete["version"] = 1
            expected = try JSONDecoder().decode(Observation.self, from: JSONSerialization.data(withJSONObject: complete))
        } else { expected = nil }
        let target = try DesktopBackgroundDaemonAuthority.decode(
            base64(JSONSerialization.data(withJSONObject: object)),
            requiresNonce: false
        )
        if let expected {
            let binding = DesktopBackgroundLaunchProtocol.Binding(
                configDirHash: String(repeating: "a", count: 64),
                instance: expected.scope.instance,
                secretService: expected.scope.secretService
            )
            _ = try DesktopBackgroundLaunchProtocol
                .decodeRequest(DesktopBackgroundLaunchProtocol.encode(DesktopBackgroundLaunchProtocol.Request(
                    action: .hello,
                    binding: binding,
                    expectedEpoch: expected.epoch
                )))
            guard expected.scope.format == 1, expected.scope.configDir == target.scope.configDir,
                  expected.pid > 1, canonicalDecimal(expected.birth.seconds), canonicalDecimal(expected.birth.microseconds),
                  let microseconds = UInt64(expected.birth.microseconds),
                  microseconds < 1_000_000 else { throw DesktopDataUsageLease.Failure.invalidScope }
        }
        return .init(target: target, expected: expected)
    }

    public static func query(_ target: DesktopBackgroundDaemonAuthority.Descriptor, runtime: URL) throws -> Observation {
        let profile = try DesktopBackgroundManagedProfile.matching(target.scope.dataScope)
        try profile.validateIdentity()
        guard target.epoch == runtime.lastPathComponent, target.activation == nil,
              target.nonce == nil else { throw DesktopDataUsageLease.Failure.invalidScope }
        let request = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: profile.binding, expectedEpoch: target.epoch)
        let actual = try DesktopBackgroundControlClient.observation(request)
        guard let origin = actual.reply.originStatus else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
        return .init(
            version: 1,
            scope: .init(
                format: 1,
                configDir: profile.configDir,
                instance: actual.reply.binding.instance,
                secretService: actual.reply.binding.secretService
            ),
            epoch: actual.reply.epoch,
            pid: actual.pid,
            birth: .init(seconds: String(actual.identity.startedSeconds), microseconds: String(actual.identity.startedMicroseconds)),
            origin: origin
        )
    }

    @MainActor
    public static func perform(_ selected: Selection, runtime: URL) async throws {
        guard let expected = selected.expected,
              try query(selected.target, runtime: runtime) == expected else { throw DesktopDataUsageLease.Failure.blocked }
        let identity = try DesktopBackgroundProcessIdentity.read(expected.pid)
        guard expected.birth.seconds == String(identity.startedSeconds),
              expected.birth.microseconds == String(identity.startedMicroseconds) else { throw DesktopDataUsageLease.Failure.blocked }
        let profile = try DesktopBackgroundManagedProfile.matching(selected.target.scope.dataScope)
        // Prefer a newly selected actual installed Main; a retained rollback keeps the old origin.
        let installed = try DesktopBackgroundApplicationOrigin.currentInstalledMain(runtime: runtime)
        if expected.origin.state != .verified {
            guard installed != nil else { throw DesktopBackgroundApplicationOrigin.Failure.retainedApplication }
            if let client = expected.origin.client, !client.isGone() { throw DesktopDataUsageLease.Failure.inUse }
        }
        let same = expected.scope == selected.target.scope && expected.epoch == selected.target.epoch
        let repair = same && expected.origin.state != .verified
        let old = DesktopBackgroundLaunchProtocol.Binding(
            configDirHash: profile.binding.configDirHash,
            instance: expected.scope.instance,
            secretService: expected.scope.secretService
        )
        let request = DesktopBackgroundLaunchProtocol.Request(
            action: repair ? .recoverOrigin : .releaseOwner,
            binding: old,
            expectedEpoch: expected.epoch
        )
        let released = try await Task.detached(priority: .utility) {
            try DesktopBackgroundControlClient.exchange(request, expectedPID: expected.pid, expectedIdentity: identity)
        }.value
        guard released.state == .ownerReleased else { throw DesktopDataUsageLease.Failure.blocked }
        let deadline = ContinuousClock.now.advanced(by: .seconds(85))
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            if !sameLiveProcess(identity) { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard !sameLiveProcess(identity) else { throw DesktopDataUsageLease.Failure.blocked }
        guard let origin = installed ?? released.origin else { throw DesktopBackgroundApplicationOrigin.Failure.unavailable }
        let application: URL
        if let installed {
            application = try DesktopBackgroundApplicationOrigin.resolve(installed)
        } else {
            let directory = DesktopApplicationArchive.defaultRoot.appendingPathComponent(selected.target.epoch)
            application = directory.appendingPathComponent("Omnesis.app")
            _ = try DesktopApplicationArchiveOwnership.verified(directory: directory, epoch: selected.target.epoch)
            try DesktopRuntimeBootstrap.validateApplication(application)
            guard try DesktopApplicationArchive.runtimeEpoch(application) == selected.target.epoch
            else { throw DesktopRuntimeUsageLease.Failure.invalidPayload }
        }
        let handoff = try DesktopBackgroundOriginHandoff.current(scope: selected.target.scope, epoch: selected.target.epoch)
        let opened = try await DesktopBackgroundObserver.openHelper(
            appBundle: application,
            arguments: ["--origin-handoff", handoff.encoded()]
        )
        let newPID = opened.processIdentifier
        let newIdentity = try DesktopBackgroundProcessIdentity.read(newPID)
        let attach = DesktopBackgroundLaunchProtocol.Request(
            action: .adoptOrigin,
            binding: profile.binding,
            expectedEpoch: selected.target.epoch,
            origin: origin,
            handoffNonce: handoff.nonce
        )
        let adopted = try await Task.detached(priority: .utility) {
            try DesktopBackgroundControlClient.exchange(attach, expectedPID: newPID, expectedIdentity: newIdentity)
        }.value
        guard adopted.state == .originAttached,
              adopted.applicationOwnership?.state == .verified else { throw DesktopBackgroundApplicationOrigin.Failure.unavailable }
        try await DesktopBackgroundObserver.ensureRunning(appBundle: application, runtime: runtime)
    }

    private static func sameLiveProcess(_ expected: DesktopBackgroundProcessIdentity) -> Bool {
        if let current = try? DesktopBackgroundProcessIdentity.read(expected.pid) { return current == expected }
        // Permission/inspection failure is not absence. ESRCH is the only release proof here.
        return Darwin.kill(expected.pid, 0) == 0 || errno != ESRCH
    }

    private static func canonicalDecimal(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 20 && value.utf8.allSatisfy { (48 ... 57).contains($0) } && UInt64(value)
            .map { String($0) == value } == true
    }

    private static func base64(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(
            of: "=",
            with: ""
        )
    }
}
