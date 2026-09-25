// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.location.Geocoder
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.feature.photos.analyzers.BarcodeAnalyzer
import dev.omnesis.android.feature.photos.analyzers.OcrAnalyzer
import dev.omnesis.android.feature.photos.analyzers.PlaceAnalyzer
import dev.omnesis.android.feature.photos.analyzers.SceneLabelAnalyzer
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.HostedSourceContract
import dev.omnesis.android.transport.SourceMultiDeviceMode
import dev.omnesis.android.transport.MobileSourceActivation
import dev.omnesis.android.transport.PermissionCapability
import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionHealthReporter
import dev.omnesis.android.transport.PermissionHealthSnapshot
import dev.omnesis.android.transport.PermissionRepairAction
import dev.omnesis.android.transport.PermissionRequirement
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.client.DocumentsClient
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Everything the app's composition root needs from the Photos feature,
 * behind generic seams: build a per-session [PhotosSyncCoordinator], kick
 * the post-pairing first sync, route inbound gateway
 * commands, and (de)schedule BOTH the periodic worker AND the media-observer
 * job. Keeps source-specific knowledge — the `photos:` id prefix, the
 * `source.sync` command contract, which analyzers run at which tier — out
 * of the app module.
 */
@Singleton
class PhotosIntegration @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: PhotosSettings,
) : PermissionHealthReporter, HostedSourceOptIn {
    override val sourceId: String = PhotosSyncCoordinator.SOURCE_ID
    // MediaStore IDs and permission-limited libraries belong to this device.
    // The gateway owns stream identity; cloud copies may appear on both phones,
    // but neither phone can reconcile another phone's library away.
    override val hostedSourceContract = HostedSourceContract(
        sourceType = PhotosSource.SOURCE_TYPE,
        multiDeviceMode = SourceMultiDeviceMode.PARTITIONED,
    )
    override val enabled: Boolean get() = settings.photosEnabled

    fun access(): PhotosAccess {
        val observed = currentPhotosAccess(context)
        settings.observeAccess(observed)
        return observed
    }

    /**
     * The local half of an explicit enable, once the gateway accepted this
     * phone: this device's membership is restored first, then the switch and
     * both background mechanisms go on. Throws when the gateway could not
     * restore the contribution, leaving the phone opted out.
     */
    suspend fun optIn(membership: SourceMembership) {
        membership.clearRefusal(sourceId)
        val resumed = membership.resumeContributing(sourceId)
        check(resumed == null || resumed == SourceMembership.Outcome.Resumed || resumed == SourceMembership.Outcome.NoRow) {
            "The gateway could not restore this phone's contribution"
        }
        settings.photosEnabled = true
        scheduleBackgroundSync()
    }

    override fun forget() {
        // Settings first: a failure to cancel the background work must not leave the opt-in behind.
        settings.reset()
        cancelBackgroundSync()
    }

    fun hasPermission(): Boolean = access() != PhotosAccess.DENIED

    override suspend fun permissionHealth(nowMillis: Long): PermissionHealthSnapshot {
        val access = access()
        return photosPermissionSnapshot(
            nowMillis = nowMillis,
            access = access,
            mediaLocationSupported = Build.VERSION.SDK_INT >= 29,
            mediaLocationGranted = hasMediaLocationPermission(),
        )
    }

    private fun hasMediaLocationPermission(): Boolean =
        Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.ACCESS_MEDIA_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED

    /** Builds the coordinator bound to one gateway session's clients. */
    fun buildCoordinator(
        analytics: AnalyticsClient,
        documents: DocumentsClient,
        admin: AdminClient,
        sendEvent: (String, JsonObject) -> Unit,
        deviceId: String?,
    ): PhotosSyncCoordinator = PhotosSyncCoordinator(
        sourceFactory = { PhotosSource(context.contentResolver, ::analyzeAsset) },
        analytics = analytics,
        documents = documents,
        settings = settings,
        hasPermission = ::hasPermission,
        hasFullAccess = { access() == PhotosAccess.FULL },
        accessGeneration = { settings.accessGeneration },
        sendEvent = sendEvent,
        prepareSync = {
            checkNotNull(deviceId) { "Re-pair this phone before syncing Photos" }
            preparePhotosPartition(admin, deviceId)
        },
    )

    /** Explicitly adopt this host's legacy stream before any protected read or cursor lookup. */
    private suspend fun preparePhotosPartition(admin: AdminClient, deviceId: String) {
        val source = admin.sources().firstOrNull { it.id == sourceId }
        // Only the user's enable flow may add a nonmember. A background sync
        // must never undo an intentional detach by silently joining again.
        MobileSourceActivation.prepareHostedPartition(source, deviceId) { id, mode ->
            admin.patchSource(id, multiDeviceMode = mode)
        }
    }

    private val ocrAnalyzer by lazy { OcrAnalyzer() }
    private val placeAnalyzer by lazy {
        PlaceAnalyzer(context.contentResolver, Geocoder(context), ::hasMediaLocationPermission)
    }
    private val sceneLabelAnalyzer by lazy { SceneLabelAnalyzer() }
    private val barcodeAnalyzer by lazy { BarcodeAnalyzer() }

    /**
     * Loads the asset's pixels — every analyzer except [PlaceAnalyzer] (which
     * reads EXIF from the file directly) needs them, including OCR at the
     * backfill tier — and runs the tier-appropriate analyzer set, merging
     * their fragments. Backfill tier: OCR + place only (cheap). New tier
     * adds scene labels and barcode detection. Both tiers run in the background.
     */
    private suspend fun analyzeAsset(asset: PhotoAssetRef, tier: AnalysisTier): PhotoAnalysisFragment {
        val bitmap = loadBitmap(asset.uri)
        val input = PhotoAnalysisInput(asset, bitmap)

        // See #2553: GenAI image description rejects background inference.
        val analyzers = if (tier == AnalysisTier.NEW) {
            listOf(ocrAnalyzer, placeAnalyzer, sceneLabelAnalyzer, barcodeAnalyzer)
        } else {
            listOf(ocrAnalyzer, placeAnalyzer)
        }

        val fragments = analyzers.mapNotNull { analyzer ->
            if (!analyzer.isAvailable()) return@mapNotNull null
            runCatching { analyzer.analyze(input) }
                .onFailure { Log.w(TAG, "${analyzer.identifier} analyzer failed for asset ${asset.id}: $it") }
                .getOrNull()
        }
        bitmap?.recycle()
        return PhotoAnalysisFragment.merge(fragments)
    }

    private fun loadBitmap(uriString: String): Bitmap? = runCatching {
        val uri = Uri.parse(uriString)
        if (Build.VERSION.SDK_INT >= 28) {
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
                decoder.isMutableRequired = false
            }
        } else {
            context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
        }
    }.onFailure { Log.w(TAG, "Failed to load bitmap for $uriString: $it") }.getOrNull()

    /**
     * Fire-and-forget first drain after a session (re)build.
     * No-op unless the user enabled Photos syncing. Failures are logged and
     * die here — a hiccup must never take the session down.
     */
    fun launchInitialSync(coordinator: PhotosSyncCoordinator, scope: CoroutineScope) {
        if (!settings.photosEnabled) return
        scope.launch {
            logOutcome(coordinator.syncNow())
        }
    }

    /**
     * Routes a gateway WS command to the coordinator when it targets this
     * source (manual "Sync now" from another client lands here).
     */
    fun handleCommand(coordinator: PhotosSyncCoordinator, type: String, payload: JsonObject, scope: CoroutineScope): Boolean {
        if (type != "source.sync") return false
        val sourceId = payload["sourceId"]?.jsonPrimitive?.contentOrNull ?: return false
        if (!sourceId.startsWith("${PhotosSource.SOURCE_TYPE}:")) return false
        scope.launch { logOutcome(coordinator.syncNow()) }
        return true
    }

    fun scheduleBackgroundSync() {
        PhotosSyncScheduler.schedule(context)
        PhotosMediaObserverJobService.install(context)
    }

    fun cancelBackgroundSync() {
        PhotosSyncScheduler.cancel(context)
        PhotosMediaObserverJobService.uninstall(context)
    }

    /**
     * The gateway refused to have this phone host the source. Nothing is
     * contributed either way, so the persisted opt-in goes off and both
     * background mechanisms with it — with or without a settings screen open.
     */
    override fun withdraw() {
        settings.photosEnabled = false
        cancelBackgroundSync()
    }

    private fun logOutcome(result: PhotosSyncCoordinator.SyncResult) {
        when (result) {
            is PhotosSyncCoordinator.SyncResult.Success ->
                Log.i(TAG, "Photos sync complete: ${result.processed} items")
            is PhotosSyncCoordinator.SyncResult.Skipped ->
                Log.i(TAG, "Photos sync skipped: ${result.reason}")
            is PhotosSyncCoordinator.SyncResult.NeedsAttention ->
                Log.w(TAG, "Photos sync needs attention: ${result.message}")
            is PhotosSyncCoordinator.SyncResult.Failed ->
                Log.w(TAG, "Photos sync failed (retryable=${result.retryable}): ${result.message}")
            is PhotosSyncCoordinator.SyncResult.SourceRemoved -> {
                Log.w(TAG, "Photos removed in Omnesis — disabled locally")
                cancelBackgroundSync()
            }
            is PhotosSyncCoordinator.SyncResult.SourcePaused ->
                Log.i(TAG, "Photos paused in Omnesis: ${result.message}")
        }
    }

    private companion object {
        const val TAG = "Omnesis:photos"
    }
}

