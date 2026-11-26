// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Metadata only. No executable, cwd, environment, key or permission grant is accepted.
public enum DesktopBackgroundLaunchProtocol {
    public static let frameLimit = 4096
    public enum Failure: Error { case invalidFrame }
    public enum Action: String, Codable,
        Sendable { case hello, ensureDaemon, verifyDaemon, verifyRetirement, releaseOwner, adoptOrigin, recoverOrigin }
    public enum State: String, Codable, Sendable {
        case helperIdle, daemonOwned, lifecycleBlocked, epochMismatch, scopeMismatch, ownerUnavailable, ownerVerified, ownerReleased,
             originRequired, originAttached
    }

    public struct Binding: Codable, Equatable, Sendable {
        public let configDirHash: String
        public let instance: String
        public let secretService: String
        public init(configDirHash: String, instance: String, secretService: String) {
            self.configDirHash = configDirHash
            self.instance = instance
            self.secretService = secretService
        }
    }

    public struct Activation: Codable, Equatable, Sendable {
        public let operationId: String
        public let attemptId: String
        public let epoch: String
        public init(operationId: String, attemptId: String, epoch: String) {
            self.operationId = operationId
            self.attemptId = attemptId
            self.epoch = epoch
        }
    }

    public struct Request: Codable, Equatable, Sendable {
        public let version: Int
        public let requestId: String
        public let nonce: String
        public let action: Action
        public let binding: Binding
        public let expectedEpoch: String
        public let activation: Activation?
        public let owner: DesktopBackgroundDaemonAuthority.Owner?
        public let origin: DesktopBackgroundApplicationOrigin.Record?
        public let handoffNonce: String?
        public init(
            action: Action,
            binding: Binding,
            expectedEpoch: String,
            activation: Activation? = nil,
            owner: DesktopBackgroundDaemonAuthority.Owner? = nil,
            origin: DesktopBackgroundApplicationOrigin.Record? = nil,
            handoffNonce: String? = nil
        ) {
            version = 1
            requestId = UUID().uuidString.lowercased()
            nonce = UUID().uuidString.lowercased()
            self.action = action
            self.binding = binding
            self.expectedEpoch = expectedEpoch
            self.activation = activation
            self.owner = owner
            self.origin = origin
            self.handoffNonce = handoffNonce
        }
    }

    public struct Reply: Codable, Equatable, Sendable {
        public let version: Int
        public let requestId: String
        public let nonce: String
        public let binding: Binding
        public let epoch: String
        public let state: State
        public let daemonPid: Int32?
        public let origin: DesktopBackgroundApplicationOrigin.Record?
        public let applicationOwnership: DesktopBackgroundApplicationOrigin.Evidence?
        public let originStatus: DesktopBackgroundOriginStatus?
        public init(
            request: Request,
            binding: Binding? = nil,
            epoch: String,
            state: State,
            daemonPid: Int32? = nil,
            origin: DesktopBackgroundApplicationOrigin.Record? = nil,
            applicationOwnership: DesktopBackgroundApplicationOrigin.Evidence? = nil,
            originStatus: DesktopBackgroundOriginStatus? = nil
        ) {
            version = 1
            requestId = request.requestId
            nonce = request.nonce
            self.binding = binding ?? request.binding
            self.epoch = epoch
            self.state = state
            self.daemonPid = daemonPid
            self.origin = origin
            self.applicationOwnership = applicationOwnership
            self.originStatus = originStatus
        }
    }

    public static func decodeRequest(_ data: Data) throws -> Request {
        let object = try object(data)
        try keys(
            object,
            required: ["version", "requestId", "nonce", "action", "binding", "expectedEpoch"],
            optional: ["activation", "owner", "origin", "handoffNonce"]
        )
        try validateBinding(object["binding"])
        if let activation = object["activation"] {
            guard let value = activation as? [String: Any] else { throw Failure.invalidFrame }
            try keys(value, required: ["operationId", "attemptId", "epoch"])
        }
        if let owner = object["owner"] {
            guard let owner = owner as? [String: Any], let scope = owner["scope"] as? [String: Any],
                  let pipe = owner["pipe"] as? [String: Any] else { throw Failure.invalidFrame }
            try keys(owner, required: ["format", "scope", "epoch", "nonce", "helperPid", "daemonPid", "pipe"])
            try keys(scope, required: ["format", "configDir", "instance", "secretService"])
            try keys(pipe, required: ["device", "inode"])
        }
        if let origin = object["origin"] { try validateOrigin(origin) }
        let request = try JSONDecoder().decode(Request.self, from: data)
        guard request.version == 1, uuid(request.requestId), uuid(request.nonce),
              digest(request.expectedEpoch) else { throw Failure.invalidFrame }
        if let activation = request.activation {
            guard request.action == .ensureDaemon, uuid(activation.operationId), uuid(activation.attemptId),
                  activation.epoch == request.expectedEpoch else { throw Failure.invalidFrame }
        }
        let adopting = request.action == .adoptOrigin
        guard adopting == (request.origin != nil), adopting == (request.handoffNonce != nil) else { throw Failure.invalidFrame }
        if adopting {
            guard request.activation == nil, let nonce = request.handoffNonce, uuid(nonce) else { throw Failure.invalidFrame }
        }
        let verifying = request.action == .verifyDaemon || request.action == .verifyRetirement
        guard verifying == (request.owner != nil), !verifying || request.activation == nil else { throw Failure.invalidFrame }
        if let owner = request.owner {
            guard owner.format == 1, owner.scope.format == 1, owner.helperPid > 0, owner.daemonPid > 0,
                  uuid(owner.nonce), owner.epoch == request.expectedEpoch,
                  owner.scope.instance == request.binding.instance,
                  owner.scope.secretService == request.binding.secretService else { throw Failure.invalidFrame }
        }
        return request
    }

