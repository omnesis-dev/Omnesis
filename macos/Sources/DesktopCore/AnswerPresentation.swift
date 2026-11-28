// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A small text-only Markdown projection. Images and HTML never create remote resources.
public enum DesktopAnswerBlock: Equatable, Sendable {
    case paragraph(String), heading(String), bullet(String), numbered(String, String), quote(String), code(String)

    public static func parse(_ source: String) -> [Self] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [Self] = [], paragraph: [String] = [], code: [String] = []
        var fence: String?
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }
        for line in lines {
            if Task.isCancelled { return [] }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fence {
                if trimmed.hasPrefix(marker) { blocks.append(.code(code.joined(separator: "\n")))
                    code = []
                    fence = nil
                } else { code.append(line) }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                fence = String(trimmed.prefix(3))
                continue
            }
            if trimmed.isEmpty { flush()
                continue
            }
            let hashes = trimmed.prefix(while: { $0 == "#" }).count
            if (1 ... 6).contains(hashes), trimmed.dropFirst(hashes).first == " " {
                flush()
                blocks.append(.heading(String(trimmed.dropFirst(hashes + 1))))
                continue
            }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
                flush()
                blocks.append(.bullet(String(trimmed.dropFirst(2))))
                continue
            }
            if trimmed.hasPrefix("> ") { flush()
                blocks.append(.quote(String(trimmed.dropFirst(2))))
                continue
            }
            let digits = trimmed.prefix(while: { $0.isASCII && $0.isNumber })
            if !digits.isEmpty, digits.count < 10, trimmed.dropFirst(digits.count).hasPrefix(". ") {
                flush()
                blocks.append(.numbered(String(digits), String(trimmed.dropFirst(digits.count + 2))))
                continue
            }
            paragraph.append(line)
        }
        flush()
        if fence != nil { blocks.append(.code(code.joined(separator: "\n"))) }
        return blocks
    }

    public static func allowsLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host != nil && url.user == nil && url.password == nil
    }
}