internal fun photosPermissionSnapshot(
    nowMillis: Long,
    access: PhotosAccess,
    mediaLocationSupported: Boolean,
    mediaLocationGranted: Boolean,
): PermissionHealthSnapshot {
    val capabilities = mutableListOf(
        PermissionCapability(
            id = "photo-library",
            label = "Photo library",
            state = when (access) {
                PhotosAccess.FULL -> PermissionCapabilityState.HEALTHY
                PhotosAccess.LIMITED, PhotosAccess.DENIED -> PermissionCapabilityState.PERMISSION_DEGRADED
            },
            requirement = PermissionRequirement.REQUIRED,
            impact = when (access) {
                PhotosAccess.FULL -> null
                PhotosAccess.LIMITED -> "Only selected photos can be indexed."
                PhotosAccess.DENIED -> "Photos cannot be indexed."
            },
            remediation = if (access == PhotosAccess.FULL) null else "Choose full photo access in Android Settings.",
            repairAction = if (access == PhotosAccess.FULL) {
                PermissionRepairAction.NONE
            } else {
                PermissionRepairAction.OPEN_SOURCE_SETTINGS
            },
        ),
    )
    if (mediaLocationSupported && access != PhotosAccess.DENIED) {
        capabilities += PermissionCapability(
            id = "photo-location",
            label = "Photo locations",
            state = if (mediaLocationGranted) {
                PermissionCapabilityState.HEALTHY
            } else {
                PermissionCapabilityState.PERMISSION_DEGRADED
            },
            requirement = PermissionRequirement.OPTIONAL,
            impact = if (mediaLocationGranted) null else "Place names cannot be extracted from photos.",
            remediation = if (mediaLocationGranted) null else "Allow photo location access in Android Settings.",
            repairAction = if (mediaLocationGranted) {
                PermissionRepairAction.NONE
            } else {
                PermissionRepairAction.OPEN_SOURCE_SETTINGS
            },
        )
    }
    return PermissionHealthSnapshot(checkedAt = nowMillis, capabilities = capabilities)
}

