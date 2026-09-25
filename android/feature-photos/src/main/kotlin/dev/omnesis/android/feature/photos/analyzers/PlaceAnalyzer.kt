// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.analyzers

import android.content.ContentResolver
import android.location.Address
import android.location.Geocoder
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.exifinterface.media.ExifInterface
import dev.omnesis.android.feature.photos.PhotoAnalysisFragment
import dev.omnesis.android.feature.photos.PhotoAnalysisInput
import dev.omnesis.android.feature.photos.PhotoAnalyzer
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive

private const val TAG = "Omnesis:photos"

/**
 * Reverse-geocodes a geotagged photo's EXIF coordinates into a human place
 * name — needs only the asset's GPS tags, no pixels. Runs for every
 * geotagged photo, backfill and new alike, matching iOS's `PlaceAnalyzer`
 * (which reads `PHAsset.location` directly; Android has no equivalent
 * MediaStore column since API 29 zeroed `LATITUDE`/`LONGITUDE`, so this
 * reads the EXIF GPS tags from the file itself instead).
 *
 * Uses the platform's `Geocoder` (a disclosed exception to on-device-only
 * for this one signal, matching iOS's `CLGeocoder` — never pixels, only the
 * coordinate already read from the photo's own metadata via the granted
 * Photos permission). Requires `ACCESS_MEDIA_LOCATION` to read un-redacted
 * GPS tags at all (see [MediaStore.setRequireOriginal]) — its absence just
 * makes this analyzer report unavailable, not the whole source.
 */
class PlaceAnalyzer(
    private val resolver: ContentResolver,
    private val geocoder: Geocoder,
    private val hasMediaLocationPermission: () -> Boolean,
) : PhotoAnalyzer {
    override val identifier = "place"

    override suspend fun isAvailable(): Boolean = Geocoder.isPresent() && hasMediaLocationPermission()

    override suspend fun analyze(input: PhotoAnalysisInput): PhotoAnalysisFragment? {
        if (!isAvailable()) return null
        val (lat, lon) = readLatLong(input.asset.uri) ?: return null
        val address = reverseGeocode(lat, lon)?.firstOrNull() ?: return null
        val name = placeName(address) ?: return null
        val extra = buildMap {
            put("latitude", JsonPrimitive(lat))
            put("longitude", JsonPrimitive(lon))
            address.countryName?.let { put("country", JsonPrimitive(it)) }
        }
        return PhotoAnalysisFragment(placeName = name, extra = extra)
    }

    /** Prefer the most specific human-legible name available: locality first, then admin area, then country. */
    private fun placeName(address: Address): String? =
        address.locality ?: address.adminArea ?: address.countryName

    private suspend fun readLatLong(uriString: String): Pair<Double, Double>? = withContext(Dispatchers.IO) {
        runCatching {
            val uri = Uri.parse(uriString)
            val original = if (Build.VERSION.SDK_INT >= 29) MediaStore.setRequireOriginal(uri) else uri
            resolver.openInputStream(original)?.use { stream ->
                val exif = ExifInterface(stream)
                val latLong = exif.latLong ?: return@use null
                latLong[0] to latLong[1]
            }
        }.onFailure { Log.w(TAG, "Failed to read EXIF GPS tags: $it") }.getOrNull()
    }

    private suspend fun reverseGeocode(lat: Double, lon: Double): List<Address>? =
        if (Build.VERSION.SDK_INT >= 33) reverseGeocodeAsync(lat, lon) else reverseGeocodeSync(lat, lon)

    private suspend fun reverseGeocodeAsync(lat: Double, lon: Double): List<Address>? =
        suspendCancellableCoroutine { continuation ->
            geocoder.getFromLocation(lat, lon, 1, object : Geocoder.GeocodeListener {
                override fun onGeocode(addresses: MutableList<Address>) {
                    if (continuation.isActive) continuation.resume(addresses)
                }

                override fun onError(errorMessage: String?) {
                    Log.w(TAG, "Reverse geocode failed: $errorMessage")
                    if (continuation.isActive) continuation.resume(null)
                }
            })
        }

    private suspend fun reverseGeocodeSync(lat: Double, lon: Double): List<Address>? = withContext(Dispatchers.IO) {
        @Suppress("DEPRECATION")
        runCatching { geocoder.getFromLocation(lat, lon, 1) }
            .onFailure { Log.w(TAG, "Reverse geocode failed: $it") }
            .getOrNull()
    }
}
