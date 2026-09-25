// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Row, arg and SQL helpers behind the Direct static card mapping
// (`PrivacyDirectCards.swift`): loop/entity rows, args summaries, DuckDB
// cell formatting, and the small `JSONValue` accessors the mapping uses.
//
// Deliberately free of SwiftUI so the mapping stays unit testable in the
// sim-less logic lane.

// MARK: - Row builders

func directDocumentRow(_ ref: AgentDocRef, fallbackTitle: String? = nil) -> DirectCardRow {
    let title = ref.title?.isEmpty == false ? ref.title! : (fallbackTitle ?? "Untitled")
    return DirectCardRow(
        title: title,
        subtitle: nil,
        destination: .document(
            id: ref.documentId,
            sourceId: ref.sourceId.isEmpty ? nil : ref.sourceId,
            title: title
        )
    )
}

func directLoopRow(loopId: String, state: String, title: String) -> DirectCardRow {
    DirectCardRow(
        title: title.isEmpty ? "Untitled loop" : title,
        subtitle: state.isEmpty ? nil : state,
        destination: loopId.isEmpty ? nil : .loop(id: loopId)
    )
}

struct DirectLoopFields: Equatable {
    let id: String
    let state: String
    let title: String
}

func directLoopList(_ value: JSONValue?) -> [DirectLoopFields] {
    (value?.arrayValue ?? []).compactMap { entry in
        guard case .object = entry else { return nil }
        let id = entry["loopId"]?.stringValue ?? entry["id"]?.stringValue ?? ""
        let title = entry["title"]?.stringValue ?? "Untitled loop"
        let state = entry["state"]?.stringValue ?? ""
        return DirectLoopFields(id: id, state: state, title: title)
    }
}

func directSingleLoop(_ data: JSONValue) -> DirectLoopFields? {
    guard case .object = data else { return nil }
    let id = data["loopId"]?.stringValue ?? data["id"]?.stringValue ?? ""
    if id.isEmpty, data["title"]?.stringValue == nil { return nil }
    return DirectLoopFields(
        id: id,
        state: data["state"]?.stringValue ?? "",
        title: data["title"]?.stringValue ?? "Untitled loop"
    )
}

func directRetiredCount(_ value: JSONValue?) -> Int {
    if case .int(let count) = value { return max(0, Int(count)) }
    return value?.arrayValue?.count ?? 0
}

func directNeighborhoodRows(_ data: JSONValue) -> [DirectCardRow] {
    var rows: [DirectCardRow] = []
    for doc in data["documents"]?.arrayValue ?? [] {
        let id = doc["documentId"]?.stringValue ?? ""
        let title = doc["title"]?.stringValue ?? "Untitled"
        let sourceId = doc["sourceId"]?.stringValue
        rows.append(DirectCardRow(
            title: title,
            subtitle: nil,
            destination: id.isEmpty ? nil : .document(
                id: id,
                sourceId: sourceId?.isEmpty == false ? sourceId : nil,
                title: title
            )
        ))
    }
    for person in data["people"]?.arrayValue ?? [] {
        let name = person["name"]?.stringValue ?? "Unnamed person"
        let id = person["personId"]?.stringValue ?? person["canonicalId"]?.stringValue ?? ""
        rows.append(DirectCardRow(
            title: name,
            subtitle: nil,
            destination: id.isEmpty ? nil : .person(canonicalId: id, name: name)
        ))
    }
    for loop in directLoopList(data["loops"]) {
        rows.append(directLoopRow(loopId: loop.id, state: loop.state, title: loop.title))
    }
    for annotation in data["temporalAnnotations"]?.arrayValue ?? [] {
        rows.append(DirectCardRow(
            title: annotation["sentence"]?.stringValue ?? "Untitled moment",
            subtitle: nil,
            destination: nil
        ))
    }
    return Array(rows.prefix(directCardMaxRows))
}

// MARK: - Args helpers

func directArgQueries(_ args: JSONValue?) -> [String] {
    (args?["queries"]?.arrayValue ?? []).map { $0["query"]?.stringValue ?? "" }
}

func directArgDocumentIds(_ args: JSONValue?) -> [String] {
    (args?["documents"]?.arrayValue ?? []).map { $0["documentId"]?.stringValue ?? "" }
}

// MARK: - SQL formatting

/// Pad or trim a row to the column count, mirroring the portal's
/// `normaliseRow`: ragged rows still print as a straight grid.
func directNormaliseSqlRow(_ row: [JSONAny], columns: Int) -> [String] {
    var cells = row.prefix(columns).map { directSqlCell($0) }
    while cells.count < columns {
        cells.append("null")
    }
    return cells
}

private func directSqlCell(_ value: JSONAny) -> String {
    switch value.value {
    case is NSNull: return "null"
    case let bool as Bool: return bool ? "true" : "false"
    case let int as Int: return String(int)
    case let double as Double: return String(double)
    case let string as String: return string
    case let dict as [String: Any] where dict.count == 1:
        // DuckDB date/timestamp objects round-trip as `{days}` / `{micros}`,
        // mirroring the portal's `formatSqlCell`.
        if let days = dict["days"] as? Int {
            return directIsoDate(ms: Int64(days) * 86_400_000)
        }
        if let micros = dict["micros"] as? Int {
            return directIsoMinute(ms: Int64(micros) / 1000)
        }
        return directJsonText(dict)
    default:
        return directJsonText(value.value)
    }
}

private func directIsoDate(ms: Int64) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withFullDate]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
}

private func directIsoMinute(ms: Int64) -> String {
    let date = Date(timeIntervalSince1970: Double(ms) / 1000)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd HH:mm"
    return formatter.string(from: date)
}

private func directJsonText(_ value: Any) -> String {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        return text
    }
    return String(describing: value)
}

// MARK: - JSONValue conveniences

extension JSONValue {
    subscript(key: String) -> JSONValue? {
        guard case .object(let fields) = self else { return nil }
        return fields[key]
    }

    var stringValue: String? {
        guard case .string(let raw) = self else { return nil }
        return raw
    }

    var arrayValue: [JSONValue]? {
        guard case .array(let items) = self else { return nil }
        return items
    }

    var intValue: Int? {
        switch self {
        case .int(let raw): Int(raw)
        case .double(let raw): Int(raw)
        default: nil
        }
    }

    var int64Value: Int64? {
        switch self {
        case .int(let raw): raw
        case .double(let raw): Int64(raw)
        default: nil
        }
    }

    var boolValue: Bool? {
        guard case .bool(let raw) = self else { return nil }
        return raw
    }
}