/** The required runtime permission to gate the whole source on — `READ_MEDIA_IMAGES` (API 33+) or `READ_EXTERNAL_STORAGE`. */
fun requiredPhotosPermission(): String =
    if (Build.VERSION.SDK_INT >= 33) android.Manifest.permission.READ_MEDIA_IMAGES else android.Manifest.permission.READ_EXTERNAL_STORAGE

enum class PhotosAccess { FULL, LIMITED, DENIED }

/** The photo-library grant as Android reports it now. */
fun currentPhotosAccess(context: Context): PhotosAccess = photosAccess(
    apiLevel = Build.VERSION.SDK_INT,
    fullGranted = ContextCompat.checkSelfPermission(context, requiredPhotosPermission()) == PackageManager.PERMISSION_GRANTED,
    selectedGranted = Build.VERSION.SDK_INT >= 34 && ContextCompat.checkSelfPermission(
        context,
        android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
    ) == PackageManager.PERMISSION_GRANTED,
)

fun photosAccess(apiLevel: Int, fullGranted: Boolean, selectedGranted: Boolean): PhotosAccess = when {
    fullGranted -> PhotosAccess.FULL
    apiLevel >= 34 && selectedGranted -> PhotosAccess.LIMITED
    else -> PhotosAccess.DENIED
}

fun photosRequestGrantsPrimaryAccess(apiLevel: Int, grants: Map<String, Boolean>): Boolean =
    grants[if (apiLevel >= 33) {
        android.Manifest.permission.READ_MEDIA_IMAGES
    } else {
        android.Manifest.permission.READ_EXTERNAL_STORAGE
    }] == true ||
        (apiLevel >= 34 && grants[android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED] == true)

fun photosPermissionsToRequest(apiLevel: Int = Build.VERSION.SDK_INT): Array<String> = when {
    apiLevel >= 34 -> arrayOf(
        android.Manifest.permission.READ_MEDIA_IMAGES,
        android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
        android.Manifest.permission.ACCESS_MEDIA_LOCATION,
    )
    apiLevel >= 33 -> arrayOf(
        android.Manifest.permission.READ_MEDIA_IMAGES,
        android.Manifest.permission.ACCESS_MEDIA_LOCATION,
    )
    apiLevel >= 29 -> arrayOf(
        android.Manifest.permission.READ_EXTERNAL_STORAGE,
        android.Manifest.permission.ACCESS_MEDIA_LOCATION,
    )
    else -> arrayOf(android.Manifest.permission.READ_EXTERNAL_STORAGE)
}
