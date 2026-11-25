// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The serialized ConfigSchema is keyed by parameter name; challenge values retain
/// their declared JSON types when sent to the collector.
final class SourceConfigField: Decodable {
    let kind: String
    let label: String
    let help: String?
    let placeholder: String?
    let required: Bool?
    let advanced: Bool?
    let pattern: String?
    let patternHint: String?
    let minLength: Int?
    let maxLength: Int?
    let min: Double?
    let max: Double?
    let integer: Bool?
    let options: [DesktopDescriptor.Param.Option]?
    let `default`: SourceJSONValue?
    let of: SourceConfigField?
    let maxItems: Int?
    let separator: String?
    let mustExist: String?

    func value(_ text: String) throws -> Any {
        if required == true, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw DesktopAPIError.message("Enter \(label.lowercased()).")
        }
        switch kind {
        case "boolean":
            guard ["true", "false"].contains(text) else { throw DesktopAPIError.message("Choose \(label.lowercased()).") }
            return text == "true"
        case "number":
            guard let value = Double(text), value.isFinite,
                  min.map({ value >= $0 }) ?? true, max.map({ value <= $0 }) ?? true,
                  integer != true || value.rounded() == value else {
                throw DesktopAPIError.message("Check \(label.lowercased()).")
            }
            return value
        case "list":
            guard let of else { throw DesktopAPIError.message("This source sent an unsupported list field.") }
            let separators = separator == "newline" || of.kind == "path" ? CharacterSet.newlines : CharacterSet(charactersIn: ",\n\r")
            let items = text.components(separatedBy: separators).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            guard maxItems.map({ items.count <= $0 }) ?? true
            else { throw DesktopAPIError.message("Too many values for \(label.lowercased()).") }
            return try items.map { try of.value($0) }
        case "string", "secret", "path", "select":
            if kind == "select", !text.isEmpty, options?.contains(where: { $0.value == text }) != true {
                throw DesktopAPIError.message("Choose an available \(label.lowercased()).")
            }
            if !text.isEmpty {
                guard minLength.map({ text.count >= $0 }) ?? true,
                      maxLength.map({ text.count <= $0 }) ?? true else { throw DesktopAPIError.message("Check \(label.lowercased()).") }
                try SourceValidation.pattern(text, pattern: pattern, hint: patternHint, label: label)
            }
            return text
        default: throw DesktopAPIError.message("This source asks for an unsupported field. Update Omnesis before continuing.")
        }
    }
}

indirect enum SourceJSONValue: Decodable {
    case string(String), number(Double), boolean(Bool), array([SourceJSONValue]), object([String: SourceJSONValue]), null
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Bool.self) { self = .boolean(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([String: SourceJSONValue].self) { self = .object(value) }
        else { self = try .array(container.decode([SourceJSONValue].self)) }
    }

    var text: String {
        switch self {
        case .string(let value): value
        case .number(let value): String(value)
        case .boolean(let value): value ? "true" : "false"
        case .array(let values): values.map(\.text).joined(separator: "\n")
        case .object, .null: ""
        }
    }

    var jsonValue: Any {
        switch self {
        case .string(let value): value
        case .number(let value): value
        case .boolean(let value): value
        case .array(let values): values.map(\.jsonValue)
        case .object(let values): values.mapValues(\.jsonValue)
        case .null: NSNull()
        }
    }

    var objectValue: [String: SourceJSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }
}

enum SourceValidation {
    static func pattern(_ value: String, pattern: String?, hint: String?, label: String) throws {
        guard let pattern else { return }
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            throw DesktopAPIError.message("This source sent an unsupported validation rule. Update Omnesis before continuing.")
        }
        guard regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil else {
            throw DesktopAPIError.message(hint ?? "Check \(label.lowercased()).")
        }
    }

    /// A desktop loopback proxy is never the externally reachable OAuth origin.
    static func publicOrigin(_ text: String?) -> String? {
        guard let text, let url = URL(string: text), url.scheme == "https", let host = url.host,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        let name = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard name.contains("."), !name.contains(":"),
              name.range(of: "^[0-9.]+$", options: .regularExpression) == nil,
              !["localhost", "local", "internal", "home.arpa"].contains(where: { name == $0 || name.hasSuffix("." + $0) })
        else { return nil }
        return text.hasSuffix("/") ? String(text.dropLast()) : text
    }
}
