// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.LocalDate

/** A read-only journal destination. Gateway credentials and task titles never enter the link. */
data class TaskWidgetDeepLink(val view: View, val day: LocalDate, val taskId: String? = null) {
    enum class View(val wire: String) { TODAY("today"), MONTH("month") }

    val uriString: String
        get() = "omnesis://tasks?view=${view.wire}&date=$day" +
            (taskId?.let { "&task=" + URLEncoder.encode(it, StandardCharsets.UTF_8.name()) } ?: "")

    companion object {
        private val DAY = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
        private val PARAMETERS = setOf("view", "date", "task")

        fun parse(raw: String?): TaskWidgetDeepLink? = runCatching {
            val uri = URI(raw ?: return null)
            if (uri.scheme != "omnesis" || uri.host != "tasks" || uri.isOpaque ||
                uri.rawUserInfo != null || uri.port != -1 || !uri.path.isNullOrEmpty() || uri.rawFragment != null
            ) return null
            val parameters = uri.rawQuery?.split('&')?.map { item ->
                val pair = item.split('=', limit = 2)
                if (pair.size != 2) return null
                URLDecoder.decode(pair[0], StandardCharsets.UTF_8.name()) to
                    URLDecoder.decode(pair[1], StandardCharsets.UTF_8.name())
            } ?: return null
            if (parameters.any { it.first !in PARAMETERS } || parameters.map { it.first }.distinct().size != parameters.size) return null
            val values = parameters.toMap()
            val view = View.entries.firstOrNull { it.wire == values["view"] } ?: return null
            val date = values["date"]?.takeIf(DAY::matches)?.let(LocalDate::parse) ?: return null
            if (date.year !in 1..9999) return null
            val taskId = values["task"]
            if (taskId != null && (taskId.length !in 1..200 || taskId.any(Char::isISOControl))) return null
            TaskWidgetDeepLink(view, date, taskId)
        }.getOrNull()
    }
}
