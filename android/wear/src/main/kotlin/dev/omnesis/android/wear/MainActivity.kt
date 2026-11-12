// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.Manifest
import android.app.RemoteInput
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.wear.input.RemoteInputIntentHelper
import dev.omnesis.android.wear.core.TextInputPurpose
import dev.omnesis.android.wear.core.WatchEffect
import dev.omnesis.android.wear.core.WatchHaptic
import dev.omnesis.android.wear.device.MicPermissionGate
import dev.omnesis.android.wear.device.SystemEnvironment
import dev.omnesis.android.wear.ui.WatchApp
import dev.omnesis.android.wearprotocol.WearLine
import dev.omnesis.android.wearprotocol.WearRoute
import kotlinx.coroutines.launch

/**
 * The app's one screen. The launcher opens it on the ask screen; the tile
 * and the complication open it with a [WearRoute], which starts the recorder.
 */
class MainActivity : ComponentActivity(), MicPermissionGate.Host {
    private val container get() = (application as WearApp).container
    private val viewModel: WatchViewModel by viewModels {
        WatchViewModel.factory(container, SystemEnvironment::now)
    }

    private var permissionResult: ((Boolean) -> Unit)? = null
    private val permissionPrompt = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionResult?.invoke(granted)
        permissionResult = null
    }

    /** What the text being entered on the system input screen is for, while that screen is up. */
    private var textInputPurpose: TextInputPurpose? = null
    private val textInput = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val purpose = textInputPurpose ?: return@registerForActivityResult
        textInputPurpose = null
        val entered = result.data?.let(RemoteInput::getResultsFromIntent)?.getCharSequence(TEXT_INPUT_KEY)
        container.core.textEntered(purpose, entered?.toString())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container.permission.attach(this)
        // The system input screen can outlive this one; what it returns is still for the same purpose.
        textInputPurpose = savedInstanceState?.getString(STATE_TEXT_INPUT_PURPOSE)?.let { saved ->
            TextInputPurpose.entries.firstOrNull { it.name == saved }
        }
        // A restored screen is handed the intent that first opened it, which
        // nobody pressed just now.
        if (savedInstanceState == null) open(intent)
        setContent { WatchApp(viewModel) }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { viewModel.effects.collect(::perform) }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        textInputPurpose?.let { outState.putString(STATE_TEXT_INPUT_PURPOSE, it.name) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        open(intent)
    }

    override fun onResume() {
        super.onResume()
        container.presence.resumed = true
    }

    override fun onPause() {
        container.presence.resumed = false
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        // The permission prompt and the text input stop this screen without
        // the person having left the app.
        val stillHere = container.permission.promptShowing || textInputPurpose != null || isChangingConfigurations
        if (!stillHere) container.core.enteredBackground()
    }

    override fun onDestroy() {
        container.permission.detach(this)
        super.onDestroy()
    }

    override fun requestMicrophone(onResult: (Boolean) -> Unit) {
        permissionResult?.invoke(false)
        permissionResult = onResult
        permissionPrompt.launch(Manifest.permission.RECORD_AUDIO)
    }

    /** Ask for the recorder when [intent] is a tile or complication press. */
    private fun open(intent: Intent?) {
        if (intent == null) return
        val replayed = (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
        if (opensRecorder(intent.dataString, intent.getStringExtra(EXTRA_ROUTE), replayed)) {
            container.core.requestCapture()
        }
    }

    private fun perform(effect: WatchEffect) {
        when (effect) {
            WatchEffect.Leave -> leaveForWatchFace()
            is WatchEffect.RequestTextInput -> openTextInput(effect.purpose)
        }
    }

    private fun leaveForWatchFace() {
        if (isFinishing) return
        startActivity(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        finishAndRemoveTask()
    }

    private fun openTextInput(purpose: TextInputPurpose) {
        val label = when (purpose) {
            TextInputPurpose.QUESTION -> WearLine.ASK.text
            TextInputPurpose.NOTE -> WearLine.NOTE_TITLE.text
        }
        val request = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(
            request,
            listOf(RemoteInput.Builder(TEXT_INPUT_KEY).setLabel(label).build()),
        )
        try {
            textInputPurpose = purpose
            textInput.launch(request)
        } catch (_: ActivityNotFoundException) {
            textInputPurpose = null
            WearLog.error("This watch has no text input to open")
            container.haptics.play(WatchHaptic.FAILURE)
        }
    }

    companion object {
        /** Carries a [WearRoute] link when the launcher cannot set the intent's data, as a tile cannot. */
        const val EXTRA_ROUTE = "dev.omnesis.android.wear.extra.ROUTE"
        private const val TEXT_INPUT_KEY = "text"
        private const val STATE_TEXT_INPUT_PURPOSE = "textInputPurpose"

        /**
         * Whether a launch asks for the recorder: its data, or failing that
         * its route extra, is one of the app's deep links, and it was not
         * [replayed] from the recent apps list, where nobody pressed anything.
         */
        internal fun opensRecorder(data: String?, routeExtra: String?, replayed: Boolean): Boolean {
            if (replayed) return false
            val link = data ?: routeExtra ?: return false
            return WearRoute.parse(link) != null
        }
    }
}
