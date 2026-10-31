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
/// ignores them, and their circle marks them already done. There are no swipe
/// actions: a horizontal swipe turns to the next or previous view, and one
/// from the screen's leading edge reveals the menu.
@available(iOS 17.0, *)
struct TasksView: View {
    @Environment(AppStore.self) private var store
    @Environment(NotificationRouter.self) private var router: NotificationRouter?
    @Environment(\.openAgentConversation) private var openAgentConversation
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
            openConversation: store.taskConversationsEnabled ? openAgentConversation : nil,
            onCounts: { counts in Task { await store.refreshTasksTodayCount(from: counts) } }
        )
        .id(store.tasks.map(ObjectIdentifier.init))
        .consumingTaskTargets(router, into: $focus)
    }
}

@available(iOS 17.0, *)
extension AppStore {
    /// Whether the paired gateway can start a chat about a task, which is
    /// what offers Chat about this on a task. False until `/status` has been
    /// fetched, and for a gateway that does not advertise it.
    var taskConversationsEnabled: Bool {
        statusSnapshot?.capabilities.supportsTaskConversations ?? false
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
    /// Opens a conversation by id in the Agent section. Nil when the
    /// gateway cannot start a chat about a task, which keeps Chat about this
    /// off every task.
    var openConversation: ((String) -> Void)?
    /// Hears every fresh set of counts, so the menu's Tasks entry follows a
    /// change made here without a read of its own.
    var onCounts: (TaskCounts) -> Void = { _ in }

    init(
        model: TasksModel,
        experimental: Bool,
        menuOpen: Binding<Bool>,
        focus: TaskFocusRequest? = nil,
        openConversation: ((String) -> Void)? = nil,
        onCounts: @escaping (TaskCounts) -> Void = { _ in }
    ) {
        self._model = State(initialValue: model)
        self.experimental = experimental
        self._menuOpen = menuOpen
        self.focus = focus
        self.openConversation = openConversation
        self.onCounts = onCounts
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                NoteProcessingNotice()
                TasksContent(
                    model: model,
                    experimental: experimental,
                    onOpen: { details = $0 },
                    onDocument: { path.append(.document(id: $0.id, title: $0.title)) },
                    onChat: openConversation.map { open in
                        { (task: TaskRecord) in chat(about: task, then: open) }
                    }
                )
            }
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { TasksToolbar(menuOpen: $menuOpen) }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationDestination(for: TasksRoute.self) { route in
                switch route {
                case .document(let id, let title):
                    DocumentDetailView(documentId: id, presetTitle: title)
                }
            }
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

@available(iOS 17.0, *)
extension TasksScreen {
    /// Starts a new chat about `task` and opens it, ready for the first
    /// message. A failure stays on Tasks as a toast.
    private func chat(about task: TaskRecord, then open: @escaping (String) -> Void) {
        Task {
            if let conversationId = await model.startConversation(about: task) { open(conversationId) }
        }
    }
}

/// The Tasks bar's buttons: the menu on the leading side, and on the
/// trailing side the way to dictate a change to the journal, such as a new
/// task. Tasks are added by telling Omnesis, so that button opens the same
/// Tell Omnesis capture as the menu's entry.
@available(iOS 17.0, *)
struct TasksToolbar: ToolbarContent {
    @Binding var menuOpen: Bool

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            MenuToolbarButton(isOpen: $menuOpen)
        }
        ToolbarItem(placement: .topBarTrailing) {
            TellOmnesisToolbarButton()
        }
    }
}

/// A microphone with a plus badge: dictate something for Omnesis to add or
/// change. It opens the app's Tell Omnesis capture through `openCapture`.
@available(iOS 17.0, *)
struct TellOmnesisToolbarButton: View {
    @Environment(\.openCapture) private var openCapture

    var body: some View {
        Button {
            openCapture?()
        } label: {
            Image(systemName: "mic.badge.plus")
                .foregroundStyle(Theme.accent)
        }
        .accessibilityLabel("Tell Omnesis")
        .accessibilityHint("Dictate a change, such as a new task")
        .accessibilityIdentifier("tasks.tellOmnesis")
    }
}

// MARK: - Content

