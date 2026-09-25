// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What a phone must establish before it asks the operating system for access
/// to a device-hosted source. This is source-agnostic: the descriptor's mode
/// decides whether two devices are redundant views, independent partitions,
/// or mutually exclusive hosts.
public enum MobileSourceActivationPlan: Equatable, Sendable {
    case ready
    case join
    case addPartition
    case choose(SourceMultiDeviceMode)
    case incompatible(current: SourceMultiDeviceMode, desired: SourceMultiDeviceMode)
}

public enum MobileSourceActivationChoice: Equatable, Sendable {
    case keepOther
    case useBoth
    case takeOver
}

public enum MobileSourceActivationOutcome: Equatable, Sendable {
    case ready
    case keptOther
    case choiceRequired(SourceMultiDeviceMode)
    case incompatible(current: SourceMultiDeviceMode, desired: SourceMultiDeviceMode)
}

/// How much of a source's data the operating system lets this device read.
public enum MobileSourceGrant: Equatable, Sendable {
    /// Everything the source reads, including while Omnesis is closed.
    case full
    /// Only a subset the user picked, such as selected photos.
    case limited
    /// Only while Omnesis is open, such as location While Using the App.
    case foregroundOnly
}

/// Where a source's operating-system permission request settled.
public enum MobileSourceAuthorization: Equatable, Sendable {
    case granted(MobileSourceGrant)
    case notAllowed
    case unavailable(reason: String)
    /// The request itself could not run; nothing was decided.
    case failed(message: String?)
}

/// A source's own work around the shared activation path: asking the
/// operating system for access, switching the source on locally, and anything
/// that has to wait for the rebuilt collector.
public struct MobileSourceActivationSteps {
    public let authorize: @MainActor () async -> MobileSourceAuthorization
    public let activate: @MainActor () async -> Void
    public let afterActivation: @MainActor () async -> Void

    public init(
        authorize: @escaping @MainActor () async -> MobileSourceAuthorization,
        activate: @escaping @MainActor () async -> Void,
        afterActivation: @escaping @MainActor () async -> Void = {}
    ) {
        self.authorize = authorize
        self.activate = activate
        self.afterActivation = afterActivation
    }
}

/// The result of turning on one phone-hosted source.
public enum MobileSourceEnableResult: Equatable, Sendable {
    case enabled(MobileSourceGrant)
    /// The operating system refused access, so nothing was changed.
    case notAllowed
    /// This device cannot provide the source.
    case unavailable(reason: String)
    /// The user chose to leave the source with the device that hosts it.
    case keptOther
    case choiceRequired(SourceMultiDeviceMode)
    /// Something else stopped the change; `message` is readable copy when known.
    case failed(message: String?)
}

public struct MobileSourceActivationOperations: Sendable {
    public let setMode: @Sendable (String, SourceMultiDeviceMode) async throws -> Void
    public let join: @Sendable (String, String) async throws -> Void
    public let transfer: @Sendable (String, String) async throws -> Void

    public init(
        setMode: @escaping @Sendable (String, SourceMultiDeviceMode) async throws -> Void,
        join: @escaping @Sendable (String, String) async throws -> Void,
        transfer: @escaping @Sendable (String, String) async throws -> Void
    ) {
        self.setMode = setMode
        self.join = join
        self.transfer = transfer
    }
}

public enum MobileSourceActivationError: LocalizedError, Equatable, Sendable {
    case invalidChoice(MobileSourceActivationChoice, SourceMultiDeviceMode)
    case notContributing
    case incompatibleMode(SourceMultiDeviceMode, SourceMultiDeviceMode)
    /// Another device changed who hosts the source while this one was
    /// activating it.
    case hostChanged

    public var errorDescription: String? {
        switch self {
        case .hostChanged:
            "Another device started sending this source. Try again to choose how this iPhone contributes."
        case .invalidChoice(let choice, let mode):
            "The \(choice) choice is not valid for a \(mode.rawValue) source."
        case .notContributing:
            "This device is not contributing to this source. Enable it before syncing."
        case .incompatibleMode(let current, let desired):
            "This source uses \(current.rawValue) mode; this device requires \(desired.rawValue) mode."
        }
    }
}

public enum MobileSourceActivation {
    public static func plan(
        source: SourceRecord?,
        deviceId: String,
        desiredMode: SourceMultiDeviceMode
    )
        -> MobileSourceActivationPlan {
        guard let source else { return .ready }
        let currentMode = SourceMultiDeviceMode(rawValue: source.multiDeviceMode ?? "exclusive")
            ?? .exclusive
        if currentMode == .exclusive, desiredMode == .partitioned { return .addPartition }
        if desiredMode == .partitioned, currentMode != desiredMode {
            return .incompatible(current: currentMode, desired: desiredMode)
        }
        if source.hosts(deviceId) { return .ready }
        if currentMode == desiredMode {
            return currentMode == .exclusive ? .choose(.exclusive) : .join
        }
        if currentMode == .exclusive {
            return desiredMode == .partitioned ? .addPartition : .choose(desiredMode)
        }
        return .incompatible(current: currentMode, desired: desiredMode)
    }

