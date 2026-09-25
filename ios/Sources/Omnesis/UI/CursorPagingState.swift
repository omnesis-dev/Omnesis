// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Request ownership for one cursor-paginated list.
///
/// Screens keep their domain items themselves — this type owns only the
/// cursor and request lifecycle. That keeps it reusable for ordinary arrays,
/// tagged recent-item responses, and richer stores such as `BriefsFeedState`.
struct CursorPagingState {
    enum Phase: Equatable {
        case refresh
        case more
    }

    struct Request: Equatable {
        fileprivate let generation: Int
        let cursor: String?
        fileprivate let phase: Phase
    }

    private(set) var nextCursor: String?
    private(set) var isRefreshing: Bool
    private(set) var isLoadingMore: Bool
    private(set) var paginationError: Error?
    /// Automatic paging stopped defensively because a page made no visible
    /// progress or repeated its cursor. The loaded count remains partial
    /// because neither condition proves that the collection is exhausted.
    private(set) var isTruncated: Bool
    private var generation: Int

    init(
        nextCursor: String? = nil,
        isLoadingMore: Bool = false,
        paginationError: Error? = nil,
        isTruncated: Bool = false
    ) {
        self.nextCursor = Self.normalized(nextCursor)
        self.isRefreshing = false
        self.isLoadingMore = isLoadingMore
        self.paginationError = paginationError
        self.isTruncated = isTruncated
        self.generation = 0
    }

    var canLoadMore: Bool {
        nextCursor != nil
    }

    var countIsPartial: Bool {
        canLoadMore || isTruncated
    }

    /// Whether a collection must keep its paging container mounted even when
    /// the current page has no rows. A cursor, refresh/load spinner, retry, or
    /// defensive truncation is meaningful UI independent of whether the
    /// preceding page happened to be empty.
    var hasPagingBoundary: Bool {
        canLoadMore || isRefreshing || isLoadingMore || paginationError != nil || isTruncated
    }

    /// Stable identity for one automatic next-page attempt. The refresh
    /// generation is part of the key so a pull-to-refresh that returns the
    /// same opaque cursor can still paginate when its boundary becomes
    /// visible again.
    var automaticLoadKey: PagingLoadKey? {
        guard !isRefreshing, let nextCursor else { return nil }
        return PagingLoadKey(generation: generation, cursor: nextCursor)
    }

    /// Start a first-page request. Any older refresh or next-page request loses
    /// ownership immediately, so its late response cannot overwrite this one.
    mutating func beginRefresh() -> Request {
        generation &+= 1
        isRefreshing = true
        isLoadingMore = false
        paginationError = nil
        isTruncated = false
        return Request(generation: generation, cursor: nil, phase: .refresh)
    }

    /// Start a next-page request exactly once for the current cursor.
    mutating func beginLoadMore() -> Request? {
        guard !isRefreshing, !isLoadingMore, let nextCursor else {
            return nil
        }
        isLoadingMore = true
        paginationError = nil
        return Request(generation: generation, cursor: nextCursor, phase: .more)
    }

    func owns(_ request: Request) -> Bool {
        guard request.generation == generation else { return false }
        switch request.phase {
        case .refresh:
            return isRefreshing
        case .more:
            return isLoadingMore && request.cursor == nextCursor
        }
    }

    mutating func finishRefresh(_ request: Request, nextCursor: String?) {
        guard request.phase == .refresh, owns(request) else { return }
        self.nextCursor = Self.normalized(nextCursor)
        isRefreshing = false
        paginationError = nil
        isTruncated = false
    }

    mutating func failRefresh(_ request: Request) {
        guard request.phase == .refresh, owns(request) else { return }
        isRefreshing = false
    }

