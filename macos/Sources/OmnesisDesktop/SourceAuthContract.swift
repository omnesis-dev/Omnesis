// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

struct AuthSnapshot: Decodable {
    let state: String
    let errorMessage: String?
    let errorDetail: ErrorDetail?
    let message: String?
    let authUrl: URL?
    let qrData: String?
    let resolvedAccountId: String?
    let resolvedAccountIds: [String]?
    let resolvedNotices: [Notice]?
    let widget: Widget?
    let pendingChallenge: Pending?
    struct Notice: Decodable { let title: String
        let detail: String?
    }

    struct Widget: Decodable { let kind: String
        let payload: [String: String]
    }

    struct ErrorDetail: Decodable { let code: String?
        let fileKey: String?
        let remedy: String?
        let retryAfterMs: Double?
    }

    struct Pending: Decodable {
        let id: String
        let expectsAnswer: Bool
        let challenge: Challenge
    }

    struct Challenge: Decodable {
        let kind: String
        let title: String
        let instructions: String?
        let url: URL?
        let data: String?
        let fields: [DesktopDescriptor.Param]?
        let schema: [String: SourceConfigField]?
        let prefill: [String: String]?
        let pattern: String?
        let patternHint: String?
        let via: String?
        let renderer: String?
        let payload: [String: String]?
        let expiresAt: String?
        var expiration: Date? {
            guard let expiresAt else { return nil }
            let parser = ISO8601DateFormatter()
            if let date = parser.date(from: expiresAt) { return date }
            parser.formatOptions.insert(.withFractionalSeconds)
            return parser.date(from: expiresAt)
        }
    }
}
