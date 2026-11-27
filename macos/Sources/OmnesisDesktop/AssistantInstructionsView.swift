// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import SwiftUI

struct DesktopChatGPTInstructions: View {
    let mcpURL: URL
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
                Text("1. Add Omnesis to ChatGPT").font(DesktopDesignTokens.Typography.body.weight(.medium))
                    .accessibilityAddTraits(.isHeader)
                Link("Open ChatGPT plugins", destination: URL(string: "https://chatgpt.com/plugins")!)
                Text("In ChatGPT, select +, then Add custom MCP server.")
                Text("Use Omnesis as the name. Paste this address into Server URL and choose OAuth authentication.")
                HStack {
                    Text(mcpURL.absoluteString).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    Spacer()
                    Button("Copy address", systemImage: "doc.on.doc") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(mcpURL.absoluteString, forType: .string)
                    }.accessibilityIdentifier("copy-mcp-address")
                }
                Text("Select I understand and want to continue, then Create as a plugin. Complete the Omnesis sign-in that opens.")
                Text("This secure address works at home and away. Keep one sign-in attempt open at a time.")
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                Text(
                    "If Add custom MCP server is missing, your account or workspace may not allow custom connections. Check ChatGPT’s requirements or ask your workspace owner."
                )
                .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                Link(
                    "ChatGPT connection requirements",
                    destination: URL(string: "https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt")!
                )
                DisclosureGroup("Other assistants") {
                    Text(
                        "In your assistant’s connection settings, add a remote MCP server named Omnesis with the address above. Choose OAuth sign-in, then follow steps 2 and 3 here to approve only the information you want to share."
                    )
                    .padding(.top, DesktopDesignTokens.Space.small)
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct DesktopChatGPTFinishInstructions: View {
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
                Text("4. Install and use Omnesis in ChatGPT").font(DesktopDesignTokens.Typography.body.weight(.medium))
                    .accessibilityAddTraits(.isHeader)
                Text(
                    "Finish the sign-in in ChatGPT. Open your personal plugins, select + on Omnesis to install it, then start a new Work chat and mention @Omnesis."
                )
                Link("Open my ChatGPT plugins", destination: URL(string: "https://chatgpt.com/plugins?view=personal")!)
                Text("For another assistant, return to its conversation and enable the Omnesis connection there.")
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