    mutating func finishLoadMore(
        _ request: Request,
        nextCursor: String?,
        madeProgress: Bool
    ) {
        guard request.phase == .more, owns(request) else { return }
        let continuation = pagingCursorContinuation(
            after: request.cursor ?? "",
            next: nextCursor,
            madeProgress: madeProgress
        )
        // A gateway that ignores `cursor`, repeats only known rows, or advances
        // through empty pages can otherwise keep an automatic footer loading
        // forever. Stop requests without claiming the collection is complete.
        self.nextCursor = continuation.nextCursor
        isTruncated = continuation.isTruncated
        isLoadingMore = false
        paginationError = nil
    }

    mutating func failLoadMore(_ request: Request, error: Error) {
        guard request.phase == .more, owns(request) else { return }
        isLoadingMore = false
        paginationError = error
    }

    /// Discard a stale load-more cursor only while that request still owns this
    /// list. The caller can then begin a page-one refresh; a late response from
    /// an older generation cannot reset a newer page.
    @discardableResult
    mutating func resetAfterStaleLoadMore(_ request: Request) -> Bool {
        guard request.phase == .more, owns(request) else { return false }
        reset()
        return true
    }

    /// Invalidate every in-flight response and optionally seed a new cursor.
    mutating func reset(nextCursor: String? = nil) {
        generation &+= 1
        self.nextCursor = Self.normalized(nextCursor)
        isRefreshing = false
        isLoadingMore = false
        paginationError = nil
        isTruncated = false
    }

    private static func normalized(_ cursor: String?) -> String? {
        guard let cursor, !cursor.isEmpty else { return nil }
        return cursor
    }
}

struct PagingLoadKey: Hashable {
    let generation: Int
    let cursor: String
}

/// Honest count copy for a cursor-paginated collection. Until the cursor is
/// exhausted, the client only knows how many rows it has loaded — not the
/// collection's authoritative total.
func pagingCountLabel(_ loadedCount: Int, countIsPartial: Bool) -> String {
    countIsPartial ? "\(loadedCount) loaded" : loadedCount.formatted()
}

struct PagingCursorContinuation: Equatable {
    let nextCursor: String?
    let isTruncated: Bool
}

/// Normalize a bespoke pager's continuation without conflating a repeated
/// cursor with true exhaustion. `CursorPagingState.finishLoadMore` applies the
/// same rule for shared pagers.
func pagingCursorContinuation(
    after current: String,
    next: String?,
    madeProgress: Bool
)
    -> PagingCursorContinuation {
    guard let next, !next.isEmpty else {
        return PagingCursorContinuation(nextCursor: nil, isTruncated: false)
    }
    guard madeProgress, next != current else {
        return PagingCursorContinuation(nextCursor: nil, isTruncated: true)
    }
    return PagingCursorContinuation(nextCursor: next, isTruncated: false)
}

/// A pageable collection is not an empty state while its continuation,
/// in-flight spinner, pagination retry, or defensive truncation still needs
/// to render.
func shouldShowPagedContent(
    itemCount: Int,
    canLoadMore: Bool,
    isRefreshing: Bool = false,
    isLoadingMore: Bool,
    hasPaginationError: Bool,
    isTruncated: Bool = false
)
    -> Bool {
    itemCount > 0
        || canLoadMore
        || isRefreshing
        || isLoadingMore
        || hasPaginationError
        || isTruncated
}

func shouldShowPagedContent(itemCount: Int, paging: CursorPagingState) -> Bool {
    shouldShowPagedContent(
        itemCount: itemCount,
        canLoadMore: paging.canLoadMore,
        isRefreshing: paging.isRefreshing,
        isLoadingMore: paging.isLoadingMore,
        hasPaginationError: paging.paginationError != nil,
        isTruncated: paging.isTruncated
    )
}

