// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/// The independent Tell Omnesis processing verdict from `GET /status`.
public struct NoteAgentStatus: Decodable, Equatable, Sendable {
    public let enabled: Bool
    public let modelAssigned: Bool
    public let active: Bool

    public init(enabled: Bool, modelAssigned: Bool, active: Bool) {
        self.enabled = enabled
        self.modelAssigned = modelAssigned
        self.active = active
    }

    public var notice: String? {
        if !enabled {
            return "Note processing is off. Notes are saved, but won't create or update tasks."
        }
        if !modelAssigned {
            return "The Agent model is missing or unavailable. Notes are saved, but won't create or update tasks."
        }
        return nil
    }
}
