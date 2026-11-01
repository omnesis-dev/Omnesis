// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The `capabilities` map on `GET /status`: the optional features this
/// gateway serves, each as the range of protocol versions it speaks. A
/// client offers a feature only when its own version is in range.
public struct GatewayCapabilities: Decodable, Equatable, Sendable {
    /// Starting a chat about a task (`POST /tasks/:id/conversation`).
    public let taskConversations: GatewayCapabilityRange?
    public let taskNoteCapture: GatewayCapabilityRange?

    /// The `taskConversations` version this app speaks.
    static let taskConversationsVersion = 1

    public init(taskConversations: GatewayCapabilityRange? = nil, taskNoteCapture: GatewayCapabilityRange? = nil) {
        self.taskConversations = taskConversations
        self.taskNoteCapture = taskNoteCapture
    }

    private enum CodingKeys: String, CodingKey {
        case taskConversations, taskNoteCapture
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Decoded per entry, so one malformed entry withholds only its own feature.
        taskNoteCapture = try? container.decodeIfPresent(GatewayCapabilityRange.self, forKey: .taskNoteCapture)
        taskConversations = try? container.decodeIfPresent(GatewayCapabilityRange.self, forKey: .taskConversations)
    }

    public var supportsTaskNoteCapture: Bool {
        taskNoteCapture?.contains(1) ?? false
    }

    /// Whether this app can start a chat about a task on this gateway.
    public var supportsTaskConversations: Bool {
        taskConversations?.contains(Self.taskConversationsVersion) ?? false
    }
}

/// The protocol versions a gateway speaks for one capability, inclusive.
public struct GatewayCapabilityRange: Decodable, Equatable, Sendable {
    public let min: Int
    public let max: Int

    public init(min: Int, max: Int) {
        self.min = min
        self.max = max
    }

    private enum CodingKeys: String, CodingKey {
        case min, max
    }

    public func contains(_ version: Int) -> Bool {
        min <= version && version <= max
    }
}
