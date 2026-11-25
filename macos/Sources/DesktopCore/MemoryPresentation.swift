// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

public enum DesktopMemorySettings {
    public static func mebibytes(_ value: String) -> Int? {
        guard let value = Int(value), (256 ... 1_048_576).contains(value) else { return nil }
        return value
    }
}
