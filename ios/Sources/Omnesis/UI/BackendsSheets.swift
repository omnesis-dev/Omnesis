// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// MARK: - Add-backend sheet

@available(iOS 17.0, *)
struct AddBackendSheet: View {
    /// Provider presets offered as a first-step grid (from `GET /admin/models`).
    var presets: [ProviderPreset] = []
    /// Experimental Codex status. Nil when the gateway is not advertising the
    /// Codex backend; non-nil means the card is addable from this sheet.
    var codex: CodexBackendStatus?
    var onAdd: (String, String, String?, String?) -> Void = { _, _, _, _ in }
    var onConfigureCodex: () -> Void = {}

    @Environment(\.dismiss) private var dismiss

    /// Which step is on screen: the preset grid, or the form (`preset` is the
    /// chosen preset, or nil for a blank "Custom" backend).
    private enum Step: Equatable {
        case grid
        case form(preset: ProviderPreset?)
    }

    @State private var step: Step = .grid
    @State private var name = ""
    @State private var url = ""
    @State private var apiKey = ""
    @State private var apiPathPrefix = ""
    /// The preset backing the current form (nil = Custom): drives the prefilled
    /// note + disabled name field.
    @State private var activePreset: ProviderPreset?

    /// nil when the name is valid; else the inline reason.
    private var nameError: String? {
        name.isEmpty ? nil : ModelManagement.validateBackendName(name)
    }

    private var canAdd: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !url.trimmingCharacters(in: .whitespaces).isEmpty
            && nameError == nil
    }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .grid:
                    presetGrid
                case .form:
                    formPane
                }
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Add backend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if case .form = step {
                        Button("Back") { backToGrid() }
                    } else {
                        Button("Cancel") { dismiss() }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if case .form = step {
                        Button("Add") {
                            onAdd(
                                name.trimmingCharacters(in: .whitespaces),
                                url.trimmingCharacters(in: .whitespaces),
                                apiKey.isEmpty ? nil : apiKey,
                                apiPathPrefix.isEmpty ? nil : apiPathPrefix
                            )
                        }
                        .fontWeight(.semibold)
                        .disabled(!canAdd)
                    }
                }
            }
        }
    }

    // MARK: - Step 1: preset grid

    private var presetGrid: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text(
                    "Pick a provider to pre-fill its URL, or point Omnesis at any OpenAI-compatible server. "
                        + "Backends are shared across every capability."
                )
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)

                LazyVGrid(
                    columns: [GridItem(.flexible(), spacing: Theme.Spacing.sm), GridItem(.flexible(), spacing: Theme.Spacing.sm)],
                    spacing: Theme.Spacing.sm
                ) {
                    ForEach(presets) { preset in
                        presetCard(
                            providerId: preset.id,
                            title: preset.name,
                            subtitle: "Set up this provider",
                            action: { selectPreset(preset) }
                        )
                    }
                    if let codex {
                        presetCard(
                            providerId: "codex",
                            title: "Codex",
                            subtitle: codex.configured ? "Manage OpenAI login" : "Log in with OpenAI",
                            action: {
                                dismiss()
                                onConfigureCodex()
                            }
                        )
                    }
                    presetCard(
                        providerId: "http",
                        title: "Custom",
                        subtitle: "Any OpenAI-compatible server",
                        action: { selectCustom() }
                    )
                }
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private func presetCard(
        providerId: String,
        title: String,
        subtitle: String,
        action: @escaping () -> Void
    )
        -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                ProviderIcon(providerId: providerId, size: 24)
                    .foregroundStyle(Theme.textPrimary)
                    .frame(height: 24)
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(2)
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func selectPreset(_ preset: ProviderPreset) {
        activePreset = preset
        name = preset.id
        url = preset.defaultUrl
        apiKey = ""
        apiPathPrefix = preset.apiPathPrefix ?? ""
        step = .form(preset: preset)
    }

    private func selectCustom() {
        activePreset = nil
        name = ""
        url = ""
        apiKey = ""
        apiPathPrefix = ""
        step = .form(preset: nil)
    }

    private func backToGrid() {
        step = .grid
        activePreset = nil
    }

    // MARK: - Step 2: form

    private var formPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                if let preset = activePreset {
                    HStack(spacing: 6) {
                        ProviderIcon(providerId: preset.id, size: 16)
                            .foregroundStyle(Theme.textPrimary)
                        Text("Configuring \(preset.name) — add your API key; the URL is pre-filled.")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textSecondary)
                    }
                } else {
                    Text("Point Omnesis at any OpenAI-compatible server. Backends are shared across every capability.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textSecondary)
                }

                field(
                    label: "Name",
                    placeholder: "my-vllm",
                    text: $name,
                    error: nameError,
                    disabled: activePreset != nil
                )
                field(
                    label: "Base URL",
                    placeholder: "https://backend.example/v1",
                    text: $url,
                    keyboard: .URL
                )
                secureField(
                    label: activePreset != nil ? "API key" : "API key (optional)",
                    placeholder: "Leave blank for a keyless local server",
                    text: $apiKey
                )
                field(
                    label: "API path prefix (optional)",
                    placeholder: "/v1",
                    text: $apiPathPrefix
                )
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private func field(
        label: String,
        placeholder: String,
        text: Binding<String>,
        keyboard: UIKeyboardType = .default,
        error: String? = nil,
        disabled: Bool = false
    )
        -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            TextField(placeholder, text: text)
                .font(.system(size: 14))
                .foregroundStyle(disabled ? Theme.textMuted : Theme.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .disabled(disabled)
                .padding(Theme.Spacing.sm)
                .background(Theme.bgSecondary)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.medium)
                        .stroke(error == nil ? Theme.border : Theme.danger.opacity(0.6), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            if let error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.danger)
            }
        }
    }

    private func secureField(label: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            SecureField(placeholder, text: text)
                .font(.system(size: 14))
                .foregroundStyle(Theme.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(Theme.Spacing.sm)
                .background(Theme.bgSecondary)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.medium)
                        .stroke(Theme.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
        }
    }
}