/// The screen below the navigation bar, separated from the fetch so a
/// preview can render every state from a fixture model.
///
/// The journal's views are pages side by side: a swipe across the list turns
/// to the next or previous view, and the segment bar above follows (and a tap
/// on a segment turns to it). The pager is SwiftUI's own paging `TabView`,
/// so each page keeps its own vertical scroll and pull to refresh, and the
/// menu's reveal negotiates with it like any other horizontal scroller —
/// except at the screen's leading edge, which is always the menu's
/// (`MenuReveal.edgeWidth`). Rows carry no swipe actions, so a horizontal
/// swipe on a row has one meaning: the next page.
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
    /// Starts a chat about a task; nil keeps Chat about this out of the fan.
    var onChat: ((TaskRecord) -> Void)?
    /// A fan to show as soon as the rows are laid out — previews and
    /// snapshots.
    var initialFan: TaskFanPreview?

    /// The task a note composer is open for: "Done + note", or a
    /// suggestion's "Accept with note".
    @State private var noting: TaskNoting?

    /// How a tap on a segment, or the review banner, turns the page.
    static let pageAnimation: Animation = .easeInOut(duration: 0.3)

    private var segments: [TaskViewKind] {
        TaskJournal.segments(experimental: experimental)
    }

    var body: some View {
        VStack(spacing: 0) {
            TaskSegmentBar(
                segments: segments,
                selected: model.selected,
                counts: model.counts,
                onSelect: { view in withAnimation(Self.pageAnimation) { model.show(view) } }
            )
            Divider().overlay(Theme.borderLight)
            pager
        }
        .background(Theme.bgPrimary)
        .task(id: experimental) {
            // A gateway that left experimental mode has no Suggested segment
            // to stay on.
            if !experimental, model.selected == .suggested { model.show(.today) }
        }
        // Whichever way a view was reached — swipe, tap, banner — it is read
        // again, showing what was last read of it meanwhile.
        .task(id: model.selected) { await model.revisit() }
        // The views either side are read ahead, and read again after a
        // change, so a swipe draws in a page that is already filled.
        .task(id: ReadAhead(selected: model.selected, invalidations: model.invalidations, experimental: experimental)) {
            await model.prefetch(TaskJournal.neighbours(of: model.selected, in: segments))
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
        // A note about a task is written on the Tell Omnesis screen.
        .fullScreenCover(item: $noting) { noting in
            CaptureView(completion: capture(for: noting))
        }
    }

    private var pager: some View {
        TabView(selection: Binding(get: { model.selected }, set: { model.show($0) })) {
            ForEach(segments, id: \.self) { view in
                TaskJournalPage(
                    model: model,
                    view: view,
                    experimental: experimental,
                    onOpen: onOpen,
                    onDocument: onDocument,
                    onNote: { noting = $0 },
                    onChat: onChat,
                    initialFan: view == model.selected ? initialFan : nil
                )
                .tag(view)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
    }

    /// The composer's wording and call for a note about `noting`'s task. The
    /// note's id is fixed while the composer is open, so saving again after
    /// a failure is a replay rather than a second note.
    private func capture(for noting: TaskNoting) -> NoteCaptureCompletion {
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
}

/// What the read-ahead of the views beside the selected one waits on.
private struct ReadAhead: Hashable {
    let selected: TaskViewKind
    let invalidations: Int
    let experimental: Bool
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
        .toolbar { TasksToolbar(menuOpen: .constant(false)) }
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
        .toolbar { TasksToolbar(menuOpen: .constant(false)) }
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Tasks — fan, sliding onto Chat about this") {
    NavigationStack {
        TasksContent(
            model: .fixture(tasks: PreviewMocks.tasksToday, counts: PreviewMocks.tasksTodayCounts, now: PreviewMocks.tasksNow),
            onChat: { _ in },
            initialFan: TaskFanPreview(taskId: PreviewMocks.taskWithPerson.id, highlight: .chat)
        )
        .navigationTitle("Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { TasksToolbar(menuOpen: .constant(false)) }
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
        .toolbar { TasksToolbar(menuOpen: .constant(false)) }
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
        .toolbar { TasksToolbar(menuOpen: .constant(false)) }
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
        .toolbar { TasksToolbar(menuOpen: .constant(false)) }
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
        .toolbar { TasksToolbar(menuOpen: .constant(false)) }
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
