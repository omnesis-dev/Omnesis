// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.omnesis.android.R
import dev.omnesis.android.designsystem.theme.OmTheme
import kotlin.math.max

/**
 * The landing screen's own palette — the port of the iOS `LandingPalette`.
 *
 * Deliberately not in the design system: these are not reusable semantic tokens, they are
 * the washes that compose one screen. The brief is written for dark mode — a near-black
 * navy ground with a blue glow — and the light variants are the same idea inverted, so the
 * screen reads as "quiet with a halo" under either scheme rather than looking broken in one.
 */
@Immutable
data class LandingPalette(
    /** The ground the whole screen sits on. */
    val base: Color,
    /**
     * A slightly lighter navy across the upper middle, so the screen is not a flat slab.
     * Kept close to [base] on purpose — this wash covers most of the screen, so any real
     * saturation here is what makes the whole thing read as blue.
     */
    val lift: Color,
    /** The blue behind the mark and the headline — the one place the screen is blue. */
    val halo: Color,
    /** Darkens the corners so the halo reads as light rather than as a tint. */
    val vignette: Color,
    /** The composer pill's translucent fill. */
    val composerFill: Color,
    /** The composer's and the round chrome's fine outer rim — blue-gray, not neutral grey. */
    val composerRim: Color,
    /** The highlight along the pill's upper edge, the way a glass lip would catch light. */
    val composerHighlight: Color,
)

private val DarkLanding = LandingPalette(
    base = Color(0xFF070B12),
    lift = Color(0xFF0C1220),
    halo = Color(0xFF3F7DFF),
    vignette = Color(0xFF00030A),
    composerFill = Color(0xFF101A2B).copy(alpha = 0.72f),
    composerRim = Color(0xFF2B3D5C),
    composerHighlight = Color(0xFF9CC4FF).copy(alpha = 0.34f),
)

private val LightLanding = LandingPalette(
    base = Color(0xFFFFFFFF),
    lift = Color(0xFFF4F7FC),
    halo = Color(0xFF4B9BFF),
    vignette = Color(0xFF93A6BC),
    composerFill = Color(0xFFFFFFFF).copy(alpha = 0.78f),
    composerRim = Color(0xFFC3D2E6),
    composerHighlight = Color(0xFFFFFFFF),
)

/** The palette for the active scheme. */
val landingPalette: LandingPalette
    @Composable get() = if (OmTheme.colors.isDark) DarkLanding else LightLanding

/** The mark's gradient, light to deep, drawn top-start to bottom-end. */
private val MarkLight = Color(0xFF72C7FF)
private val MarkMid = Color(0xFF4B9BFF)
private val MarkDeep = Color(0xFF386FFF)

/** Where the mark's centre sits, as a fraction of the screen's height. */
const val LANDING_MARK_CENTRE_Y = 0.46f

/**
 * The mark's frame. Larger than the ~85dp the mark should *read* as, because the vector
 * carries about 12% padding inside its square viewport — the frame is the box, not the art.
 */
val LandingMarkBox: Dp = 124.dp

/** The mic's frame on quick capture. */
val LandingMicBox: Dp = 96.dp

/**
 * Where the mic's centre sits on quick capture, as a fraction of the screen's height.
 * Higher than the agent landing's mark: the capture form stacks from the top under the
 * app bar rather than being centred in the free space.
 */
const val LANDING_MIC_CENTRE_Y = 0.16f

/**
 * The layered wash behind the landing screen: base, an upper-middle lift, a halo under the
 * mark, and a vignette.
 *
 * All gradients — no raster asset — so it costs nothing to ship and scales to any device.
 * [focusY] is the mark's centre in unit space so the halo tracks the logo rather than a
 * magic constant that drifts when the layout moves.
 *
 * There is deliberately **no** glow under the composer: the pill is chrome, not a light
 * source, and a second glow below the mark's read as a second sun.
 */