// MARK: - Codex setup sheet

@available(iOS 17.0, *)
struct CodexSetupSheet: View {
    let status: CodexBackendStatus?
    let flow: CodexLoginFlow?
    var busy = false
    var autoChecking = false
    var onStartLogin: () -> Void = {}
    var onCheckLogin: () -> Void = {}
    var onRefresh: () -> Void = {}
    var onCancelLogin: () -> Void = {}
    var onRemove: () -> Void = {}

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    statusHeader
                    if let flow, flow.status == "pending" {
                        loginInstructions(flow)
                    } else {
                        loginActions
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Codex")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var statusHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Theme.Spacing.sm) {
                BackendBrandIcon(key: "codex", size: 24)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Codex")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text(statusLine)
                        .font(.system(size: 12))
                        .foregroundStyle(statusColor)
                }
                Spacer(minLength: 0)
            }
            if let reason = status?.reason, !reason.isEmpty {
                Text(reason)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(3)
            }
            if let refreshedAt = status?.refreshedAt {
                Text("Last checked \(refreshedAt)")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    private var loginActions: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(
                "Use Codex with the gateway host's dedicated Codex login. OpenAI will show a one-time code flow; Omnesis never sees your ChatGPT password."
            )
            .font(.system(size: 13))
            .foregroundStyle(Theme.textSecondary)

            Button(action: onStartLogin) {
                Text(status?.loggedIn == true ? "Log in again" : "Log in to OpenAI")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.sm)
                    .foregroundStyle(.white)
                    .background(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            }
            .buttonStyle(.plain)
            .disabled(busy)

            HStack(spacing: Theme.Spacing.sm) {
                outlineButton(title: "Check status", color: Theme.accent, action: onRefresh)
                if status?.configured == true {
                    outlineButton(title: "Remove", color: Theme.danger, action: onRemove)
                }
            }
        }
    }

    private func loginInstructions(_ flow: CodexLoginFlow) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Open this link to log in to OpenAI, then paste this one-time code.")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)

            if let uri = flow.verificationUri, let url = URL(string: uri) {
                Link(destination: url) {
                    HStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: "arrow.up.right.square")
                        Text("Open OpenAI login")
                        Spacer(minLength: 0)
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .padding(Theme.Spacing.md)
                    .background(Theme.accent.opacity(0.10))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
                }
            }

            if let code = flow.userCode {
                HStack(spacing: Theme.Spacing.sm) {
                    Text(code)
                        .font(.system(size: 24, weight: .semibold).monospaced())
                        .foregroundStyle(Theme.textPrimary)
                        .minimumScaleFactor(0.7)
                    Spacer(minLength: 0)
                    Button("Copy") {
                        UIPasteboard.general.string = code
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                }
                .padding(Theme.Spacing.md)
                .background(Theme.bgSecondary)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.medium)
                        .stroke(Theme.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            }

            if let expiresAt = flow.expiresAt {
                Text("Expires \(expiresAt)")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }

            Text(
                autoChecking
                    ? "Checking login status…"
                    : "Omnesis checks automatically when you return to the app. Use Check now if it does not update."
            )
            .font(.system(size: 11))
            .foregroundStyle(Theme.textMuted)

            HStack(spacing: Theme.Spacing.sm) {
                outlineButton(title: "Check now", color: Theme.accent, action: onCheckLogin)
                outlineButton(title: "Cancel", color: Theme.danger, action: onCancelLogin)
            }
        }
    }

    private func outlineButton(title: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(color)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.medium)
                        .stroke(color.opacity(0.4), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private var statusLine: String {
        guard let status else { return "Not available" }
        if status.status == "probing" { return "Checking status" }
        if status.loggedIn, status.status == "ok" {
            let count = status.models.count
            return "Connected · \(count) model\(count == 1 ? "" : "s")"
        }
        if status.configured { return "Login needs attention" }
        return "Not configured"
    }

    private var statusColor: Color {
        guard let status else { return Theme.textMuted }
        if status.status == "ok", status.loggedIn { return Theme.success }
        if status.configured { return Theme.warning }
        return Theme.textMuted
    }
}

