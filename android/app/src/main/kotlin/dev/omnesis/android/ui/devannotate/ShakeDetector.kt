// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devannotate

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * Accelerometer shake detection — the Android half of shake-to-annotate
 * (iOS gets the gesture from the OS; Android reads the accelerometer).
 *
 * A shake is a total-acceleration spike past [SHAKE_THRESHOLD_M_S2] with at
 * least [SHAKE_COOLDOWN_MS] since the last one, so one vigorous shake files
 * one composer rather than a burst. Kept in a plain listener (no Compose)
 * so registration stays a single `DisposableEffect` below.
 */
class ShakeDetector(private val onShake: () -> Unit) : SensorEventListener {

    private var lastShakeAt = 0L

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        val x = event.values.getOrNull(0) ?: return
        val y = event.values.getOrNull(1) ?: return
        val z = event.values.getOrNull(2) ?: return
        if (!exceedsShakeThreshold(x, y, z)) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastShakeAt < SHAKE_COOLDOWN_MS) return
        lastShakeAt = now
        onShake()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    companion object {
        /** ~2.7g of total acceleration — a deliberate shake, not a footstep. */
        const val SHAKE_THRESHOLD_M_S2 = 26.5f

        /** One shake opens one composer, even if the hand keeps moving. */
        const val SHAKE_COOLDOWN_MS = 1500L

        /**
         * Whether an accelerometer sample counts as a shake. Pure (no
         * `android.hardware` types) so the decision is unit-testable on the
         * plain-JVM lane; the listener above only wires it to the sensor.
         */
        fun exceedsShakeThreshold(x: Float, y: Float, z: Float): Boolean {
            val magnitude = kotlin.math.sqrt((x * x + y * y + z * z).toDouble()).toFloat()
            return magnitude >= SHAKE_THRESHOLD_M_S2
        }
    }
}

/**
 * Listen for a shake while [enabled] and call [onShake] for each one. The
 * accelerometer registers only while the app is resumed — no sensor cost when
 * developer mode is off, the shell is gone, or the app sits backgrounded
 * (a pocket shake must not queue a composer). Mirrors iOS, where motion
 * events only reach the foreground app.
 */
@Composable
fun ShakeToAnnotate(enabled: Boolean, onShake: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            resumed = event.targetState.isAtLeast(Lifecycle.State.RESUMED)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val latestOnShake by rememberUpdatedState(onShake)
    DisposableEffect(context, enabled, resumed) {
        if (!enabled || !resumed) return@DisposableEffect onDispose {}
        val sensorManager =
            context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
                ?: return@DisposableEffect onDispose {}
        val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            ?: return@DisposableEffect onDispose {}
        val detector = ShakeDetector { latestOnShake() }
        sensorManager.registerListener(detector, accelerometer, SensorManager.SENSOR_DELAY_UI)
        onDispose { sensorManager.unregisterListener(detector) }
    }
}
