// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

struct ScopePickerRequest {
    var sourceId: String
    var kind: String
    var query: String
    var parentId: String?
}

func appendScopeOptions(_ page: ScopeOptions, to previous: ScopeOptions?) throws -> ScopeOptions {
    guard let previous else { return page }
    guard previous.sourceId == page.sourceId, previous.sourceType == page.sourceType else {
        throw GatewayClient.Error.invalidResponse
    }
    var value = page
    value.items = previous.items
    for item in page.items {
        if let index = value.items.firstIndex(where: { scopeRefIdentityMatches($0.ref, item.ref) }) {
            value.items[index] = item
        } else {
            value.items.append(item)
        }
    }
    return value
}

func loadScopePickerPages(
    client: AccessClient, request: ScopePickerRequest, previous: ScopeOptions?, cursor: String?, restoreCount: Int
) async throws
    -> ScopeOptions {
    var value = try await client.scopeOptions(
        sourceId: request.sourceId,
        kind: request.kind,
        query: request.query,
        parentId: request.parentId,
        cursor: cursor
    )
    guard value.sourceId == request.sourceId else { throw GatewayClient.Error.invalidResponse }
    if cursor != nil { return try appendScopeOptions(value, to: previous) }
    var visited: Set<String> = []
    while value.items.count < restoreCount, let next = value.nextCursor {
        try Task.checkCancellation()
        guard visited.insert(next).inserted else { throw GatewayClient.Error.invalidResponse }
        let more = try await client.scopeOptions(
            sourceId: request.sourceId,
            kind: request.kind,
            query: request.query,
            parentId: request.parentId,
            cursor: next
        )
        value = try appendScopeOptions(more, to: value)
    }
    return value
}
