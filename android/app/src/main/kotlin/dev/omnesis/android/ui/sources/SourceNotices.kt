// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.designsystem.components.NoticeGroup
import dev.omnesis.android.setup.notices.toNoticeUi
import dev.omnesis.android.transport.dto.SourceNotice
import dev.omnesis.android.transport.dto.SourceSyncStatus

/**
 * Where a status's notices go on the Sources screens. Nothing here reads a notice's
 * `kind` or a status's error fields — the gateway already composed the wording; this
 * only decides which device each notice sits beside.
 */

/** Notices placed against a source's host devices, plus any no host device claims. */
internal data class AttributedNotices(
    val byDevice: Map<String, List<SourceNotice>>,
    val unattributed: List<SourceNotice>,
)

/**
 * Place [status]'s notices against [hostIds]. Members match their own device id; a
 * member hosted on a device the record does not list stays unattributed rather than
 * being dropped. Without members the aggregate's notices belong to its own device, or
 * to the sole host when the status names none.
 */
internal fun attributeNotices(status: SourceSyncStatus?, hostIds: List<String>): AttributedNotices {
    if (status == null) return AttributedNotices(emptyMap(), emptyList())
    val members = status.members
    if (members != null) {
        val byDevice = mutableMapOf<String, List<SourceNotice>>()
        val unattributed = mutableListOf<SourceNotice>()
        for (member in members) {
            val notices = member.displayNotices
            if (notices.isEmpty()) continue
            val id = member.deviceId
            if (id != null && id in hostIds) byDevice[id] = byDevice[id].orEmpty() + notices else unattributed += notices
        }
        return AttributedNotices(byDevice, unattributed)
    }
    val notices = status.displayNotices
    if (notices.isEmpty()) return AttributedNotices(emptyMap(), emptyList())
    val owner = status.deviceId?.takeIf { it in hostIds } ?: hostIds.singleOrNull()
    return if (owner != null) {
        AttributedNotices(mapOf(owner to notices), emptyList())
    } else {
        AttributedNotices(emptyMap(), notices)
    }
}

/**
 * Every notice of [status], one group per device that has any. [deviceName] resolves a
 * device id to its display name; an unknown id shows as a shortened id.
 */
internal fun noticeGroups(status: SourceSyncStatus?, deviceName: (String) -> String?): List<NoticeGroup> {
    if (status == null) return emptyList()
    fun label(id: String?): String? = id?.let { deviceName(it)?.takeIf(String::isNotBlank) ?: shortDeviceId(it) }
    val members = status.members
    if (members != null) {
        return members
            .filter { it.displayNotices.isNotEmpty() }
            .map { NoticeGroup(label(it.deviceId), it.displayNotices.toNoticeUi()) }
    }
    val notices = status.displayNotices
    return if (notices.isEmpty()) emptyList() else listOf(NoticeGroup(label(status.deviceId), notices.toNoticeUi()))
}

/**
 * The list row's device label: "N devices" when several devices contribute to the
 * source, so one host's name never stands for notices that may belong to another;
 * otherwise the host's name.
 */
internal fun rowDeviceLabel(status: SourceSyncStatus?, hostName: String?): String? {
    val members = status?.members?.size ?: 0
    return if (members > 1) "$members devices" else hostName
}

internal fun shortDeviceId(id: String): String = if (id.length > 12) id.take(12) + "…" else id