/// Whether a paging boundary is inside (or just about to enter) its visible
/// window. Kept pure so the iOS 17 geometry fallback is unit-testable.
func pagingBoundaryIsVisible(
    _ boundary: CGRect,
    in viewport: CGRect,
    prefetchDistance: CGFloat = 80
)
    -> Bool {
    guard !boundary.isNull, !boundary.isInfinite,
          !viewport.isNull, !viewport.isInfinite else {
        return false
    }
    return viewport.insetBy(dx: 0, dy: -prefetchDistance).intersects(boundary)
}

func shouldAutomaticallyLoadPage(
    automaticLoadingEnabled: Bool,
    hasError: Bool,
    isLoading: Bool,
    loadKey: PagingLoadKey?,
    lastRequested: PagingLoadKey?,
    boundary: CGRect,
    viewport: CGRect
)
    -> Bool {
    guard automaticLoadingEnabled, !hasError, !isLoading,
          let loadKey, lastRequested != loadKey else {
        return false
    }
    return pagingBoundaryIsVisible(boundary, in: viewport)
}

struct PagingPrependAnchor: Equatable {
    let id: String
    let viewportOffset: CGFloat
    let rowHeight: CGFloat
}

/// `ScrollViewProxy.scrollTo` aligns the same unit point in the target row and
/// viewport. Solve that relation for the unit point which restores the row's
/// pre-prepend top offset.
func pagingPrependRestorationUnitY(
    _ anchor: PagingPrependAnchor,
    viewportHeight: CGFloat
)
    -> CGFloat {
    let availableTravel = viewportHeight - anchor.rowHeight
    guard viewportHeight > 0, availableTravel > 0 else { return 0 }
    // UnitPoint accepts values outside its conventional 0...1 range. Keeping
    // this signed preserves a partially clipped row instead of snapping it to
    // the viewport's top edge after older content is prepended.
    return anchor.viewportOffset / availableTravel
}

/// Merge one page without duplicating stable item identities. Returns only the
/// newly accepted items so callers can trigger follow-up work for that slice.
@discardableResult
func appendUnique<Item>(
    _ incoming: [Item],
    to items: inout [Item],
    id: (Item) -> some Hashable
)
    -> [Item] {
    var known = Set(items.map(id))
    let fresh = incoming.filter { known.insert(id($0)).inserted }
    items.append(contentsOf: fresh)
    return fresh
}

/// Prepend one older page while preserving both the page's order and the
/// existing list's order.
@discardableResult
func prependUnique<Item>(
    _ incoming: [Item],
    to items: inout [Item],
    id: (Item) -> some Hashable
)
    -> [Item] {
    var known = Set(items.map(id))
    let fresh = incoming.filter { known.insert(id($0)).inserted }
    items.insert(contentsOf: fresh, at: 0)
    return fresh
}

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

private struct PagingBoundaryFrameKey: PreferenceKey {
    static var defaultValue = CGRect.null

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

private struct PagingRowFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

extension View {
    func pagingRowFrame(id: String, in coordinateSpace: String) -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: PagingRowFramesKey.self,
                    value: [id: proxy.frame(in: .named(coordinateSpace))]
                )
            }
        }
    }

    func onPagingRowFramesChange(_ action: @escaping ([String: CGRect]) -> Void) -> some View {
        onPreferenceChange(PagingRowFramesKey.self, perform: action)
    }
}

/// Shared automatic pagination boundary.
///
/// This deliberately observes geometry rather than `onAppear`: most Omnesis
/// scroll surfaces contain eager `VStack`s, where an off-screen footer appears
/// immediately and would otherwise drain every page without a scroll. Each
/// cursor-generation key fires at most once. A failed request leaves the
/// loaded list intact and replaces automatic loading with an explicit Retry.
@available(iOS 17.0, *)
struct ListPagingFooter: View {
    let label: String
    let loadingLabel: String
    let loadKey: PagingLoadKey?
    let isLoading: Bool
    let error: Error?
    let isTruncated: Bool
    let automaticLoadingEnabled: Bool
    let action: () -> Void

    @State private var boundaryFrame = CGRect.null
    @State private var lastAutomaticallyRequested: PagingLoadKey?

