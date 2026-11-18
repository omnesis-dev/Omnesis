// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

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
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Records a conversation with the screen off: a foreground service of type
 * microphone, with a persistent notification showing the elapsed time and
 * Pause/Resume/Stop. It is only ever started from a visible screen (the
 * platform requires that for a microphone service, and the app never records
 * silently), and stops on its own after [RecordingSettings.MAX_SESSION_MS].
 * One recording at a time: a Start while one is starting, running or closing
 * is ignored, and a Stop during a start runs once the start settles. Every
 * method runs on the main thread; the outbox writes go to the controller's
 * queue.
 */
class RecordingForegroundService : Service() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun recordingController(): RecordingController
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var controller: RecordingController
    private var recorder: ChunkedAudioRecorder? = null
    private var sessionId: String? = null
    /** A start is opening the session and the microphone. */
    private var starting = false
    /** A Stop arrived during the start; it runs once the start settles. */
    private var stopWhenStarted = false
    /** The recorder stopped and the session's close is being filed. */
    private var stopping = false
    private val maxLength = Runnable { stopRecording() }
    private val handler by lazy { android.os.Handler(mainLooper) }

    override fun onCreate() {
        super.onCreate()
        controller = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java).recordingController()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRecording(intent.getStringExtra(EXTRA_TITLE))
            ACTION_PAUSE -> pauseRecording()
            ACTION_RESUME -> resumeRecording()
            ACTION_STOP -> stopRecording()
            // Restarted by the system without an intent: the recording it held is gone.
            else -> if (recorder == null && !starting && !stopping) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun startRecording(title: String?) {
        ensureChannel(this)
        // Every start command must reach the foreground, even one that is ignored.
        startInForeground(currentNotification())
        if (recorder != null || starting || stopping) return
        starting = true
        val id = UUID.randomUUID().toString()
        scope.launch {
            val active = try {
                controller.begin(title, id)
            } catch (e: CancellationException) {
                // The service is going away mid-start; the queue still opens the session.
                controller.discard(id)
                throw e
            }
            starting = false
            if (active == null) {
                Log.w(TAG, "A recording is still closing; not started")
                if (recorder == null && !stopping) stopSelfCleanly()
                return@launch
            }
            val r = ChunkedAudioRecorder(
                context = this@RecordingForegroundService,
                directory = controller.directoryFor(id),
                onChunk = { chunk -> controller.chunkClosed(id, chunk) },
                onMicrophoneLost = ::onMicrophoneLost,
            )
            if (!r.start()) {
                Log.w(TAG, "Microphone unavailable; recording not started")
                controller.discard(id)
                stopWhenStarted = false
                stopSelfCleanly()
                return@launch
            }
            recorder = r
            sessionId = id
            handler.postDelayed(maxLength, RecordingSettings.MAX_SESSION_MS)
            if (stopWhenStarted) {
                stopWhenStarted = false
                stopRecording()
            }
        }
    }

    private fun pauseRecording() {
        val r = recorder ?: return
        if (!r.isRecording) return
        r.pause()
        controller.onPaused()
        refreshNotification()
    }

    private fun resumeRecording() {
        val r = recorder ?: return
        if (r.isRecording) return
        if (r.start()) controller.onResumed() else controller.onPaused(micLost = true)
        refreshNotification()
    }

    /** The recorder could not reopen the microphone at a chunk boundary: show it paused. */
    private fun onMicrophoneLost() {
        controller.onPaused(micLost = true)
        refreshNotification()
    }

    private fun stopRecording() {
        if (starting) {
            stopWhenStarted = true
            return
        }
        val r = recorder ?: run {
            if (!stopping) stopSelfCleanly()
            return
        }
        val id = sessionId ?: return
        recorder = null
        sessionId = null
        stopping = true
        handler.removeCallbacks(maxLength)
        r.stop()
        // Every chunk the recorder reported is filed before the session closes.
        controller.stopped(id, r.chunksRecorded) { scope.launch { stopSelfCleanly() } }
    }

    private fun stopSelfCleanly() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        val r = recorder
        val id = sessionId
        if (r != null && id != null) {
            // Destroyed while recording (the system reclaimed us): keep what was recorded.
            recorder = null
            sessionId = null
            r.stop()
            controller.stopped(id, r.chunksRecorded)
        }
        handler.removeCallbacks(maxLength)
        scope.cancel()
        super.onDestroy()
    }

    private fun refreshNotification() {
        if (controller.state.value !is RecordingState.Active) return
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, currentNotification())
    }

    private fun currentNotification(): Notification {
        val active = controller.state.value as? RecordingState.Active
            ?: return notification(paused = false, micLost = false, elapsedMs = 0)
        return notification(active.paused, active.micLost, active.elapsedMs(System.currentTimeMillis()))
    }

    private fun startInForeground(notification: Notification) {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    }

    private fun notification(paused: Boolean, micLost: Boolean, elapsedMs: Long): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_recording_mic)
            .setContentTitle(if (paused) "Recording paused" else "Recording conversation")
            .setContentText(
                when {
                    micLost -> "The microphone is in use elsewhere. Tap Resume to try again"
                    paused -> "Tap Resume to continue"
                    else -> "Omnesis is recording with the microphone"
                },
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
        if (!paused) {
            builder.setUsesChronometer(true).setWhen(System.currentTimeMillis() - elapsedMs).setShowWhen(true)
            builder.addAction(0, "Pause", actionIntent(ACTION_PAUSE))
        } else {
            builder.setShowWhen(false)
            builder.addAction(0, "Resume", actionIntent(ACTION_RESUME))
        }
        builder.addAction(0, "Stop", actionIntent(ACTION_STOP))
        return builder.build()
    }

    private fun actionIntent(action: String): PendingIntent =
        PendingIntent.getService(
            this,
            action.hashCode(),
            Intent(this, RecordingForegroundService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    companion object {
        private const val TAG = "Omnesis:Recording"
        const val CHANNEL_ID = "omnesis_recording"
        private const val NOTIFICATION_ID = 0x7EC0
        const val ACTION_START = "dev.omnesis.android.recording.START"
        const val ACTION_PAUSE = "dev.omnesis.android.recording.PAUSE"
        const val ACTION_RESUME = "dev.omnesis.android.recording.RESUME"
        const val ACTION_STOP = "dev.omnesis.android.recording.STOP"
        private const val EXTRA_TITLE = "title"

        /** Start recording. Call only from a visible screen, after RECORD_AUDIO is granted. */
        fun start(context: Context, title: String?) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, RecordingForegroundService::class.java).setAction(ACTION_START).putExtra(EXTRA_TITLE, title),
            )
        }

        fun send(context: Context, action: String) {
            context.startService(Intent(context, RecordingForegroundService::class.java).setAction(action))
        }

        /**
         * Low importance: the notification is a standing indicator, not an
         * alert. A channel's importance cannot be lowered after creation, so
         * it starts low.
         */
        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Conversation recording", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while Omnesis records a conversation"
                    setShowBadge(false)
                },
            )
        }
    }
}
