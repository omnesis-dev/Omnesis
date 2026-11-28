// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Filesystem identities shared with Node and Rust use POSIX realpath, not Foundation URL aliases.
public enum DesktopCanonicalPath {
    public enum Failure: Error { case invalidPath }

    public static func resolve(_ path: String, allowMissing: Bool = false) throws -> String {
        guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw Failure.invalidPath }
        var probe = path, suffix: [String] = []
        while true {
            let (pointer, failure) = probe.withCString { value in
                let pointer = Darwin.realpath(value, nil)
                return (pointer, errno)
            }
            if let pointer {
                defer { free(pointer) }
                let root = String(cString: pointer)
                return suffix.reversed().reduce(root) { partial, component in
                    (partial == "/" ? "" : partial) + "/" + component
                }
            }
            guard allowMissing, failure == ENOENT else { throw Failure.invalidPath }
            var metadata = stat()
            guard lstat(probe, &metadata) != 0, errno == ENOENT,
                  let slash = probe.lastIndex(of: "/"), slash < probe.index(before: probe.endIndex) else {
                throw Failure.invalidPath
            }
            let component = String(probe[probe.index(after: slash)...])
            guard component != ".", component != ".." else { throw Failure.invalidPath }
            suffix.append(component)
            probe = slash == probe.startIndex ? "/" : String(probe[..<slash])
        }
    }
}
