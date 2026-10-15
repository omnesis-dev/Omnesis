// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Client for the gateway's `/tasks` surface — the bullet-journal Tasks
/// view. Same shape as the other admin clients: one dispatch helper, the
/// same `GatewayClient.Error` translation.
///
/// Every mutation answers with the task as it now stands (nil once deleted)
/// and a receipt: one line saying what changed, plus the ledger sequence that
/// `undo(seq:)` reverses.
public final class TasksClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    /// `GET /tasks?view=…&date=…` — one journal view read for `day`, the
    /// device's local date (`YYYY-MM-DD`). The gateway places tasks relative
    /// to that day, so the phone's calendar, not the gateway's, decides what
    /// "today" is. `before` pages the Done history (resolved strictly before
    /// that instant).
    public func view(
        _ view: TaskViewKind,
        day: String,
        limit: Int? = nil,
        before: String? = nil
    ) async throws
        -> TaskViewPage {
        var components = URLComponents()
        components.path = "/tasks"
        components.queryItems = [
            URLQueryItem(name: "view", value: view.rawValue),
            URLQueryItem(name: "date", value: day),
            URLQueryItem(name: "limit", value: limit.map(String.init)),
            URLQueryItem(name: "before", value: before),
        ].filter { $0.value != nil }
        let data = try await dispatch(method: "GET", path: components.string ?? "/tasks", body: nil)
        return try decodeOrThrow(TaskViewPage.self, from: data)
    }

    /// `GET /tasks/:id` — one task with its history, newest first.
    public func detail(id: String) async throws -> TaskDetail {
        let data = try await dispatch(method: "GET", path: "/tasks/\(percentEncode(id))", body: nil)
        return try decodeOrThrow(TaskDetail.self, from: data)
    }

    /// `GET /tasks/counts?date=…` — how many open tasks each view holds on
    /// `day`, without reading any view's rows.
    public func counts(day: String) async throws -> TaskCountsPage {
        var components = URLComponents()
        components.path = "/tasks/counts"
        components.queryItems = [URLQueryItem(name: "date", value: day)]
        let data = try await dispatch(method: "GET", path: components.string ?? "/tasks/counts", body: nil)
        return try decodeOrThrow(TaskCountsPage.self, from: data)
    }

    /// `POST /tasks/:id/actions` — one user command on a task.
    public func perform(_ action: TaskAction, on id: String) async throws -> TaskMutation {
        let data = try await dispatch(
            method: "POST",
            path: "/tasks/\(percentEncode(id))/actions",
            body: encoder.encode(action)
        )
        return try decodeOrThrow(TaskMutation.self, from: data)
    }

    /// `POST /tasks/undo` — reverse the change a receipt named.
    public func undo(seq: Int) async throws -> TaskMutation {
        struct Body: Encodable { let seq: Int }
        let data = try await dispatch(method: "POST", path: "/tasks/undo", body: encoder.encode(Body(seq: seq)))
        return try decodeOrThrow(TaskMutation.self, from: data)
    }

    // MARK: - Internals

    private func dispatch(method: String, path: String, body: Data?) async throws -> Data {
        guard let requestURL = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: requestURL)
        // Tasks change under the screen with every command, the note agent
        // and the Brain; a read answered from the URL cache shows a task as
        // it was, such as a suggestion still offering Accept after it was
        // accepted. Every read goes to the gateway.
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299: return data
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
        default:
            throw GatewayClient.Error.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
    }

    private func decodeOrThrow<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try decoder.decode(type, from: data) } catch { throw GatewayClient.Error.decoding("\(error)") }
    }

    private func percentEncode(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? raw
    }
}

// MARK: - Status

/// The `tasks` field on `GET /status`.
public struct TasksStatus: Decodable, Equatable, Sendable {
    /// The gateway serves `/tasks`.
    public let available: Bool
    /// A Tell Omnesis note is read by an agent turn that can add or change
    /// tasks.
    public let noteAgent: Bool

