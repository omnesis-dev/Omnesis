// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Native MCP authorization. No request detail appears until the paired
/// owner submits the short code displayed by the initiating client, or opens
/// a request the gateway's overview already lists as waiting.
@available(iOS 17.0, *)
struct AccessAuthorizationSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var code = ""
    @State private var request: AccessAuthorizationRequest?
    /// The principal a gateway without connection proposals would reconnect
    /// the client to; only that gateway's flow reads it.
    @State private var reconnect: AccessReconnectProposal?
    /// The Connection step's choices; nil when the gateway offers no
    /// Connection step.
    @State private var choice: AccessConnectionChoice?
    @State private var overview: AccessOverview?
    @State private var form = AccessAuthorizationFormState(sourceIds: [])
    @State private var loading = false
    @State private var lookupError: Error?
    @State private var actionError: Error?
    @State private var actionChoiceRefresh = AccessAuthorizationChoiceRefresh.notAttempted
    @State private var deciding = false
    @State private var generation = 0
    @State private var step = AccessAuthorizationStep.permissions
    @State private var outcome: AccessAuthorizationOutcome?
    /// The waiting request this sheet was opened for, when it was opened from
    /// the overview rather than from a code. Cleared when that request can no
    /// longer be read, so the sheet falls back to asking for a code.
    @State private var requestId: String?

    private let initialLookup: AccessAuthorizationLookupKey?

    init(initialCode: String? = nil, automaticallyLookup: Bool = true) {
        initialLookup = automaticallyLookup ? initialCode.map { AccessAuthorizationLookupKey.code($0) } : nil
        _code = State(initialValue: initialCode ?? "")
        _loading = State(initialValue: initialCode != nil && !automaticallyLookup)
    }

    /// Open straight onto a request the overview lists as waiting.
    init(requestId: String) {
        initialLookup = .id(requestId)
        _requestId = State(initialValue: requestId)
        _loading = State(initialValue: true)
    }

    #if DEBUG
    init(
        previewRequest: AccessAuthorizationRequest,
        overview: AccessOverview,
        mode: AccessAuthorizationPreviewMode
    ) {
        initialLookup = nil
        _request = State(initialValue: previewRequest)
        _overview = State(initialValue: overview)
        let state = AccessAuthorizationPreviewState(request: previewRequest, overview: overview, mode: mode)
        _choice = State(initialValue: state.choice)
        _form = State(initialValue: state.form)
        _step = State(initialValue: state.step)
        _actionError = State(initialValue: state.actionError)
        _actionChoiceRefresh = State(initialValue: state.actionChoiceRefresh)
        _outcome = State(initialValue: state.outcome)
    }

    /// The code form as it stands once a lookup has failed: what a sheet
    /// opened from the home banner shows when its request cannot be read.
    init(previewLookupError: Error) {
        initialLookup = nil
        _lookupError = State(initialValue: previewLookupError)
    }

    #endif

    var body: some View {
        NavigationStack {
            Group {
                if let outcome {
                    AccessAuthorizationOutcomeContent(
                        outcome: outcome,
                        clientName: request?.clientName,
                        onDone: { dismiss() }
                    )
                } else if let request, let overview {
                    decisionView(request: request, overview: overview)
                } else {
                    AccessAuthorizationCodeEntry(
                        code: $code,
                        loading: loading,
                        errorMessage: lookupError.map(accessAuthorizationLookupMessage),
                        onLookup: { Task { await lookup() } }
                    )
                }
            }
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            // Value-based so the document is built only once it is navigated
            // to, and keeps its loading state however often the decision
            // content it is reached from is rebuilt.
            .navigationDestination(for: AccessPolicyTextRoute.self) { route in
                PrivacyPolicyScreen(familyId: route.familyId, name: route.name)
            }
            .toolbar {
                if outcome == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .disabled(deciding)
                    }
                }
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
        }
        .omnesisColorScheme()
        .onDisappear { generation += 1 }
        .task {
            guard initialLookup != nil else { return }
            await lookup()
        }
    }

    private var navigationTitle: String {
        if let outcome {
            return outcome == .approved ? "Access granted" : "Request denied"
        }
        return request == nil ? "Connect an agent" : "Review access"
    }

    private func decisionView(
        request: AccessAuthorizationRequest,
        overview: AccessOverview
    )
        -> some View {
        VStack(spacing: 0) {
            requestHeader(request: request)
            Form {
                // A taken level name is explained under the field it is about.
                if let actionError, !accessAuthorizationIsLevelNameTaken(actionError) {
                    Section("Authorization changed") {
                        Text(accessAuthorizationDecisionMessage(
                            errorCode: accessAuthorizationErrorCode(actionError),
                            choiceRefresh: actionChoiceRefresh
                        ))
                        .foregroundStyle(Theme.warning)
                    }
                    .listRowBackground(Theme.bgSecondary)
                }
                stepContent(request: request, overview: overview)
            }
            .onChange(of: choice?.levelName) {
                if let actionError, accessAuthorizationIsLevelNameTaken(actionError) {
                    self.actionError = nil
                }
            }
            .scrollContentBackground(.hidden)
            // The header above already separates itself with its own padding;
            // the list's default top inset on top of that reads as a gap.
            .contentMargins(.top, Theme.Spacing.sm, for: .scrollContent)
            .background(Theme.bgPrimary)
            wizardActions(request: request, overview: overview)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.sm)
                .background(Theme.bgPrimary)
        }
    }

    /// Who is asking and how long the request stands, above the wizard itself.
    ///
    /// This is the page's own furniture: it does not scroll away with a step's
    /// questions, and it is not a card, so the numbered steps below it read as
    /// the progress through the whole screen.
    private func requestHeader(request: AccessAuthorizationRequest) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                // The name is whatever the client called itself, so it is
                // labelled as self-reported rather than presented as an
                // identity Omnesis verified.
                Text("Client name, self-reported")
                    .font(.caption2)
                    .foregroundStyle(Theme.textMuted)
                Text(request.clientName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                // The deadline is the only part of the page that moves, so it
                // alone is redrawn every second.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let nowMillis = Int64(context.date.timeIntervalSince1970 * 1000)
                    Text(accessAuthorizationDeadlineText(expiresAt: request.expiresAt, nowMillis: nowMillis))
                        .font(.caption)
                        .foregroundStyle(nowMillis >= request.expiresAt ? Theme.warning : Theme.textMuted)
                }
            }
            AccessAuthorizationStepIndicator(
                steps: steps,
                current: step,
                compact: dynamicTypeSize.isAccessibilitySize,
                onSelect: { step = $0 }
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.sm)
        .background(Theme.bgPrimary)
    }

    @ViewBuilder
    private func stepContent(
        request: AccessAuthorizationRequest,
        overview: AccessOverview
    )
        -> some View {
        switch step {
        case .connection:
            if let current = choice {
                AccessAuthorizationConnectionStep(
                    // Reads fall back to the choice this step was drawn with,
                    // so a frame that still shows the step after the choice
                    // is cleared has something to read.
                    choice: Binding(get: { choice ?? current }, set: { choice = $0 }),
                    request: request,
                    overview: overview,
                    levelNameRefusal: levelNameTaken ? AccessConnectionCopy.levelNameTaken : nil
                )
            }
        case .permissions:
            permissionsStep(request: request)
        case .data:
            if form.answerActive(request: request), form.directEnabled {
                sourceBoundaryChoice()
            }
            ForEach(form.sourceScopes(request: request), id: \.self) { scope in
                AccessSourceRuleEditor(
                    scope: scope,
                    value: Binding(
                        get: { form.sources(for: scope) },
                        set: { form.setSources($0, for: scope) }
                    ),
                    sources: overview.sources,
                    store: store
                )
            }
            if form.answerActive(request: request) {
                AccessAnswerReleaseSection(form: $form, overview: overview)
            }
        case .review:
            AccessAuthorizationReviewSection(
                request: request,
                overview: overview,
                connection: choice?.review(overview: overview)
                    ?? .legacy(request: request, reconnect: reconnect),
                form: choice?.reviewForm(request: request, overview: overview, form: form) ?? form
            )
        }
    }

    private func permissionsStep(request: AccessAuthorizationRequest) -> some View {
        Section("What should this connection be allowed to do?") {
            Toggle(isOn: Binding(
                get: { form.answerActive(request: request) },
                set: { form.answerEnabled = request.requiresAnswer ? true : $0 }
            )) {
                permissionLabel(
                    title: "Answer",
                    detail: "Ask questions using allowed sources. A privacy policy can "
                        + "review every answer before it is released."
                )
            }
            .disabled(request.requiresAnswer)
            Toggle(isOn: $form.directEnabled) {
                permissionLabel(
                    title: "Direct",
                    detail: "Search and read raw matching records.",
                    // The consequence sits in Direct's own description and
                    // speaks up once Direct is chosen — before that it is
                    // one option among three.
                    warning: "Direct is not protected by a privacy policy.",
                    warningActive: form.directEnabled
                )
            }
            Toggle(isOn: $form.notesEnabled) {
                permissionLabel(
                    title: "Notes",
                    detail: "Save notes with Tell Omnesis. The agent’s name is recorded "
                        + "with each note. This does not grant access to read existing notes."
                )
            }
            if request.requiresAnswer {
                Text("Answer is required by this integration.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if !form.holdings(request: request).holdsAnything {
                Text(accessNoCapabilityMessage)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
            }
        }
        .listRowBackground(Theme.bgSecondary)
    }

    /// One source list or two, as a plain pair of options worded as what they
    /// do — the same shape as the new-source choice inside each list, so the
    /// two read as siblings.
    private func sourceBoundaryChoice() -> some View {
        // No header: the two options name the object and the choice, and a
        // heading above them would only restate the list heading below.
        Section {
            sourceBoundaryOption(
                linked: true,
                title: "Allow the same sources for Answer and Direct",
                detail: "One selection controls both capabilities."
            )
            sourceBoundaryOption(
                linked: false,
                title: "Allow different sources",
                detail: "Direct may expose raw records, so a narrower boundary can be useful."
            )
        }
        .listRowBackground(Theme.bgSecondary)
    }

    private func sourceBoundaryOption(
        linked: Bool,
        title: String,
        detail: String
    )
        -> some View {
        Button {
            // Unlinking starts Direct from the list the two shared, so the
            // separate list opens where the shared one left off.
            if !linked, form.linkSources { form.directSources = form.answerSources }
            form.linkSources = linked
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(
                    systemName: form.linkSources == linked
                        ? "largecircle.fill.circle"
                        : "circle"
                )
                .foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.textPrimary)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(form.linkSources == linked ? .isSelected : [])
    }

    private func permissionLabel(
        title: String,
        detail: String,
        warning: String? = nil,
        warningActive: Bool = false
    )
        -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).fontWeight(.semibold)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let warning {
                Text(warning)
                    .font(warningActive ? .footnote.weight(.bold) : .footnote)
                    .foregroundStyle(warningActive ? Theme.danger : Theme.textSecondary)
            }
        }
    }
}

