// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Step two of changing the Decision model: what the chosen provider needs.
/// A new backend asks for its name, its decision URL (or the values that
/// complete a preset's URL), an API key when the provider takes one — the one
/// key serves its chat models too when the provider has them — and the model.
/// A backend gaining decisions asks only for the model: it keeps its key. A
/// backend already answering decisions asks for the model and lets its URL
/// and key be changed; TypeSafe asks for the model and its key. A local or
/// hand-added server is asked for its models. A URL off the gateway's host
/// asks for cloud-inference consent before saving, when that is still off.
@available(iOS 17.0, *)
struct DecisionBackendForm: View {
    let choice: DecisionModelSetup.Choice
    let overview: ModelsOverview
    var actions: DecisionModelActions = .unavailable
    var onSave: (DecisionModelSetup.Draft) async throws -> Void = { _ in }
    var onRemove: (String) async throws -> Void = { _ in }

    @State private var name: String
    @State private var url: String
    @State private var paramValues: [String: String] = [:]
    @State private var apiKey = ""
    @State private var model: String
    @State private var probed: [String] = []
    @State private var probeNote: String?
    @State private var probing = false
    @State private var typesafeListed: Bool?
    @State private var saving = false
    @State private var saveError: String?
    @State private var consentPending = false
    @State private var confirmRemove = false
    private var isPreview = false

    /// How long typing settles before a server is asked for its models.
    private static let probeDelay = Duration.milliseconds(600)

    init(
        choice: DecisionModelSetup.Choice,
        overview: ModelsOverview,
        actions: DecisionModelActions = .unavailable,
        onSave: @escaping (DecisionModelSetup.Draft) async throws -> Void = { _ in },
        onRemove: @escaping (String) async throws -> Void = { _ in }
    ) {
        self.choice = choice
        self.overview = overview
        self.actions = actions
        self.onSave = onSave
        self.onRemove = onRemove
        let initial = DecisionModelSetup.formDefaults(choice, in: overview)
        _name = State(initialValue: initial.name)
        _url = State(initialValue: initial.url)
        _model = State(initialValue: initial.model)
    }

    #if DEBUG
    /// Preview/snapshot seam: typed values, probe results and a save error
    /// already on screen, and no gateway calls.
    init(
        choice: DecisionModelSetup.Choice,
        overview: ModelsOverview,
        previewParams: [String: String] = [:],
        previewURL: String? = nil,
        previewApiKey: String = "",
        previewModel: String? = nil,
        previewProbed: [String] = [],
        previewProbeNote: String? = nil,
        previewTypeSafeListed: Bool? = nil,
        previewError: String? = nil
    ) {
        self.init(choice: choice, overview: overview)
        _paramValues = State(initialValue: previewParams)
        if let previewURL { _url = State(initialValue: previewURL) }
        _apiKey = State(initialValue: previewApiKey)
        if let previewModel { _model = State(initialValue: previewModel) }
        _probed = State(initialValue: previewProbed)
        _probeNote = State(initialValue: previewProbeNote)
        _typesafeListed = State(initialValue: previewTypeSafeListed)
        _saveError = State(initialValue: previewError)
        isPreview = true
    }
    #endif

    // MARK: - What the choice is

    private var preset: ProviderPreset? {
        switch choice {
        case .preset(let preset): preset
        case .existing(let backend), .enable(let backend): backend.preset
        case .custom: nil
        }
    }

    /// A backend whose decision API is set up.
    private var existing: DecisionModelSetup.ExistingBackend? {
        if case .existing(let backend) = choice { return backend }
        return nil
    }

    /// A backend gaining its provider's decision API.
    private var enabling: DecisionModelSetup.ExistingBackend? {
        if case .enable(let backend) = choice { return backend }
        return nil
    }

    private var isTypeSafe: Bool {
        if case .preset(let preset) = choice { return preset.isTypeSafe }
        return false
    }

