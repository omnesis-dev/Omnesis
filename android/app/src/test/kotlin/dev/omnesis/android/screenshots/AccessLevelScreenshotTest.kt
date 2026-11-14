// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.screenshots

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import androidx.compose.material3.Surface
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.*
import dev.omnesis.android.ui.access.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The account filter where it cannot be edited and at a large text size, and the invented example data
 * every access render shares: two levels, three accounts and their filters.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AccessLevelScreenshotTest {
    @Test fun filterDisabledLight() = capture("scope_filter_disabled_light", false) { filter(false) }
    @Test fun filterDisabledDark() = capture("scope_filter_disabled_dark", true) { filter(false) }
    @Test fun filterAccessible() = capture("scope_filter_accessible", false, 1.6f) { filter(true) }
    @Test fun filterAccessibleDark() = capture("scope_filter_accessible_dark", true, 1.6f) { filter(true) }
    @Composable private fun filter(enabled: Boolean) {
        SourceFilterEditor(source, level.id, "answer", policy, enabled, gateway, onClose = {}, icon = icons(source.id)) {}
    }
    private fun capture(name: String, dark: Boolean, fontScale: Float = 1f, content: @Composable () -> Unit) {
        RuntimeEnvironment.setFontScale(fontScale)
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density.density, fontScale)) {
                OmnesisTheme(darkTheme = dark) { Surface(Modifier.fillMaxSize()) { content() } }
            }
        }
    }
    companion object {
        // Fields as the providers declare them; every account and content value is invented.
        const val CHATS = "extra.chatId"
        const val GMAIL_LABELS = "extra.labelIds"
        const val DRIVE_FOLDERS = "extra.folderId"
        private val chatField = readyField(CHATS, FilterRef.MEMBERSHIP, "chat", "chats")
        private val mailLabelField = readyField(GMAIL_LABELS, FilterRef.TREE, "label", "labels", picker = "tree", insideText = "Includes the labels inside.")
        private val folderField = readyField(DRIVE_FOLDERS, FilterRef.TREE, "folder", "folders", picker = "tree", insideText = "Includes the folders inside.")
        internal val gmailSource = AccessSourceInstance("gmail:reader@example.org", "Gmail · reader@example.org", sourceType = "gmail", filterable = true)
        internal val driveSource = AccessSourceInstance("google-drive:reader@example.org", "Google Drive · reader@example.org", sourceType = "google-drive", filterable = true)
        /** The WhatsApp account, whose filter the filter renders edit. */
        internal val source = AccessSourceInstance("whatsapp-messages:+15550100123", "WhatsApp · +1 (555) 010-0123", sourceType = "whatsapp-messages", filterable = true)
        private val fields = mapOf(
            source.id to listOf(chatField, peopleField("phone")),
            gmailSource.id to listOf(peopleField("email", "domain"), mailLabelField),
            driveSource.id to listOf(folderField),
        )

        private fun person(name: String, phone: String) = FilterRef.person(name, listOf(FilterIdentifier("phone", phone)))
        private fun option(ref: FilterRef, label: String, count: Long, short: String = label, children: Boolean = false, parent: String? = null) =
            FilterOption(ref, label, short, count, parentId = parent, hasChildren = children.takeIf { it })
        private fun chat(id: String) = FilterRef.item(FilterRef.MEMBERSHIP, CHATS, id)
        private fun folder(id: String) = FilterRef.item(FilterRef.TREE, DRIVE_FOLDERS, id)
        internal val workshop = chat("chat-workshop")
        internal val maya = person("Maya Reeves", "+15550100142")
        internal val jamie = person("Jamie Lopez", "+15550100187")
        internal val projects = option(folder("folder-projects"), "Projects", 18, children = true)
        /** What the WhatsApp filter hides: one chat and one person. */
        internal val refs = listOf(workshop, maya)
        private val chats = listOf(option(workshop, "Workshop planning", 24), option(chat("chat-hike"), "Weekend hike", 12), option(chat("chat-books"), "Book club", 7))
        private val people = listOf(option(maya, "Maya Reeves", 17), option(jamie, "Jamie Lopez", 9), option(person("David Lin", "+15550100188"), "David Lin", 6), option(person("Sarah Mendez", "+15550100191"), "Sarah Mendez", 3))
        private val rootFolders = listOf(projects, option(folder("folder-archive"), "Archive", 9))
        private val projectFolders = listOf(option(folder("folder-plans"), "Projects/Plans", 11, "Plans", parent = "folder-projects"),
            option(folder("folder-budgets"), "Projects/Budgets", 5, "Budgets", parent = "folder-projects"), option(folder("folder-reference"), "Projects/Reference", 2, "Reference", parent = "folder-projects"),
            option(folder("folder-drafts"), "Projects/Drafts", 0, "Drafts", parent = "folder-projects"))
        private val mailLabels = listOf(option(FilterRef.item(FilterRef.TREE, GMAIL_LABELS, "Label_41"), "Project", 12), option(FilterRef.item(FilterRef.TREE, GMAIL_LABELS, "Label_42"), "Receipts", 7))
        private val mailPeople = listOf(option(FilterRef.person("reader@example.org", listOf(FilterIdentifier("email", "reader@example.org"))), "reader@example.org", 17))

        internal const val LEVEL_ID = "scope-level"
        /** WhatsApp shares everything except the workshop chat and one person. */
        internal val policy = SourceFilter(source.id, FilterAudience(LEVEL_ID, "answer"), listOf(FilterRule(refs, "hide")), "share")
        /** Google Drive shares only one folder. */
        internal val drivePolicy = SourceFilter(driveSource.id, FilterAudience(LEVEL_ID, "answer"), listOf(FilterRule(listOf(projects.ref), "share")), "hide")
        private val policyFamily = AccessPolicyFamilySummary("policy-everyday", "Everyday privacy", "4")
        private val everyAccount = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(gmailSource.id, driveSource.id, source.id))
        /** "Research assistant" as saved, used by two connections and one integration. */
        internal val level = AccessLevelSummary(LEVEL_ID, "Research assistant", 4, listOf(
            AccessGrantRule.answer(everyAccount, AccessAnswerRelease.reviewed(policyFamily.id)).copy(filterRevision = 3, scopePolicies = listOf(drivePolicy, policy)),
            AccessGrantRule.direct(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf(gmailSource.id))),
        ), 2, listOf(AccessLevelDevice("device-example", "Kitchen speaker", "integration")))
        internal val notesLevel = AccessLevelSummary("notes-level", "Notes capture", 1, listOf(AccessGrantRule.notes()), 0)
        internal val overview = AccessOverview(
            principals = listOf("Aurora Planner", "Northstar Assistant").mapIndexed { index, name ->
                AccessPrincipalSummary("principal-$index", name, "interactive", listOf(AccessGrantSummary("grant-$index", "$name access", 1, level.rules, emptyList(), levelId = level.id)))
            },
            sources = listOf(gmailSource, driveSource, source), policyFamilies = listOf(policyFamily), defaultPolicyFamilyId = policyFamily.id,
            levels = listOf(level, notesLevel), sourceFilters = SourceFiltersAvailability(true),
        )

        /** The art a gateway serves for each fixture source type, so account rows render their real icons. */
        private val iconArt: Map<String, String> = OmnesisJson.decodeFromString(AccessLevelScreenshotTest::class.java.classLoader!!.getResource("access-render-icons.json")!!.readText())
        internal val icons: (String) -> SourceIconModel = { id -> SourceIconModel(imageData = iconArt[id.substringBefore(':')], fallbackInitial = id.take(1)) }
        /** The name a source catalog gives each fixture source. */
        internal val names: (String) -> String? = { id -> mapOf("gmail" to "Gmail", "google-drive" to "Google Drive", "whatsapp-messages" to "WhatsApp")[id.substringBefore(':')] }

        /** What each known selection of the WhatsApp filter hides, where selected items overlap. */
        private val hiddenByWhatsAppSelection = mapOf(setOf(workshop, maya) to 37L, setOf(maya, jamie) to 22L)
        /** The sentences the gateway writes for the records a filter on each account keeps hidden. */
        private val hiddenSentences = mapOf(
            source.id to (null to "4 records can’t be matched to a chat and stay hidden."),
            driveSource.id to ("6 older items could not be resynced and stay hidden from agents using this filter." to "2 records can’t be matched to a folder and stay hidden."),
        )
        /** Gmail's labels and people before the account was resynced, at the cost its source declares. */
        internal val gmailNeedsResync = mapOf(
            GMAIL_LABELS to FilterFieldState(FilterFieldState.NEEDS_RESYNC, cost = "This reads about 75,000 messages a day.",
                text = "Label filters need Gmail to be resynced. Search keeps working meanwhile. This reads about 75,000 messages a day."),
            FilterRef.PEOPLE_FIELD to FilterFieldState(FilterFieldState.NEEDS_RESYNC, cost = "This reads about 75,000 messages a day.",
                text = "People filters need Gmail to be resynced. Search keeps working meanwhile. This reads about 75,000 messages a day."),
        )
        /** The one sentence the gateway writes for the fields of an account that wait on the same resync. */
        private val resyncs = mapOf(
            gmailSource.id to FilterEditorResync(FilterFieldState.NEEDS_RESYNC, listOf(GMAIL_LABELS, FilterRef.PEOPLE_FIELD),
                "Label and people filters need Gmail to be resynced. Your emails stay searchable meanwhile. This reads about 75,000 messages a day."),
            driveSource.id to FilterEditorResync(FilterFieldState.RESYNCING, listOf(DRIVE_FOLDERS), "Resyncing Google Drive: 212 of about 900.", 212, 900),
        )
        /** Drive's folders while the account is read again. */
        internal val driveResyncing = FilterFieldState(FilterFieldState.RESYNCING, processed = 212, total = 900, text = "Resyncing Google Drive: 212 of about 900.")

        /**
         * A gateway over the fixture accounts. [counted] false answers as a gateway still counting; [states] puts fields of
         * an account, by its id and then the field's path, in another state than ready.
         */
        internal fun gatewayFor(counted: Boolean = true, states: Map<String, Map<String, FilterFieldState>> = emptyMap(), connected: Boolean = true) = object : FilterEditorGateway {
            override suspend fun editor(sourceId: String) = FilterEditor(sourceId, sourceId.substringBefore(':'), listOf(FilterDevice("dev_studio", "Studio Mac")),
                fields = fields.getValue(sourceId).map { field -> states[sourceId]?.get(field.field)?.let { field.copy(state = it) } ?: field },
                resync = resyncs[sourceId]?.takeIf { states[sourceId] != null }).let { if (connected) it else disconnectedEditor(it) }
            override suspend fun preview(policy: SourceFilter): FilterPreview {
                assertProviderWirePolicy(policy)
                if (!counted) return pendingPreview()
                val account = overview.sources.first { it.id == policy.sourceId }
                val matched = policy.rules.flatMap { it.match }
                val listed = (chats + people + rootFolders + projectFolders + mailLabels + mailPeople).associateBy { it.ref }
                val sum = matched.sumOf { listed.getValue(it).count!! }
                val total = 120L
                val hidden = if (policy.rules.single().action == "share") total - sum else hiddenByWhatsAppSelection[matched.toSet()] ?: sum
                val (tooOld, unmatched) = hiddenSentences[account.id] ?: (null to null)
                if (!connected) return readyPreview(account.id, 0, 0, matched.map { FilterPreviewItem(it, listed.getValue(it).label, 0) }).copy(connected = false)
                return readyPreview(account.id, total, total - hidden, matched.map { FilterPreviewItem(it, listed.getValue(it).label, listed.getValue(it).count!!) }, tooOld, unmatched)
            }
            override suspend fun options(sourceId: String, field: String, query: String, parentId: String?, device: String?, cursor: String?): FilterOptions {
                val options = when (field) {
                    DRIVE_FOLDERS -> if (parentId == projects.ref.id) projectFolders else rootFolders
                    GMAIL_LABELS -> mailLabels
                    CHATS -> chats
                    FilterRef.PEOPLE_FIELD -> if (sourceId == source.id) people else mailPeople
                    else -> error("The fixture has no options for this field")
                }.filter { query.isBlank() || it.label.contains(query, ignoreCase = true) }
                val declared = fields.getValue(sourceId).first { it.field == field }
                return assertProviderWireOptions(FilterOptions(sourceId, field, if (counted) options else options.map { it.copy(count = null) }, retryAfterMs = if (counted) null else 1_500), declared, sourceId)
            }
            override suspend fun identifier(type: String, value: String) = FilterIdentifierCheck(error = "Enter a valid phone number. Include the international country code.")
            override suspend fun resync(sourceId: String) = Unit
        }
        internal val gateway = gatewayFor()
        /** The gateway for an account that is no longer connected: it still names and captions the saved entries. */
        internal val disconnectedGateway = gatewayFor(connected = false)
    }
}