    public init(available: Bool, noteAgent: Bool = false) {
        self.available = available
        self.noteAgent = noteAgent
    }

    private enum CodingKeys: String, CodingKey { case available, noteAgent }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        available = try values.decodeIfPresent(Bool.self, forKey: .available) ?? false
        noteAgent = try values.decodeIfPresent(Bool.self, forKey: .noteAgent) ?? false
    }
}

// MARK: - Views

/// The journal views, as the gateway spells them.
public enum TaskViewKind: String, CaseIterable, Sendable, Hashable {
    case today, month, future, anytime, waiting, suggested, done
}

/// What the journal holds on one day. The per-view numbers count open tasks
/// only; `today` leaves out what was resolved today.
public struct TaskCounts: Decodable, Equatable, Sendable {
    public let today: Int
    public let month: Int
    public let future: Int
    public let anytime: Int
    public let waiting: Int
    /// Brain suggestions waiting for a yes or no.
    public let suggested: Int
    /// The user's tasks carrying a change Omnesis proposes.
    public let proposals: Int
    /// Tasks planned for an earlier day and still open.
    public let carried: Int

    public init(
        today: Int = 0,
        month: Int = 0,
        future: Int = 0,
        anytime: Int = 0,
        waiting: Int = 0,
        suggested: Int = 0,
        proposals: Int = 0,
        carried: Int = 0
    ) {
        self.today = today
        self.month = month
        self.future = future
        self.anytime = anytime
        self.waiting = waiting
        self.suggested = suggested
        self.proposals = proposals
        self.carried = carried
    }

    private enum CodingKeys: String, CodingKey {
        case today, month, future, anytime, waiting, suggested, proposals, carried
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        today = try values.decodeIfPresent(Int.self, forKey: .today) ?? 0
        month = try values.decodeIfPresent(Int.self, forKey: .month) ?? 0
        future = try values.decodeIfPresent(Int.self, forKey: .future) ?? 0
        anytime = try values.decodeIfPresent(Int.self, forKey: .anytime) ?? 0
        waiting = try values.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
        suggested = try values.decodeIfPresent(Int.self, forKey: .suggested) ?? 0
        proposals = try values.decodeIfPresent(Int.self, forKey: .proposals) ?? 0
        carried = try values.decodeIfPresent(Int.self, forKey: .carried) ?? 0
    }
}

/// The body of `GET /tasks/counts`.
public struct TaskCountsPage: Decodable, Equatable, Sendable {
    /// The day the counts were read for (`YYYY-MM-DD`).
    public let day: String
    public let counts: TaskCounts

    public init(day: String, counts: TaskCounts) {
        self.day = day
        self.counts = counts
    }

    private enum CodingKeys: String, CodingKey { case day, counts }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        day = try values.decodeIfPresent(String.self, forKey: .day) ?? ""
        counts = try values.decodeIfPresent(TaskCounts.self, forKey: .counts) ?? .init()
    }
}

public struct TaskViewPage: Decodable, Equatable, Sendable {
    public let view: String
    public let day: String
    public let tasks: [TaskRecord]
    public let counts: TaskCounts

    public init(view: TaskViewKind, day: String, tasks: [TaskRecord], counts: TaskCounts = .init()) {
        self.view = view.rawValue
        self.day = day
        self.tasks = tasks
        self.counts = counts
    }

    private enum CodingKeys: String, CodingKey { case view, day, tasks, counts }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        view = try values.decodeIfPresent(String.self, forKey: .view) ?? ""
        day = try values.decodeIfPresent(String.self, forKey: .day) ?? ""
        tasks = try values.decodeIfPresent([TaskRecord].self, forKey: .tasks) ?? []
        counts = try values.decodeIfPresent(TaskCounts.self, forKey: .counts) ?? .init()
    }
}

// MARK: - Task

/// One task. Named `TaskRecord` because `Task` is Swift concurrency's.
public struct TaskRecord: Decodable, Equatable, Sendable, Identifiable {
    public enum State: String, Sendable {
        case open, snoozed, done, dismissed
    }

