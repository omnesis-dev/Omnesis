// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.root

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.flow.FirstRunDecision
import dev.omnesis.android.setup.flow.PhoneSetupEntry
import dev.omnesis.android.ui.home.HomeScaffold
import dev.omnesis.android.ui.home.PHONE_SETUP_ROUTE_PATTERN
import dev.omnesis.android.ui.home.phoneSetupArguments
import dev.omnesis.android.ui.onboarding.OnboardingScreen
import dev.omnesis.android.ui.pairing.PairingScreen
import dev.omnesis.android.ui.phonesetup.PhoneSetupCoordinator
import dev.omnesis.android.ui.phonesetup.PhoneSetupScreen
import javax.inject.Inject
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class RootViewModel @Inject constructor(
    private val session: SessionManager,
    private val phoneSetup: PhoneSetupCoordinator,
) : ViewModel() {
    val state: StateFlow<SessionManager.AppState> = session.state
    val relayConsentPrompt: StateFlow<SessionManager.RelayConsentPrompt?> = session.relayConsentPrompt

    /**
     * Whether the paired device is walked through phone setup before the shell
     * appears. Re-decided when the pairing changes and when the flow records
     * the device as done.
     */
    val firstRunSetup: StateFlow<Boolean> = combine(session.state, phoneSetup.record.completedForDeviceId) { appState, _ ->
        presentsFirstRun(appState)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, presentsFirstRun(session.state.value))

    /** Whether phone setup is presenting anywhere, including when reopened from Settings. */
    val setupPresenting: StateFlow<Boolean> = phoneSetup.gate.presenting

    init {
        // A paired phone that already contributes is recorded as done, and so never sees the first run.
        viewModelScope.launch {
            session.state.collect { appState ->
                if (appState is SessionManager.AppState.Paired) phoneSetup.completeSilentlyIfContributing(appState.pairing.deviceId)
            }
        }
    }

    private fun presentsFirstRun(appState: SessionManager.AppState): Boolean =
        appState is SessionManager.AppState.Paired &&
            phoneSetup.firstRunDecision(appState.pairing.deviceId) == FirstRunDecision.PRESENT

    fun grantRelayConsent() = session.allowRelayConsent()

    fun dismissRelayConsent() = session.dismissRelayConsent()
}

/** Top-level switch: the unpaired onboarding flow, first-run phone setup, or the paired home. */
@Composable
fun RootScreen(vm: RootViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val relayConsentPrompt by vm.relayConsentPrompt.collectAsStateWithLifecycle()
    val firstRunSetup by vm.firstRunSetup.collectAsStateWithLifecycle()
    val setupPresenting by vm.setupPresenting.collectAsStateWithLifecycle()
    when (state) {
        is SessionManager.AppState.Unpaired -> UnpairedFlow()
        is SessionManager.AppState.Paired -> if (firstRunSetup) FirstRunPhoneSetup() else HomeScaffold()
    }
    if (relayConsentDialogVisible(firstRunSetup, setupPresenting)) {
        relayConsentPrompt?.let { prompt ->
            RelayConsentSheet(
                prompt = prompt,
                appId = prompt.appId,
                onGrant = vm::grantRelayConsent,
                onDismiss = vm::dismissRelayConsent,
            )
        }
    }
}

/**
 * Whether the relay disclosure may show as its bottom sheet. It waits while phone setup
 * presents: the flow asks on its own page before Finish, and a request still pending
 * once the flow closes appears here.
 */
internal fun relayConsentDialogVisible(firstRunSetup: Boolean, setupPresenting: Boolean): Boolean =
    !firstRunSetup && !setupPresenting

/**
 * The first-run flow, in a navigation host of its own so each showing gets a
 * fresh flow: the host leaves composition when the device is recorded as done,
 * and a later pairing that should see the flow again composes a new one.
 */
@Composable
private fun FirstRunPhoneSetup() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = PHONE_SETUP_ROUTE_PATTERN) {
        composable(route = PHONE_SETUP_ROUTE_PATTERN, arguments = phoneSetupArguments(PhoneSetupEntry.FIRST_RUN)) {
            // Finishing or skipping records the device as done, which swaps this host for the shell.
            PhoneSetupScreen(onClose = {})
        }
    }
}

@Composable
private fun UnpairedFlow() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = "onboarding") {
        composable("onboarding") {
            OnboardingScreen(onPairClicked = { nav.navigate("pairing") })
        }
        composable("pairing") {
            PairingScreen(onBack = { nav.popBackStack() })
        }
    }
}
