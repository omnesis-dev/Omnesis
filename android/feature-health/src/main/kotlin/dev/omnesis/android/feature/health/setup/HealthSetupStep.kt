// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.setup

import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.omnesis.android.feature.health.HealthCategory
import dev.omnesis.android.feature.health.HealthIntegration
import dev.omnesis.android.feature.health.HealthSessionProvider
import dev.omnesis.android.feature.health.HealthSettings
import dev.omnesis.android.feature.health.HealthTypeCatalog
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.feature.health.di.HealthConnectStatusReader
import dev.omnesis.android.feature.health.enabledHealthTypePermissions
import dev.omnesis.android.feature.health.ui.healthCategoryUi
import dev.omnesis.android.feature.health.ui.openHealthConnectPermissions
import dev.omnesis.android.feature.health.ui.openHealthConnectPlayStore
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.SetupStepController
import dev.omnesis.android.setup.flow.HostedSourceEnableActions
import dev.omnesis.android.setup.flow.SetupAccessKind
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SourceEnableSequence
import dev.omnesis.android.setup.flow.hostedSourceChoices
import dev.omnesis.android.setup.ui.SetupLauncher
import dev.omnesis.android.setup.ui.SetupLedgerSection
import dev.omnesis.android.setup.ui.SetupToggleChip
import dev.omnesis.android.setup.ui.rememberSourceSetupController
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SessionScopeProvider
import dev.omnesis.android.transport.SourceMembership
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** After this many empty answers in a row Health Connect stops showing its sheet. */
const val HEALTH_CONSENT_DISMISSALS_BEFORE_SETTINGS = 2

/** The fine print while no category is selected, when there is nothing to ask for. */
const val HEALTH_NO_CATEGORY_NOTE = "Choose at least one category."

/** Why Health Connect cannot be used, in the words the setup page shows; null when it can. */
fun healthSetupUnavailable(availability: HealthConnectAvailability): SetupOutcome.Unavailable? = when (availability) {
    HealthConnectAvailability.Available -> null
    HealthConnectAvailability.NotInstalled -> SetupOutcome.Unavailable(
        title = "Health Connect isn't installed",
        body = "Install it from the Play Store, then come back.",
        actionLabel = "Install Health Connect",
    )
    HealthConnectAvailability.UpdateRequired -> SetupOutcome.Unavailable(
        title = "Health Connect needs an update",
        body = "Update it from the Play Store, then come back.",
        actionLabel = "Update Health Connect",
    )
    HealthConnectAvailability.NotSupported -> SetupOutcome.Unavailable(
        title = "Health Connect isn't available on this phone",
        body = "This version of Android can't run Health Connect.",
        actionLabel = null,
    )
}

/** Whether a consent answer lets the enable continue: it has to cover at least one requested record type. */
fun healthConsentGrantsAccess(granted: Set<String>, requestedTypes: Set<String>): Boolean =
    (granted intersect requestedTypes).isNotEmpty()

/**
 * How a Health Connect enable reads once the grants are known: on with
 * everything it asked for, on with limits when a record type, background
 * reading or older history was left off, and off when no type was allowed.
 */
fun healthSetupOutcome(
    availability: HealthConnectAvailability,
    requestedTypes: Set<String>,
    granted: Set<String>,
    backgroundSupported: Boolean,
    historySupported: Boolean,
): SetupOutcome {
    healthSetupUnavailable(availability)?.let { return it }
    if (!healthConsentGrantsAccess(granted, requestedTypes)) return SetupOutcome.NotAllowed
    val missingTypes = requestedTypes - granted
    val backgroundMissing = backgroundSupported && HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND !in granted
    val historyMissing = historySupported && HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY !in granted
    return if (missingTypes.isEmpty() && !backgroundMissing && !historyMissing) SetupOutcome.On else SetupOutcome.Partial
}

/**
 * Where availability stands after the user came back from the Play Store.
 * Right after an install the provider can report "update required" for a
 * moment before its service is bindable, so that answer is read again a few
 * times before it is believed. Null means Health Connect is ready.
 */
