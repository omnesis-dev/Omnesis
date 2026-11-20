// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.assist.AssistRuntime
import dev.omnesis.android.feature.assist.CommandFeedback
import dev.omnesis.android.feature.recording.RecordingController
import dev.omnesis.android.feature.recording.RecordingForegroundService
import dev.omnesis.android.feature.recording.RecordingInput
import dev.omnesis.android.feature.recording.RecordingSettings
import dev.omnesis.android.feature.recording.RecordingState
import dev.omnesis.android.feature.recording.SharedWearableAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Keeps the link to the associated pendant while no recording runs, so its
 * button can start one: a foreground service of type connectedDevice with a
 * quiet notification of the pendant's state. The pendant's capture stays
 * muted meanwhile ([OmiLink]); only the link and the button are live.
 * While all-day capture is on ([RecordingSettings.alwaysOn]) it starts the
 * ambient episodes whenever the pendant is linked and nothing records, and
 * stops them when capture is turned off. When voice commands are on, the
 * pendant's audio also streams to the wake-word listener ([AssistRuntime])
 * on the phone, recorded nowhere.
 * Started from the Recordings screen, after an association, and by the
 * system when the pendant comes in range ([OmiPresenceService]).
 */
class OmiLinkService : Service() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun omiLink(): OmiLink
        fun recordingController(): RecordingController
        fun sharedAudio(): SharedWearableAudio
        fun assistRuntime(): AssistRuntime
        fun recordingSettings(): RecordingSettings
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var link: OmiLink
    private lateinit var assist: AssistRuntime
    private var started = false

    override fun onCreate() {
        super.onCreate()
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        link = deps.omiLink()
        val controller = deps.recordingController()
        val settings = deps.recordingSettings()
        val policy = OmiButtonPolicy(
            recording = controller.state,
            startRecording = {
                try {
                    RecordingForegroundService.start(this, title = null, input = RecordingInput.WEARABLE)
                    true
                } catch (e: IllegalStateException) {
                    // Not allowed from the background now (the association was removed in system settings).
                    Log.w(TAG, "Could not start a recording from the pendant: ${e.message}")
                    false
                }
            },
            stopRecording = { RecordingForegroundService.send(this, RecordingForegroundService.ACTION_STOP) },
            markMoment = controller::markMoment,
            alwaysOn = settings.alwaysOn,
            vibrate = link::vibrate,
            scope = scope,
        )
        scope.launch { link.buttons.collect(policy::onButton) }
        scope.launch { link.status.collect { refreshNotification(it) } }
        scope.launch {
            combine(link.ready, settings.alwaysOn, controller.state) { ready, on, state ->
                when {
                    on && ready && state == RecordingState.Idle -> AmbientAction.START
                    !on && (state as? RecordingState.Active)?.ambient == true -> AmbientAction.STOP
                    else -> AmbientAction.NONE
                }
            }.distinctUntilChanged().collect { action ->
                when (action) {
                    AmbientAction.START -> try {
                        RecordingForegroundService.startAmbient(this@OmiLinkService)
                    } catch (e: IllegalStateException) {
                        Log.w(TAG, "Could not start capturing with the pendant: ${e.message}")
                    }
                    AmbientAction.STOP -> RecordingForegroundService.send(this@OmiLinkService, RecordingForegroundService.ACTION_STOP)
                    AmbientAction.NONE -> Unit
                }
            }
        }

        assist = deps.assistRuntime()
        val commandAudio = deps.sharedAudio().view()
        scope.launch {
            combine(link.ready, assist.changes) { ready, _ -> ready }.collect { ready ->
                assist.sync(commandAudio, ready) { feedback ->
                    link.vibrate(
                        when (feedback) {
                            CommandFeedback.LISTENING -> Haptic.LISTENING
                            CommandFeedback.DONE -> Haptic.DONE
                            CommandFeedback.FAILED -> Haptic.FAILED
                        },
                    )
                }
                refreshNotification(link.status.value)
            }
        }
    }

    private enum class AmbientAction { START, STOP, NONE }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        startInForeground(notification(link.status.value))
        if (intent?.action == ACTION_STOP) {
            link.disconnect()
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!link.hasPermission()) {
            Log.w(TAG, "Bluetooth permission missing; not keeping the pendant linked")
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!started) {
            started = true
            link.connect()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (::assist.isInitialized) assist.stop()
        scope.cancel()
        super.onDestroy()
    }

    private fun startInForeground(notification: Notification) {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        } catch (e: RuntimeException) {
            // Not allowed to run in the foreground now (no association, no permission).
            Log.w(TAG, "Could not keep the pendant linked: ${e.message}")
            stopSelf()
        }
    }

    private fun refreshNotification(status: OmiStatus) {
        if (!started) return
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification(status))
    }

    private fun notification(status: OmiStatus): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_omi)
            .setContentTitle(statusLine(status))
            .setContentText(
                if (::assist.isInitialized && assist.listening) {
                    "Listening for ${assist.phrases.joinToString { "“$it”" }} · tap to start or stop a recording"
                } else {
                    "Tap the pendant to start or stop a recording"
                },
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(open)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Omi pendant", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while Omnesis keeps the pendant linked"
                setShowBadge(false)
            },
        )
    }

    companion object {
        private const val TAG = "Omnesis:Omi"
        private const val CHANNEL_ID = "omnesis_omi"
        private const val NOTIFICATION_ID = 0x7EC1
        const val ACTION_STOP = "dev.omnesis.android.omi.STOP"

        fun start(context: Context) {
            try {
                ContextCompat.startForegroundService(context, Intent(context, OmiLinkService::class.java))
            } catch (e: IllegalStateException) {
                Log.w(TAG, "Not allowed to start the pendant link now: ${e.message}")
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, OmiLinkService::class.java).setAction(ACTION_STOP))
        }

        fun statusLine(status: OmiStatus): String = when (status) {
            OmiStatus.NotPaired -> "No pendant associated"
            OmiStatus.Disconnected -> "Omi not connected"
            OmiStatus.Connecting -> "Connecting to Omi…"
            is OmiStatus.Ready -> "Omi connected" + (status.battery?.let { " · $it%" } ?: "")
            is OmiStatus.Unsupported -> "Omi firmware not supported"
        }
    }
}
