// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore

/// Login requests the menu-bar application without activation. Window presentation is handled by the GUI.
@MainActor
enum BackgroundMainApplication {
    static func openIfNeeded(_ application: URL) async throws {
        guard try !verifiedMainAlreadyRunning(application) else { return }
        try await Task.detached(priority: .utility) {
            try DesktopRuntimeBootstrap.validateApplication(application)
        }.value
        try Task.checkCancellation()
        // Recheck after verification: a GUI launch racing login must keep its visible window.
        guard try !verifiedMainAlreadyRunning(application) else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.createsNewApplicationInstance = false
        _ = try await NSWorkspace.shared.openApplication(at: application, configuration: configuration)
    }

    private static func verifiedMainAlreadyRunning(_ application: URL) throws -> Bool {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.omnesis.desktop")
            .filter { !$0.isTerminated }
        guard !running.isEmpty else { return false }
        let expected = try DesktopCanonicalPath.resolve(application.appendingPathComponent("Contents/MacOS/Omnesis").path)
        for candidate in running {
            let before = try DesktopBackgroundProcessIdentity.read(candidate.processIdentifier)
            let actual = try DesktopBackgroundPeerTrust.observer(pid: candidate.processIdentifier)
            guard actual.executable.path == expected,
                  try DesktopBackgroundProcessIdentity.read(candidate.processIdentifier) == before else {
                throw DesktopBackgroundPeerTrust.Failure.untrustedPeer
            }
        }
        return true
    }
}
