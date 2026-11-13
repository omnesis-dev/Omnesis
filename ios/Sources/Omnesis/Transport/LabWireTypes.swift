// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Effective gateway gates. Unknown or absent flags never enable a surface.
public struct LabFlags: Decodable, Sendable {
    public let brain: Bool
    public let tasks: Bool
    public let watches: Bool

    public init(brain: Bool = false, tasks: Bool = false, watches: Bool = false) {
        self.brain = brain
        self.tasks = tasks
        self.watches = watches
    }

    private enum CodingKeys: String, CodingKey { case brain, tasks, watches }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        brain = try values.decodeIfPresent(Bool.self, forKey: .brain) ?? false
        tasks = try values.decodeIfPresent(Bool.self, forKey: .tasks) ?? false
        watches = try values.decodeIfPresent(Bool.self, forKey: .watches) ?? false
    }
}

public struct LabSnapshot: Decodable, Sendable {
    public let experimental: Bool
    public let features: [LabFeature]
}

public struct LabFeature: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let enabled: Bool
    public let iconSvg: String?
}

/// Explicit Lab flags take priority; gateways that predate Lab keep their advertised surfaces.
extension StatusSnapshot {
    public var tasksAvailable: Bool {
        tasks?.available == true && (lab?.tasks ?? true)
    }

    public var brainEnabled: Bool {
        lab?.brain ?? experimental
    }

    public var watchesEnabled: Bool {
        lab?.watches ?? experimental
    }
}
