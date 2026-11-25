// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum DesktopRuntimeEnvironment {
    /// Isolation begins before Node starts, so its loader cannot read a
    /// headless installation's custom trust roots, preload code or credentials.
    public static func child(parent: [String: String], runtime: URL) -> [String: String] {
        let blocked = Set([
            "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_PATH",
            "NODE_REPL_EXTERNAL_MODULE", "SSL_CERT_FILE", "SSL_CERT_DIR", "LD_PRELOAD", "LD_LIBRARY_PATH",
        ])
        var env = parent.filter { key, _ in
            !key.hasPrefix("OMNESIS_") && !key.hasPrefix("DYLD_") && !blocked.contains(key)
                && !key.hasSuffix("_API_KEY")
        }
        let existing = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = runtime.path + ":" + existing
        return env
    }
}
