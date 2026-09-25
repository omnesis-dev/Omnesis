// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.theme

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import dev.omnesis.android.designsystem.R

/**
 * Bundled type families. [inter] is the humanist sans used for assistant prose in
 * the agent transcript so it contrasts with the platform sans the user's own message
 * bubbles render in — mirroring the iOS app, which bundles `InterVariable.ttf` and
 * renders assistant `.text` parts in Inter. The variable TTF lives at
 * `res/font/inter_variable.ttf`; Compose resolves a single static instance from it.
 */
object OmFonts {
    val inter: FontFamily = FontFamily(Font(R.font.inter_variable))
}