    public enum Origin: String, Sendable {
        /// Added by the agent reading a Tell Omnesis note.
        case note
        /// Added by the user.
        case user
        /// Suggested by the Brain.
        case brain
    }

    public let id: String
    public let title: String
    public let description: String
    /// Nil for a state this build does not know; such a task reads as open.
    public let state: State?
    public let origin: Origin?
    /// A Brain suggestion the user took on.
    public let accepted: Bool
    /// A Brain suggestion the user ignored: it leaves their tasks while
    /// Omnesis keeps tracking it.
    public let ignored: Bool
    /// When the user plans to do it: `YYYY-MM-DD`, `YYYY-MM`, `someday`, or nil.
    public let scheduledFor: String?
    public let deadline: TaskDeadline?
    /// The day its deadline falls due, when it has one.
    public let dueDay: String?
    /// Planned for an earlier day and still open.
    public let carried: Bool
    public let completionNote: String?
    public let proposedChange: TaskProposedChange?
    public let actors: [TaskActor]
    public let blockedBy: [TaskBlocker]
    /// The documents the task refers to that are still there to open.
    public let documents: [TaskDocument]
    public let createdAt: String?
    public let lastUpdate: String?
    public let resolvedAt: String?

    public init(
        id: String,
        title: String,
        description: String = "",
        state: State = .open,
        origin: Origin = .user,
        accepted: Bool = false,
        ignored: Bool = false,
        scheduledFor: String? = nil,
        deadline: TaskDeadline? = nil,
        dueDay: String? = nil,
        carried: Bool = false,
        completionNote: String? = nil,
        proposedChange: TaskProposedChange? = nil,
        actors: [TaskActor] = [],
        blockedBy: [TaskBlocker] = [],
        documents: [TaskDocument] = [],
        createdAt: String? = nil,
        lastUpdate: String? = nil,
        resolvedAt: String? = nil
    ) {
        self.id = id
        self.title = title
        self.description = description
        self.state = state
        self.origin = origin
        self.accepted = accepted
        self.ignored = ignored
        self.scheduledFor = scheduledFor
        self.deadline = deadline
        self.dueDay = dueDay
        self.carried = carried
        self.completionNote = completionNote
        self.proposedChange = proposedChange
        self.actors = actors
        self.blockedBy = blockedBy
        self.documents = documents
        self.createdAt = createdAt
        self.lastUpdate = lastUpdate
        self.resolvedAt = resolvedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, description, state, origin, accepted, ignored, scheduledFor, deadline, dueDay
        case carried, completionNote, proposedChange, actors, blockedBy, documents
        case createdAt, lastUpdate, resolvedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        title = try values.decode(String.self, forKey: .title)
        description = try values.decodeIfPresent(String.self, forKey: .description) ?? ""
        state = try values.decodeIfPresent(String.self, forKey: .state).flatMap(State.init(rawValue:))
        origin = try values.decodeIfPresent(String.self, forKey: .origin).flatMap(Origin.init(rawValue:))
        accepted = try values.decodeIfPresent(Bool.self, forKey: .accepted) ?? false
        ignored = try values.decodeIfPresent(Bool.self, forKey: .ignored) ?? false
        scheduledFor = try values.decodeIfPresent(String.self, forKey: .scheduledFor)
        // The deadline is agent-owned and loosely shaped; one this build
        // cannot read is dropped rather than failing the whole view.
        deadline = try? values.decodeIfPresent(TaskDeadline.self, forKey: .deadline)
        dueDay = try values.decodeIfPresent(String.self, forKey: .dueDay)
        carried = try values.decodeIfPresent(Bool.self, forKey: .carried) ?? false
        completionNote = try values.decodeIfPresent(String.self, forKey: .completionNote)
        proposedChange = try? values.decodeIfPresent(TaskProposedChange.self, forKey: .proposedChange)
        actors = (try? values.decodeIfPresent([TaskActor].self, forKey: .actors)) ?? []
        blockedBy = (try? values.decodeIfPresent([TaskBlocker].self, forKey: .blockedBy)) ?? []
        documents = (try? values.decodeIfPresent([TaskDocument].self, forKey: .documents)) ?? []
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
        lastUpdate = try values.decodeIfPresent(String.self, forKey: .lastUpdate)
        resolvedAt = try values.decodeIfPresent(String.self, forKey: .resolvedAt)
    }

