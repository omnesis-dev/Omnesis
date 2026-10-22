// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import SwiftUI
import UIKit

/// Follows growing speech until the reader moves away; the header never moves.
struct RealtimeTranscriptScrollView<Header: View, Content: View>: View {
    private let header: Header
    private let content: Content
    @State private var position = RealtimeTranscriptPosition()
    @State private var headerHeight: CGFloat = 0

    init(@ViewBuilder header: () -> Header, @ViewBuilder content: () -> Content) {
        self.header = header()
        self.content = content()
    }

    var body: some View {
        RealtimeTranscriptContainer(
            content: content
                .padding(.top, headerHeight + 16)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity),
            position: position
        )
        .overlay(alignment: .top) {
            header.onGeometryChange(for: CGFloat.self) { geometry in
                geometry.size.height
            } action: { height in
                headerHeight = height
            }
        }
        .overlay(alignment: .bottom) {
            if !position.following {
                Button { position.returnToLatest() } label: {
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

/// The native scroll view owns every offset write synchronously. Only the
/// button's presentation update is deferred outside UIKit layout callbacks.
@MainActor
@Observable
private final class RealtimeTranscriptPosition {
    private(set) var following = true
    @ObservationIgnored private weak var scrollView: RealtimeTranscriptNativeScrollView?
    @ObservationIgnored private var followsEnd = true
    @ObservationIgnored private var movingToEnd = false
    @ObservationIgnored private var notificationScheduled = false
    @ObservationIgnored private var previousViewport: CGSize = .zero
    @ObservationIgnored private var previousInsets: UIEdgeInsets = .zero

    func attach(to scroll: RealtimeTranscriptNativeScrollView) {
        guard scrollView !== scroll else { return }
        scrollView = scroll
        previousViewport = scroll.bounds.size
        previousInsets = scroll.adjustedContentInset
    }

    func detach(from scroll: RealtimeTranscriptNativeScrollView) {
        if scrollView === scroll { scrollView = nil }
    }

    func beginReading(on scroll: RealtimeTranscriptNativeScrollView) {
        guard scrollView === scroll else { return }
        followsEnd = false
        publish()
    }

    func endReading(on scroll: RealtimeTranscriptNativeScrollView) {
        guard scrollView === scroll, !scroll.isDragging, !scroll.isDecelerating else { return }
        followsEnd = distanceFromEnd(scroll) <= 36
        publish()
    }

    func offsetChanged(on scroll: RealtimeTranscriptNativeScrollView) {
        guard scrollView === scroll else { return }
        let viewportChanged = previousViewport != scroll.bounds.size || previousInsets != scroll.adjustedContentInset
        previousViewport = scroll.bounds.size
        previousInsets = scroll.adjustedContentInset
        guard !movingToEnd, !scroll.layingOut, !viewportChanged else { return }
        followsEnd = !scroll.isDragging && !scroll.isDecelerating && distanceFromEnd(scroll) <= 36
        publish()
    }

    func layoutCompleted(on scroll: RealtimeTranscriptNativeScrollView) {
        guard scrollView === scroll else { return }
        previousViewport = scroll.bounds.size
        previousInsets = scroll.adjustedContentInset
        if followsEnd, !scroll.isTracking, !scroll.isDragging, !scroll.isDecelerating { moveToEnd(scroll) }
        publish()
    }

    func returnToLatest() {
        followsEnd = true
        if let scrollView { moveToEnd(scrollView) }
        publish()
    }

    private func moveToEnd(_ scroll: RealtimeTranscriptNativeScrollView) {
        let minimumY = -scroll.adjustedContentInset.top
        let maximumY = max(minimumY, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        previousViewport = scroll.bounds.size
        previousInsets = scroll.adjustedContentInset
        guard abs(scroll.contentOffset.y - maximumY) > 0.5 else { return }
        movingToEnd = true
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: maximumY), animated: false)
        movingToEnd = false
    }

    private func distanceFromEnd(_ scroll: UIScrollView) -> CGFloat {
        max(
            0,
            scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height - scroll.contentOffset.y
        )
    }

    private func publish() {
        guard following != followsEnd, !notificationScheduled else { return }
        notificationScheduled = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.notificationScheduled = false
            if self.following != self.followsEnd { self.following = self.followsEnd }
        }
    }
}

private final class RealtimeTranscriptNativeScrollView: UIScrollView {
    private(set) var layingOut = false
    var layoutCompleted: (() -> Void)?

    override func layoutSubviews() {
        let alreadyLayingOut = layingOut
        layingOut = true
        super.layoutSubviews()
        layingOut = alreadyLayingOut
        if !alreadyLayingOut { layoutCompleted?() }
    }

    override func adjustedContentInsetDidChange() {
        super.adjustedContentInsetDidChange()
        setNeedsLayout()
    }
}

/// Stable SwiftUI identity and the complete environment are preserved across
/// streaming updates, including the shared tool cards' own state and sheets.
private struct RealtimeTranscriptHostedContent<Content: View>: View {
    let content: Content
    let environment: EnvironmentValues

    var body: some View {
        content.environment(\.self, environment)
    }
}

private struct RealtimeTranscriptContainer<Content: View>: UIViewControllerRepresentable {
    let content: Content
    let position: RealtimeTranscriptPosition

    func makeUIViewController(context: Context) -> RealtimeTranscriptController<Content> {
        RealtimeTranscriptController(content: content, environment: context.environment, position: position)
    }

    func updateUIViewController(_ controller: RealtimeTranscriptController<Content>, context: Context) {
        controller.update(content: content, environment: context.environment)
    }

    static func dismantleUIViewController(_ controller: RealtimeTranscriptController<Content>, coordinator _: ()) {
        controller.detach()
    }
}

private final class RealtimeTranscriptController<Content: View>: UIViewController, UIScrollViewDelegate {
    private let scroll = RealtimeTranscriptNativeScrollView()
    private let hosting: UIHostingController<RealtimeTranscriptHostedContent<Content>>
    private let position: RealtimeTranscriptPosition

    init(content: Content, environment: EnvironmentValues, position: RealtimeTranscriptPosition) {
        hosting = UIHostingController(
            rootView: RealtimeTranscriptHostedContent(content: content, environment: environment)
        )
        self.position = position
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        nil
    }

    override func loadView() {
        view = scroll
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        scroll.delegate = self
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.accessibilityIdentifier = "realtime.transcript"
        scroll.backgroundColor = .clear
        scroll.layoutCompleted = { [weak self] in
            guard let self else { return }
            self.position.layoutCompleted(on: self.scroll)
        }
        hosting.sizingOptions = [.intrinsicContentSize]
        hosting.safeAreaRegions = []
        addChild(hosting)
        hosting.view.backgroundColor = .clear
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            hosting.view.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])
        hosting.didMove(toParent: self)
        position.attach(to: scroll)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        position.attach(to: scroll)
        scroll.setNeedsLayout()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        position.detach(from: scroll)
    }

    func update(content: Content, environment: EnvironmentValues) {
        hosting.rootView = RealtimeTranscriptHostedContent(content: content, environment: environment)
    }

    func detach() {
        position.detach(from: scroll)
        scroll.delegate = nil
        scroll.layoutCompleted = nil
        hosting.willMove(toParent: nil)
        hosting.view.removeFromSuperview()
        hosting.removeFromParent()
    }

    func scrollViewDidScroll(_: UIScrollView) {
        position.offsetChanged(on: scroll)
    }

    func scrollViewWillBeginDragging(_: UIScrollView) {
        position.beginReading(on: scroll)
    }

    func scrollViewDidEndDragging(_: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { position.endReading(on: scroll) }
    }

    func scrollViewDidEndDecelerating(_: UIScrollView) {
        position.endReading(on: scroll)
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
