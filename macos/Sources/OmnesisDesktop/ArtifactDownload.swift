// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation

/// Per-task redirects are refused; the existing session retains its TLS pin delegate.
final class ArtifactRedirectRefusal: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

actor DesktopArtifactDownloader {
    func save(
        _ artifact: DesktopArtifact,
        api: DesktopAPI,
        destination: URL,
        readableExport: Bool = false,
        progress: @escaping @Sendable (Int64) -> Void
    ) async throws {
        try Task.checkCancellation()
        guard artifact.valid else { throw DesktopAPIError.message("Refresh the backup list before saving this item.") }
        guard !readableExport || artifact.kind == "export"
        else { throw DesktopAPIError.message("Readable downloads are available for data exports only.") }
        let action = readableExport ? "readable-download" : "download"
        let url = api.connection.url.appendingPathComponent("admin/artifacts/\(artifact.id)/\(action)")
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = readableExport ? 6 * 60 * 60 : 70
        request.setValue("Bearer \(api.connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/x-tar", forHTTPHeaderField: "Accept")
        if readableExport {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(#"{"acknowledgeUnencryptedCopy":true}"#.utf8)
        }
        let file = try PrivateSaveFile(url: destination)
        do {
            let (bytes, response) = try await api.session.bytes(for: request, delegate: ArtifactRedirectRefusal())
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  response.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?.lowercased() == "application/x-tar"
            else {
                if readableExport, (response as? HTTPURLResponse)?.statusCode == 400 {
                    throw DesktopAPIError
                        .message(
                            "Create a new export before saving readable JSON or CSV files. You can still save the stored encrypted copy."
                        )
                }
                throw DesktopAPIError.message("The library refused this download. Refresh the list and try again.")
            }
            var chunk = Data()
            chunk.reserveCapacity(65536)
            var received: Int64 = 0
            let clock = ContinuousClock()
            var lastProgress = clock.now
            for try await byte in bytes {
                chunk.append(byte)
                if chunk.count == 65536 {
                    try file.append(chunk)
                    received += Int64(chunk.count)
                    chunk.removeAll(keepingCapacity: true)
                    if lastProgress.duration(to: clock.now) >= .milliseconds(200) {
                        progress(received)
                        lastProgress = clock.now
                    }
                }
            }
            try Task.checkCancellation()
            if !chunk.isEmpty { try file.append(chunk)
                received += Int64(chunk.count)
            }
            guard received >= 1024,
                  response.expectedContentLength < 0 || received == response.expectedContentLength else {
                throw DesktopAPIError.message("The download was incomplete. No backup was saved.")
            }
            try file.finish()
            progress(received)
        } catch {
            file.discard()
            throw error
        }
    }
}
