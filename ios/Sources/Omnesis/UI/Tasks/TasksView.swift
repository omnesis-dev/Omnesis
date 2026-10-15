// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Tasks section: a bullet journal over the gateway's `/tasks` views.
///
/// A tap on a task's circle completes it (or reopens a resolved one) and
/// offers Undo; a tap on its text opens its details; a long press anywhere
/// on the row opens its action fan, which the same touch slides over and
/// lifts on. Omnesis's suggestions are the same rows: their fan accepts or
/// ignores them, and their circle marks them already done. There are no swipe actions: a horizontal swipe anywhere
/// in the leading majority of the screen belongs to the menu reveal.
@available(iOS 17.0, *)
struct TasksView: View {
    @Environment(AppStore.self) private var store
    @Environment(NotificationRouter.self) private var router: NotificationRouter?
    @Binding var menuOpen: Bool
    @State private var focus: TaskFocusRequest?

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
    }

    var body: some View {
        // One model per paired client: a re-pair starts the screen afresh
        // rather than carrying rows read from another gateway.
        TasksScreen(
            model: TasksModel(service: store.tasks),
            experimental: store.experimentalEnabled,
            menuOpen: $menuOpen,
            focus: focus,
            onCounts: { counts in Task { await store.refreshTasksTodayCount(from: counts) } }
        )
        .id(store.tasks.map(ObjectIdentifier.init))
        .consumingTaskTargets(router, into: $focus)
    }
}

/// Where the Tasks stack can push.
@available(iOS 17.0, *)
enum TasksRoute: Hashable {
    case document(id: String, title: String)
}

@available(iOS 17.0, *)
struct TasksScreen: View {
    @State private var model: TasksModel
    @State private var path: [TasksRoute] = []
    /// The task whose details sheet is open.
    @State private var details: TaskRecord?
    let experimental: Bool
    @Binding var menuOpen: Bool
    /// A task to show with its details open, asked for from elsewhere in the app.
    var focus: TaskFocusRequest?
    /// Hears every fresh set of counts, so the menu's Tasks entry follows a
    /// change made here without a read of its own.
    var onCounts: (TaskCounts) -> Void = { _ in }

    init(
        model: TasksModel,
        experimental: Bool,
        menuOpen: Binding<Bool>,
        focus: TaskFocusRequest? = nil,
        onCounts: @escaping (TaskCounts) -> Void = { _ in }
    ) {
        self._model = State(initialValue: model)
        self.experimental = experimental
        self._menuOpen = menuOpen
        self.focus = focus
        self.onCounts = onCounts
    }

    var body: some View {
        NavigationStack(path: $path) {
            TasksContent(
                model: model,
                experimental: experimental,
                onOpen: { details = $0 },
                onDocument: { path.append(.document(id: $0.id, title: $0.title)) }
            )
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    MenuToolbarButton(isOpen: $menuOpen)
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationDestination(for: TasksRoute.self) { route in
                switch route {
                case .document(let id, let title):
                    DocumentDetailView(documentId: id, presetTitle: title)
                }
            }
            .task { await model.load() }
            .task(id: focus) {
                // The task as it now stands, wherever it sits in the journal.
                guard let focus, let detail = try? await model.detail(id: focus.taskId) else { return }
                path = []
                details = detail.task
            }
            .onChange(of: model.counts) { _, counts in onCounts(counts) }
            .sheet(item: $details) { task in
                TaskEditorSheet(task: task, today: model.today, model: model) { action in
                    await model.perform(action, on: task)
                }
                .omnesisColorScheme()
            }
        }
    }
}

// MARK: - Content

/// The screen below the navigation bar, separated from the fetch so a
/// preview can render every state from a fixture model.
///
/// `experimental` mirrors the gateway's experimental mode: the Brain's
/// suggestions (the Suggested segment) and its proposed changes (Confirm /
/// Keep on a row) exist only there, so they are shown only then.
@available(iOS 17.0, *)
struct TasksContent: View {
    let model: TasksModel
    var experimental = false
    /// Opens a task's details.
    var onOpen: (TaskRecord) -> Void = { _ in }
    var onDocument: (TaskDocument) -> Void = { _ in }
    /// A fan to show as soon as the rows are laid out — previews and
    /// snapshots.
    var initialFan: TaskFanPreview?