/// The policy family this grant would be judged against, pushed read-only so
/// the owner can read the rules before agreeing to them.
struct AccessPolicyTextRoute: Hashable {
    let familyId: String
    let name: String?
}

@available(iOS 17.0, *)
extension AccessAuthorizationSheet {
    private var steps: [AccessAuthorizationStep] {
        // Data & privacy asks which sources a capability may read and how its
        // answers are released. A Notes-only grant has neither question, so
        // the step is skipped rather than shown empty.
        let readsSources = form.directEnabled
            || form.answerEnabled
            || request?.requiresAnswer == true
        return accessAuthorizationSteps(choice: choice, readsSources: readsSources)
    }

    /// Whether the last approval was refused for its access level name. The
    /// refusal stands until that name is edited.
    private var levelNameTaken: Bool {
        actionError.map(accessAuthorizationIsLevelNameTaken) ?? false
    }

    private func wizardActions(
        request: AccessAuthorizationRequest,
        overview: AccessOverview
    )
        -> some View {
        let currentSteps = steps
        let index = currentSteps.firstIndex(of: step) ?? 0
        let last = index == currentSteps.count - 1
        return HStack(spacing: Theme.Spacing.sm) {
            if index == 0 {
                Button("Deny", role: .destructive) {
                    Task { await decide(request: request, overview: overview, approve: false) }
                }
                .disabled(deciding)
            } else {
                Button("Back") { step = currentSteps[index - 1] }
                    .buttonStyle(.bordered)
                    .disabled(deciding)
            }
            Spacer()
            // Of the actions, only this one depends on the clock: it stops
            // accepting once the request has expired.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Button(last ? "Allow access" : "Continue") {
                    if last {
                        Task { await decide(request: request, overview: overview, approve: true) }
                    } else {
                        step = currentSteps[index + 1]
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    deciding || Int64(context.date.timeIntervalSince1970 * 1000) >= request.expiresAt
                        || !canContinue(request: request, overview: overview)
                )
            }
        }
    }

    private func canContinue(
        request: AccessAuthorizationRequest,
        overview: AccessOverview
    )
        -> Bool {
        switch step {
        case .connection:
            choice.map {
                $0.isComplete(request: request, overview: overview) && !$0.levelNameRefusalApplies(levelNameTaken)
            } ?? true
        case .permissions:
            form.holdings(request: request).holdsAnything
        case .data, .review:
            selection(request: request, overview: overview) != nil
        }
    }

    /// What approval sends: the Connection step's choice, or the `connect`
    /// selection a gateway without connection proposals accepts.
    private func selection(
        request: AccessAuthorizationRequest,
        overview: AccessOverview
    )
        -> AccessAuthorizationSelection? {
        guard let choice else { return form.selection(request: request, overview: overview) }
        // A level name the gateway refused is not sent again unedited.
        guard !choice.levelNameRefusalApplies(levelNameTaken) else { return nil }
        return choice.selection(request: request, overview: overview, form: form)
    }

    @MainActor
    private func lookup() async {
        guard let client = store.access else {
            lookupError = URLError(.userAuthenticationRequired)
            return
        }
        generation += 1
        let ownedGeneration = generation
        let key = lookupKey
        loading = true
        lookupError = nil
        defer { if generation == ownedGeneration { loading = false } }
        do {
            let envelope = try await fetch(client, key: key)
            let loadedRequest = envelope.request
            switch accessAuthorizationLookupDisposition(
                status: loadedRequest.status,
                expiresAt: loadedRequest.expiresAt,
                nowMillis: Int64(Date().timeIntervalSince1970 * 1000)
            ) {
            case .approved:
                guard generation == ownedGeneration else { return }
                request = loadedRequest
                outcome = .approved
                return
            case .denied:
                guard generation == ownedGeneration else { return }
                request = loadedRequest
                outcome = .denied
                return
            case .expired:
                throw AccessAuthorizationLocalError.expired
            case .alreadyDecided:
                throw AccessAuthorizationLocalError.alreadyDecided
            case .pending:
                break
            }
            // The overview contains client-independent authority choices, but
            // is intentionally fetched only after the code resolved.
            let loadedOverview = try await client.overview()
            guard generation == ownedGeneration else { return }
            request = loadedRequest
            openChoices(request: loadedRequest, overview: loadedOverview, lookup: envelope)
        } catch {
            guard generation == ownedGeneration else { return }
            lookupError = accessAuthorizationLookupFailure(error, key: key)
            // A request that cannot be read by id has nothing left to retry;
            // the sheet becomes the code form, with the failure explained.
            if case .id = key { requestId = nil }
        }
    }

    @MainActor
    private func decide(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
        approve: Bool
    ) async {
        let nowMillis = Int64(Date().timeIntervalSince1970 * 1000)
        guard accessAuthorizationMayBeginDecision(
            deciding: deciding,
            expiresAt: request.expiresAt,
            nowMillis: nowMillis
        ) else {
            if !deciding { actionError = AccessAuthorizationLocalError.expired }
            return
        }
        guard let client = store.access else {
            actionError = URLError(.userAuthenticationRequired)
            return
        }
        let decision: AccessAuthorizationDecision
        if approve {
            guard let selection = selection(request: request, overview: overview) else {
                return
            }
            decision = .approve(selection)
        } else {
            decision = .deny
        }
        deciding = true
        actionError = nil
        actionChoiceRefresh = .notAttempted
        do {
            try await client.decide(approvalId: request.approvalId, decision: decision)
            deciding = false
            outcome = approve ? .approved : .denied
        } catch {
            let current = await lookupAgain(client: client, requestId: request.id)
            if let current, accessAuthorizationDecisionWasRecorded(status: current.request.status, approve: approve) {
                deciding = false
                outcome = approve ? .approved : .denied
                return
            }
            if accessAuthorizationIsTerminalError(error) {
                deciding = false
                actionError = error
                return
            }
            if accessAuthorizationIsStaleSelectionError(error) {
                await reloadChoices(client: client, request: request, lookup: current)
            }
            if let next = accessAuthorizationRefusalStep(
                error: error,
                hasChoice: choice != nil,
                refreshed: actionChoiceRefresh == .refreshed
            ) {
                step = next
            }
            actionError = error
            deciding = false
        }
    }

    private var normalizedCode: String {
        code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    /// A sheet opened for a listed request keeps reading it by id; every
    /// other sheet reads whatever the code names now.
    private var lookupKey: AccessAuthorizationLookupKey {
        requestId.map { AccessAuthorizationLookupKey.id($0) } ?? .code(normalizedCode)
    }

    /// One envelope whichever way the sheet was opened. Failures are thrown
    /// as the client raised them; `lookup()` reads them by key.
    private func fetch(
        _ client: AccessClient,
        key: AccessAuthorizationLookupKey
    ) async throws
        -> AccessAuthorizationLookupEnvelope {
        switch key {
        case .code(let code):
            try await client.lookup(code: code)
        case .id(let id):
            try await client.lookup(id: id)
        }
    }

    /// The request as the gateway holds it now, or nil when it cannot be read
    /// or the code has come to name a different request.
    @MainActor
    private func lookupAgain(
        client: AccessClient,
        requestId: String
    ) async
        -> AccessAuthorizationLookupEnvelope? {
        guard let envelope = try? await fetch(client, key: lookupKey),
              envelope.request.id == requestId else { return nil }
        return envelope
    }

    /// A refused selection means the access the wizard offered is no longer
    /// what the gateway has: a level or connection it offered may be gone or
    /// changed, and the sources or policies may have changed. The lookup and
    /// the overview are both taken fresh, so the wizard reopens on the
    /// Connection step describing what still exists. The names the owner
    /// typed are kept while the refreshed choice opens on the same path; the
    /// permissions are drawn again from the refreshed proposal.
    @MainActor
    private func reloadChoices(
        client: AccessClient,
        request: AccessAuthorizationRequest,
        lookup: AccessAuthorizationLookupEnvelope?
    ) async {
        guard let lookup, let refreshed = try? await client.overview() else {
            actionChoiceRefresh = .failed
            return
        }
        let previous = choice
        openChoices(request: request, overview: refreshed, lookup: lookup)
        choice = choice?.keepingNames(from: previous)
        actionChoiceRefresh = .refreshed
    }

    /// Open the wizard on what a lookup proposes, over the overview taken
    /// with it.
    @MainActor
    private func openChoices(
        request: AccessAuthorizationRequest,
        overview loaded: AccessOverview,
        lookup envelope: AccessAuthorizationLookupEnvelope
    ) {
        let opening = AccessAuthorizationOpening(
            request: request,
            overview: loaded,
            connection: envelope.connection,
            reconnect: envelope.reconnect,
            nowMillis: Int64(Date().timeIntervalSince1970 * 1000)
        )
        reconnect = envelope.reconnect
        overview = loaded
        choice = opening.choice
        form = opening.form
        step = opening.step
    }
}

#if DEBUG
#Preview("Access permissions including Notes") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .permissions
    )
    .environment(AppStore.preview())
}

#Preview("Notes-only access review") {
    AccessAuthorizationSheet(
        previewRequest: PreviewMocks.accessAuthorizationRequest,
        overview: PreviewMocks.accessOverview,
        mode: .notesOnly
    )
    .environment(AppStore.preview())
}

#Preview("Request no longer waiting") {
    AccessAuthorizationSheet(previewLookupError: AccessAuthorizationLocalError.noLongerPending)
        .environment(AppStore.preview())
}
#endif

#endif