    public static func decodeReply(_ data: Data, request: Request) throws -> Reply {
        let object = try object(data)
        try keys(
            object,
            required: ["version", "requestId", "nonce", "binding", "epoch", "state"],
            optional: ["daemonPid", "origin", "applicationOwnership", "originStatus"]
        )
        try validateBinding(object["binding"])
        if let origin = object["origin"] { try validateOrigin(origin) }
        if let status = object["originStatus"] { try DesktopBackgroundOriginStatus.validate(status) }
        if let ownership = object["applicationOwnership"] {
            guard let ownership = ownership as? [String: Any] else { throw Failure.invalidFrame }
            try keys(
                ownership,
                required: ["state", "codeEpoch", "presentation", "installation"],
                optional: ["originEpoch", "installationId"]
            )
        }
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        guard !([State.epochMismatch, .scopeMismatch].contains(reply.state) && request.action != .hello),
              reply.state != .ownerVerified || request.action == .verifyDaemon || request.action == .verifyRetirement,
              reply.state != .ownerReleased || request.action == .releaseOwner || request.action == .recoverOrigin,
              reply.origin == nil || ([Action.releaseOwner, .recoverOrigin].contains(request.action) && reply.state == .ownerReleased),
              reply.applicationOwnership == nil || reply.applicationOwnership?.codeEpoch == reply.epoch,
              reply.applicationOwnership?.installationId == nil || reply.applicationOwnership?.installationId == reply.binding.instance,
              reply.state != .originAttached || request.action == .adoptOrigin,
              reply.version == 1, reply.requestId == request.requestId, reply.nonce == request.nonce,
              digest(reply.epoch),
              (reply.state == .epochMismatch || reply.state == .scopeMismatch) && request.action == .hello
              ? reply.binding.configDirHash == request.binding.configDirHash
              : reply.binding == request.binding && reply.epoch == request.expectedEpoch,
              reply.state == .daemonOwned ? (reply.daemonPid ?? 0) > 0 : reply.daemonPid == nil else { throw Failure.invalidFrame }
        return reply
    }

    public static func encode(_ value: some Encodable) throws -> Data {
        let data = try JSONEncoder().encode(value)
        guard data.count <= frameLimit else { throw Failure.invalidFrame }
        return data
    }

    private static func object(_ data: Data) throws -> [String: Any] {
        guard !data.isEmpty, data.count <= frameLimit,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.invalidFrame }
        return result
    }

    private static func keys(_ value: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        let actual = Set(value.keys)
        guard required.isSubset(of: actual), actual.isSubset(of: required.union(optional)) else { throw Failure.invalidFrame }
    }

    private static func validateOrigin(_ value: Any) throws {
        guard let value = value as? [String: Any] else { throw Failure.invalidFrame }
        try keys(value, required: ["version", "referenceURL", "device", "inode", "observedEpoch", "revision"])
    }

    private static func validateBinding(_ value: Any?) throws {
        guard let value = value as? [String: Any] else { throw Failure.invalidFrame }
        try keys(value, required: ["configDirHash", "instance", "secretService"])
        guard let hash = value["configDirHash"] as? String, digest(hash),
              let instance = value["instance"] as? String, instance.hasPrefix("desktop-"),
              digest(String(instance.dropFirst(8)), count: 16),
              let service = value["secretService"] as? String, service.hasPrefix("dev.omnesis.desktop."),
              digest(String(service.dropFirst(20))) else { throw Failure.invalidFrame }
    }

    private static func uuid(_ value: String) -> Bool {
        value == value.lowercased() && UUID(uuidString: value) != nil
    }

    private static func digest(_ value: String, count: Int = 64) -> Bool {
        value.count == count && value.utf8.allSatisfy { (48 ... 57).contains($0) || (97 ... 102).contains($0) }
    }
}
