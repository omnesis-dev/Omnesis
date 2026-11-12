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
}

public struct LabSnapshot: Decodable, Sendable {
    public let experimental: Bool
    public let features: [LabFeature]
}

public struct LabFeature: Decodable, Identifiable, Sendable {
    public enum FeatureID: String, Decodable, Sendable { case brain, tasks, watches }
    public let id: FeatureID
    public let name: String
    public let description: String
    public let enabled: Bool
    public let iconSvg: String?
}