// MARK: - Set-credential sheet

/// Field-driven credential form: one input per `spec.fields` entry, masked for
/// `secret` fields. Values are write-only — submitted, never read back. The
/// submit button gates on `ModelManagement.validateCredentialFields` (required +
/// per-field pattern); the gateway re-validates.
@available(iOS 17.0, *)
struct SetCredentialSheet: View {
    let entry: ModelCredentialEntry
    var onSave: ([String: String]) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss

    @State private var values: [String: String] = [:]

    private var validation: ModelManagement.CredentialValidation {
        ModelManagement.validateCredentialFields(values, spec: entry.spec)
    }

    private var canSave: Bool {
        if case .valid = validation { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    Text(
                        "Enter your \(entry.providerName) credentials. They're stored on the gateway host "
                            + "and used to call \(entry.providerName); the key is never shown again."
                    )
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)

                    ForEach(entry.spec.fields) { field in
                        fieldInput(field)
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle(entry.providerName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        if case .valid(let cleaned) = validation { onSave(cleaned) }
                    }
                    .fontWeight(.semibold)
                    .disabled(!canSave)
                }
            }
        }
    }

    @ViewBuilder
    private func fieldInput(_ field: CredentialField) -> some View {
        let binding = Binding(
            get: { values[field.name] ?? "" },
            set: { values[field.name] = $0 }
        )
        VStack(alignment: .leading, spacing: 4) {
            Text(field.label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            Group {
                if field.secret == true {
                    SecureField(field.placeholder ?? "", text: binding)
                } else {
                    TextField(field.placeholder ?? "", text: binding)
                }
            }
            .font(.system(size: 14))
            .foregroundStyle(Theme.textPrimary)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(Theme.Spacing.sm)
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.medium)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            if let hint = field.patternHint {
                Text(hint)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
enum BackendsPreviewData {
    static func backends() -> [ModelManagement.BackendRow] {
        ModelManagement.httpBackends(populatedOverview())
    }

    /// A handful of cloud-provider presets for the add-backend grid. The ids
    /// match the real gateway preset ids (so `ProviderIcon` resolves the brand
    /// glyph); URLs/models are the documented defaults, not user data.
    static func presets() -> [ProviderPreset] {
        [
            ProviderPreset(
                id: "openai",
                name: "OpenAI",
                defaultUrl: "https://api.openai.com",
                knownModels: ["gpt-4o", "text-embedding-3-small"],
                capabilities: ["agent", "embed"]
            ),
            ProviderPreset(
                id: "groq",
                name: "Groq",
                defaultUrl: "https://api.groq.com/openai",
                knownModels: ["llama-3.3-70b-versatile"],
                capabilities: ["agent"]
            ),
            ProviderPreset(
                id: "together",
                name: "Together AI",
                defaultUrl: "https://api.together.xyz",
                capabilities: ["agent", "embed"]
            ),
            ProviderPreset(
                id: "google",
                name: "Google AI (Gemini)",
                defaultUrl: "https://generativelanguage.googleapis.com",
                apiPathPrefix: "/v1beta/openai",
                knownModels: ["gemini-2.5-flash"],
                capabilities: ["agent", "embed"]
            ),
        ]
    }

    /// Two provider rows — one configured, one not — exercising both states.
    /// Field spec mirrors the gateway's Anthropic spec (masked `apiKey` with a
    /// pattern). All sample data is invented per the privacy rule.
    static func credentials() -> [ModelCredentialEntry] {
        [
            ModelCredentialEntry(
                fileKey: "anthropic",
                providerType: "anthropic",
                providerName: "Anthropic",
                spec: CredentialSpec(fields: [
                    CredentialField(
                        name: "apiKey",
                        label: "API Key",
                        placeholder: "sk-ant-…",
                        secret: true,
                        pattern: "^sk-ant-[A-Za-z0-9_-]+$",
                        patternHint: "API keys start with sk-ant- followed by letters, numbers, dashes or underscores."
                    ),
                ]),
                configured: true
            ),
            ModelCredentialEntry(
                fileKey: "example-provider",
                providerType: "openai",
                providerName: "Example Provider",
                spec: CredentialSpec(fields: [
                    CredentialField(
                        name: "apiKey",
                        label: "API Key",
                        placeholder: "sk-example-…",
                        secret: true
                    ),
                ]),
                configured: false
            ),
        ]
    }

    static func populatedOverview() -> ModelsOverview {
        ModelsOverview(
            assignmentDisplays: [:],
            capabilities: ModelsPreviewData.capabilities,
            inference: InferenceOverview(
                backends: [
                    "deepseek": BackendStatus(
                        type: "http",
                        status: "ok",
                        url: "https://api.deepseek.com/v1",
                        models: ["example-embed-v1", "example-chat-v1"],
                        modelRoles: [
                            "example-embed-v1": ["embedder"],
                            "example-chat-v1": ["agent"],
                        ],
                        hasApiKey: true
                    ),
                    "northstar": BackendStatus(
                        type: "http",
                        status: "ok",
                        url: "https://ocr.example/v1",
                        models: ["dots-ocr", "llama-vision-8b"],
                        modelRoles: ["dots-ocr": ["ocr"], "llama-vision-8b": ["ocr", "agent"]],
                        hasApiKey: true
                    ),
                    "studio-local": BackendStatus(
                        type: "http",
                        status: "unreachable",
                        url: "http://192.0.2.10:8000/v1",
                        models: [],
                        hasApiKey: false
                    ),
                ],
                codex: CodexBackendStatus(
                    configured: true,
                    status: "ok",
                    loggedIn: true,
                    models: ["gpt-example-frontier"],
                    modelDetails: [
                        CodexModelStatus(
                            id: "gpt-example-frontier",
                            name: "GPT Example Frontier",
                            description: "Example Codex model.",
                            recommended: true
                        ),
                    ],
                    modelRoles: ["gpt-example-frontier": ["agent", "background-agent"]],
                    refreshedAt: "2026-07-03T12:00:00Z"
                ),
                assignments: [:]
            ),
            catalog: [],
            installed: [],
            presets: presets()
        )
    }

    /// A single verifiable target for the standalone `VerifyRow` snapshots.
    static func verifyTarget() -> ModelManagement.VerifyTarget {
        ModelManagement.VerifyTarget(
            backendKey: "deepseek",
            model: "example-embed-v1",
            role: "embedder"
        )
    }
}

@available(iOS 17.0, *)
#Preview("BackendsView — list") {
    NavigationStack {
        BackendsView(
            previewOverview: BackendsPreviewData.populatedOverview(),
            previewCredentials: BackendsPreviewData.credentials()
        )
        .environment(AppStore.preview())
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AddBackendSheet — preset grid") {
    AddBackendSheet(
        presets: BackendsPreviewData.presets(),
        codex: BackendsPreviewData.populatedOverview().inference.codex
    )
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("CodexSetupSheet") {
    CodexSetupSheet(
        status: CodexBackendStatus(
            configured: true,
            status: "unreachable",
            loggedIn: false,
            models: [],
            reason: "OpenAI login pending."
        ),
        flow: CodexLoginFlow(
            id: "flow_1",
            status: "pending",
            verificationUri: "https://auth.openai.com/codex/device",
            userCode: "ABCD-12345",
            expiresAt: "2026-07-03T12:15:00Z"
        ),
        autoChecking: true
    )
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("SetCredentialSheet") {
    SetCredentialSheet(entry: BackendsPreviewData.credentials()[0])
        .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BackendDetailView — verify rows") {
    let backend = BackendsPreviewData.backends().first { $0.key == "northstar" }!
    return NavigationStack {
        BackendDetailView(
            row: backend,
            verifyStates: [
                "northstar/llama-vision-8b/agent": .verdict(supported: true, detail: "Chat completion returned 1 choice."),
            ]
        )
        .environment(AppStore.preview())
    }
    .preferredColorScheme(.dark)
}
#endif
#endif