    private var isNewBackend: Bool {
        switch choice {
        case .preset(let preset): !preset.isTypeSafe
        case .custom: true
        case .existing, .enable: false
        }
    }

    /// Whether the decision URL comes from the preset, completed by the
    /// operator's values when it has `{key}` placeholders.
    private var urlFromPreset: Bool {
        (isNewBackend || enabling != nil) && preset?.decision != nil && !urlEditable
    }

    /// The backend's name once it exists; the header names the provider.
    private var title: String {
        existing?.key ?? enabling?.key ?? "Set up"
    }

    /// Whether the URL is typed in full: a backend already set up, a custom
    /// server, or a new local preset whose port the operator may have changed.
    private var urlEditable: Bool {
        if existing != nil { return true }
        guard isNewBackend else { return false }
        return preset == nil || (preset?.isLocal == true && preset?.decision?.urlParams.isEmpty != false)
    }

    private var keyField: DecisionModelSetup.KeyField {
        DecisionModelSetup.keyField(
            choice,
            in: overview,
            typesafeStored: DecisionModelSetup.typesafeKeyStored(listed: typesafeListed, in: overview)
        )
    }

    // MARK: - Validation

    private var nameError: String? {
        guard isNewBackend, !name.isEmpty else { return nil }
        return DecisionModelSetup.validateName(name, in: overview)
    }

    /// The decision endpoint this form saves, or nil while it is incomplete.
    private var resolvedURL: String? {
        if isTypeSafe { return overview.inference.typesafe?.url ?? preset?.decision?.url }
        if urlFromPreset, let decision = preset?.decision {
            guard case .ready(let filled) = DecisionModelSetup.fillURL(decision, values: paramValues) else { return nil }
            return filled
        }
        let typed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        return DecisionModelSetup.validateURL(typed) == nil ? typed : nil
    }

    private var urlError: String? {
        guard urlEditable, !url.isEmpty else { return nil }
        return DecisionModelSetup.validateURL(url)
    }

    private var canSave: Bool {
        if saving || model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if isNewBackend, DecisionModelSetup.validateName(name, in: overview) != nil { return false }
        if resolvedURL == nil { return false }
        if keyField.required, apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        return true
    }

    private var needsConsent: Bool {
        if isTypeSafe { return DecisionModelSetup.typesafeNeedsRemoteConsent(in: overview) }
        if let existing { return DecisionModelSetup.needsRemoteConsent(existing, url: url, in: overview) }
        guard let endpoint = resolvedURL else { return false }
        let openAIURL = isNewBackend ? preset?.defaultUrl : nil
        return DecisionModelSetup.needsRemoteConsent(urls: [endpoint] + [openAIURL].compactMap(\.self), in: overview)
    }

    /// What to ask a local or hand-added server for its models before it is
    /// saved; nil for anything else, or while the URL is incomplete. A
    /// backend gaining decisions lends its saved key.
    private var probeRequest: DecisionProbeRequest? {
        guard isNewBackend || enabling != nil, preset == nil || preset?.isLocal == true, let endpoint = resolvedURL else {
            return nil
        }
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        return DecisionProbeRequest(
            url: endpoint,
            auth: preset?.decision?.auth,
            apiKey: key.isEmpty ? nil : key,
            protocol: preset?.decision?.protocol,
            preset: preset?.id,
            backendKey: enabling?.key
        )
    }

