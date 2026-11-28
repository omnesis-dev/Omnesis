// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public enum DesktopRecoveryFile {
    /// A user-selected file is read once, without following links or opening a pipe.
    public static func read(_ url: URL) throws -> BridgeValue {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw CocoaError(.fileReadNoSuchFile) }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? file.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size > 0, info.st_size <= 16384,
              let data = try file.read(upToCount: 16385), data.count <= 16384 else { throw CocoaError(.fileReadCorruptFile) }
        let value = try JSONDecoder().decode(BridgeValue.self, from: data)
        guard case .object = value else { throw CocoaError(.fileReadCorruptFile) }
        return value
    }
}
