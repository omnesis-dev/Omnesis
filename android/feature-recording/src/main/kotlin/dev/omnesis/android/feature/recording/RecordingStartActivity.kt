// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import dagger.hilt.android.AndroidEntryPoint
import dev.omnesis.android.feature.recording.ui.RecordingAvailability
import javax.inject.Inject

/**
 * Starts a recording from the Quick Settings tile or the launcher shortcut. A
 * microphone service may start only while the app is visible, so the tile and
 * the shortcut open this window, which has nothing to show: it asks for the
 * microphone if it has not been granted, starts the recording and closes. The
 * notification then shows the recording, as when it is started from the
 * Recordings screen. A recording already running is left alone.
 *
 * Not exported: only the app's own tile and shortcut start it, never another app.
 */
@AndroidEntryPoint
class RecordingStartActivity : ComponentActivity() {

    @Inject lateinit var controller: RecordingController

    @Inject lateinit var availability: RecordingAvailability

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // Recording runs without it; the notification is how it is seen and stopped.
            finish()
        }

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                finish()
                return@registerForActivityResult
            }
            startRecording()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                finish()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A recreated window has already acted; the result callbacks finish it.
        if (savedInstanceState != null) return
        when {
            controller.state.value is RecordingState.Active -> finish()
            availability.state.value != RecordingAvailability.Availability.AVAILABLE -> {
                // The gateway does not take recordings (any more): the app explains why.
                packageManager.getLaunchIntentForPackage(packageName)?.let(::startActivity)
                finish()
            }
            granted(Manifest.permission.RECORD_AUDIO) -> {
                startRecording()
                finish()
            }
            else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startRecording() = RecordingForegroundService.start(this, title = null)

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    companion object {
        fun intent(context: Context): Intent =
            Intent(context, RecordingStartActivity::class.java)
                .setAction(ACTION_RECORD)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        /** The shortcut's action; the activity starts a recording whatever action it is given. */
        const val ACTION_RECORD = "dev.omnesis.android.recording.RECORD"
    }
}
