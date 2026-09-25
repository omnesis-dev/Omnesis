// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

/**
 * Compose's default text metrics add extra vertical padding above the first line and below the
 * last line of every `Text` (`includeFontPadding = true`) and don't trim the half-leading around
 * single lines. iOS's `.system(size:)` text has neither, so a naive port reads notably looser —
 * stacked labels in list rows end up with several extra dp between each line. We turn font padding
 * off and trim the line-height leading app-wide so Android text hugs the same way iOS does. Applied
 * to every type-scale entry below and provided as the default `LocalTextStyle` (see [OmnesisTheme])
 * so ad-hoc `Text(fontSize = …)` call sites inherit it too.
 */
internal val OmTightLineHeight = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.Both,
)
internal val OmNoFontPadding = PlatformTextStyle(includeFontPadding = false)

/** Base text style carrying the tight metrics, with no size/weight of its own. */
internal val OmnesisDefaultTextStyle = TextStyle(
    platformStyle = OmNoFontPadding,
    lineHeightStyle = OmTightLineHeight,
)

private fun tight(size: TextUnit, line: TextUnit, weight: FontWeight = FontWeight.Normal): TextStyle =
    TextStyle(
        fontSize = size,
        lineHeight = line,
        fontWeight = weight,
        platformStyle = OmNoFontPadding,
        lineHeightStyle = OmTightLineHeight,
    )

/**
 * Type scale tuned to the iOS app's sizing (which leans on the system font at
 * `.system(size:)` points). Android keeps its native system font but matches the iOS
 * sizes/weights so the two read as the same product.
 */
internal val OmnesisTypography = Typography(
    titleLarge = tight(22.sp, 28.sp, FontWeight.SemiBold),
    titleMedium = tight(17.sp, 22.sp, FontWeight.SemiBold),
    titleSmall = tight(15.sp, 20.sp, FontWeight.SemiBold),
    bodyLarge = tight(16.sp, 22.sp),
    bodyMedium = tight(15.sp, 20.sp),
    bodySmall = tight(13.sp, 18.sp),
    labelLarge = tight(14.sp, 18.sp, FontWeight.Medium),
    labelMedium = tight(12.sp, 16.sp, FontWeight.Medium),
    labelSmall = tight(11.sp, 14.sp, FontWeight.Medium),
)
