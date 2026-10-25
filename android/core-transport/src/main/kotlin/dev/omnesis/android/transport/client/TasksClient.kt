// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.transport.dto.TaskConversationDto
import dev.omnesis.android.transport.dto.TaskCountsResponseDto
import dev.omnesis.android.transport.dto.TaskDetailDto
import dev.omnesis.android.transport.dto.TaskMutationDto
import dev.omnesis.android.transport.dto.TaskViewDto
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.getPrivateJson
import dev.omnesis.android.transport.http.postJson
import dev.omnesis.android.transport.http.postJsonSegments
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The journal views `GET /tasks` serves, as the gateway spells them. */
enum class TaskView(val wire: String) {
    TODAY("today"),
    MONTH("month"),
    FUTURE("future"),
    ANYTIME("anytime"),
    WAITING("waiting"),
    SUGGESTED("suggested"),
    DONE("done"),
}

/**
 * A deadline as the user sets it from the editor. `type` is `any_time`, `by`, `approximate`
 * or `on_day`; [date] is `YYYY-MM-DD`.
 */
data class TaskDeadlineInput(val type: String, val date: String? = null, val note: String? = null) {
    internal fun toJson(): JsonObject = buildJsonObject {
        put("type", type)
        date?.let { put("date", it) }
        note?.takeIf(String::isNotBlank)?.let { put("note", it) }
    }

    companion object {
        /** Due by the end of [day]. */
        fun by(day: String) = TaskDeadlineInput(type = "by", date = day)
    }
}

/**
 * One change to a field the editor owns. [Keep] leaves the field out of the request, [Clear]
 * sends an explicit null, and [Set] sends the value — the gateway reads an absent field and a
 * null one differently, so the three must stay distinct.
 */
sealed interface FieldChange<out T> {
    data object Keep : FieldChange<Nothing>
    data object Clear : FieldChange<Nothing>
    data class Set<T>(val value: T) : FieldChange<T>
}

/**
 * The commands `POST /tasks/:id/actions` takes. Every one answers with a receipt whose
 * `undoSeq` reverts it through [TasksClient.undo].
 */
sealed interface TaskAction {
    fun body(): JsonObject

    data class Complete(val note: String? = null) : TaskAction {
        override fun body() = action("complete") { note?.trim()?.takeIf(String::isNotEmpty)?.let { put("note", it) } }
    }

    /** Move to a day (`YYYY-MM-DD`), a month (`YYYY-MM`) or `someday`. */
    data class Migrate(val to: String) : TaskAction {
        override fun body() = action("migrate") { put("to", to) }
    }

    data class Strike(val reason: String? = null) : TaskAction {
        override fun body() = action("strike") { reason?.trim()?.takeIf(String::isNotEmpty)?.let { put("reason", it) } }
    }

    data class Edit(
        val title: String? = null,
        val description: String? = null,
        val scheduledFor: FieldChange<String> = FieldChange.Keep,
        val deadline: FieldChange<TaskDeadlineInput> = FieldChange.Keep,
    ) : TaskAction {
        override fun body() = action("edit") {
            title?.let { put("title", it) }
            description?.let { put("description", it) }
            fieldChange("scheduledFor", scheduledFor) { JsonPrimitive(it) }
            fieldChange("deadline", deadline) { it.toJson() }
        }
    }

    /**
     * Accept a suggestion, optionally planning it for [scheduledFor]. A [note] is what the user
     * adds about it: the gateway saves it as a Tell Omnesis note naming the task, which the note
     * agent applies. [noteId] (a UUID) keeps one note per attempt, so a retried request replays.
     */
    data class Accept(
        val scheduledFor: String? = null,
        val note: String? = null,
        val noteId: String? = null,
    ) : TaskAction {
        override fun body() = action("accept") {
            scheduledFor?.let { put("scheduledFor", it) }
            note?.trim()?.takeIf(String::isNotEmpty)?.let { text ->
                put("note", text)
                noteId?.let { put("noteId", it) }
            }
        }
    }

    /**
     * Take a suggestion out of the Tasks views. The Brain keeps tracking the loop behind it;
     * the receipt's undo brings the suggestion back.
     */
    data class Ignore(val reason: String? = null) : TaskAction {
        override fun body() = action("ignore") { reason?.trim()?.takeIf(String::isNotEmpty)?.let { put("reason", it) } }
    }

    /** Apply the Brain's proposed change. */
    data object Confirm : TaskAction {
        override fun body() = action("confirm") {}
    }

    /** Leave the task as it is and drop the Brain's proposed change. */
    data object Keep : TaskAction {
        override fun body() = action("keep") {}
    }

    data object Reopen : TaskAction {
        override fun body() = action("reopen") {}
    }

    data object Delete : TaskAction {
        override fun body() = action("delete") {}
    }
}

private inline fun action(
    name: String,
    fields: JsonObjectBuilder.() -> Unit,
): JsonObject = buildJsonObject {
    put("action", name)
    fields()
}

private inline fun <T> JsonObjectBuilder.fieldChange(
    key: String,
    change: FieldChange<T>,
    encode: (T) -> JsonElement,
) {
    when (change) {
        FieldChange.Keep -> Unit
        FieldChange.Clear -> put(key, JsonNull)
        is FieldChange.Set -> put(key, encode(change.value))
    }
}

/**
 * The Tasks journal: the user's own tasks read the way a bullet journal is, plus the Brain's
 * suggestions and proposed changes. Admin-scoped, and available on every gateway that reports
 * `tasks.available` on `GET /status` — it needs no model.
 *
 * Task ids come from the gateway and go back in the path, so every id-bearing call uses the
 * segment helpers: the id is one path segment, encoded exactly once.
 */
class TasksClient(private val http: GatewayHttp) {

    /**
     * `GET /tasks?view&date` — one journal view as of [date], the device's local day
     * (`YYYY-MM-DD`). The gateway places carried and due tasks relative to that day, so it
     * must be the phone's, not the gateway's.
     */
    suspend fun view(view: TaskView, date: String, limit: Int? = null): TaskViewDto =
        http.getPrivateJson(
            listOf("tasks"),
            buildMap {
                put("view", view.wire)
                put("date", date)
                limit?.let { put("limit", it.toString()) }
            },
        )

    /**
     * `GET /tasks/counts?date` — how many open tasks each view holds as of [date], the
     * device's local day, without reading any view.
     */
    suspend fun counts(date: String): TaskCountsResponseDto =
        http.getPrivateJson(listOf("tasks", "counts"), mapOf("date" to date))

    /** `GET /tasks/:id` — the task and its history, newest first. */
    suspend fun detail(id: String): TaskDetailDto = http.getPrivateJson(listOf("tasks", id))

    /** `POST /tasks/:id/actions`. */
    suspend fun act(id: String, action: TaskAction): TaskMutationDto =
        http.postJsonSegments(listOf("tasks", id, "actions"), action.body())

    /**
     * `POST /tasks/:id/conversation` — open a new conversation about the task, titled with it
     * and anchored to it, with no messages yet. Every call creates a new one. Offered only when
     * `GET /status` advertises [dev.omnesis.android.transport.dto.StatusSnapshot.taskConversations].
     */
    suspend fun conversation(id: String): ConversationSummary =
        http.postJsonSegments<JsonObject, TaskConversationDto>(
            listOf("tasks", id, "conversation"),
            buildJsonObject {},
        ).conversation

    /** `POST /tasks/undo` — revert the ledger entry a receipt named. */
    suspend fun undo(seq: Long): TaskMutationDto =
        http.postJson<JsonObject, TaskMutationDto>("tasks/undo", buildJsonObject { put("seq", seq) })
}
