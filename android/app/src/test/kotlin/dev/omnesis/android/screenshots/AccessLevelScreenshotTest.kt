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
        // Actual provider-declared contracts; all account/content values invented from scratch.
        internal val contract = SourceScopes(listOf(
            SourceScopeItem("conversation", "fixed", noun = SourceScopeNoun("conversation", "conversations"), picker = "search"),
            SourceScopeItem("participant", "changes", identifiers = listOf("phone")),
        ), revision = 2)
        internal val readiness = contract.items.map { ScopeKindReadiness(it.kind, true) }
        private val mailContract = SourceScopes(listOf(SourceScopeItem("participant", "fixed", identifiers = listOf("email", "domain")), SourceScopeItem("label", "changes", noun = SourceScopeNoun("label", "labels"), picker = "search")), revision = 2)
        internal val gmailSource = AccessSourceInstance("gmail:reader@example.org", "Gmail · reader@example.org", sourceType = "gmail", scopes = mailContract, scopeReadiness = mailContract.items.map { ScopeKindReadiness(it.kind, true) })
        private val folderContract = SourceScopes(listOf(SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("folder", "folders"), picker = "tree")), revision = 3)
        internal val driveSource = AccessSourceInstance("google-drive:reader@example.org", "Google Drive · reader@example.org", sourceType = "google-drive", scopes = folderContract, scopeReadiness = listOf(ScopeKindReadiness("folder", true)))
        /** The WhatsApp account, whose filter the filter renders edit. */
        internal val source = AccessSourceInstance("whatsapp-messages:+15550100123", "WhatsApp · +1 (555) 010-0123", sourceType = "whatsapp-messages", scopes = contract, scopeReadiness = readiness)

        private fun person(name: String, phone: String) = ScopeRef("participant", label = name, identifiers = listOf(ScopeIdentifier("phone", phone)))
        internal val workshop = ScopeRef("conversation", "conversation-workshop")
        internal val maya = person("Maya Reeves", "+15550100142")
        internal val jamie = person("Jamie Lopez", "+15550100167")
        internal val projects = ScopeOption(ScopeRef("folder", "projects"), "Projects", 18, hasChildren = true)
        /** What the WhatsApp filter hides: one conversation and one person. */
        internal val refs = listOf(workshop, maya)
        private val conversations = listOf(ScopeOption(workshop, "Workshop planning", 24), ScopeOption(ScopeRef("conversation", "conversation-hike"), "Weekend hike", 12), ScopeOption(ScopeRef("conversation", "conversation-books"), "Book club", 7))
        private val people = listOf(ScopeOption(maya, "Maya Reeves", 17), ScopeOption(jamie, "Jamie Lopez", 9), ScopeOption(person("David Lin", "+15550100188"), "David Lin", 6), ScopeOption(person("Sarah Mendez", "+15550100191"), "Sarah Mendez", 3))
        private val rootFolders = listOf(projects, ScopeOption(ScopeRef("folder", "archive"), "Archive", 9))
        private val projectFolders = listOf(ScopeOption(ScopeRef("folder", "plans"), "Plans", 11), ScopeOption(ScopeRef("folder", "budgets"), "Budgets", 5), ScopeOption(ScopeRef("folder", "reference"), "Reference", 2))
        private val mailLabels = listOf(ScopeOption(ScopeRef("label", "Label_41"), "Project", 12))
        private val mailPeople = listOf(ScopeOption(ScopeRef("participant", label = "reader@example.org", identifiers = listOf(ScopeIdentifier("email", "reader@example.org"))), "reader@example.org", 17))

        internal const val LEVEL_ID = "scope-level"
        /** WhatsApp shares everything except the workshop conversation and one person. */
        internal val policy = ScopePolicy(source.id, ScopeAudience(LEVEL_ID, "answer"), listOf(ScopeRule(refs, "hide")), "share")
        /** Google Drive shares only one folder. */
        internal val drivePolicy = ScopePolicy(driveSource.id, ScopeAudience(LEVEL_ID, "answer"), listOf(ScopeRule(listOf(projects.ref), "share")), "hide")
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

        /** A gateway over the fixture accounts. [counted] false answers as a source whose counts are still being prepared. */
        internal fun gatewayFor(counted: Boolean = true) = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview {
                assertProviderWirePolicy(policy)
                val account = overview.sources.first { it.id == policy.sourceId }
                val matched = policy.rules.flatMap { it.match }
                val listed = (conversations + people + rootFolders + projectFolders + mailLabels + mailPeople).associateBy { it.ref }
                val sum = matched.sumOf { listed.getValue(it).count }
                val total = 120L
                val hidden = if (policy.rules.single().action == "share") total - sum else hiddenByWhatsAppSelection[matched.toSet()] ?: sum
                val samples = if (account.id == source.id) listOf(ScopePreviewSample("visible", "Weekend hike", true, false), ScopePreviewSample("hidden", "Workshop planning", false, false), ScopePreviewSample("unknown", "Unnamed group", false, true)) else emptyList()
                return ScopePreview(account.id, total, total - hidden, hidden, if (account.id == source.id) 4 else 0, matched.map { ScopePreviewItem(it, listed.getValue(it).label, listed.getValue(it).count) }, samples,
                    account.scopeReadiness!!.map { if (counted) it else it.copy(ready = false, reason = "backfill") })
            }
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions {
                val account = overview.sources.first { it.id == sourceId }
                val declaration = checkNotNull(account.scopes?.items?.firstOrNull { it.kind == kind })
                val options = when (kind) {
                    "folder" -> if (parentId == projects.ref.id) projectFolders else rootFolders
                    "label" -> mailLabels
                    "conversation" -> conversations
                    "participant" -> if ("phone" in declaration.identifiers.orEmpty()) people else mailPeople
                    else -> error("The fixture has no options for this declared kind")
                }.filter { query.isBlank() || it.label.contains(query, ignoreCase = true) }
                return assertProviderWireOptions(ScopeOptions(account.id, account.sourceType!!, account.scopes!!, account.scopeReadiness!!.map { if (counted) it else it.copy(ready = false, reason = "backfill") }, options), account, kind)
            }
        }
        internal val gateway = gatewayFor()
        /** A gateway that no longer knows the account asked about, as for an account that was disconnected. */
        internal val disconnectedGateway = object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview = throw dev.omnesis.android.transport.GatewayException.NotFound("source-not-found")
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions = throw dev.omnesis.android.transport.GatewayException.NotFound("source-not-found")
        }
    }
}
