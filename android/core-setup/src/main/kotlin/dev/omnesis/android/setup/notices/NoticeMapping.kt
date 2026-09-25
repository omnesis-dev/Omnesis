// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.notices

import dev.omnesis.android.designsystem.components.NoticeSeverity
import dev.omnesis.android.designsystem.components.NoticeUi
import dev.omnesis.android.transport.dto.NoticeLevel
import dev.omnesis.android.transport.dto.SourceNotice

/** The design-system form of a gateway notice; every field is carried verbatim. */
fun SourceNotice.toNoticeUi(): NoticeUi = NoticeUi(
    severity = when (level) {
        NoticeLevel.INFO -> NoticeSeverity.INFO
        NoticeLevel.WARNING -> NoticeSeverity.WARNING
        NoticeLevel.ERROR -> NoticeSeverity.ERROR
    },
    title = title,
    detail = detail,
    steps = steps.orEmpty(),
    since = since,
)

fun List<SourceNotice>.toNoticeUi(): List<NoticeUi> = map { it.toNoticeUi() }
