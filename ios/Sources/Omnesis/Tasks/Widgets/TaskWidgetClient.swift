// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum TaskWidgetClientError: Error, Equatable {
    case insecureCredential
    case invalidResponse
    case unavailable
    case unauthorized
}

/// The signed widget extension uses the paired device authority in its own
/// Keychain group. Transport retains the exact pairing TLS contract.
public struct TaskWidgetClient: Sendable {
    public typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    public let credential: TaskWidgetCredential
    private let request: Request

    public init(credential: TaskWidgetCredential, request: Request? = nil) {
        self.credential = credential
        if let request { self.request = request
            return
        }
        let session: URLSession = if credential.tlsMode == "pinned-leaf", let pin = credential.fingerprint {
            PinnedSession(fingerprintHex: pin, host: credential.url.host).session
        } else {
            URLSession(configuration: .ephemeral)
        }
        self.request = { try await session.data(for: $0) }
    }

    public func fetch(now: Date = Date(), calendar: Calendar = .current) async throws -> TaskWidgetSnapshot {
        struct Page: Decodable { let tasks: [TaskWidgetTask] }
        let day = TaskWidgetSchedule.dayString(now, calendar: calendar)
        var tasks: [String: TaskWidgetTask] = [:]
        // Owned journal views are complete, unpaginated partitions. Suggested
        // and Done are intentionally excluded from the compact widget cache.
        for view in ["today", "month", "future", "anytime"] {
            var parts = URLComponents()
            parts.path = "/tasks"
            parts.queryItems = [.init(name: "view", value: view), .init(name: "date", value: day)]
            let data = try await send(path: parts.string ?? "/tasks", method: "GET")
            for task in try JSONDecoder().decode(Page.self, from: data).tasks {
                if !task.isResolved, task.isOwned, !task.ignored { tasks[task.id] = task }
            }
        }
        return TaskWidgetSnapshot(tasks: tasks.values.sorted { $0.id < $1.id }, updatedAt: now)
    }

    public func complete(id: String) async throws {
        guard !id.isEmpty,
              let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            throw TaskWidgetClientError.invalidResponse
        }
        _ = try await send(path: "/tasks/\(encoded)/actions", method: "POST", body: Data(#"{"action":"complete"}"#.utf8))
    }

    private func send(path: String, method: String, body: Data? = nil) async throws -> Data {
        guard credential.isSecure else { throw TaskWidgetClientError.insecureCredential }
        guard let url = URL(string: path, relativeTo: credential.url)?.absoluteURL else {
            throw TaskWidgetClientError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 8
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await self.request(request)
        guard let http = response as? HTTPURLResponse else { throw TaskWidgetClientError.invalidResponse }
        switch http.statusCode {
        case 200 ... 299: return data
        case 401, 403: throw TaskWidgetClientError.unauthorized
        default: throw TaskWidgetClientError.unavailable
        }
    }
}
