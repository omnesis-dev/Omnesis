// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Prevent a completed recorder from releasing the shared audio session after its owner changed.
struct AudioSessionLease {
    private(set) var generation = UUID()
    private var active = false

    mutating func begin() {
        generation = UUID()
        active = true
    }

    func owns(_ generation: UUID) -> Bool {
        active && self.generation == generation
    }

    mutating func release(expectedGeneration: UUID? = nil) -> Bool {
        guard active, expectedGeneration == nil || expectedGeneration == generation else { return false }
        active = false
        generation = UUID()
        return true
    }
}

/// Starting an engine doesn't prove that its microphone is delivering audio.
struct RealtimeCaptureReadiness {
    private(set) var isReady = false

    mutating func receivePCMFrame(byteCount: Int) -> Bool {
        guard byteCount > 0, !isReady else { return false }
        isReady = true
        return true
    }
}