    /// Completed or struck: no longer something to do.
    public var isResolved: Bool {
        state == .done || state == .dismissed
    }

    /// A Brain suggestion still waiting for the user's yes or no.
    public var isSuggestion: Bool {
        origin == .brain && !accepted && !ignored && !isResolved
    }

    /// The same task with a new state — the optimistic face of a tap on its
    /// bullet while the gateway confirms.
    public func with(state newState: State) -> TaskRecord {
        TaskRecord(
            id: id,
            title: title,
            description: description,
            state: newState,
            origin: origin ?? .user,
            accepted: accepted,
            ignored: ignored,
            scheduledFor: scheduledFor,
            deadline: deadline,
            dueDay: dueDay,
            carried: carried,
            completionNote: completionNote,
            proposedChange: proposedChange,
            actors: actors,
            blockedBy: blockedBy,
            documents: documents,
            createdAt: createdAt,
            lastUpdate: lastUpdate,
            resolvedAt: resolvedAt
        )
    }
}

/// A task's deadline. The gateway writes `{type, date?, note?}`; an older
/// record may hold a bare date string, read here as a `by` deadline.
public struct TaskDeadline: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case anyTime = "any_time"
        case by
        case approximate
        case onDay = "on_day"
    }

    public let type: Kind
    public let date: String?
    public let note: String?

    public init(type: Kind, date: String? = nil, note: String? = nil) {
        self.type = type
        self.date = date
        self.note = note
    }

    private enum CodingKeys: String, CodingKey { case type, date, note }

    public init(from decoder: Decoder) throws {
        if let bare = try? decoder.singleValueContainer().decode(String.self) {
            type = .by
            date = bare
            note = nil
            return
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decodeIfPresent(String.self, forKey: .type).flatMap(Kind.init(rawValue:)) ?? .by
        date = try values.decodeIfPresent(String.self, forKey: .date)
        note = try values.decodeIfPresent(String.self, forKey: .note)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(type, forKey: .type)
        try values.encodeIfPresent(date, forKey: .date)
        try values.encodeIfPresent(note, forKey: .note)
    }
}

/// A change Omnesis proposes to one of the user's tasks. The task keeps its
/// values until the user confirms.
public struct TaskProposedChange: Decodable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case complete, strike, edit
    }

    /// Nil for a proposal kind this build does not know.
    public let kind: Kind?
    public let fields: TaskProposedFields?
    public let reason: String
    /// Document ids the proposal rests on.
    public let evidence: [String]
    public let proposedAt: String?

    public init(
        kind: Kind,
        fields: TaskProposedFields? = nil,
        reason: String,
        evidence: [String] = [],
        proposedAt: String? = nil
    ) {
        self.kind = kind
        self.fields = fields
        self.reason = reason
        self.evidence = evidence
        self.proposedAt = proposedAt
    }

    private enum CodingKeys: String, CodingKey { case kind, fields, reason, evidence, proposedAt }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decodeIfPresent(String.self, forKey: .kind).flatMap(Kind.init(rawValue:))
        fields = try values.decodeIfPresent(TaskProposedFields.self, forKey: .fields)
        reason = try values.decodeIfPresent(String.self, forKey: .reason) ?? ""
        evidence = (try? values.decodeIfPresent([String].self, forKey: .evidence)) ?? []
        proposedAt = try values.decodeIfPresent(String.self, forKey: .proposedAt)
    }
}

/// The fields an `edit` proposal would set.
public struct TaskProposedFields: Decodable, Equatable, Sendable {
    public let title: String?
    public let description: String?
    public let scheduledFor: String?
    public let deadline: TaskDeadline?

