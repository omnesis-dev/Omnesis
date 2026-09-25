// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.toArgb
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import dagger.hilt.android.AndroidEntryPoint
import dev.omnesis.android.access.accessAuthorizationIdentity
import dev.omnesis.android.access.consumedAccessAuthorizationIntent
import dev.omnesis.android.access.routeAccessAuthorizationDeepLink
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notifications.NotificationLaunchBus
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.ui.capture.CaptureLaunchBus
import dev.omnesis.android.ui.capture.CaptureSurface
import dev.omnesis.android.ui.root.RootScreen
import dev.omnesis.android.ui.search.SearchLaunchBus
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.AppearanceStore
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var sessionManager: SessionManager

    @Inject
    lateinit var appearance: AppearanceStore

    @Inject
    lateinit var captureLaunchBus: CaptureLaunchBus

    @Inject
    lateinit var notesRepository: NotesRepository

    @Inject
    lateinit var sourceMembership: SourceMembership

    @Inject
    lateinit var notificationLaunchBus: NotificationLaunchBus

    @Inject
    lateinit var searchLaunchBus: SearchLaunchBus

    /**
     * The tile stamp of the last capture intent already handled, restored across
     * recreations so a re-delivered intent isn't re-posted. 0 = none handled yet.
     */
    private var lastHandledLaunchStamp = 0L
    private var lastHandledApprovalLaunchStamp = 0L
    private var lastHandledAccessAuthorizationLaunchStamp = 0L
    private var lastHandledConversationLaunchStamp = 0L
    private var lastHandledWatchLaunchStamp = 0L
    private var lastHandledSourcePermissionLaunchStamp = 0L
    private var lastHandledRemoteSourcePermissionLaunchStamp = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lastHandledLaunchStamp = savedInstanceState?.getLong(STATE_LAUNCH_STAMP) ?: 0L
        lastHandledApprovalLaunchStamp = savedInstanceState?.getLong(STATE_APPROVAL_LAUNCH_STAMP) ?: 0L
        lastHandledAccessAuthorizationLaunchStamp =
            savedInstanceState?.getLong(STATE_ACCESS_AUTHORIZATION_LAUNCH_STAMP) ?: 0L
        lastHandledConversationLaunchStamp =
            savedInstanceState?.getLong(STATE_CONVERSATION_LAUNCH_STAMP) ?: 0L
        lastHandledWatchLaunchStamp = savedInstanceState?.getLong(STATE_WATCH_LAUNCH_STAMP) ?: 0L
        lastHandledSourcePermissionLaunchStamp =
            savedInstanceState?.getLong(STATE_SOURCE_PERMISSION_LAUNCH_STAMP) ?: 0L
        lastHandledRemoteSourcePermissionLaunchStamp =
            savedInstanceState?.getLong(STATE_REMOTE_SOURCE_PERMISSION_LAUNCH_STAMP) ?: 0L
        maybeHandleCaptureIntent(intent, firstCreation = savedInstanceState == null)
        maybeHandlePrivacyApprovalIntent(intent, firstCreation = savedInstanceState == null)
        maybeHandleAccessAuthorizationIntent(intent, firstCreation = savedInstanceState == null)
        maybeHandleAccessAuthorizationDeepLink(intent)
        maybeHandleAgentConversationIntent(intent, firstCreation = savedInstanceState == null)
        maybeHandleWatchFiringIntent(intent, firstCreation = savedInstanceState == null)
        maybeHandleSourcePermissionIntent(intent, firstCreation = savedInstanceState == null)
        maybeHandleRemoteSourcePermissionIntent(intent, firstCreation = savedInstanceState == null)
        maybeHandleSearchIntent(intent, freshDelivery = savedInstanceState == null)
        // Draw edge-to-edge so the themed app background paints behind the status + navigation
        // bars (the bars themselves are coloured + their icons toned from the active theme below).
        enableEdgeToEdge()
        if (BuildConfig.DEBUG) maybeSeedPairing(intent)
        setContent {
            val mode by appearance.mode.collectAsStateWithLifecycle()
            val dark = when (mode) {
                AppearanceMode.LIGHT -> false
                AppearanceMode.DARK -> true
                AppearanceMode.SYSTEM -> isSystemInDarkTheme()
            }
            OmnesisTheme(darkTheme = dark) {
                // System-bar appearance follows the in-app theme (not just the OS one): a
                // transparent status bar so the app background shows through and matches it, a
                // nav bar tinted to the app background at slight translucency (whitish in light,
                // black in dark) that content scrolls gently under, and bar icons toned for
                // legibility against each.
                val navBarColor = OmTheme.colors.bgPrimary.copy(alpha = 0.85f).toArgb()
                LaunchedEffect(dark, navBarColor) {
                    val controller = WindowCompat.getInsetsController(window, window.decorView)
                    controller.isAppearanceLightStatusBars = !dark
                    controller.isAppearanceLightNavigationBars = !dark
                    window.statusBarColor = Color.TRANSPARENT
                    window.navigationBarColor = navBarColor
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        window.isNavigationBarContrastEnforced = false
                    }
                }
                RootScreen()
            }
        }
    }

    private fun maybeHandleSourcePermissionIntent(launchIntent: Intent?, firstCreation: Boolean = false) {
        if (launchIntent?.action != ACTION_SOURCE_PERMISSION) return
        val sourceId = launchIntent.getStringExtra(EXTRA_SOURCE_ID)?.takeIf { it.isNotBlank() } ?: return
        val stamp = launchIntent.getLongExtra(EXTRA_SOURCE_PERMISSION_LAUNCH_STAMP, 0L)
        if (!firstCreation && stamp != 0L && stamp == lastHandledSourcePermissionLaunchStamp) return
        lastHandledSourcePermissionLaunchStamp = stamp
        notificationLaunchBus.postSourcePermission(sourceId)
    }

    private fun maybeHandleRemoteSourcePermissionIntent(launchIntent: Intent?, firstCreation: Boolean = false) {
        if (launchIntent?.action != ACTION_REMOTE_SOURCE_PERMISSION) return
        val sourceId = launchIntent.getStringExtra(EXTRA_SOURCE_ID)?.takeIf { it.isNotBlank() } ?: return
        val deviceId = launchIntent.getStringExtra(EXTRA_AFFECTED_DEVICE_ID)?.takeIf { it.isNotBlank() } ?: return
        val sourceName = launchIntent.getStringExtra(EXTRA_SOURCE_NAME)?.takeIf { it.isNotBlank() }
        val deviceName = launchIntent.getStringExtra(EXTRA_AFFECTED_DEVICE_NAME)?.takeIf { it.isNotBlank() }
        val stamp = launchIntent.getLongExtra(EXTRA_REMOTE_SOURCE_PERMISSION_LAUNCH_STAMP, 0L)
        if (!firstCreation && stamp != 0L && stamp == lastHandledRemoteSourcePermissionLaunchStamp) return
        lastHandledRemoteSourcePermissionLaunchStamp = stamp
        notificationLaunchBus.postRemoteSourcePermission(sourceId, deviceId, sourceName, deviceName)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // singleTask: a tile / app-shortcut launch while the app is alive lands here.
        // setIntent so a later recreation compares its stamp against this intent,
        // not the original launch one.
        setIntent(intent)
        maybeHandleCaptureIntent(intent)
        maybeHandlePrivacyApprovalIntent(intent)
        maybeHandleAccessAuthorizationIntent(intent)
        maybeHandleAccessAuthorizationDeepLink(intent)
        maybeHandleAgentConversationIntent(intent)
        maybeHandleWatchFiringIntent(intent)
        maybeHandleSourcePermissionIntent(intent)
        maybeHandleRemoteSourcePermissionIntent(intent)
        maybeHandleSearchIntent(intent, freshDelivery = true)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putLong(STATE_LAUNCH_STAMP, lastHandledLaunchStamp)
        outState.putLong(STATE_APPROVAL_LAUNCH_STAMP, lastHandledApprovalLaunchStamp)
        outState.putLong(
            STATE_ACCESS_AUTHORIZATION_LAUNCH_STAMP,
            lastHandledAccessAuthorizationLaunchStamp,
        )
        outState.putLong(STATE_CONVERSATION_LAUNCH_STAMP, lastHandledConversationLaunchStamp)
        outState.putLong(STATE_WATCH_LAUNCH_STAMP, lastHandledWatchLaunchStamp)
        outState.putLong(STATE_SOURCE_PERMISSION_LAUNCH_STAMP, lastHandledSourcePermissionLaunchStamp)
        outState.putLong(STATE_REMOTE_SOURCE_PERMISSION_LAUNCH_STAMP, lastHandledRemoteSourcePermissionLaunchStamp)
    }

    override fun onStart() {
        super.onStart()
        // Push any offline-queued quick-capture notes on every app start /
        // return to foreground. No-op while unpaired or with an empty queue.
        lifecycleScope.launch { runCatching { notesRepository.drain() } }
        // Registration is best-effort during pairing; retry on every foreground
        // so a transient gateway or FCM failure does not permanently disable push.
        sessionManager.beginForegroundVisit()
        lifecycleScope.launch { sessionManager.retryFcmRegistration() }
        // A source the user turned off while the gateway was unreachable is
        // still listed there as hosted by this phone until the detach lands.
        sourceMembership.retryPending()
    }

    /**
     * The Quick Settings tile and the static app shortcut both launch this
     * activity with [ACTION_TELL_BRAIN]; the carried surface slug rides through
     * the [CaptureLaunchBus] into the nav graph, which opens the capture route.
     *
     * The tile stamps each tap with [EXTRA_LAUNCH_STAMP]: a stamped intent is
     * handled whenever its stamp differs from the last-handled one, which covers
     * both a fresh tap AND a singleTask relaunch after process death (where the
     * still-unhandled intent arrives with non-null saved state). A recreation
     * (rotation, theme change) re-delivers an already-handled stamp and is
     * skipped. The static shortcut can't carry a dynamic extra, so it keeps the
     * first-creation check — a shortcut launch restored after process death is
     * dropped (the user lands in the app, one tap from capture).
     */
    private fun maybeHandleCaptureIntent(launchIntent: Intent?, firstCreation: Boolean = true) {
        if (launchIntent?.action != ACTION_TELL_BRAIN) return
        val stamp = launchIntent.getLongExtra(EXTRA_LAUNCH_STAMP, 0L)
        val shouldHandle = if (stamp != 0L) stamp != lastHandledLaunchStamp else firstCreation
        if (!shouldHandle) return
        lastHandledLaunchStamp = stamp
        val surface = launchIntent.getStringExtra(EXTRA_SURFACE) ?: CaptureSurface.APP
        captureLaunchBus.post(surface)
    }

    private fun maybeHandleSearchIntent(launchIntent: Intent?, freshDelivery: Boolean) {
        if (!freshDelivery || launchIntent?.action != ACTION_SEARCH) return
        searchLaunchBus.post(launchIntent.getStringExtra(EXTRA_SEARCH_QUERY))
    }

    private fun maybeHandlePrivacyApprovalIntent(
        launchIntent: Intent?,
        firstCreation: Boolean = true,
    ) {
        if (launchIntent?.action != ACTION_PRIVACY_APPROVAL) return
        val approvalId = launchIntent.getStringExtra(EXTRA_APPROVAL_ID)?.takeIf { it.isNotBlank() } ?: return
        val stamp = launchIntent.getLongExtra(EXTRA_APPROVAL_LAUNCH_STAMP, 0L)
        val shouldHandle = if (stamp != 0L) {
            stamp != lastHandledApprovalLaunchStamp
        } else {
            firstCreation
        }
        if (!shouldHandle) return
        lastHandledApprovalLaunchStamp = stamp
        notificationLaunchBus.postPrivacyApproval(approvalId)
    }

    private fun maybeHandleAccessAuthorizationIntent(
        launchIntent: Intent?,
        firstCreation: Boolean = true,
    ) {
        if (launchIntent?.action != ACTION_ACCESS_AUTHORIZATION) return
        val stamp = launchIntent.getLongExtra(EXTRA_ACCESS_AUTHORIZATION_LAUNCH_STAMP, 0L)
        val shouldHandle = if (stamp != 0L) {
            stamp != lastHandledAccessAuthorizationLaunchStamp
        } else {
            firstCreation
        }
        if (!shouldHandle) return
        lastHandledAccessAuthorizationLaunchStamp = stamp
        notificationLaunchBus.postAccessAuthorization()
    }

    private fun maybeHandleAccessAuthorizationDeepLink(launchIntent: Intent?) {
        val pairingIdentity = (sessionManager.state.value as? SessionManager.AppState.Paired)
            ?.pairing
            ?.accessAuthorizationIdentity()
        val handled = routeAccessAuthorizationDeepLink(
            launchIntent,
            freshDelivery = true,
            pairingIdentity = pairingIdentity,
            onLaunch = notificationLaunchBus::postAccessAuthorization,
        )
        if (!handled || launchIntent == null) return

        // Consume every canonical public URI, including one received while unpaired. A
        // configuration recreation must not route that stale code after a later pairing,
        // while a genuinely new ACTION_VIEW still works in a restored killed task.
        setIntent(consumedAccessAuthorizationIntent(launchIntent))
    }

    private fun maybeHandleAgentConversationIntent(
        launchIntent: Intent?,
        firstCreation: Boolean = true,
    ) {
        if (launchIntent?.action != ACTION_AGENT_CONVERSATION) return
        val conversationId =
            launchIntent.getStringExtra(EXTRA_CONVERSATION_ID)?.takeIf { it.isNotBlank() } ?: return
        val stamp = launchIntent.getLongExtra(EXTRA_CONVERSATION_LAUNCH_STAMP, 0L)
        val shouldHandle = if (stamp != 0L) {
            stamp != lastHandledConversationLaunchStamp
        } else {
            firstCreation
        }
        if (!shouldHandle) return
        lastHandledConversationLaunchStamp = stamp
        notificationLaunchBus.postAgentConversation(conversationId)
    }

    private fun maybeHandleWatchFiringIntent(
        launchIntent: Intent?,
        firstCreation: Boolean = true,
    ) {
        if (launchIntent?.action != ACTION_WATCH_FIRING) return
        val watchId = launchIntent.getStringExtra(EXTRA_WATCH_ID)?.takeIf { it.isNotBlank() } ?: return
        val firingKey = launchIntent.getStringExtra(EXTRA_WATCH_FIRING_KEY)
            ?.takeIf { it.isNotBlank() } ?: return
        val stamp = launchIntent.getLongExtra(EXTRA_WATCH_LAUNCH_STAMP, 0L)
        val shouldHandle = if (stamp != 0L) stamp != lastHandledWatchLaunchStamp else firstCreation
        if (!shouldHandle) return
        lastHandledWatchLaunchStamp = stamp
        notificationLaunchBus.postWatchFiring(watchId, firingKey)
    }

    /**
     * Debug-only: pair non-interactively from `am start` extras so the paired flow
     * can be exercised on an emulator or in CI without driving the pairing UI. It
     * runs the REAL [SessionManager.pairManually] exchange against the gateway.
     *
     *   adb shell am start -n dev.omnesis.android/.MainActivity \
     *     --es seed_url https://10.0.2.2:17700 --es seed_code <CODE> \
     *     --es seed_fingerprint <SHA256_HEX>
     */
    private fun maybeSeedPairing(launchIntent: Intent?) {
        val url = launchIntent?.getStringExtra("seed_url") ?: return
        val code = launchIntent.getStringExtra("seed_code") ?: return
        val fingerprint = launchIntent.getStringExtra("seed_fingerprint")
        lifecycleScope.launch {
            runCatching { sessionManager.pairManually(url, code, fingerprint) }
        }
    }

    companion object {
        const val ACTION_SEARCH = "dev.omnesis.android.action.SEARCH"
        const val EXTRA_SEARCH_QUERY = "query"
        /** Intent action the quick-capture entry points (QS tile, app shortcut) launch with. */
        const val ACTION_TELL_BRAIN = "dev.omnesis.android.action.TELL_BRAIN"

        /** String extra naming the capture surface slug ("android-tile", "android-shortcut"). */
        const val EXTRA_SURFACE = "surface"

        /** Long extra: per-tap `elapsedRealtime()` stamp the tile sets so re-delivered intents are detectable. */
        const val EXTRA_LAUNCH_STAMP = "launch_stamp"

        const val ACTION_AGENT_CONVERSATION = "dev.omnesis.android.action.AGENT_CONVERSATION"
        const val EXTRA_CONVERSATION_ID = "agent_conversation_id"
        const val EXTRA_CONVERSATION_LAUNCH_STAMP = "agent_conversation_launch_stamp"
        const val ACTION_PRIVACY_APPROVAL = "dev.omnesis.android.action.PRIVACY_APPROVAL"
        const val EXTRA_APPROVAL_ID = "privacy_approval_id"
        const val EXTRA_APPROVAL_LAUNCH_STAMP = "privacy_approval_launch_stamp"
        const val ACTION_ACCESS_AUTHORIZATION = "dev.omnesis.android.action.ACCESS_AUTHORIZATION"
        const val EXTRA_ACCESS_AUTHORIZATION_LAUNCH_STAMP = "access_authorization_launch_stamp"
        const val ACTION_WATCH_FIRING = "dev.omnesis.android.action.WATCH_FIRING"
        const val EXTRA_WATCH_ID = "watch_id"
        const val EXTRA_WATCH_FIRING_KEY = "watch_firing_key"
        const val EXTRA_WATCH_LAUNCH_STAMP = "watch_launch_stamp"
        const val ACTION_SOURCE_PERMISSION = "dev.omnesis.android.action.SOURCE_PERMISSION"
        const val EXTRA_SOURCE_ID = "source_permission_source_id"
        const val EXTRA_SOURCE_PERMISSION_LAUNCH_STAMP = "source_permission_launch_stamp"
        const val ACTION_REMOTE_SOURCE_PERMISSION = "dev.omnesis.android.action.REMOTE_SOURCE_PERMISSION"
        const val EXTRA_AFFECTED_DEVICE_ID = "remote_source_permission_device_id"
        const val EXTRA_SOURCE_NAME = "remote_source_permission_source_name"
        const val EXTRA_AFFECTED_DEVICE_NAME = "remote_source_permission_device_name"
        const val EXTRA_REMOTE_SOURCE_PERMISSION_LAUNCH_STAMP = "remote_source_permission_launch_stamp"

        /** Saved-state key for [lastHandledLaunchStamp]. */
        private const val STATE_LAUNCH_STAMP = "last_handled_launch_stamp"
        private const val STATE_APPROVAL_LAUNCH_STAMP = "last_handled_approval_launch_stamp"
        private const val STATE_ACCESS_AUTHORIZATION_LAUNCH_STAMP =
            "last_handled_access_authorization_launch_stamp"
        private const val STATE_CONVERSATION_LAUNCH_STAMP =
            "last_handled_conversation_launch_stamp"
        private const val STATE_WATCH_LAUNCH_STAMP = "last_handled_watch_launch_stamp"
        private const val STATE_SOURCE_PERMISSION_LAUNCH_STAMP =
            "last_handled_source_permission_launch_stamp"
        private const val STATE_REMOTE_SOURCE_PERMISSION_LAUNCH_STAMP =
            "last_handled_remote_source_permission_launch_stamp"
    }
}
