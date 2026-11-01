// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// One journal view as a page of the Tasks pager: its heading and its rows,
/// scrolling on its own, with the action fan its rows open on a long press.
///
/// Each page keeps its own scroll position, fan and press recognizer, so a
/// swipe to the next view and back finds the page where it was left. The
/// page shows what `model` last read of `view`; reading it is the pager's
/// business, so a page laid out beside the one on screen costs nothing.
@available(iOS 17.0, *)
struct TaskJournalPage: View {
    let model: TasksModel
    let view: TaskViewKind
    var experimental = false
    /// Opens a task's details.
    var onOpen: (TaskRecord) -> Void = { _ in }
    var onDocument: (TaskDocument) -> Void = { _ in }
    /// Opens the note composer for a task: "Done + note", or a suggestion's
    /// "Accept with note".
    var onNote: (TaskNoting) -> Void = { _ in }
    /// Starts a chat about a task; nil when the gateway cannot, which keeps
    /// Chat about this out of the fan.
    var onChat: ((TaskRecord) -> Void)?
    /// A fan to show as soon as the rows are laid out — previews and
    /// snapshots.
    var initialFan: TaskFanPreview?

    @State private var fan = TaskFanController()
    @State private var press = TaskRowPressBridge()
    /// The fan's targets grow with the text size.
    @ScaledMetric(relativeTo: .subheadline) private var fanTargetHeight: CGFloat = 44
    @ScaledMetric(relativeTo: .subheadline) private var fanTargetWidth: CGFloat = 176

    private var page: TaskViewState {
        model.page(view)
    }

    private var isCurrent: Bool {
        model.selected == view
    }

    /// Whether there is a settled page to show: read, and either read
    /// cleanly or holding rows from an earlier read. A re-read in flight
    /// leaves it settled, so the banner stays put.
    private var settled: Bool {
        page.loaded && (page.loadError == nil || !page.tasks.isEmpty)
    }

    var body: some View {
        VStack(spacing: 0) {
            banner
            journal
        }
        .background(Theme.bgPrimary)
        // The pages either side are laid out for the swipe, not shown: only
        // the page on screen is read out by VoiceOver or found by a test.
        .accessibilityHidden(!isCurrent)
        .onChange(of: isCurrent) { _, current in
            if !current { fan.dismiss() }
        }
    }

    private var journal: some View {
        GeometryReader { viewport in
            ZStack(alignment: .topLeading) {
                ScrollView {
                    // Eager, not lazy: a journal page is short (Done pages in
                    // fifties), every row reports its frame for the fan, and a
                    // lazy stack of rows that measure themselves can keep
                    // re-placing its rows without end once scrolled to its foot.
                    VStack(alignment: .leading, spacing: 0) {
                        TaskPageHeading(view: view, today: model.readDay, tasks: page.tasks)
                        rows
                    }
                    .padding(.bottom, Theme.Spacing.xl)
                    .background(TaskRowPressScrollProbe(bridge: press))
                }
                .refreshable { await model.load(view, showSpinner: false) }
                TaskFanOverlay(controller: fan)
            }
            .background(TaskFanSpaceProbe(bridge: press))
            .onAppear { configureFan(size: viewport.size) }
            // An open fan keeps the bounds it opened with: the toast coming
            // or going must not pull it out from under a finger.
            .onChange(of: viewport.size) { _, size in configureFan(size: size) }
            // `/status` can report the chat capability after the page appeared.
            .onChange(of: onChat != nil) { _, _ in configureFan(size: viewport.size) }
        }
        .coordinateSpace(.named(TaskFanOverlay.space))
        .onPreferenceChange(TaskRowFrameKey.self) { frames in fan.rowFrames = frames }
        .task {
            #if DEBUG
            if let initialFan, let task = page.tasks.first(where: { $0.id == initialFan.taskId }) {
                try? await Task.sleep(for: .milliseconds(400))
                fan.previewOpen(
                    task,
                    pressedAt: initialFan.pressedAt,
                    today: model.today,
                    mode: initialFan.mode,
                    highlighting: initialFan.highlight
                )
            }
            #endif
        }
    }

