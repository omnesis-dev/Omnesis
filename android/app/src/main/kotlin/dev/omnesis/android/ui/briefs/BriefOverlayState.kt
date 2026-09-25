// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import dev.omnesis.android.transport.dto.BriefDismissReasonDto
import dev.omnesis.android.transport.dto.BriefRecordDto

/** The one modal surface Briefs can present at a time. */
internal sealed interface BriefOverlay {
    data class Detail(val brief: BriefRecordDto) : BriefOverlay
    data class Dismiss(
        val brief: BriefRecordDto,
        val initialReason: BriefDismissReasonDto?,
    ) : BriefOverlay
}

/**
 * Stop work owned by the feed before covering it. In particular, a recording started on
 * one row must never remain live and invisible behind another row's sheet.
 */
internal fun openBriefDetail(
    brief: BriefRecordDto,
    stopFeedWork: () -> Unit,
): BriefOverlay.Detail {
    stopFeedWork()
    return BriefOverlay.Detail(brief)
}

internal fun openBriefDismiss(
    brief: BriefRecordDto,
    initialReason: BriefDismissReasonDto?,
    stopFeedWork: () -> Unit,
): BriefOverlay.Dismiss {
    stopFeedWork()
    return BriefOverlay.Dismiss(brief, initialReason)
}
