// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.sources

import androidx.compose.ui.graphics.Color
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.components.parseHexColor
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.dto.SerializedDescriptor
import dev.omnesis.android.transport.dto.SourceMetaEntry
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Resolves a source's display metadata (label, unit noun, icon, colors) generically
 * from the gateway — the Android analogue of the iOS source registry. This is how the
 * client honors the repo's source-encapsulation rule: NO source-type branching, NO
 * hardcoded per-source icons/labels/nouns. Everything comes from
 * `/admin/source-descriptors` + `/portal/source-meta.json`.
 *
 * Source ids are `type:account`; metadata is keyed by both full id (per-instance) and
 * type, so resolution prefers the per-instance value then falls back to the type.
 */
@Singleton
class SourceCatalog @Inject constructor() {

    @Volatile
    private var descriptorsByType: Map<String, SerializedDescriptor> = emptyMap()

    @Volatile
    private var metaByKey: Map<String, SourceMetaEntry> = emptyMap()

    @Volatile
    private var loaded = false

    /** Whether both halves of the catalog have landed for the current session. */
    val isLoaded: Boolean get() = loaded

    /**
     * Fetch the catalog from the gateway.
     *
     * A fetch that fails leaves whatever the catalog already holds in place:
     * every screen that draws a source reads from here, so a transient refusal
     * — a session built before its token was ready, an older session's fetch
     * finishing after a newer one's — must not blank every icon for the rest
     * of the run. The result says whether anything landed; `isLoaded` says
     * whether everything did, which is what a later `ensureLoaded` retries.
     */
    suspend fun load(admin: AdminClient): Boolean = load(admin::descriptors, admin::sourceMeta)

    suspend fun load(
        descriptors: suspend () -> List<SerializedDescriptor>,
        meta: suspend () -> Map<String, SourceMetaEntry>,
    ): Boolean {
        // The two halves stand on their own: the metadata carries every icon by
        // itself, and it must not be held hostage by a descriptor fetch that
        // depends on which collectors happen to be online.
        val fetchedDescriptors = runCatching { descriptors() }.getOrNull()
        val fetchedMeta = runCatching { meta() }.getOrNull()
        fetchedDescriptors?.let { descriptorsByType = it.associateBy { d -> d.typeId } }
        fetchedMeta?.let { metaByKey = it }
        // Once both halves have landed this session the catalog is whole; a
        // later refusal changes nothing it already holds.
        if (fetchedDescriptors != null && fetchedMeta != null) loaded = true
        return fetchedDescriptors != null || fetchedMeta != null
    }

    /**
     * The catalog a screen needs before it draws sources: the one already
     * loaded, or one fetched now. Retries a failed load rather than trusting
     * an empty map, since an empty map draws every source as its initial.
     */
    suspend fun ensureLoaded(admin: AdminClient): Boolean = ensureLoaded(admin::descriptors, admin::sourceMeta)

    suspend fun ensureLoaded(
        descriptors: suspend () -> List<SerializedDescriptor>,
        meta: suspend () -> Map<String, SourceMetaEntry>,
    ): Boolean = loaded || load(descriptors, meta)

    fun clear() {
        descriptorsByType = emptyMap()
        metaByKey = emptyMap()
        loaded = false
    }

    fun typeOf(sourceId: String): String = sourceId.substringBefore(':')

    fun label(sourceId: String): String {
        val type = typeOf(sourceId)
        return metaByKey[sourceId]?.label?.nonBlank()
            ?: metaByKey[type]?.label?.nonBlank()
            ?: descriptorsByType[type]?.name?.nonBlank()
            ?: type
    }

    /**
     * The source-FAMILY human name ("Gmail", "Google Drive"), resolved from the source TYPE —
     * never an account-specific instance label like "Gmail (work)". Mirrors the iOS
     * `humanName(for: sourceTypeFromId(...))` used in doc-row meta strips.
     */
    fun familyLabel(sourceId: String): String {
        val type = typeOf(sourceId)
        return metaByKey[type]?.label?.nonBlank()
            ?: descriptorsByType[type]?.name?.nonBlank()
            ?: type
    }

    /** Provider-declared plural noun ("emails", "messages", "activities"). */
    fun unitName(sourceId: String): String? = descriptorsByType[typeOf(sourceId)]?.unitName?.nonBlank()

    /** "12 emails" / "1 email" / "12 items" — generic, never source-branched. */
    fun unitLabel(sourceId: String, count: Int): String {
        val plural = unitName(sourceId) ?: "items"
        val noun = if (count == 1) plural.removeSuffix("s").ifEmpty { plural } else plural
        return "$count $noun"
    }

    fun accentColor(sourceId: String): Color? {
        val type = typeOf(sourceId)
        return parseHexColor(
            metaByKey[sourceId]?.accentColor
                ?: metaByKey[type]?.accentColor
                ?: descriptorsByType[type]?.icon?.color,
        )
    }

    fun bgColor(sourceId: String): Color? {
        val type = typeOf(sourceId)
        return parseHexColor(
            metaByKey[sourceId]?.bgColor
                ?: metaByKey[type]?.bgColor
                ?: descriptorsByType[type]?.icon?.bgColor,
        )
    }

    fun iconModel(sourceId: String): SourceIconModel {
        val type = typeOf(sourceId)
        val image = metaByKey[sourceId]?.icon?.nonBlank()
            ?: metaByKey[type]?.icon?.nonBlank()
            ?: descriptorsByType[type]?.icon?.imageDataUri?.nonBlank()
            ?: descriptorsByType[type]?.icon?.url?.nonBlank()
        return SourceIconModel(
            imageData = image,
            fallbackInitial = label(sourceId).take(1),
            accentColor = accentColor(sourceId),
            bgColor = bgColor(sourceId),
        )
    }

    private fun String.nonBlank(): String? = takeIf { it.isNotBlank() }
}
