// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum DesktopPhase: String, Codable, Sendable {
    case welcome, accountRequired, chooseHome, preparing, ready, waiting, error
}

public struct DesktopConnection: Codable, Equatable, Sendable {
    public let url: URL
    public let token: String
    public let deviceId: String?
    public let collectorDeviceId: String?
    public let certificatePEM: String?
}

public struct DesktopState: Codable, Equatable, Sendable {
    public let phase: DesktopPhase
    public let mode: String?
    public let message: String?
    public let connection: DesktopConnection?
    public let homeName: String?
    public let encrypted: Bool?
    public let signup: Signup?
    public let searchModel: SearchModel?
    public let retired: Bool?
    public let retirement: Retirement?
    public let installationId: String?
    public let storageAdmission: DesktopServiceAdmission?
    public let remoteRoute: DesktopServiceAdmission?
    /// Optional display evidence. Unknown future values cannot alter library authorization.
    public let nearby: String?

    public struct Signup: Codable, Equatable, Sendable {
        public let policy: String?
        public let acmeTermsUrl: URL?
    }

    public struct Retirement: Codable, Equatable, Sendable {
        public let mode: String
        public let phase: String
    }

    public struct SearchModel: Codable, Equatable, Sendable {
        public let state: String
        public let downloadedBytes: Int64?
        public let totalBytes: Int64?
    }

    public init(
        phase: DesktopPhase,
        mode: String? = nil,
        message: String? = nil,
        connection: DesktopConnection? = nil,
        homeName: String? = nil,
        encrypted: Bool? = nil,
        signup: Signup? = nil,
        searchModel: SearchModel? = nil,
        retired: Bool? = nil,
        retirement: Retirement? = nil,
        installationId: String? = nil,
        storageAdmission: DesktopServiceAdmission? = nil,
        remoteRoute: DesktopServiceAdmission? = nil,
        nearby: String? = nil
    ) {
        self.phase = phase
        self.mode = mode
        self.message = message
        self.connection = connection
        self.homeName = homeName
        self.encrypted = encrypted
        self.signup = signup
        self.searchModel = searchModel
        self.retired = retired
        self.retirement = retirement
        self.installationId = installationId
        self.storageAdmission = storageAdmission
        self.remoteRoute = remoteRoute
        self.nearby = nearby
    }

    /// Opening a library requires verified protection for this Mac and its library home.
    public var canOpenLibrary: Bool {
        retired != true && phase == .ready && connection != nil && encrypted == true && ["home", "joined"].contains(mode ?? "")
    }

    public var statusLabel: String {
        if retired == true { return "Omnesis is stopped" }
        return switch phase {
        case .welcome: "Welcome to Omnesis"
        case .accountRequired: "Connect your Omnesis account"
        case .chooseHome: "Choose where your library lives"
        case .preparing: "Preparing your private library"
        case .ready: canOpenLibrary ? "Connected" : "Checking your library’s protection"
        case .waiting: waitingForLocalLibrary ? "Starting your library" : "Waiting to connect"
        case .error: "Omnesis needs your attention"
        }
    }
}

public struct RuntimeInteraction: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let url: URL?
    public let choices: [Choice]?
    public let code: String?
    public let role: String?
    public let message: String?
    /// Typed platform interactions retain their complete payload without logging it.
    public let payload: [String: BridgeValue]

    private enum CodingKeys: String, CodingKey { case id, kind, url, choices, code, role, message }
    public init(from decoder: Decoder) throws {
        let values = try decoder.singleValueContainer().decode([String: BridgeValue].self)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        url = try c.decodeIfPresent(URL.self, forKey: .url)
        choices = try c.decodeIfPresent([Choice].self, forKey: .choices)
        code = try c.decodeIfPresent(String.self, forKey: .code)
        role = try c.decodeIfPresent(String.self, forKey: .role)
        message = try c.decodeIfPresent(String.self, forKey: .message)
        payload = values
    }

    public struct Choice: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
    }
}

