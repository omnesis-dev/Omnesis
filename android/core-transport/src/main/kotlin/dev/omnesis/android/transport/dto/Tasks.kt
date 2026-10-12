// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Wire DTOs for the gateway's Tasks journal (`/tasks*`, admin-scoped).
 *
 * Gateway TS shape (the contract these mirror — `packages/gateway/src/brain/tasks/http.ts`):
 *
 * ```ts
 * // GET  /tasks?view&date&limit&before -> { view, day, tasks: Task[], counts: Counts }
 * // GET  /tasks/counts?date            -> { day, counts: Counts }
 * // GET  /tasks/:id                    -> { task: Task, history: TaskEvent[], undoSeq: number | null }
 * // POST /tasks/:id/actions            -> { task: Task | null, receipt: { text, undoSeq } }
 * // POST /tasks/undo                   -> { task: Task | null, receipt: { text, undoSeq } }
 * type Task = {
 *   id: string; title: string; description: string;
 *   state: "open" | "snoozed" | "done" | "dismissed"; origin: "note" | "user" | "brain";
 *   accepted: boolean; scheduledFor: string | null; deadline: unknown | null;
 *   dueDay: string | null; carried: boolean; completionNote: string | null;
 *   proposedChange: { kind: "complete" | "strike" | "edit"; fields: {...} | null;
 *                     reason: string; evidence: string[]; proposedAt: string } | null;
 *   actors: { id: string; name: string | null; isSelf: boolean }[];
 *   blockedBy: { id: string; title: string }[];
 *   documents: { id: string; title: string; sourceId: string }[];
 *   createdAt: string; lastUpdate: string; resolvedAt: string | null;
 * };
 * type Counts = { today; month; future; anytime; waiting; suggested; proposals; carried: number };
 * ```
 *
 * Decoded with [OmnesisJson]: unknown keys are ignored and every field the screen can live
 * without has a default, so a newer gateway never crashes this client.
 */
@Serializable
data class TaskDto(
    val id: String,
    val title: String = "",
    val description: String? = null,
    /** `open`, `snoozed`, `done` or `dismissed` (struck); kept as text for forward-compat. */
    val state: String = STATE_OPEN,
    /** `note`, `user` or `brain`. */
    val origin: String = "user",
    val accepted: Boolean = false,
    /** When the user plans to do it: `YYYY-MM-DD`, `YYYY-MM`, `someday`, or null. */
    val scheduledFor: String? = null,
    /** The agent-owned deadline structure, opaque to the client; read [dueDay] instead. */
    val deadline: JsonElement? = null,
    /** The local day the deadline falls on, when it has one. */
    val dueDay: String? = null,
    /** Planned for an earlier day and still open. */
    val carried: Boolean = false,
    val completionNote: String? = null,
    val proposedChange: TaskProposalDto? = null,
    val actors: List<TaskActorDto> = emptyList(),
    val blockedBy: List<TaskRefDto> = emptyList(),
    /** The documents the task refers to that are still there to open. */
    val documents: List<TaskDocumentDto> = emptyList(),
    val createdAt: String? = null,
    val lastUpdate: String? = null,
    val resolvedAt: String? = null,
) {
    val isDone: Boolean get() = state == STATE_DONE
    val isStruck: Boolean get() = state == STATE_DISMISSED
    val isResolved: Boolean get() = isDone || isStruck

    /** A Brain suggestion the user has not accepted yet. */
    val isSuggestion: Boolean get() = origin == "brain" && !accepted

    /** The deadline's free-text note, when the deadline is the structured kind that has one. */
    val deadlineNote: String?
        get() = ((deadline as? JsonObject)?.get("note") as? JsonPrimitive)
            ?.takeIf { it.isString }?.content?.takeIf(String::isNotBlank)

    companion object {
        const val STATE_OPEN = "open"
        const val STATE_DONE = "done"
        const val STATE_DISMISSED = "dismissed"
    }
}

/**
 * A change the Brain proposes to one of the user's tasks. The task keeps its current values
 * until the user confirms; Keep leaves it as it is.
 */
@Serializable
data class TaskProposalDto(
    /** `complete`, `strike` or `edit`. */
    val kind: String = "",
    val fields: JsonObject? = null,
    val reason: String = "",
    val evidence: List<String> = emptyList(),
    val proposedAt: String? = null,
)

@Serializable
data class TaskActorDto(
    val id: String = "",
    val name: String? = null,
    val isSelf: Boolean = false,
)

@Serializable
data class TaskRefDto(
    val id: String = "",
    val title: String = "",
)

/** A document a task refers to: its source's icon, its title, and the id that opens it. */
@Serializable
data class TaskDocumentDto(
    val id: String = "",
    val title: String = "",
    /** The owning source; its type picks the icon. */
    val sourceId: String = "",
)

/**
 * What the journal holds on one day: the open tasks in each view the segment strip tabs
 * ([today] leaves out what was resolved today), the Brain's suggestions, the pending proposed
 * changes and the carried-over tasks. Sent as `counts` on `GET /tasks` and `GET /tasks/counts`.
 */
@Serializable
data class TaskCountsDto(
    val today: Int = 0,
    val month: Int = 0,
    val future: Int = 0,
    val anytime: Int = 0,
    val waiting: Int = 0,
    val suggested: Int = 0,
    val proposals: Int = 0,
    val carried: Int = 0,
)

/** `GET /tasks/counts?date=…` — the counts alone, for the menu badge. */
@Serializable
data class TaskCountsResponseDto(
    /** The day the counts were read for (`YYYY-MM-DD`). */
    val day: String = "",
    val counts: TaskCountsDto = TaskCountsDto(),
)

/** `GET /tasks?view=…&date=…`. */
@Serializable
data class TaskViewDto(
    val view: String = "",
    /** The day the view was read for (`YYYY-MM-DD`). */
    val day: String = "",
    val tasks: List<TaskDto> = emptyList(),
    val counts: TaskCountsDto = TaskCountsDto(),
)

/** One line of a task's history. */
@Serializable
data class TaskEventDto(
    val seq: Long = 0,
    val at: String? = null,
    val note: String? = null,
    /** `created`, `completed`, `migrated`, … or `note` for a free ledger entry. */
    val kind: String = "note",
    /** `tasks`, `conversation`, `note` or `brain`. */
    val surface: String = "tasks",
    val conversationId: String? = null,
    val from: String? = null,
    val to: String? = null,
)

/** `GET /tasks/:id`. */
@Serializable
data class TaskDetailDto(
    val task: TaskDto,
    /** Newest first. */
    val history: List<TaskEventDto> = emptyList(),
    val undoSeq: Long? = null,
)

/** What a mutation said it did, and the ledger entry `POST /tasks/undo` reverts. */
@Serializable
data class TaskReceiptDto(
    val text: String = "",
    val undoSeq: Long? = null,
)

/** Every task mutation's response. [task] is null when the task no longer exists. */
@Serializable
data class TaskMutationDto(
    val task: TaskDto? = null,
    val receipt: TaskReceiptDto = TaskReceiptDto(),
)