    public init(
        title: String? = nil,
        description: String? = nil,
        scheduledFor: String? = nil,
        deadline: TaskDeadline? = nil
    ) {
        self.title = title
        self.description = description
        self.scheduledFor = scheduledFor
        self.deadline = deadline
    }

    private enum CodingKeys: String, CodingKey { case title, description, scheduledFor, deadline }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        title = try values.decodeIfPresent(String.self, forKey: .title)
        description = try values.decodeIfPresent(String.self, forKey: .description)
        scheduledFor = try values.decodeIfPresent(String.self, forKey: .scheduledFor)
        deadline = try? values.decodeIfPresent(TaskDeadline.self, forKey: .deadline)
    }
}

/// A person a task involves.
public struct TaskActor: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let isSelf: Bool

    public init(id: String, name: String?, isSelf: Bool = false) {
        self.id = id
        self.name = name
        self.isSelf = isSelf
    }

    private enum CodingKeys: String, CodingKey { case id, name, isSelf }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decodeIfPresent(String.self, forKey: .name)
        isSelf = try values.decodeIfPresent(Bool.self, forKey: .isSelf) ?? false
    }
}

/// A task this one waits on.
public struct TaskBlocker: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// A document a task refers to: enough to show its source's icon and its
/// title, and to open it.
public struct TaskDocument: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// The owning source; its type picks the icon.
    public let sourceId: String

    public init(id: String, title: String, sourceId: String) {
        self.id = id
        self.title = title
        self.sourceId = sourceId
    }

    private enum CodingKeys: String, CodingKey { case id, title, sourceId }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? ""
        sourceId = try values.decodeIfPresent(String.self, forKey: .sourceId) ?? ""
    }
}

// MARK: - Detail and history

public struct TaskDetail: Decodable, Equatable, Sendable {
    public let task: TaskRecord
    /// Newest first.
    public let history: [TaskEvent]
    /// The newest change that can still be undone.
    public let undoSeq: Int?

    public init(task: TaskRecord, history: [TaskEvent], undoSeq: Int? = nil) {
        self.task = task
        self.history = history
        self.undoSeq = undoSeq
    }

    private enum CodingKeys: String, CodingKey { case task, history, undoSeq }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        task = try values.decode(TaskRecord.self, forKey: .task)
        history = try values.decodeIfPresent([TaskEvent].self, forKey: .history) ?? []
        undoSeq = try values.decodeIfPresent(Int.self, forKey: .undoSeq)
    }
}

/// One line of a task's history.
public struct TaskEvent: Decodable, Equatable, Sendable, Identifiable {
    public let seq: Int
    public let at: String?
    public let note: String
    /// `created`, `completed`, `migrated`, … — kept as the wire string so a
    /// kind this build does not know still shows its note.
    public let kind: String
    /// Where the change came from: `tasks`, `conversation`, `note`, `brain`.
    public let surface: String
    /// The conversation the change was made in, when it was made in one.
    public let conversationId: String?
    public let from: String?
    public let to: String?

    public var id: Int {
        seq
    }

    public init(
        seq: Int,
        at: String?,
        note: String,
        kind: String,
        surface: String,
        conversationId: String? = nil,
        from: String? = nil,
        to: String? = nil
    ) {
        self.seq = seq
        self.at = at
        self.note = note
        self.kind = kind
        self.surface = surface
        self.conversationId = conversationId
        self.from = from
        self.to = to
    }

    private enum CodingKeys: String, CodingKey { case seq, at, note, kind, surface, conversationId, from, to }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        seq = try values.decode(Int.self, forKey: .seq)
        at = try values.decodeIfPresent(String.self, forKey: .at)
        note = try values.decodeIfPresent(String.self, forKey: .note) ?? ""
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "note"
        surface = try values.decodeIfPresent(String.self, forKey: .surface) ?? "tasks"
        conversationId = try values.decodeIfPresent(String.self, forKey: .conversationId)
        // `from`/`to` are schedules or states as strings; anything else is
        // not something this list renders.
        from = try? values.decodeIfPresent(String.self, forKey: .from)
        to = try? values.decodeIfPresent(String.self, forKey: .to)
    }
}

