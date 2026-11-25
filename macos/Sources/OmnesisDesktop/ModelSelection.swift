// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Omnesis

struct DesktopModelChoice: Identifiable, Equatable {
    enum Apply: Equatable { case assign(String), activate(String, String) }
    let id: String
    let title: String
    let onHost: Bool
    let apply: Apply
}

enum DesktopModelSelection {
    static func choices(for role: String, overview: ModelsOverview) -> [DesktopModelChoice] {
        var choices: [DesktopModelChoice] = []
        let catalogRole: String? = switch role {
        case "embedder": "embed"
        case "agent", "privacy-reviewer": "agent"
        case "transcriber": "transcribe"
        default: nil
        }
        if let catalogRole {
            let installed = Set(overview.installed.map(\.id))
            for entry in overview.catalog where entry.roles.contains(catalogRole) {
                if entry.kind == "gguf", installed.contains(entry.id) {
                    choices.append(.init(
                        id: "local/" + entry.id,
                        title: "\(entry.name) · On your library Mac",
                        onHost: true,
                        apply: .activate(entry.id, catalogRole)
                    ))
                } else if entry.kind == "anthropic-api", overview.inference.backends["anthropic"]?.hasApiKey == true,
                          overview.inference.backends["anthropic"]?.status == "ok" {
                    choices.append(.init(
                        id: "anthropic/" + entry.id,
                        title: "\(entry.name) · Anthropic API",
                        onHost: false,
                        apply: .activate(entry.id, catalogRole)
                    ))
                }
            }
        }
        for (key, backend) in overview.inference.backends.sorted(by: { $0.key < $1.key })
            where backend.type == "http" && backend.status == "ok" {
            let host = backend.url.flatMap(URL.init(string:))?.host?.lowercased()
            let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host ?? "")
            let name = overview.presets.first(where: { $0.id == backend.preset })?.name ?? key
            for model in backend.models ?? [] where backend.modelRoles?[model]?.contains(role) == true {
                choices.append(.init(id: key + "/" + model, title: "\(name) · \(model)", onHost: local, apply: .assign(key + "/" + model)))
            }
        }
        if let codex = overview.inference.codex, codex.configured, codex.loggedIn, codex.runtime?.supported == true {
            for model in codex.models where codex.modelRoles?[model]?.contains(role) == true {
                let label = codex.modelDetails?.first(where: { $0.id == model })?.name ?? model
                choices.append(.init(id: "codex/" + model, title: "ChatGPT · \(label)", onHost: false, apply: .assign("codex/" + model)))
            }
        }
        var seen = Set<String>()
        return choices.filter { seen.insert($0.id).inserted }
    }
}