    @State private var fan = TaskFanController()
    @State private var press = TaskRowPressBridge()
    /// The task a note composer is open for: "Done + note", or a
    /// suggestion's "Accept with note".
    @State private var noting: TaskNoting?
    /// The fan's targets grow with the text size.
    @ScaledMetric(relativeTo: .subheadline) private var fanTargetHeight: CGFloat = 44
    @ScaledMetric(relativeTo: .subheadline) private var fanTargetWidth: CGFloat = 176

    var body: some View {
        VStack(spacing: 0) {
            TaskSegmentBar(
                segments: TaskJournal.segments(experimental: experimental),
                selected: model.selected,
                counts: model.counts,
                onSelect: { view in Task { await model.select(view) } }
            )
            Divider().overlay(Theme.borderLight)
            banner
            journal
        }
        .background(Theme.bgPrimary)
        .task(id: experimental) {
            // A gateway that left experimental mode has no Suggested segment
            // to stay on.
            if !experimental, model.selected == .suggested { await model.select(.today) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let toast = model.toast {
                TaskToastView(
                    toast: toast,
                    onUndo: { Task { await model.undo(toast) } },
                    onDismiss: { model.dismissToast(id: toast.id) }
                )
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.sm)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.toast)
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
                        TaskPageHeading(view: model.selected, today: model.today, tasks: model.tasks)
                        rows(for: model)
                        footer
                    }
                    .padding(.bottom, Theme.Spacing.xl)
                    .background(TaskRowPressScrollProbe(bridge: press))
                }
                .refreshable { await model.load(showSpinner: false) }
                TaskFanOverlay(controller: fan)
            }
            .background(TaskFanSpaceProbe(bridge: press))
            .onAppear { configureFan(size: viewport.size) }
            // An open fan keeps the bounds it opened with: the toast coming
            // or going must not pull it out from under a finger.
            .onChange(of: viewport.size) { _, size in configureFan(size: size) }
        }
        .coordinateSpace(.named(TaskFanOverlay.space))
        .onPreferenceChange(TaskRowFrameKey.self) { frames in fan.rowFrames = frames }
        .onChange(of: model.selected) { _, _ in fan.dismiss() }
        // A note about a task is written on the Tell Omnesis screen.
        .fullScreenCover(item: $noting) { noting in
            CaptureView(completion: capture(for: noting))
        }
        .task {
            #if DEBUG
            if let initialFan, let task = model.tasks.first(where: { $0.id == initialFan.taskId }) {
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
        fan.perform = { action, task in run(action, on: task) }
        press.canBegin = { point in fan.pressedTask(at: point, in: model.tasks) != nil }
        press.began = { point in
            guard let task = fan.pressedTask(at: point, in: model.tasks) else { return }
            fan.open(task, at: point, today: model.today)
        }
        press.moved = { fan.move($0) }
        press.ended = { fan.end($0) }
    }

    /// What a fan action does to its task. Completion goes through the
    /// bullet's path, which shows the row done at once. A time accepts a
    /// suggestion for then, and moves one of the person's own tasks there.
    private func run(_ action: TaskFanAction, on task: TaskRecord) {
        let schedule = TaskSchedule()
        let now = schedule.date(fromDay: model.today) ?? Date()
        let plan: (String) -> TaskAction = { value in
            task.isSuggestion ? .accept(scheduledFor: .set(value)) : .migrate(to: value)
        }
        switch action {
        case .done: Task { await model.tapBullet(task) }
        case .doneWithNote: noting = TaskNoting(task: task, purpose: .complete)
        case .today: Task { await model.perform(plan(model.today), on: task) }
        case .tomorrow: Task { await model.perform(plan(schedule.tomorrow(from: now)), on: task) }
        case .thisMonth: Task { await model.perform(plan(schedule.month(now)), on: task) }
        case .nextMonth: Task { await model.perform(plan(schedule.nextMonth(from: now)), on: task) }
        case .month(let month): Task { await model.perform(plan(month), on: task) }
        case .someday: Task { await model.perform(plan("someday"), on: task) }
        case .cancelTask: Task { await model.perform(.strike(reason: nil), on: task) }
        case .accept: Task { await model.perform(.accept(scheduledFor: .unchanged), on: task) }
        case .acceptWithNote: noting = TaskNoting(task: task, purpose: .accept)
        case .ignore: Task { await model.perform(.ignore(reason: nil), on: task) }
        case .otherMonth: fan.openForAccessibility(task, today: model.today, mode: .months(page: 0))
        case .acceptFor: fan.openForAccessibility(task, today: model.today, mode: .when)
        case .back, .laterMonths, .earlierMonths: break
        }
    }

    /// The composer's wording and call for a note about `noting`'s task. The
    /// note's id is fixed while the composer is open, so saving again after
    /// a failure is a replay rather than a second note.
    private func capture(for noting: TaskNoting) -> TaskNoteCapture {
        let task = noting.task
        switch noting.purpose {
        case .complete:
            return .completing(task.title) { note in
                await model.perform(.complete(note: note), on: task)
            }
        case .accept:
            return .accepting(task.title) { note in
                await model.perform(
                    .accept(scheduledFor: .unchanged, note: note, noteId: noting.id.uuidString.lowercased()),
                    on: task
                )
            }
        }
    }

    /// What opens Today when Omnesis has suggestions waiting: the way to
    /// them, held under the segment bar above the list, so however long the
    /// day it never scrolls out of reach.
    @ViewBuilder
    private var banner: some View {
        if !model.loading, model.loadError == nil || !model.tasks.isEmpty,
           experimental, model.selected == .today,
           let text = TaskJournal.reviewBannerText(suggested: model.counts.suggested) {
            TaskReviewBanner(text: text) { Task { await model.select(.suggested) } }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.vertical, Theme.Spacing.sm)
        }
    }

    /// What closes the list on the views a person fills: how tasks get there.
    @ViewBuilder
    private var footer: some View {
        if !model.loading, model.loadError == nil || !model.tasks.isEmpty {
            if TaskJournal.showsCaptureHint(for: model.selected) {
                TaskCaptureHint()
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.top, Theme.Spacing.lg)
            }
        }
    }

    @ViewBuilder
    private func rows(for model: TasksModel) -> some View {
        if model.loading, model.tasks.isEmpty {
            ProgressView()
                .tint(Theme.accent)
                .frame(maxWidth: .infinity, minHeight: 200)
        } else if let error = model.loadError, model.tasks.isEmpty {
            GatewayErrorView(
                context: "load tasks",
                error: error,
                onRetry: { Task { await model.load() } }
            )
            .frame(minHeight: GatewayErrorView.minScrollHeight)
        } else if model.sections.isEmpty {
            TaskEmptyState(view: model.selected)
        } else {
            // One list, not one per section: see `TaskJournal.entries`.
            ForEach(model.entries) { entry in
                switch entry {
                case .heading(_, let title, let count):
                    TaskSectionHeader(title: title, count: count)
                case .task(let task):
                    row(task)
                }
            }
            if model.selected == .done, model.canLoadMoreDone {
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
}

@available(iOS 17.0, *)
extension TasksContent {
    /// One task's line, with the divider under it.
    fileprivate func row(_ task: TaskRecord) -> some View {
        VStack(spacing: 0) {
            TaskRowView(
                task: task,
                view: model.selected,
                today: model.today,
                busy: model.busyIds.contains(task.id),
                showsBrainProposals: experimental,
                fanOpen: fan.task?.id == task.id,
                onOpen: { onOpen(task) },
                onBullet: { Task { await model.tapBullet(task) } },
                onAction: { action in Task { await model.perform(action, on: task) } },
                onDocument: onDocument,
                onFanAction: { run($0, on: task) }
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

// MARK: - Segment bar

/// The journal's views as a row of chips that scrolls sideways when the
/// labels outgrow the screen (large Dynamic Type sizes).
@available(iOS 17.0, *)
struct TaskSegmentBar: View {
    let segments: [TaskViewKind]
    let selected: TaskViewKind
    let counts: TaskCounts
    let onSelect: (TaskViewKind) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.xs) {
                    ForEach(segments, id: \.self) { view in
                        chip(view)
                            .id(view)
                    }
                }
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.sm)
            }
            .onChange(of: selected) { _, now in
                withAnimation { proxy.scrollTo(now, anchor: .center) }
            }
            .onAppear { proxy.scrollTo(selected, anchor: .center) }
        }
    }

    private func chip(_ view: TaskViewKind) -> some View {
        let isSelected = view == selected
        let badge = view == .suggested ? counts.suggested : 0
        let title = TaskJournal.segmentLabel(for: view, counts: counts)
        return Button {
            onSelect(view)
        } label: {
            HStack(spacing: 6) {
                Text(title)
                    .font(.subheadline.weight(isSelected ? .semibold : .regular))
                if badge > 0 {
                    Text(badge > 99 ? "99+" : "\(badge)")
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Theme.accent))
                }
            }
            .foregroundStyle(isSelected ? Theme.accent : Theme.textSecondary)
            .padding(.horizontal, 14)
            .frame(minHeight: 34)
            .background(
                Capsule().fill(isSelected ? Theme.accent.opacity(0.14) : Theme.bgSecondary)
            )
            .overlay(
                Capsule().stroke(isSelected ? Theme.accent.opacity(0.35) : Theme.borderLight, lineWidth: 1)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel(view, badge: badge))
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    /// "Today, 4 open" rather than the chip's "Today (4)", which VoiceOver
    /// would read with its parentheses.
    private func accessibilityLabel(_ view: TaskViewKind, badge: Int) -> String {
        let label = TaskJournal.label(for: view)
        if badge > 0 { return "\(label), \(badge) waiting" }
        let count = view == .suggested ? 0 : TaskJournal.count(of: view, in: counts)
        return count > 0 ? "\(label), \(count) open" : label
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

// MARK: - Footer

/// A note composer open for a task, with the id its note is saved under.
@available(iOS 17.0, *)
struct TaskNoting: Identifiable {
    enum Purpose { case complete, accept }

    let id = UUID()
    let task: TaskRecord
    let purpose: Purpose
}

/// A fan to open as soon as the rows are laid out — previews and snapshots.
@available(iOS 17.0, *)
struct TaskFanPreview {
    let taskId: String
    /// Where across the row the finger pressed, as a fraction of its width.
    var pressedAt: CGFloat = 0.7
    var mode: TaskFanSession.Mode = .main
    /// The target the finger has slid onto; nil leaves it on the press point.
    var highlight: TaskFanAction?
}

/// Where each row sits in `TaskFanOverlay.space`, by task id.
private struct TaskRowFrameKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// The top of Today when Omnesis has suggestions waiting: one tap opens the
/// Suggested view. Dressed like the home screen's access-request banner —
/// the app's one treatment for "something is waiting for you".
@available(iOS 17.0, *)
struct TaskReviewBanner: View {
    let text: String
    let onReview: () -> Void

    var body: some View {
        Button(action: onReview) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                Text(text)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Review")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, 12)
            .frame(minHeight: Theme.tapTarget)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.large).fill(Theme.bgSecondary))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.large).stroke(Theme.borderLight, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityHint("Opens the Suggested view")
        .accessibilityAddTraits(.isButton)
    }
}

/// The reminder that tasks are added by telling Omnesis, with "Tell
/// Omnesis" opening the same capture as the menu's Tell Omnesis entry.
@available(iOS 17.0, *)
struct TaskCaptureHint: View {
    @Environment(\.openCapture) private var openCapture

    private static let captureURL = URL(string: "omnesis-tasks://tell-omnesis")!

    var body: some View {
        Text(line)
            .font(.footnote)
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
            .environment(\.openURL, OpenURLAction { url in
                guard url == Self.captureURL else { return .systemAction }
                openCapture?()
                return .handled
            })
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Use Tell Omnesis to add tasks.")
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Opens Tell Omnesis")
            .accessibilityAction { openCapture?() }
    }

    private var line: AttributedString {
        var link = AttributedString("Tell Omnesis")
        link.link = Self.captureURL
        link.foregroundColor = Theme.accent
        link.font = .footnote.weight(.semibold)
        return AttributedString("Use ") + link + AttributedString(" to add tasks.")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Tasks — today") {
    NavigationStack {
        TasksContent(model: .fixture(
            tasks: PreviewMocks.tasksToday,
            counts: PreviewMocks.tasksTodayCounts,
            now: PreviewMocks.tasksNow
        ))
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — today, undo toast") {
    NavigationStack {
        TasksContent(model: .fixture(
            tasks: PreviewMocks.tasksToday,
            counts: PreviewMocks.tasksTodayCounts,
            toast: TaskToast(id: 1, text: "Done: Book the Q4 budget review room", undoSeq: 12, isError: false),
            now: PreviewMocks.tasksNow
        ))
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — today, experimental") {
    NavigationStack {
        TasksContent(
            model: .fixture(
                tasks: PreviewMocks.tasksToday,
                counts: PreviewMocks.tasksTodayCounts,
                now: PreviewMocks.tasksNow
            ),
            experimental: true
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — today, one suggestion") {
    NavigationStack {
        TasksContent(
            model: .fixture(
                tasks: PreviewMocks.tasksToday,
                counts: PreviewMocks.tasksOneSuggestionCounts,
                now: PreviewMocks.tasksNow
            ),
            experimental: true
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — fan, sliding onto Tomorrow") {
    NavigationStack {
        TasksContent(
            model: .fixture(tasks: PreviewMocks.tasksToday, counts: PreviewMocks.tasksTodayCounts, now: PreviewMocks.tasksNow),
            initialFan: TaskFanPreview(taskId: PreviewMocks.taskWithPerson.id, highlight: .tomorrow)
        )
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — month fan") {
    NavigationStack {
        TasksContent(
            model: .fixture(
                selected: .month,
                tasks: PreviewMocks.tasksMonth,
                counts: PreviewMocks.tasksTodayCounts,
                now: PreviewMocks.tasksNow
            ),
            initialFan: TaskFanPreview(
                taskId: PreviewMocks.tasksMonth[6].id,
                mode: .months(page: 0),
                highlight: .month("2027-02")
            )
        )
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — fan near the top, open for taps, large text") {
    NavigationStack {
        TasksContent(
            model: .fixture(tasks: PreviewMocks.tasksToday, counts: PreviewMocks.tasksTodayCounts, now: PreviewMocks.tasksNow),
            initialFan: TaskFanPreview(taskId: PreviewMocks.taskCarried.id)
        )
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
    }
    .environment(AppStore.preview())
    .environment(\.dynamicTypeSize, .xxxLarge)
}

@available(iOS 17.0, *)
#Preview("Tasks — suggested, experimental") {
    NavigationStack {
        TasksContent(
            model: .fixture(
                selected: .suggested,
                tasks: PreviewMocks.tasksSuggested,
                counts: PreviewMocks.tasksTodayCounts,
                now: PreviewMocks.tasksNow
            ),
            experimental: true
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — suggestion fan") {
    NavigationStack {
        TasksContent(
            model: .fixture(
                selected: .suggested,
                tasks: PreviewMocks.tasksSuggestedLong,
                counts: PreviewMocks.tasksTodayCounts,
                now: PreviewMocks.tasksNow
            ),
            experimental: true,
            initialFan: TaskFanPreview(taskId: PreviewMocks.tasksSuggestedLong[4].id, highlight: .acceptWithNote)
        )
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — suggestion fan, accept for") {
    NavigationStack {
        TasksContent(
            model: .fixture(
                selected: .suggested,
                tasks: PreviewMocks.tasksSuggestedLong,
                counts: PreviewMocks.tasksTodayCounts,
                now: PreviewMocks.tasksNow
            ),
            experimental: true,
            initialFan: TaskFanPreview(taskId: PreviewMocks.tasksSuggestedLong[5].id, mode: .when, highlight: .tomorrow)
        )
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — empty, light") {
    NavigationStack {
        TasksContent(model: .fixture(tasks: [], now: PreviewMocks.tasksNow))
    }
    .environment(AppStore.preview())
    .preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("Tasks — error") {
    NavigationStack {
        TasksContent(model: .fixture(
            tasks: [],
            loadError: URLError(.cannotConnectToHost),
            now: PreviewMocks.tasksNow
        ))
    }
    .environment(AppStore.preview())
}
#endif
#endif