    init(
        loadKey: PagingLoadKey?,
        label: String,
        loadingLabel: String = "Loading more…",
        isLoading: Bool,
        error: Error?,
        isTruncated: Bool = false,
        automaticLoadingEnabled: Bool = true,
        retry: @escaping () -> Void
    ) {
        self.label = label
        self.loadingLabel = loadingLabel
        self.loadKey = loadKey
        self.isLoading = isLoading
        self.error = error
        self.isTruncated = isTruncated
        self.automaticLoadingEnabled = automaticLoadingEnabled
        self.action = retry
    }

    init(
        state: CursorPagingState,
        label: String,
        loadingLabel: String = "Loading more…",
        automaticLoadingEnabled: Bool = true,
        retry: @escaping () -> Void
    ) {
        self.init(
            loadKey: state.automaticLoadKey,
            label: label,
            loadingLabel: loadingLabel,
            isLoading: state.isLoadingMore,
            error: state.paginationError,
            isTruncated: state.isTruncated,
            automaticLoadingEnabled: automaticLoadingEnabled,
            retry: retry
        )
    }

    var body: some View {
        if loadKey != nil || isLoading || error != nil || isTruncated {
            VStack(spacing: Theme.Spacing.xs) {
                if let error {
                    Label(
                        GatewayErrorView.classify(error).title,
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.warning)
                }
                if error != nil {
                    Button(action: action) {
                        Text("Retry")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Retry \(label.lowercased())")
                } else if isLoading {
                    HStack(spacing: Theme.Spacing.xs) {
                        ProgressView().controlSize(.small)
                        Text(loadingLabel)
                    }
                    .frame(maxWidth: .infinity)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(loadingLabel)
                } else if isTruncated {
                    Label(
                        "More items may be available.",
                        systemImage: "exclamationmark.triangle"
                    )
                    .frame(maxWidth: .infinity)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .accessibilityElement(children: .combine)
                }

                Color.clear
                    .frame(height: 1)
                    .background {
                        GeometryReader { proxy in
                            Color.clear.preference(
                                key: PagingBoundaryFrameKey.self,
                                value: proxy.frame(in: .global)
                            )
                        }
                    }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.sm)
            .onPreferenceChange(PagingBoundaryFrameKey.self) { frame in
                boundaryFrame = frame
                requestNextPageIfVisible()
            }
            .onChange(of: loadKey) { _, _ in
                requestNextPageIfVisible()
            }
            .onChange(of: automaticLoadingEnabled) { _, _ in
                requestNextPageIfVisible()
            }
        }
    }

    private func requestNextPageIfVisible() {
        guard shouldAutomaticallyLoadPage(
            automaticLoadingEnabled: automaticLoadingEnabled,
            hasError: error != nil,
            isLoading: isLoading,
            loadKey: loadKey,
            lastRequested: lastAutomaticallyRequested,
            boundary: boundaryFrame,
            viewport: activeWindowBounds()
        ), let loadKey else {
            return
        }
        lastAutomaticallyRequested = loadKey
        action()
    }

    private func activeWindowBounds() -> CGRect {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
        if let window = scenes
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) {
            return window.convert(window.bounds, to: nil)
        }
        return .null
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("List pagination") {
    VStack(spacing: Theme.Spacing.lg) {
        ListPagingFooter(
            state: CursorPagingState(nextCursor: "people-next"),
            label: "Load more people",
            retry: {}
        )
        ListPagingFooter(
            state: CursorPagingState(nextCursor: "firings-next", isLoadingMore: true),
            label: "Load older firings",
            retry: {}
        )
        ListPagingFooter(
            state: CursorPagingState(
                nextCursor: "retry-next",
                paginationError: URLError(.timedOut)
            ),
            label: "Load more",
            retry: {}
        )
    }
    .padding(Theme.Spacing.lg)
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}
#endif
#endif
