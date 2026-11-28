// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum DesktopMacServerGuidance {
    public static let appleGuide = URL(string: "https://support.apple.com/guide/mac-help/mchle41a6ccd/mac")!
    public static let summary = "The Mac storing your library must stay awake, online, and running Omnesis. Configure it to prevent automatic system sleep before completing setup. Its display can turn off and its screen can stay locked."

    public static func desktopEnergyPane(macOSMajorVersion: Int) -> String {
        macOSMajorVersion >= 15 ? "Energy" : "Energy Saver"
    }
}
