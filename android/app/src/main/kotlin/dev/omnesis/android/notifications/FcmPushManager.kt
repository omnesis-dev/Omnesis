// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.MainActivity
import dev.omnesis.android.R
import dev.omnesis.android.setup.flow.NotificationPermissionState
import dev.omnesis.android.setup.flow.notificationPermissionState as permissionStateFor
import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.gatewayConnectionAdvice
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Where a fresh FCM registration token comes from. The production binding asks the Firebase
 * SDK; a test graph binds one that never reaches the SDK, whatever the build's Firebase
 * properties say.
 */
fun interface FcmRegistrationTokens {
    /** The carrier's current token, or null when none can be had. Never throws. */
    suspend fun fetch(): String?
}

/**
 * Owns the optional Firebase client configuration and locally claimed notifications.
 * Firebase client identifiers are supplied as build properties;
 * no service credential or `google-services.json` belongs in this repository.
 */
@Singleton
class FcmPushManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val registrationTokens: FcmRegistrationTokens,
) {
    /** The SDK-backed wiring, for callers that hold no graph of their own. */
    constructor(context: Context) : this(context, FirebaseRegistrationTokens(context))

    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    val configured: Boolean
        get() = listOf(
            BuildConfig.FIREBASE_APPLICATION_ID,
            BuildConfig.FIREBASE_API_KEY,
            BuildConfig.FIREBASE_PROJECT_ID,
            BuildConfig.FIREBASE_SENDER_ID,
        ).all { it.isNotBlank() }

    /** Existing token first, then a best-effort carrier fetch for first registration. */
    suspend fun currentRegistrationToken(): String? {
        if (!configured) return null
        val cached = preferences.getString(KEY_TOKEN, null)
            ?.takeIf { preferences.getString(KEY_CONFIGURATION, null) == configurationKey() }
        if (!cached.isNullOrBlank()) return cached
        return registrationTokens.fetch()
            ?.takeIf { it.isNotBlank() }
            ?.also(::rememberRegistrationToken)
    }

    fun rememberRegistrationToken(token: String) {
        if (token.isNotBlank()) {
            preferences.edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_CONFIGURATION, configurationKey())
                .apply()
        }
    }

    /**
     * The notification permission as the setup flow and Settings read it. Only
     * those two ask Android for it, and only when the user chose to.
     */
    fun notificationPermissionState(): NotificationPermissionState = permissionStateFor(
        apiLevel = Build.VERSION.SDK_INT,
        granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED,
        prompted = preferences.getBoolean(KEY_PERMISSION_PROMPTED, false),
    )

    fun markNotificationPermissionPrompted() {
        preferences.edit().putBoolean(KEY_PERMISSION_PROMPTED, true).apply()
    }

    /** Stable status accepted by the gateway's cross-platform push-health endpoint. */
    fun deliveryHealth(): String = deliveryHealth(configured)

    /** Configuration is supplied explicitly in tests so real OS permission state remains under Robolectric. */
    internal fun deliveryHealth(configurationAvailable: Boolean): String {
        if (!configurationAvailable) return "not-determined"
        createNotificationChannel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return if (preferences.getBoolean(KEY_PERMISSION_PROMPTED, false)) "permission-denied" else "not-determined"
        }
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return "alerts-disabled"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val system = context.getSystemService(NotificationManager::class.java)
            if (listOf(PRIVACY_CHANNEL_ID, AGENT_CHANNEL_ID, NOTIFICATION_CHANNEL_ID).any {
                    system.getNotificationChannel(it)?.importance == NotificationManager.IMPORTANCE_NONE
                }
            ) return "alerts-disabled"
        }
        return "healthy"
    }

    /** Render gateway-claimed content locally; returns true only after posting it. */
    @SuppressLint("MissingPermission")
    fun showClaimed(delivery: ClaimedNotificationDelivery, localDeviceId: String? = null): Boolean {
        return showClaimedOutcome(delivery, localDeviceId) == NotificationRenderOutcome.Rendered
    }

    /** A content-free wake failed its private claim. This fixed text reveals no claimed content. */
    @SuppressLint("MissingPermission")
    fun showClaimFailureDiagnostic(error: Throwable) {
        createNotificationChannel()
        if (!notificationsAllowed(NOTIFICATION_CHANNEL_ID)) return
        val now = System.currentTimeMillis()
        val last = preferences.getLong(KEY_LAST_CLAIM_FAILURE_NOTICE, 0)
        if (last > 0 && now - last < CLAIM_FAILURE_NOTICE_INTERVAL_MS) return
        val text = when (error) {
            is GatewayException.Network -> gatewayConnectionAdvice(error) ?: "Open Omnesis and check the gateway connection."
            is GatewayException.Unauthorized, is GatewayException.Forbidden ->
                "Omnesis couldn't check for an update. Open the app and check its pairing."
            else -> "Omnesis couldn't check for an update. Open the app and try again."
        }
        val intent = PendingIntent.getActivity(
            context,
            CLAIM_FAILURE_REQUEST_CODE,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.omnesis_logo)
            .setContentTitle("Couldn't check for a private update")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(intent)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(CLAIM_FAILURE_TAG, 0, notification)
        preferences.edit().putLong(KEY_LAST_CLAIM_FAILURE_NOTICE, now).apply()
    }

    @SuppressLint("MissingPermission")
    internal fun showClaimedOutcome(
        delivery: ClaimedNotificationDelivery,
        localDeviceId: String? = null,
    ): NotificationRenderOutcome {
        val route = notificationAction(delivery, localDeviceId) ?: return if (knownNotificationKind(delivery.kind)) {
            NotificationRenderOutcome.RejectedInvalid
        } else {
            NotificationRenderOutcome.DeferredUnknownKind
        }
        if (!validNotificationId(delivery.id)) return NotificationRenderOutcome.RejectedInvalid
        createNotificationChannel()
        val intent = Intent(context, MainActivity::class.java).apply {
            data = Uri.Builder()
                .scheme("omnesis")
                .authority("notification")
                .appendPath(claimedNotificationIdentity(delivery))
                .build()
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            when (val target = route.target) {
                is NotificationTarget.AgentConversation -> {
                    action = MainActivity.ACTION_AGENT_CONVERSATION
                    putExtra(MainActivity.EXTRA_CONVERSATION_ID, target.conversationId)
                    putExtra(MainActivity.EXTRA_CONVERSATION_LAUNCH_STAMP, System.nanoTime())
                }
                is NotificationTarget.PrivacyApproval -> {
                    action = MainActivity.ACTION_PRIVACY_APPROVAL
                    putExtra(MainActivity.EXTRA_APPROVAL_ID, target.approvalId)
                    putExtra(MainActivity.EXTRA_APPROVAL_LAUNCH_STAMP, System.nanoTime())
                }
                NotificationTarget.AccessAuthorization -> {
                    action = MainActivity.ACTION_ACCESS_AUTHORIZATION
                    putExtra(MainActivity.EXTRA_ACCESS_AUTHORIZATION_LAUNCH_STAMP, System.nanoTime())
                }
                is NotificationTarget.WatchFiring -> {
                    action = MainActivity.ACTION_WATCH_FIRING
                    putExtra(MainActivity.EXTRA_WATCH_ID, target.watchId)
                    putExtra(MainActivity.EXTRA_WATCH_FIRING_KEY, target.firingKey)
                    putExtra(MainActivity.EXTRA_WATCH_LAUNCH_STAMP, System.nanoTime())
                }
                is NotificationTarget.SourcePermission -> {
                    action = MainActivity.ACTION_SOURCE_PERMISSION
                    putExtra(MainActivity.EXTRA_SOURCE_ID, target.sourceId)
                    putExtra(MainActivity.EXTRA_SOURCE_PERMISSION_LAUNCH_STAMP, System.nanoTime())
                }
                is NotificationTarget.RemoteSourcePermission -> {
                    action = MainActivity.ACTION_REMOTE_SOURCE_PERMISSION
                    putExtra(MainActivity.EXTRA_SOURCE_ID, target.sourceId)
                    putExtra(MainActivity.EXTRA_AFFECTED_DEVICE_ID, target.deviceId)
                    putExtra(MainActivity.EXTRA_SOURCE_NAME, target.sourceName)
                    putExtra(MainActivity.EXTRA_AFFECTED_DEVICE_NAME, target.deviceName)
                    putExtra(MainActivity.EXTRA_REMOTE_SOURCE_PERMISSION_LAUNCH_STAMP, System.nanoTime())
                }
                NotificationTarget.App -> Unit
            }
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val channel = when (route.kind) {
            "agent-answer", "conversation" -> AGENT_CHANNEL_ID
            "privacy-approval" -> PRIVACY_CHANNEL_ID
            else -> NOTIFICATION_CHANNEL_ID
        }
        if (!notificationsAllowed(channel)) return NotificationRenderOutcome.DeferredNotificationsDisabled
        val remotePermission = route.target is NotificationTarget.RemoteSourcePermission
        val text = if (remotePermission) {
            delivery.body.ifBlank { "A paired device needs attention." } +
                " Open Omnesis to review the affected device."
        } else {
            delivery.body.ifBlank { "Open Omnesis to view this update." }
        }
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.omnesis_logo)
            .setContentTitle(
                if (remotePermission) "Permission needed on another device"
                else delivery.title.ifBlank { "Omnesis" },
            )
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(
                if (route.kind == "privacy-approval") {
                    NotificationCompat.PRIORITY_HIGH
                } else {
                    NotificationCompat.PRIORITY_DEFAULT
                },
            )
            .setCategory(
                if (route.kind == "agent-answer" || route.kind == "conversation") {
                    NotificationCompat.CATEGORY_MESSAGE
                } else {
                    NotificationCompat.CATEGORY_STATUS
                },
            )
            .setNumber(delivery.remaining.coerceAtLeast(0))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(context).notify(
            claimedNotificationIdentity(delivery),
            0,
            notification,
        )
        NotificationManagerCompat.from(context).cancel(CLAIM_FAILURE_TAG, 0)
        preferences.edit().remove(KEY_LAST_CLAIM_FAILURE_NOTICE).apply()
        return NotificationRenderOutcome.Rendered
    }

    private fun notificationsAllowed(channelId: String? = null): Boolean =
        (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || channelId == null ||
                context.getSystemService(NotificationManager::class.java)
                    .getNotificationChannel(channelId)?.importance != NotificationManager.IMPORTANCE_NONE)

    private fun createNotificationChannel() {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                PRIVACY_CHANNEL_ID,
                "Privacy approvals",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Requests to review an Omnesis answer before release"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Omnesis notifications",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Briefs, watches, and account updates from your gateway"
            },
        )
        // Agent answers get their own channel. Posting them on the privacy one
        // would list them under "Privacy approvals" in system settings, tie
        // their importance to a category the operator may reasonably silence,
        // and inherit IMPORTANCE_HIGH — which overrides the priority set on the
        // notification itself. A channel's importance cannot be lowered later
        // by the app, so the split has to exist before anyone installs this.
        manager.createNotificationChannel(
            NotificationChannel(
                AGENT_CHANNEL_ID,
                "Agent answers",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Conversations the agent added to while you were away"
            },
        )
    }

    private fun configurationKey(): String =
        "${BuildConfig.FIREBASE_APPLICATION_ID}:${BuildConfig.FIREBASE_SENDER_ID}"

    companion object {
        const val PRIVACY_CHANNEL_ID = "privacy-approvals"
        const val AGENT_CHANNEL_ID = "agent-answers"
        const val NOTIFICATION_CHANNEL_ID = "omnesis-notifications"
        private const val PREFERENCES = "omnesis_push"
        private const val KEY_TOKEN = "fcm_registration_token"
        private const val KEY_CONFIGURATION = "firebase_configuration"
        private const val KEY_PERMISSION_PROMPTED = "notification_permission_prompted"
        private const val KEY_LAST_CLAIM_FAILURE_NOTICE = "last_claim_failure_notice"
        private const val CLAIM_FAILURE_TAG = "omnesis-claim-failure"
        private const val CLAIM_FAILURE_REQUEST_CODE = 1
        private const val CLAIM_FAILURE_NOTICE_INTERVAL_MS = 30 * 60 * 1000L
    }
}

/** The Firebase SDK's token, initialising the default app from the build's properties on first use. */
class FirebaseRegistrationTokens(private val context: Context) : FcmRegistrationTokens {
    @Suppress("DEPRECATION")
    override suspend fun fetch(): String? {
        firebaseApp() ?: return null
        return runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
    }

    @Synchronized
    private fun firebaseApp(): FirebaseApp? {
        FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }?.let { return it }
        val options = FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
            .build()
        return FirebaseApp.initializeApp(context, options)
    }
}