    // MARK: - Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                header
                if let saveError {
                    DecisionResultLine(ok: false, text: saveError)
                }
                if isNewBackend {
                    DecisionTextField(label: "Name", placeholder: "my-decider", text: $name, error: nameError)
                }
                endpointFields
                keyInput
                DecisionModelField(
                    model: $model,
                    options: DecisionModelSetup.modelOptions(preset: preset, probed: probed),
                    probing: probing,
                    probeNote: probeNote
                )
                if let existing {
                    DecisionOutlineButton(title: removeTitle(existing), color: Theme.danger) { confirmRemove = true }
                        .disabled(saving)
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if saving {
                    ProgressView()
                } else {
                    Button("Save") { requestSave() }
                        .fontWeight(.semibold)
                        .disabled(!canSave)
                }
            }
        }
        .task { await prepare() }
        .task(id: probeRequest) { await probeUnsaved() }
        .alert(DecisionModelSetup.consentTitle, isPresented: $consentPending) {
            Button(DecisionModelSetup.consentConfirm) { save(enableRemote: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(DecisionModelSetup.consentMessage(model: model, provider: consentProvider))
        }
        .confirmationDialog(
            existing.map { "\(removeTitle($0))?" } ?? "",
            isPresented: $confirmRemove,
            titleVisibility: .visible
        ) {
            Button(existing?.status.servesOpenAI == true ? "Stop using" : "Remove", role: .destructive) { remove() }
        } message: {
            Text(removeMessage)
        }
    }

    private var consentProvider: String {
        preset?.name ?? resolvedURL.map(DecisionProviderList.hostLabel) ?? title
    }

    private func removeTitle(_ backend: DecisionModelSetup.ExistingBackend) -> String {
        backend.status.servesOpenAI ? "Stop using \(backend.key) for decisions" : "Remove \(backend.key)"
    }

    private var removeMessage: String {
        existing?.status.servesOpenAI == true
            ? "Its decision API is removed; its chat models and API key stay. A Decision model that uses it is turned off."
            : "The backend and its API key are deleted. A Decision model that uses it is turned off."
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                ProviderIcon(providerId: preset?.brandId ?? "http", size: 22)
                    .foregroundStyle(Theme.textPrimary)
                Text(preset?.name ?? "Other server")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
            }
            if !headerNote.isEmpty {
                Text(headerNote)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            links
        }
    }

    private var headerNote: String {
        if existing != nil { return "Already set up. Pick the model it should answer with." }
        if let enabling {
            return "Adds \(preset?.name ?? "its provider")'s decision models to \(enabling.key), "
                + "with the API key it already has."
        }
        guard let preset else { return "A server that answers System One decisions, on this machine or elsewhere." }
        let note = preset.decision?.note.map(DecisionProviderList.plainNote)
        let both = isNewBackend && preset.defaultUrl != nil ? "Its chat models are set up too, with the same API key." : nil
        return [note, both].compactMap(\.self).joined(separator: " ")
    }

    @ViewBuilder
    private var links: some View {
        let keyLink = keyField.shown ? preset?.decision?.keyUrl.flatMap(URL.init(string:)) : nil
        let docsLink = preset?.decision?.docsUrl.flatMap(URL.init(string:))
        if keyLink != nil || docsLink != nil {
            HStack(spacing: Theme.Spacing.lg) {
                if let keyLink {
                    Link("Get an API key", destination: keyLink)
                }
                if let docsLink {
                    Link("Documentation", destination: docsLink)
                }
            }
            .font(.system(size: 13, weight: .semibold))
            .tint(Theme.accent)
        }
    }

    @ViewBuilder
    private var endpointFields: some View {
        if urlEditable {
            DecisionTextField(
                label: "URL",
                placeholder: "http://127.0.0.1:8080/v1/systemone",
                text: $url,
                keyboard: .URL,
                error: urlError
            )
        } else if urlFromPreset, let decision = preset?.decision {
            ForEach(decision.urlParams) { param in
                DecisionTextField(
                    label: param.label,
                    placeholder: param.placeholder ?? "",
                    text: paramBinding(param.key)
                )
            }
            endpointCaption("Decision endpoint", resolvedURL ?? decision.url)
            if isNewBackend, let openAIURL = preset?.defaultUrl {
                endpointCaption("Chat models (OpenAI-compatible)", openAIURL)
            }
        }
    }

    private func endpointCaption(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            Text(value)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var keyInput: some View {
        let field = keyField
        if field.shown {
            DecisionTextField(
                label: keyLabel(field),
                placeholder: keyPlaceholder(field),
                text: $apiKey,
                secure: true,
                error: existing?.decision?.apiKeySecretError
            )
        }
    }

    private func keyLabel(_ field: DecisionModelSetup.KeyField) -> String {
        if field.required || isTypeSafe { return "API key" }
        return field.stored ? "New API key (optional)" : "API key (optional)"
    }

    private func keyPlaceholder(_ field: DecisionModelSetup.KeyField) -> String {
        if field.stored { return "Saved — leave blank to keep it" }
        if isTypeSafe { return "Your TypeSafe key" }
        return field.required ? "Paste the key" : "Leave blank for a server without one"
    }

    private func paramBinding(_ key: String) -> Binding<String> {
        Binding(get: { paramValues[key] ?? "" }, set: { paramValues[key] = $0 })
    }

    // MARK: - Actions

    /// Ask whether a TypeSafe key is stored, and a saved local or hand-added
    /// decision server for its models.
    private func prepare() async {
        guard !isPreview else { return }
        if isTypeSafe, typesafeListed == nil {
            typesafeListed = await actions.typesafeKeyListed()
        }
        guard let existing, existing.listsModels else { return }
        probing = true
        defer { probing = false }
        do {
            let result = try await actions.probe(existing.key)
            probed = result.models
            probeNote = DecisionModelSetup.probeNote(result)
        } catch {
            probeNote = deviceGatewayMessage(error)
        }
    }

    /// Ask a server not saved yet for its models once the URL and key stop
    /// changing. A gateway without the route, or any other failed request,
    /// leaves the preset's suggestions as they are.
    private func probeUnsaved() async {
        guard !isPreview, let request = probeRequest else { return }
        do {
            try await Task.sleep(for: Self.probeDelay)
        } catch {
            return
        }
        probing = true
        defer { probing = false }
        guard let result = try? await actions.probeURL(request), !Task.isCancelled else { return }
        probed = result.models
        probeNote = DecisionModelSetup.probeNote(result)
    }

    private func requestSave() {
        guard canSave else { return }
        if needsConsent {
            consentPending = true
        } else {
            save(enableRemote: false)
        }
    }

    private func save(enableRemote: Bool) {
        guard let endpoint = resolvedURL else { return }
        let draft = DecisionModelSetup.Draft(
            choice: choice,
            name: existing?.key ?? enabling?.key ?? name,
            url: endpoint,
            apiKey: apiKey,
            model: model,
            enableRemoteInference: enableRemote
        )
        saving = true
        saveError = nil
        Task {
            defer { saving = false }
            do {
                try await onSave(draft)
            } catch {
                saveError = "Could not save: \(deviceGatewayMessage(error))"
            }
        }
    }

    private func remove() {
        guard let existing else { return }
        saving = true
        saveError = nil
        Task {
            defer { saving = false }
            do {
                try await onRemove(existing.key)
            } catch {
                saveError = "Could not remove: \(deviceGatewayMessage(error))"
            }
        }
    }
}

/// The model to answer with: typed freely, or picked from the suggestions.
@available(iOS 17.0, *)
struct DecisionModelField: View {
    @Binding var model: String
    let options: [DecisionModelOption]
    var probing = false
    var probeNote: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            DecisionTextField(label: "Model", placeholder: "Model id", text: $model)
            if probing {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Asking the server for its models…")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                }
            } else if let probeNote {
                Text(probeNote)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !options.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                        if index > 0 { Divider().overlay(Theme.border) }
                        optionRow(option)
                    }
                }
                .background(Theme.bgSecondary)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.large).stroke(Theme.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            }
        }
    }

    private func optionRow(_ option: DecisionModelOption) -> some View {
        let selected = option.id == model.trimmingCharacters(in: .whitespacesAndNewlines)
        return Button { model = option.id } label: {
            HStack(spacing: Theme.Spacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.id)
                        .font(.system(size: 14, weight: selected ? .semibold : .regular))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let detail = DecisionModelSetup.modelDetail(option) {
                        Text(detail)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                }
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
#endif