// MARK: - Mutations

/// What a mutation says it did.
public struct TaskReceipt: Decodable, Equatable, Sendable {
    public let text: String
    /// The ledger sequence `TasksClient.undo(seq:)` reverses; nil when the
    /// change cannot be undone.
    public let undoSeq: Int?

    public init(text: String, undoSeq: Int?) {
        self.text = text
        self.undoSeq = undoSeq
    }
}

public struct TaskMutation: Decodable, Equatable, Sendable {
    /// The task as it now stands; nil once deleted.
    public let task: TaskRecord?
    public let receipt: TaskReceipt
}

/// A field an edit either leaves alone or sets — where setting includes
/// clearing it to null, which "leave alone" must never be confused with.
public enum TaskFieldChange<Value: Equatable & Sendable>: Equatable, Sendable {
    case unchanged
    case set(Value?)
}

/// One user command on a task, encoded as the gateway's `{action, …}` body.
/// Absent optionals are omitted from the body, never sent as null: the
/// gateway's schemas are strict.
public enum TaskAction: Encodable, Equatable, Sendable {
    case complete(note: String?)
    /// Move to a schedule: `YYYY-MM-DD`, `YYYY-MM` or `someday`.
    case migrate(to: String)
    case strike(reason: String?)
    case edit(
        title: String?,
        description: String?,
        scheduledFor: TaskFieldChange<String>,
        deadline: TaskFieldChange<TaskDeadline>
    )
    /// Take on a suggestion; `.set(nil)` leaves it unscheduled. With a
    /// `note`, the gateway also saves it as a Tell Omnesis note about the
    /// task, which Omnesis applies to it; `noteId` makes a retry a replay.
    case accept(scheduledFor: TaskFieldChange<String>, note: String? = nil, noteId: String? = nil)
    /// Take a suggestion out of the person's tasks; Omnesis keeps tracking it.
    case ignore(reason: String?)
    case confirm
    case keep
    case reopen
    case delete

    private enum CodingKeys: String, CodingKey {
        case action, note, noteId, to, reason, title, description, scheduledFor, deadline
    }

    public var name: String {
        switch self {
        case .complete: "complete"
        case .migrate: "migrate"
        case .strike: "strike"
        case .edit: "edit"
        case .accept: "accept"
        case .ignore: "ignore"
        case .confirm: "confirm"
        case .keep: "keep"
        case .reopen: "reopen"
        case .delete: "delete"
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(name, forKey: .action)
        switch self {
        case .complete(let note):
            try values.encodeIfPresent(note.nonBlank, forKey: .note)
        case .migrate(let to):
            try values.encode(to, forKey: .to)
        case .strike(let reason), .ignore(let reason):
            try values.encodeIfPresent(reason.nonBlank, forKey: .reason)
        case .edit(let title, let description, let scheduledFor, let deadline):
            try values.encodeIfPresent(title, forKey: .title)
            try values.encodeIfPresent(description, forKey: .description)
            try Self.encode(scheduledFor, forKey: .scheduledFor, into: &values)
            try Self.encode(deadline, forKey: .deadline, into: &values)
        case .accept(let scheduledFor, let note, let noteId):
            try Self.encode(scheduledFor, forKey: .scheduledFor, into: &values)
            if let note = note.nonBlank {
                try values.encode(note, forKey: .note)
                try values.encodeIfPresent(noteId, forKey: .noteId)
            }
        case .confirm, .keep, .reopen, .delete:
            break
        }
    }

    private static func encode(
        _ change: TaskFieldChange<some Encodable & Equatable & Sendable>,
        forKey key: CodingKeys,
        into container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        switch change {
        case .unchanged: break
        case .set(let value?): try container.encode(value, forKey: key)
        case .set(nil): try container.encodeNil(forKey: key)
        }
    }
}

extension String? {
    /// Nil for nil or whitespace-only text.
    fileprivate var nonBlank: String? {
        guard let trimmed = self?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