suspend fun healthAvailabilityAfterInstall(
    availability: () -> HealthConnectAvailability,
    attempts: Int = 3,
    retryDelayMillis: Long = 1_500,
): SetupOutcome.Unavailable? {
    repeat(attempts) { attempt ->
        val now = availability()
        if (now == HealthConnectAvailability.Available) return null
        if (now != HealthConnectAvailability.UpdateRequired || attempt == attempts - 1) return healthSetupUnavailable(now)
        delay(retryDelayMillis)
    }
    return healthSetupUnavailable(availability())
}

/**
 * The Health Connect page of the phone setup flow, and the only way Health
 * Connect is turned on: its Settings card opens this page too.
 *
 * The categories the page shows are a selection of its own until the user
 * agrees; only then are they saved to [HealthSettings] and asked for.
 */
@Singleton
class HealthSetupStep @Inject constructor(
    private val integration: HealthIntegration,
    private val settings: HealthSettings,
    private val status: HealthConnectStatusReader,
    private val sessions: HealthSessionProvider,
    private val membership: SourceMembership,
    private val permissionHealth: PermissionHealthCoordinator,
    private val sessionScopes: SessionScopeProvider,
) : PhoneSetupStep {
    /** Outlives any page, so an enable under way finishes after the user moves on. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** The categories saved in [HealthSettings], as last read. */
    private val saved = MutableStateFlow(settings.enabledCategories)

    /** The page's own selection once the user changed a chip; null while it follows [saved]. */
    private val draft = MutableStateFlow<Set<HealthCategory>?>(null)

    /** Set while the user is in the Play Store installing or updating Health Connect. */
    @Volatile private var storeTripPending = false

    internal val actions = HostedSourceEnableActions(
        membership = membership,
        sourceId = integration.sourceId,
        mode = integration.hostedSourceContract.multiDeviceMode,
        optIn = { optIn() },
        sessionGeneration = { sessionScopes.generation },
    )

    internal val sequence = SourceEnableSequence(
        scope = scope,
        actions = actions,
        isOn = ::isOn,
        isGranted = { healthConsentGrantsAccess(readGrants(), requestedTypes()) },
        // The consent sheet can add types to an existing grant, so it is skipped only once every requested type is allowed.
        grantedWithoutAsking = { readGrants().containsAll(requestedTypes()) },
        outcomeAfterEnable = ::currentOutcome,
        accessKind = ::accessKind,
        unavailable = { healthSetupUnavailable(status.availability()) },
        choiceOptions = hostedSourceChoices(HealthSetupCopy.name),
    )

    override val id: String = integration.sourceId
    override val order: Int = 10
    override val group: SetupGroup = SetupGroup.SOURCE
    override val sourceId: String = integration.sourceId
    override val copy = HealthSetupCopy
    override val outcomes: Flow<SetupOutcome?> = sequence.outcomes

    override val extraSection: (@Composable () -> Unit) = {
        HealthCategoryChips(rememberSelection(), ::toggleCategory)
    }

    /** The categories the page shows and Agree asks for. */
    internal val categories: Set<HealthCategory> get() = draft.value ?: saved.value

    override suspend fun refresh() {
        saved.value = settings.enabledCategories
    }

    override fun availability(): SetupAvailability =
        if (status.availability() == HealthConnectAvailability.NotSupported) {
            SetupAvailability.Disabled("Not available on this phone")
        } else {
            SetupAvailability.Available
        }

    override fun isOn(): Boolean = settings.healthConnectEnabled

    override suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? = when {
        previous is SetupOutcome.Unavailable && status.availability() == HealthConnectAvailability.Available -> null
        isOn() -> currentOutcome()
        else -> previous
    }

    override fun notNow() {
        draft.value = null
        sequence.notNow()
    }

    override fun resume() = sequence.onResume()

    override fun reset() {
        draft.value = null
        storeTripPending = false
        sequence.reset()
    }

    internal fun toggleCategory(category: HealthCategory, enabled: Boolean) {
        draft.value = if (enabled) categories + category else categories - category
    }

    /** Saves the page's selection and starts the enable; nothing happens while no category is selected. */
    internal fun agree() {
        val selected = categories
        if (selected.isEmpty() || sequence.inFlight) return
        settings.enabledCategories = selected
        saved.value = settings.enabledCategories
        draft.value = null
        sequence.start()
    }

    /** Health Connect's consent sheet answered with [granted]. */
    internal fun onConsentAnswer(granted: Set<String>) {
        settings.hasRequestedPermissions = true
        settings.recordConsentResult(granted)
        sequence.onAccessResult(healthConsentGrantsAccess(granted, requestedTypes()))
    }

    @Composable
    override fun rememberController(): SetupStepController {
        val context = LocalContext.current
        val selected = rememberSelection()
        val contract = remember { PermissionController.createRequestPermissionResultContract() }
        val consent = rememberLauncherForActivityResult(contract) { granted -> onConsentAnswer(granted) }
        val launcher = remember(consent, context) {
            object : SetupLauncher {
                override fun launch() {
                    val opened = if (accessKind() == SetupAccessKind.ROUND_TRIP) {
                        openHealthConnectPermissions(context)
                    } else {
                        runCatching { consent.launch(permissionsToRequest()) }.isSuccess
                    }
                    if (!opened) sequence.onLaunchFailed()
                }

                override fun openSettings(): Boolean = openHealthConnectPermissions(context)
            }
        }
        LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { returnedFromStore() }
        return rememberSourceSetupController(
            sequence = sequence,
            launcher = launcher,
            primaryEnabled = selected.isNotEmpty(),
            fineNote = if (selected.isEmpty()) HEALTH_NO_CATEGORY_NOTE else null,
            onAgree = ::agree,
            // The unavailable outcome's Install or Update Health Connect.
            secondaryAction = { openStore(context) },
        )
    }

    @Composable
    private fun rememberSelection(): Set<HealthCategory> {
        val draftNow by draft.collectAsState()
        val savedNow by saved.collectAsState()
        return draftNow ?: savedNow
    }

    /**
     * Health Connect's contract returns silently once its sheet was dismissed twice, so from
     * then on the request goes to its permissions screen and the grant is read on return.
     */
    private fun accessKind(): SetupAccessKind =
        if (settings.consentDismissals >= HEALTH_CONSENT_DISMISSALS_BEFORE_SETTINGS) SetupAccessKind.ROUND_TRIP else SetupAccessKind.DIALOG

    private fun openStore(context: Context) {
        storeTripPending = openHealthConnectPlayStore(context)
    }

    /** Back from the Play Store: the page follows what Health Connect can do now. */
    private fun returnedFromStore() {
        if (!storeTripPending) return
        storeTripPending = false
        scope.launch { sequence.report(healthAvailabilityAfterInstall(status::availability)) }
    }

    private fun permissionsToRequest(): Set<String> =
        HealthTypeCatalog.permissionsToRequest(settings.enabledCategories, status::featureAvailable)

    private fun requestedTypes(): Set<String> = enabledHealthTypePermissions(settings, status::featureAvailable)

    /** The current grants; one that covers a requested type means the consent sheet can show again. */
    private suspend fun readGrants(): Set<String> {
        val granted = status.grantedPermissions()
        if (healthConsentGrantsAccess(granted, requestedTypes())) settings.clearConsentDismissals()
        return granted
    }

    private suspend fun currentOutcome(): SetupOutcome = healthSetupOutcome(
        availability = status.availability(),
        requestedTypes = requestedTypes(),
        granted = readGrants(),
        backgroundSupported = status.featureAvailable(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND),
        historySupported = status.featureAvailable(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY),
    )

    /** The local half, once the gateway accepted this phone; its first sync belongs to the current session. */
    private fun optIn() {
        integration.optIn(membership) {
            val coordinator = sessions.coordinator()
            val sessionScope = sessionScopes.current()
            if (coordinator != null && sessionScope != null) integration.launchInitialSync(coordinator, sessionScope)
        }
        // Newly contributing: a source the gateway did not know before is reported again.
        permissionHealth.resetReporting()
        permissionHealth.refresh()
    }
}

/** The interactive Categories section: one chip per category, the existing model and its defaults. */
@Composable
fun HealthCategoryChips(selected: Set<HealthCategory>, onToggle: (HealthCategory, Boolean) -> Unit) {
    SetupLedgerSection("Categories", Icons.Outlined.GridView, rowSpacing = 0.dp) {
        healthCategoryUi.forEach { entry ->
            SetupToggleChip(
                text = entry.title,
                selected = entry.category in selected,
                tint = HealthSetupCopy.tint,
                onToggle = { enabled -> onToggle(entry.category, enabled) },
            )
        }
    }
}
