// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Environment handler that presents the quick-capture surface
/// (`CaptureView`) as a full-screen cover. Injected by the app shell
/// (`HomeView`), which owns the presentation state; the default no-op
/// is only hit by previews and snapshots. The drawer row calls this
/// action; the Lock Screen / Control Center control reaches
/// the same presentation through `CaptureRouter`. Mirrors
/// `openAgentConversation`.
private struct OpenCaptureKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var openCapture: (() -> Void)? {
        get { self[OpenCaptureKey.self] }
        set { self[OpenCaptureKey.self] = newValue }
    }
}

/// "Tell Omnesis" quick capture: full-screen, listening from the
/// moment it appears. The live transcript lands in an editable text
/// area (typing works whenever speech is stopped, and is the only
/// path when speech permission is denied); Done delivers the note —
/// POST to the gateway, or the durable offline queue when unreachable
/// — then confirms and auto-dismisses. Swipe down or Cancel discards
/// (after a confirmation when there is text to lose).
@available(iOS 17.0, *)
struct CaptureView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    /// Attribution slug for the entry point that opened the surface.
    let surface: NoteSurface

    /// How the surface leaves. The app shell renders capture inside the
    /// menu-reveal container rather than as a full-screen cover — a cover sits
    /// outside the container, and the swipe that reveals the menu from every
    /// other surface would do nothing here — so there is no presentation to
    /// dismiss and the shell hands down its own teardown. Previews and
    /// snapshots, which really are presented, fall back to `dismiss`.
    var onClose: (() -> Void)?

    @State private var speech: SpeechRecognizer
    @State private var text: String = ""
    @State private var phase: Phase
    /// Text committed before the current dictation run. The recognizer
    /// resets its transcript on every (re)start, so live partials
    /// render `dictationBase + partial` — stopping and resuming the mic
    /// must never wipe what was already captured.
    @State private var dictationBase: String = ""
    /// `text` as it was when the user stopped dictation. While the
    /// recognizer finishes up, the field stays editable; the late final
    /// transcript is only committed if `text` still matches this value
    /// — a user edit during the finishing window wins.
    @State private var textAtStop: String?
    /// Deterministic save rejection (over-long note, gateway 400/413/
    /// 422) shown inline; the text stays in the editor for fixing.
    @State private var saveError: String?
    @State private var confirmDiscard = false
    @FocusState private var keyboardFocused: Bool

    enum Phase: Equatable {
        /// Capturing (listening, or stopped with editable text).
        case capturing
        /// Save in flight.
        case saving
        /// Save landed; showing the confirmation before auto-dismiss.
        case done(NoteCaptureService.Outcome)
    }

    init(
        surface: NoteSurface = .app,
        onClose: (() -> Void)? = nil,
        speech: SpeechRecognizer = SpeechRecognizer(),
        previewText: String = "",
        previewPhase: Phase = .capturing,
        previewSaveError: String? = nil
    ) {
        self.surface = surface
        self.onClose = onClose
        self._speech = State(initialValue: speech)
        self._text = State(initialValue: previewText)
        self._phase = State(initialValue: previewPhase)
        self._saveError = State(initialValue: previewSaveError)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Spacer(minLength: Theme.Spacing.lg)
            micCluster
            Spacer(minLength: Theme.Spacing.lg)
            transcriptArea
            saveErrorLine
            doneButton
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.lg)
        // Recede behind the confirmation card once the note is on its way.
        .opacity(phase == .capturing || phase == .saving ? 1 : 0.35)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Background as a modifier (not a ZStack sibling): a
        // `Color.ignoresSafeArea()` laid out INSIDE a fixed-size
        // container inflates it past its frame and shoves the bottom
        // row off-screen.
        //
        // The same wash the agent landing screen sits on, with the halo
        // centred on the mic — this surface is its sibling: one calm screen
        // with a single glowing subject in the middle.
        .background(LandingBackdrop(focusY: Self.micCentreY))
        .overlay {
            if case .done(let outcome) = phase {
                confirmationOverlay(outcome)
            }
        }
        .omnesisColorScheme()
        // Swipe-down anywhere discards, mirroring a sheet's pull-down
        // (full-screen covers don't get that gesture for free). High
        // threshold + strong downward bias so vertical scrolling inside
        // the transcript editor doesn't trigger it.
        .gesture(
            DragGesture(minimumDistance: 30)
                .onEnded { value in
                    if value.translation.height > 120,
                       value.translation.height > abs(value.translation.width) * 2 {
                        cancel()
                    }
                }
        )
        .confirmationDialog(
            "Discard this note?",
            isPresented: $confirmDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
                speech.cancel()
                close()
            }
            Button("Keep editing", role: .cancel) {}
        }
        .onAppear {
            // Listening starts the moment the surface appears — that is
            // the point of the feature. Chained onto the permission
            // grants so a first-ever run prompts, then starts.
            if phase == .capturing, speech.state == .idle, text.isEmpty {
                speech.requestPermissionsAndStart()
            }
        }
        .onDisappear {
            // Belt and braces: never leave the audio session running
            // behind a dismissed cover.
            if speech.isListening { speech.cancel() }
        }
        .onChange(of: text) {
            saveError = nil
        }
        .onChange(of: speech.transcript) { _, newValue in
            if speech.isListening {
                text = DictationTranscript.compose(base: dictationBase, partial: newValue)
            }
        }
        .onChange(of: speech.state) { oldValue, newValue in
            // Commit the final transcript when recognition wraps up —
            // appended onto the dictation base, and only if the user
            // hasn't edited the text since stopping (their edit wins
            // over a late final-transcript callback). Hand the user the
            // keyboard when speech isn't available at all.
            if oldValue == .listening || oldValue == .finishing,
               newValue == .idle {
                if !speech.transcript.isEmpty, textAtStop == nil || text == textAtStop {
                    text = DictationTranscript.compose(base: dictationBase, partial: speech.transcript)
                }
                textAtStop = nil
            }
            if newValue == .unavailable {
                keyboardFocused = true
            }
        }
    }

    // MARK: - Pieces

    private var header: some View {
        HStack {
            Button("Cancel") { cancel() }
                .font(.system(size: 16))
                .foregroundStyle(Theme.textSecondary)
                .accessibilityLabel("Cancel capture")
            Spacer()
            Text("Tell Omnesis")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Spacer()
            // Mirror the Cancel button's width so the title stays
            // optically centered.
            Text("Cancel").font(.system(size: 16)).hidden()
        }
        .padding(.top, Theme.Spacing.sm)
    }

    /// Where the mic's centre sits, as a fraction of the screen's height. The
    /// halo behind it is anchored to the same fraction.
    private static let micCentreY: CGFloat = 0.43

    /// The mic as this screen's subject — lit and breathing while the recogniser
    /// is hot, the way the Omnesis mark is lit on the agent landing screen.
    /// Tappable to stop and restart. Under it, one line of state copy.
    private var micCluster: some View {
        VStack(spacing: Theme.Spacing.md) {
            Button {
                micTapped()
            } label: {
                ZStack {
                    // Rings radiating off the mic while the recogniser is hot.
                    // The glyph's own breath is the subtle part of the cue; this
                    // is the unmissable part — a recording surface has to say so
                    // in a way a glance catches.
                    if speech.isListening {
                        // Starting just outside the glyph: a ring that begins
                        // inside it cuts across the mic on the first frame of
                        // every cycle.
                        MicPulseRing(color: LandingPalette.markMid)
                            .frame(width: 104, height: 104)
                    }
                    if speech.state == .unavailable {
                        LandingMicUnavailableGlyph()
                    } else {
                        LandingMicGlyph(isListening: speech.isListening)
                    }
                }
                // The glyph is a mic shape, not a disc, so the tap target has to
                // be declared rather than inherited from the artwork.
                .frame(width: 96, height: 96)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(speech.state == .unavailable || phase != .capturing)
            .accessibilityLabel(speech.isListening ? "Stop listening" : "Start listening")

            Text(stateCopy)
                .font(.system(size: 14))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
    }

    private var stateCopy: String {
        switch speech.state {
        case .listening: "Listening — tap Done when you're finished"
        case .finishing: "Finishing up…"
        case .unavailable: "Speech recognition isn't available — type your note instead"
        case .idle: text.isEmpty ? "Tap the mic to talk, or just type" : "Tap the mic to keep talking"
        }
    }

    private static let transcriptShape = RoundedRectangle(cornerRadius: 20, style: .continuous)

    /// Live transcript / manual entry. Editable whenever speech is
    /// stopped; while listening the recognizer owns the text, so a tap
    /// stops listening first and then hands over the keyboard.
    private var transcriptArea: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(speech.isListening ? "Start speaking…" : "What should the brain remember?")
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.horizontal, Theme.Spacing.md + 4)
                    .padding(.vertical, Theme.Spacing.md + 8)
                    .allowsHitTesting(false)
            }
            TextField("", text: $text, axis: .vertical)
                .font(.system(size: 17))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(3 ... 10)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.md)
                .focused($keyboardFocused)
                .disabled(speech.isListening || phase != .capturing)
                .accessibilityIdentifier("captureTranscript")
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        // The agent composer's chrome: a translucent fill over the wash rather
        // than an opaque card, and the same fine blue-gray rim.
        .background(Self.transcriptShape.fill(LandingPalette.fieldFill.opacity(0.72)))
        .background(Self.transcriptShape.fill(.ultraThinMaterial))
        .overlay(
            Self.transcriptShape
                .strokeBorder(
                    speech.isListening ? Theme.accent.opacity(0.6) : LandingPalette.fieldRim,
                    lineWidth: speech.isListening ? 1 : 0.8
                )
        )
        .clipShape(Self.transcriptShape)
        .contentShape(Rectangle())
        .onTapGesture {
            // Typing fallback: tapping the transcript while listening
            // stops the recognizer and opens the keyboard on the text
            // captured so far.
            if speech.isListening {
                stopDictation()
                keyboardFocused = true
            }
        }
        .padding(.bottom, Theme.Spacing.md)
        .animation(.easeInOut(duration: 0.2), value: speech.isListening)
    }

    /// Inline deterministic-rejection message (the note itself was
    /// refused). The text stays in the editor above for fixing.
    @ViewBuilder
    private var saveErrorLine: some View {
        if let saveError {
            Label(saveError, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(Theme.warning)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, Theme.Spacing.md)
        }
    }

    private var canSave: Bool {
        phase == .capturing && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var doneButton: some View {
        Button {
            Task { await save() }
        } label: {
            HStack(spacing: 8) {
                if phase == .saving {
                    ProgressView().tint(.white)
                }
                Text("Done")
                    .font(.system(size: 17, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                Capsule().fill(canSave ? Theme.accent : Theme.accent.opacity(0.35))
            )
        }
        .disabled(!canSave)
        .accessibilityIdentifier("captureDoneButton")
    }

    private func confirmationOverlay(_ outcome: NoteCaptureService.Outcome) -> some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: outcome == .saved ? "checkmark.circle.fill" : "tray.and.arrow.down.fill")
                .font(.system(size: 44, weight: .medium))
                .foregroundStyle(outcome == .saved ? Theme.success : Theme.warning)
            Text(confirmationTitle(outcome))
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            if let subtitle = confirmationSubtitle(outcome) {
                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(Theme.Spacing.xl)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        .transition(.scale(scale: 0.9).combined(with: .opacity))
    }

    private func confirmationTitle(_ outcome: NoteCaptureService.Outcome) -> String {
        switch outcome {
        case .saved: "Saved"
        case .queued(.unreachable): "Queued"
        case .queued(.featureOff), .queued(.unauthorized): "Saved on device"
        case .rejected, .failed: "Not saved"
        }
    }

    /// Honest per-cause copy for the queued confirmations, so the user
    /// knows whether waiting will fix it or whether the gateway needs
    /// their attention.
    private func confirmationSubtitle(_ outcome: NoteCaptureService.Outcome) -> String? {
        switch outcome {
        case .saved: nil
        case .queued(.unreachable): "Delivers when your gateway is reachable"
        case .queued(.featureOff): "Update your gateway to sync quick captures"
        case .queued(.unauthorized): "Re-pair with your gateway to sync"
        case .rejected, .failed: nil
        }
    }

    // MARK: - Actions

    private func close() {
        if let onClose {
            onClose()
        } else {
            dismiss()
        }
    }

    private func micTapped() {
        switch speech.state {
        case .listening: stopDictation()
        case .idle:
            keyboardFocused = false
            // Snapshot what's already captured/typed — the recognizer
            // resets its transcript on start, and partials compose onto
            // this base so resuming never wipes earlier text.
            dictationBase = text
            speech.startListening()
        case .finishing, .unavailable: break
        }
    }

    /// Stop the recognizer, remembering the on-screen text so a user
    /// edit made during the finishing window beats the late final
    /// transcript (see the `speech.state` onChange).
    private func stopDictation() {
        textAtStop = text
        speech.stopListening()
    }

    private func cancel() {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard hasText, phase == .capturing else {
            speech.cancel()
            close()
            return
        }
        // There is text to lose — stop the mic and ask first.
        if speech.isListening { stopDictation() }
        confirmDiscard = true
    }

    private func save() async {
        guard canSave else { return }
        // Snapshot the text BEFORE stopping the recognizer — a late
        // final-transcript callback must not mutate what gets saved.
        let noteText = text
        let captureTime = NoteCaptureTime.now()
        if speech.isListening { stopDictation() }
        keyboardFocused = false
        withAnimation(.easeInOut(duration: 0.15)) { phase = .saving }
        let outcome = await store.notes.save(
            text: noteText,
            surface: surface,
            captureTime: captureTime
        )
        switch outcome {
        case .rejected(let reason):
            // Deterministic refusal — keep the text in the editor for
            // shortening/fixing; nothing was queued.
            phase = .capturing
            saveError = reason
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return
        case .failed:
            // The one unacceptable path: gateway AND queue both failed.
            // Return the text to the user rather than pretending.
            phase = .capturing
            saveError = "Couldn't save the note — try again."
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return
        case .saved, .queued:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            withAnimation(.easeInOut(duration: 0.2)) { phase = .done(outcome) }
            try? await Task.sleep(nanoseconds: 900_000_000)
            close()
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Capture — listening") {
    CaptureView(
        speech: .preview(state: .listening),
        previewText: ""
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — transcribing") {
    CaptureView(
        speech: .preview(
            state: .listening,
            transcript: "Remember to book the dentist for Thursday morning and move the team retro to two"
        ),
        previewText: "Remember to book the dentist for Thursday morning and move the team retro to two"
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — stopped, editable") {
    CaptureView(
        speech: .preview(state: .idle),
        previewText: "Idea: use the garage wall for the climbing holds"
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — speech unavailable (typing fallback)") {
    CaptureView(speech: .preview(state: .unavailable))
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — saved confirmation") {
    CaptureView(
        speech: .preview(state: .idle),
        previewText: "Buy a spare charger for the office",
        previewPhase: .done(.saved)
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — queued confirmation") {
    CaptureView(
        speech: .preview(state: .idle),
        previewText: "Buy a spare charger for the office",
        previewPhase: .done(.queued(.unreachable))
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — queued, older gateway") {
    CaptureView(
        speech: .preview(state: .idle),
        previewText: "Buy a spare charger for the office",
        previewPhase: .done(.queued(.featureOff))
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — queued, needs re-pair") {
    CaptureView(
        speech: .preview(state: .idle),
        previewText: "Buy a spare charger for the office",
        previewPhase: .done(.queued(.unauthorized))
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — note rejected") {
    CaptureView(
        speech: .preview(state: .idle),
        previewText: "Idea: use the garage wall for the climbing holds",
        previewSaveError: "The gateway rejected this note (422). Edit it and try again."
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — very long transcript") {
    CaptureView(
        speech: .preview(state: .idle),
        previewText: String(
            repeating: "This is a long rambling thought that keeps going and needs to wrap across many lines. ",
            count: 6
        )
    )
    .environment(AppStore.preview())
}
#endif
#endif