@Composable
fun LandingBackdrop(
    modifier: Modifier = Modifier,
    focusY: Float = LANDING_MARK_CENTRE_Y,
) {
    val p = landingPalette
    Canvas(modifier.fillMaxSize()) {
        val diagonal = max(size.width, size.height)

        drawRect(p.base)

        // Upper-middle lift. Zero at both ends so it never draws an edge.
        drawRect(
            Brush.verticalGradient(
                0.0f to p.lift.copy(alpha = 0f),
                0.40f to p.lift,
                0.92f to p.lift.copy(alpha = 0f),
            ),
        )

        // The halo behind the mark and headline. Four stops rather than two: a single
        // linear falloff reads as a spotlight, and a short tail leaves a visible disc edge
        // partway down the screen.
        drawRect(
            Brush.radialGradient(
                0.0f to p.halo.copy(alpha = 0.17f),
                0.34f to p.halo.copy(alpha = 0.06f),
                0.62f to p.halo.copy(alpha = 0.018f),
                1.0f to p.halo.copy(alpha = 0f),
                center = Offset(size.width / 2f, size.height * focusY),
                radius = diagonal * 0.52f,
            ),
        )

        // Vignette. Clear well past the centre so it only ever touches the corners — but
        // firm there, since it is what keeps the halo legible as light instead of a tint.
        drawRect(
            Brush.radialGradient(
                0.00f to p.vignette.copy(alpha = 0f),
                0.48f to p.vignette.copy(alpha = 0f),
                1.00f to p.vignette.copy(alpha = 0.55f),
                center = center,
                radius = diagonal * 0.74f,
            ),
        )
    }
}

/**
 * A landing surface's subject: a glyph filled with the landing blue and lit from behind.
 *
 * The shape is never redrawn here — the supplied vector is masked, and the gradient plus
 * the glow behind it is what changes. The glow is two radial discs rather than blurred
 * copies of the glyph: `Modifier.blur` is a no-op below API 31, so a blurred copy would
 * degrade into a hard-edged second glyph on older devices. The close bloom peaks away
 * from the centre rather than at it — a plain disc shines through the mark's open ring
 * and reads as a lens flare sitting inside the logo.
 *
 * [glowIntensity] scales only the glow, so a subject can breathe without the shape itself
 * changing brightness. [hollow] says whether the glyph has an open middle: the mark's ring
 * does, so its close bloom peaks away from the centre — a centre-peaked disc would shine
 * through the ring and read as a lens flare sitting inside the logo. A solid glyph like the
 * mic wants the opposite, since an off-centre peak around it draws a visible plate.
 */
@Composable
fun LandingGlyph(
    painter: Painter,
    modifier: Modifier = Modifier,
    boxSize: Dp = LandingMarkBox,
    glowIntensity: Float = 1f,
    hollow: Boolean = true,
) {
    val gradient = Brush.linearGradient(listOf(MarkLight, MarkMid, MarkDeep))
    Box(modifier.size(boxSize)) {
        Canvas(Modifier.fillMaxSize()) {
            val r = size.minDimension
            if (hollow) {
                // Ambient: wide and faint, the light the subject spills on the backdrop.
                drawCircle(
                    brush = Brush.radialGradient(
                        0.0f to MarkMid.copy(alpha = 0.16f * glowIntensity),
                        0.5f to MarkMid.copy(alpha = 0.07f * glowIntensity),
                        1.0f to MarkMid.copy(alpha = 0f),
                        center = center,
                        radius = r * 0.78f,
                    ),
                    radius = r * 0.78f,
                )
                // Close: the bloom on the strokes themselves, peaked away from the
                // centre so it does not shine through the ring.
                drawCircle(
                    brush = Brush.radialGradient(
                        0.00f to MarkMid.copy(alpha = 0f),
                        0.30f to MarkMid.copy(alpha = 0.05f * glowIntensity),
                        0.62f to MarkMid.copy(alpha = 0.26f * glowIntensity),
                        1.00f to MarkMid.copy(alpha = 0f),
                        center = center,
                        radius = r * 0.50f,
                    ),
                    radius = r * 0.50f,
                )
            } else {
                // One soft bloom, centred and faint. A solid glyph needs far less: two
                // layers around it stack into a lit plate rather than a halo.
                drawCircle(
                    brush = Brush.radialGradient(
                        0.00f to MarkMid.copy(alpha = 0.16f * glowIntensity),
                        0.35f to MarkMid.copy(alpha = 0.07f * glowIntensity),
                        1.00f to MarkMid.copy(alpha = 0f),
                        center = center,
                        radius = r * 0.50f,
                    ),
                    radius = r * 0.50f,
                )
            }
        }
        Image(
            painter = painter,
            contentDescription = null,
            modifier = Modifier
                .fillMaxSize()
                // The layer is what makes SrcIn clip to the glyph rather than to the box.
                .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
                .drawWithContent {
                    drawContent()
                    drawRect(gradient, blendMode = BlendMode.SrcIn)
                },
        )
    }
}