    /// Prepare an already-enabled independent stream before reading its
    /// cursor. Only an existing host may adopt legacy shared history here;
    /// ordinary background sync never rejoins a detached phone or unpauses a
    /// source. The explicit mode request must finish before any data is read.
    public static func prepareHostedPartition(
        source: SourceRecord?,
        deviceId: String,
        setMode: @Sendable (String, SourceMultiDeviceMode) async throws -> Void
    ) async throws {
        guard let source, source.hosts(deviceId) else {
            throw MobileSourceActivationError.notContributing
        }
        let currentMode = SourceMultiDeviceMode(rawValue: source.multiDeviceMode ?? "exclusive") ?? .exclusive
        switch currentMode {
        case .partitioned: return
        case .exclusive: try await setMode(source.id, .partitioned)
        case .replicated: throw MobileSourceActivationError.incompatibleMode(currentMode, .partitioned)
        }
    }

    /// Only explicit activation may create a registration. A background
    /// refresh using a stale live row could otherwise clear a newer tombstone.
    public static func mayCreateRegistration(
        source: SourceRecord?,
        deviceId: String,
        sourceId: String? = nil,
        allowCreationFor: String? = nil
    )
        -> Bool {
        guard let requestedId = sourceId ?? source?.id, requestedId == allowCreationFor else { return false }
        return source.map { $0.hosts(deviceId) } ?? true
    }

    /// Resolve the user-visible decision without mutating gateway ownership.
    /// Protected-data authorization can safely happen after this returns
    /// `.ready`; callers commit with `execute` only after the OS grant.
    public static func inspect(
        source: SourceRecord?,
        deviceId: String,
        desiredMode: SourceMultiDeviceMode,
        choice: MobileSourceActivationChoice? = nil
    ) throws
        -> MobileSourceActivationOutcome {
        let activationPlan = plan(source: source, deviceId: deviceId, desiredMode: desiredMode)
        switch activationPlan {
        case .ready, .join, .addPartition:
            return .ready
        case .incompatible(let current, let desired):
            return .incompatible(current: current, desired: desired)
        case .choose(let currentMode):
            guard let choice else { return .choiceRequired(currentMode) }
            switch choice {
            case .keepOther:
                return .keptOther
            case .useBoth:
                guard desiredMode != .exclusive, currentMode == desiredMode else {
                    throw MobileSourceActivationError.invalidChoice(choice, currentMode)
                }
                return .ready
            case .takeOver:
                let persistedMode = SourceMultiDeviceMode(
                    rawValue: source?.multiDeviceMode ?? "exclusive"
                ) ?? .exclusive
                guard persistedMode == .exclusive else {
                    throw MobileSourceActivationError.invalidChoice(choice, persistedMode)
                }
                return .ready
            }
        }
    }

    public static func execute(
        source: SourceRecord?,
        deviceId: String,
        desiredMode: SourceMultiDeviceMode,
        choice: MobileSourceActivationChoice? = nil,
        operations: MobileSourceActivationOperations
    ) async throws
        -> MobileSourceActivationOutcome {
        let activationPlan = plan(source: source, deviceId: deviceId, desiredMode: desiredMode)
        guard let source else { return .ready }

        switch activationPlan {
        case .ready:
            return .ready
        case .join:
            try await operations.join(source.id, deviceId)
            return .ready
        case .addPartition:
            try await operations.setMode(source.id, .partitioned)
            try await operations.join(source.id, deviceId)
            return .ready
        case .incompatible(let current, let desired):
            return .incompatible(current: current, desired: desired)
        case .choose(let currentMode):
            guard let choice else { return .choiceRequired(currentMode) }
            switch choice {
            case .keepOther:
                return .keptOther
            case .useBoth:
                guard desiredMode != .exclusive, currentMode == desiredMode else {
                    throw MobileSourceActivationError.invalidChoice(choice, currentMode)
                }
                try await operations.setMode(source.id, desiredMode)
                try await operations.join(source.id, deviceId)
                return .ready
            case .takeOver:
                let persistedMode = SourceMultiDeviceMode(rawValue: source.multiDeviceMode ?? "exclusive")
                    ?? .exclusive
                guard persistedMode == .exclusive else {
                    throw MobileSourceActivationError.invalidChoice(choice, persistedMode)
                }
                try await operations.transfer(source.id, deviceId)
                return .ready
            }
        }
    }
}