    private func configureFan(size: CGSize) {
        fan.bounds = CGRect(origin: .zero, size: size)
        var metrics = TaskFanSession.Metrics()
        metrics.targetHeight = max(44, fanTargetHeight)
        metrics.targetWidth = min(fanTargetWidth, max(140, size.width - metrics.lead - 2 * TaskRowView.textInset))
        fan.metrics = metrics
        fan.offersChat = onChat != nil
        fan.perform = { action, task in run(action, on: task) }
        press.canBegin = { point in fan.pressedTask(at: point, in: page.tasks) != nil }
        press.began = { point in
            guard let task = fan.pressedTask(at: point, in: page.tasks) else { return }
            fan.open(task, at: point, today: model.today)
        }
        press.moved = { fan.move($0) }
        press.ended = { fan.end($0) }
    }

    /// What a fan action does to its task. Completion goes through the
    /// bullet's path, which shows the row done at once. A time accepts a
    /// suggestion for then, and moves one of the person's own tasks there.
    private func run(_ action: TaskFanAction, on task: TaskRecord) {
        if let when = scheduledValue(for: action) {
            let plan: TaskAction = task.isSuggestion ? .accept(scheduledFor: .set(when)) : .migrate(to: when)
            Task { await model.perform(plan, on: task) }
            return
        }
        switch action {
        case .done: Task { await model.tapBullet(task) }
        case .doneWithNote: onNote(TaskNoting(task: task, purpose: .complete))
        case .today, .tomorrow, .thisMonth, .nextMonth, .month, .someday: break
        case .cancelTask: Task { await model.perform(.strike(reason: nil), on: task) }
        case .accept: Task { await model.perform(.accept(scheduledFor: .unchanged), on: task) }
        case .acceptWithNote: onNote(TaskNoting(task: task, purpose: .accept))
        case .ignore: Task { await model.perform(.ignore(reason: nil), on: task) }
        case .chat: onChat?(task)
        case .otherMonth: fan.openForAccessibility(task, today: model.today, mode: .months(page: 0))
        case .acceptFor: fan.openForAccessibility(task, today: model.today, mode: .when)
        case .back, .laterMonths, .earlierMonths: break
        }
    }

    /// The day, month or "someday" a scheduling fan action names, or nil for
    /// every other action.
    private func scheduledValue(for action: TaskFanAction) -> String? {
        let schedule = TaskSchedule()
        let now = schedule.date(fromDay: model.today) ?? Date()
        switch action {
        case .today: return model.today
        case .tomorrow: return schedule.tomorrow(from: now)
        case .thisMonth: return schedule.month(now)
        case .nextMonth: return schedule.nextMonth(from: now)
        case .month(let month): return month
        case .someday: return "someday"
        default: return nil
        }
    }