/** The Omnesis mark, as the agent landing screen's subject. */
@Composable
fun OmnesisMarkGlyph(
    modifier: Modifier = Modifier,
    boxSize: Dp = LandingMarkBox,
) = LandingGlyph(
    painter = painterResource(R.drawable.omnesis_logo),
    modifier = modifier,
    boxSize = boxSize,
)

/**
 * The microphone, as quick capture's subject — the same treatment the mark gets on the
 * agent landing screen, breathing while the recogniser is hot.
 *
 * The breath is a slow scale on the glyph with a stronger swell in the glow: on a screen
 * this diffuse, expanding rings would read as a different design language, where a subject
 * that visibly breathes says "listening" on its own.
 *
 * Frozen mid-breath under `LocalInspectionMode` — an infinite animation never idles, and
 * the screenshot lane waits for idle, so an ungated one hangs the capture forever.
 */
@Composable
fun LandingMicGlyph(
    listening: Boolean,
    modifier: Modifier = Modifier,
    boxSize: Dp = LandingMicBox,
) {
    val breath: Float
    if (!listening) {
        breath = 0f
    } else if (LocalInspectionMode.current) {
        breath = 0.5f
    } else {
        val pulse = rememberInfiniteTransition(label = "micBreath")
        breath = pulse.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(durationMillis = 1100), RepeatMode.Reverse),
            label = "micBreathPhase",
        ).value
    }
    LandingGlyph(
        painter = rememberVectorPainter(Icons.Filled.Mic),
        modifier = modifier.scale(1f + 0.05f * breath),
        boxSize = boxSize,
        glowIntensity = 1f + 0.5f * breath,
        hollow = false,
    )
}

/**
 * Rings radiating off the mic while the recogniser is hot.
 *
 * The glyph's own breath is the subtle half of the cue; this is the unmissable half — a
 * recording surface has to say so in a way a glance catches. Two rings a half-period apart,
 * driven from one phase so they cannot drift out of step.
 *
 * Frozen at a representative frame under `LocalInspectionMode` — an infinite animation
 * never idles, and the screenshot lane waits for idle, so an ungated one hangs the capture
 * forever.
 */
@Composable
fun LandingMicRings(
    modifier: Modifier = Modifier,
    micSize: Dp = LandingMicBox,
) {
    val phase = if (LocalInspectionMode.current) {
        0.35f
    } else {
        rememberInfiniteTransition(label = "micRings").animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(durationMillis = 1800, easing = LinearEasing)),
            label = "micRingPhase",
        ).value
    }
    // Starting just outside the glyph: a ring that begins inside it cuts across the
    // mic on the first frame of every cycle.
    val start = micSize * 0.56f
    val end = micSize * 1.15f
    // The canvas has to be wide enough for the largest ring: Compose clips a Canvas
    // to its own bounds, so a ring sized off the mic alone would vanish as it grew.
    Canvas(modifier.size(end * 2)) {
        listOf(phase, (phase + 0.5f) % 1f).forEach { p ->
            drawCircle(
                color = MarkMid.copy(alpha = 0.5f * (1f - p)),
                radius = (start + (end - start) * p).toPx(),
                style = Stroke(width = 2.dp.toPx()),
            )
        }
    }
}

/**
 * The microphone when speech is unavailable: no gradient, no glow. It is not a lit
 * subject — it is the reason the screen cannot listen.
 */
@Composable
fun LandingMicUnavailableGlyph(
    modifier: Modifier = Modifier,
    boxSize: Dp = LandingMicBox,
) {
    Icon(
        Icons.Filled.MicOff,
        contentDescription = null,
        tint = OmTheme.colors.textMuted,
        modifier = modifier.size(boxSize),
    )
}