public enum BridgeValue: Codable, Equatable, Sendable {
    case string(String), bool(Bool), number(Double), object([String: BridgeValue]), array([BridgeValue]), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: BridgeValue].self) { self = .object(v) }
        else { self = try .array(c.decode([BridgeValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
}

public struct BridgeRequest: Encodable, Sendable {
    public let version = 1
    public let id: String
    public let command: String
    public let params: [String: BridgeValue]
    public init(id: String = UUID().uuidString, command: String, params: [String: BridgeValue] = [:]) {
        self.id = id
        self.command = command
        self.params = params
    }
}

public struct BridgeEnvelope: Decodable, Sendable {
    public let version: Int
    public let id: String?
    public let ok: Bool?
    public let result: DesktopState?
    public let rawResult: BridgeValue?
    public let recoveryStatus: DesktopRecoveryStatus?
    public let recoveryDraft: DesktopRecoveryDraft?
    public let recoveryImportOutcome: DesktopRecoveryImportOutcome?
    public let recoveryCommit: DesktopRecoveryCommit?
    public let removalPlan: DesktopRemovalPlan?
    public let removalOutcome: DesktopRemovalOutcome?
    public let update: DesktopUpdatePresentation?
    public let event: String?
    public let state: DesktopState?
    public let interaction: RuntimeInteraction?
    public let error: Failure?

    private enum CodingKeys: String, CodingKey { case version, id, ok, result, event, state, interaction, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        guard version == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: c, debugDescription: "Unsupported desktop bridge protocol version")
        }
        id = try c.decodeIfPresent(String.self, forKey: .id)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
        // Commands such as cancel/respond may acknowledge without returning a state.
        result = try? c.decodeIfPresent(DesktopState.self, forKey: .result)
        rawResult = try? c.decode(BridgeValue.self, forKey: .result)
        recoveryStatus = try? c.decodeIfPresent(DesktopRecoveryStatus.self, forKey: .result)
        recoveryDraft = try? c.decodeIfPresent(DesktopRecoveryDraft.self, forKey: .result)
        recoveryImportOutcome = try? c.decodeIfPresent(DesktopRecoveryImportOutcome.self, forKey: .result)
        recoveryCommit = try? c.decodeIfPresent(DesktopRecoveryCommit.self, forKey: .result)
        removalPlan = try? c.decodeIfPresent(DesktopRemovalPlan.self, forKey: .result)
        removalOutcome = try? c.decodeIfPresent(DesktopRemovalOutcome.self, forKey: .result)
        update = try? c.decodeIfPresent(DesktopUpdatePresentation.self, forKey: .result)
        event = try c.decodeIfPresent(String.self, forKey: .event)
        state = try c.decodeIfPresent(DesktopState.self, forKey: .state)
        interaction = try c.decodeIfPresent(RuntimeInteraction.self, forKey: .interaction)
        error = try c.decodeIfPresent(Failure.self, forKey: .error)
    }

    public struct Failure: Decodable, Sendable {
        public let code: String
        public let message: String
    }
}

/// Bounds an untrusted helper's output without ever logging credential lines.
public struct JSONLineBuffer {
    private var pending = Data()
    public static let maximumLineBytes = 1_048_576
    public init() {}
    public mutating func append(_ bytes: Data) throws -> [Data] {
        pending.append(bytes)
        var lines: [Data] = []
        while let newline = pending.firstIndex(of: 10) {
            guard pending.distance(from: pending.startIndex, to: newline) <= Self.maximumLineBytes else {
                throw CocoaError(.fileReadTooLarge)
            }
            let line = pending[..<newline]
            if !line.isEmpty { lines.append(Data(line)) }
            pending.removeSubrange(...newline)
        }
        guard pending.count <= Self.maximumLineBytes else { throw CocoaError(.fileReadTooLarge) }
        return lines
    }
}