    /// What opens Today when Omnesis has suggestions waiting: the way to
    /// them, held above the list, so however long the day it never scrolls
    /// out of reach.
    @ViewBuilder
    private var banner: some View {
        if settled, experimental, view == .today,
           let text = TaskJournal.reviewBannerText(suggested: model.counts.suggested) {
            TaskReviewBanner(text: text) {
                withAnimation(TasksContent.pageAnimation) { model.show(.suggested) }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        }
    }

    @ViewBuilder
    private var rows: some View {
        if let error = page.loadError, page.tasks.isEmpty {
            GatewayErrorView(
                context: "load tasks",
                error: error,
                onRetry: { Task { await model.load(view, showSpinner: true) } }
            )
            .frame(minHeight: GatewayErrorView.minScrollHeight)
        } else if page.tasks.isEmpty, page.loading || !page.loaded {
            ProgressView()
                .tint(Theme.accent)
                .frame(maxWidth: .infinity, minHeight: 200)
        } else if TaskJournal.sections(for: view, tasks: page.tasks).isEmpty {
            TaskEmptyState(view: view)
        } else {
            // One list, not one per section: see `TaskJournal.entries`.
            ForEach(TaskJournal.entries(for: view, tasks: page.tasks)) { entry in
                switch entry {
                case .heading(_, let title, let count):
                    TaskSectionHeader(title: title, count: count)
                case .task(let task):
                    row(task)
                }
            }
            if view == .done, page.canLoadMoreDone {
                Button {
                    Task { await model.loadMoreDone() }
                } label: {
                    HStack(spacing: Theme.Spacing.sm) {
                        if model.loadingMore { ProgressView().controlSize(.small) }
                        Text(model.loadingMore ? "Loading…" : "Show older")
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: .infinity, minHeight: Theme.tapTarget)
                }
                .buttonStyle(.plain)
                .disabled(model.loadingMore)
            }
        }
    }

    /// One task's line, with the divider under it.
    private func row(_ task: TaskRecord) -> some View {
        VStack(spacing: 0) {
            TaskRowView(
                task: task,
                view: view,
                today: model.today,
                busy: model.busyIds.contains(task.id),
                showsBrainProposals: experimental,
                fanOpen: fan.task?.id == task.id,
                onOpen: { onOpen(task) },
                onBullet: { Task { await model.tapBullet(task) } },
                onAction: { action in Task { await model.perform(action, on: task) } },
                onDocument: onDocument,
                onFanAction: { run($0, on: task) },
                offersChat: onChat != nil
            )
            // The whole row is where a long press opens the fan.
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(
                        key: TaskRowFrameKey.self,
                        value: [task.id: geometry.frame(in: .named(TaskFanOverlay.space))]
                    )
                }
            }
            Divider()
                .overlay(Theme.borderLight)
                .padding(.leading, TaskRowView.textInset)
        }
    }
}

// MARK: - Page furniture

/// The page's own heading, the way a journal page is headed by its date:
/// today's long date on Today, the month on Month.
@available(iOS 17.0, *)
private struct TaskPageHeading: View {
    let view: TaskViewKind
    let today: String
    let tasks: [TaskRecord]

    var body: some View {
        if let title {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.top, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.md)
        }
    }

    private var title: String? {
        let schedule = TaskSchedule()
        guard let date = schedule.date(fromDay: today) else { return nil }
        switch view {
        case .today: return date.formatted(.dateTime.weekday(.wide).day().month(.wide))
        case .month: return date.formatted(.dateTime.month(.wide).year())
        default: return nil
        }
    }

    private var subtitle: String? {
        guard view == .today else { return nil }
        let open = tasks.filter { !$0.isResolved }.count
        let done = tasks.filter { $0.state == .done }.count
        var parts: [String] = []
        parts.append(open == 1 ? "1 to do" : "\(open) to do")
        if done > 0 { parts.append("\(done) done") }
        return parts.joined(separator: " · ")
    }
}

@available(iOS 17.0, *)
private struct TaskSectionHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.textSecondary)
            Text("\(count)")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(Theme.textMuted)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.top, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

@available(iOS 17.0, *)
private struct TaskEmptyState: View {
    let view: TaskViewKind

    var body: some View {
        let copy = TaskJournal.emptyState(for: view)
        VStack(spacing: Theme.Spacing.sm) {
            Image(systemName: view == .suggested ? "sparkles" : "checklist")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Theme.textMuted)
                .accessibilityHidden(true)
            Text(copy.title)
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text(copy.detail)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.top, 56)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Journal page — Month") {
    TaskJournalPage(
        model: .fixture(
            selected: .month,
            tasks: PreviewMocks.tasksMonth,
            counts: PreviewMocks.tasksTodayCounts,
            now: PreviewMocks.tasksNow
        ),
        view: .month
    )
    .environment(AppStore.preview())
}

// A page beside the one on screen before its read-ahead lands: a spinner,
// never the empty state, which would claim the view holds nothing.
@available(iOS 17.0, *)
#Preview("Journal page — not yet read") {
    TaskJournalPage(
        model: .fixture(tasks: PreviewMocks.tasksToday, counts: PreviewMocks.tasksTodayCounts, now: PreviewMocks.tasksNow),
        view: .future
    )
    .environment(AppStore.preview())
}
#endif

/// Where each row sits in `TaskFanOverlay.space`, by task id.
private struct TaskRowFrameKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}
#endif
