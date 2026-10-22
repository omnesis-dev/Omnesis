// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import SwiftUI

/// Follows growing speech until the reader moves away; the header never moves.
struct RealtimeTranscriptScrollView<Header: View, Content: View>: View {
    private let header: Header
    private let content: Content
    @State private var following = true
    @GestureState private var dragging = false
    @State private var previousFrame: CGRect?
    @State private var previousViewport: CGFloat = 0
    @State private var headerHeight: CGFloat = 0

    init(@ViewBuilder header: () -> Header, @ViewBuilder content: () -> Content) {
        self.header = header()
        self.content = content()
    }

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        content.padding(.top, headerHeight + 16).padding(.bottom, 16)
                        Color.clear.frame(height: 1).id("realtime.latest")
                    }
                    .frame(maxWidth: .infinity)
                    .onGeometryChange(for: CGRect.self) { geometry in
                        geometry.frame(in: .named("realtime.transcript"))
                    } action: { frame in
                        track(frame, viewport: viewport.size.height, proxy: proxy)
                    }
                }
                .coordinateSpace(name: "realtime.transcript")
                .overlay(alignment: .top) {
                    header.onGeometryChange(for: CGFloat.self) { geometry in
                        geometry.size.height
                    } action: { height in
                        headerHeight = height
                    }
                }
                .accessibilityIdentifier("realtime.transcript")
                .simultaneousGesture(DragGesture(minimumDistance: 8)
                    .updating($dragging) { _, state, _ in state = true }
                    .onChanged { _ in following = false })
                .onChange(of: dragging) { _, active in
                    if !active, let previousFrame {
                        following = previousFrame.maxY <= previousViewport + 36
                    }
                }
                .overlay(alignment: .bottom) {
                    if !following {
                        Button {
                            following = true
                            proxy.scrollTo("realtime.latest", anchor: .bottom)
                        } label: {
                            Label("Latest speech", systemImage: "arrow.down")
                                .font(.callout.weight(.medium))
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                        .accessibilityLabel("Return to latest speech")
                        .padding(.bottom, 8)
                    }
                }
            }
        }
    }

    private func track(_ frame: CGRect, viewport: CGFloat, proxy: ScrollViewProxy) {
        guard frame.height > 0, viewport > 0 else { return }
        let resized = previousFrame.map { abs($0.height - frame.height) > 0.5 } ?? true
        let viewportChanged = abs(viewport - previousViewport) > 0.5
        if !dragging, frame.maxY <= viewport + 36 {
            following = true
        } else if let previousFrame, !viewportChanged {
            // A reader can move back during the same layout pass that appends
            // speech. Owned jumps toward the latest words move the other way.
            let movedBack = frame.minY > previousFrame.minY + 0.5
            let movedWithoutGrowth = !resized && abs(previousFrame.minY - frame.minY) > 0.5
            if movedBack || movedWithoutGrowth { following = false }
        }
        previousFrame = frame
        previousViewport = viewport
        if following, !dragging, resized || viewportChanged {
            proxy.scrollTo("realtime.latest", anchor: .bottom)
        }
    }
}

#if DEBUG
#Preview("Voice transcript · Streaming") {
    RealtimeTranscriptScrollView {
        RealtimeVoiceHalo(activity: .agent, muted: false)
            .padding()
            .frame(maxWidth: .infinity)
            .background(Theme.bgPrimary)
    } content: {
        Text(PreviewMocks.realtimeLongCaption).padding()
    }
}
#endif
#endif
