// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.XmlResourceParser
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.MainActivity
import dev.omnesis.android.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.xmlpull.v1.XmlPullParser

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssistantAppActionsResourcesTest {

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun `launcher manifest publishes shortcuts and a narrow Assistant entry point`() {
        val launcher = context.packageManager.getActivityInfo(
            ComponentName(context, MainActivity::class.java),
            PackageManager.GET_META_DATA,
        )
        assertEquals(R.xml.shortcuts, launcher.metaData.getInt("android.app.shortcuts"))

        val assistant = context.packageManager.getActivityInfo(
            ComponentName(context.packageName, ASSISTANT_ACTIVITY),
            0,
        )
        assertTrue(assistant.exported)
    }

    @Test
    fun `every Assistant capability has explicit fulfillment and fallback`() {
        val capabilities = parseShortcuts().capabilities.associateBy { it.name }
        assertEquals(EXPECTED_CAPABILITIES, capabilities.keys)

        capabilities.values.forEach { capability ->
            assertEquals("$capability must have a parameter fulfillment and fallback", 2, capability.intents.size)
            capability.intents.forEach { fulfillment -> assertEquals(context.packageName, fulfillment.targetPackage) }
            assertEquals(1, capability.intents.first().parameters.size)
            assertTrue(capability.intents.first().parameters.single().required)
            assertTrue(capability.intents.last().parameters.isEmpty())
        }
    }

    @Test
    fun `built in intents map to their documented parameters`() {
        val capabilities = parseShortcuts().capabilities.associateBy { it.name }

        capabilities.getValue("actions.intent.OPEN_APP_FEATURE").assertPrimary(
            action = ACTION_OPEN_FEATURE,
            parameterName = "feature",
            key = "assistant_feature",
            shortcutMatchRequired = true,
            fallbackAction = Intent.ACTION_MAIN,
            fallbackTargetClass = MainActivity::class.java.name,
        )
        capabilities.getValue("actions.intent.GET_THING").assertPrimary(
            action = ACTION_SEARCH,
            parameterName = "thing.name",
            key = "query",
            targetClass = MainActivity::class.java.name,
        )
        capabilities.getValue("actions.intent.CREATE_THING").assertPrimary(
            action = ACTION_CAPTURE,
            parameterName = "thing.name",
            key = "note",
        )

        val featureFallback = capabilities.getValue("actions.intent.OPEN_APP_FEATURE").intents.last()
        assertEquals(Intent.ACTION_MAIN, featureFallback.action)
        assertEquals(MainActivity::class.java.name, featureFallback.targetClass)
    }

    @Test
    fun `custom intents use text parameters and nonempty query patterns`() {
        val capabilities = parseShortcuts().capabilities.associateBy { it.name }

        val ask = capabilities.getValue("custom.actions.intent.ASK_OMNESIS")
        ask.assertPrimary(ACTION_ASK, "question", "question", mimeType = SCHEMA_TEXT)
        assertQueryPatterns(ask, "${'$'}question")

        val capture = capabilities.getValue("custom.actions.intent.CAPTURE_NOTE")
        capture.assertPrimary(ACTION_CAPTURE, "note", "note", mimeType = SCHEMA_TEXT)
        assertQueryPatterns(capture, "${'$'}note")

        val askPrefixes = context.resources.getStringArray(ask.queryPatterns)
            .map { it.substringBefore("${'$'}question").trim() }
        val capturePrefixes = context.resources.getStringArray(capture.queryPatterns)
            .map { it.substringBefore("${'$'}note").trim() }
        assertTrue(askPrefixes.all(String::isNotEmpty))
        assertTrue(askPrefixes.toSet().intersect(capturePrefixes.toSet()).isEmpty())
    }

    @Test
    fun `feature inventory preserves capture launcher shortcut and binds both features`() {
        val shortcuts = parseShortcuts().shortcuts.associateBy { it.id }
        assertTrue(shortcuts.keys.containsAll(setOf("tell_brain", "ask_omnesis")))

        val capture = shortcuts.getValue("tell_brain")
        assertEquals("dev.omnesis.android.action.TELL_BRAIN", capture.action)
        assertEquals(MainActivity::class.java.name, capture.targetClass)
        assertEquals("Tell Omnesis", capture.featureValue)

        val ask = shortcuts.getValue("ask_omnesis")
        assertEquals(ACTION_ASK, ask.action)
        assertEquals(ASSISTANT_ACTIVITY, ask.targetClass)
        assertEquals("Ask Omnesis", ask.featureValue)
    }

    private fun Capability.assertPrimary(
        action: String,
        parameterName: String,
        key: String,
        mimeType: String? = null,
        shortcutMatchRequired: Boolean = false,
        targetClass: String = ASSISTANT_ACTIVITY,
        fallbackAction: String = action,
        fallbackTargetClass: String = targetClass,
    ) {
        val primary = intents.first()
        assertEquals(action, primary.action)
        assertEquals(targetClass, primary.targetClass)
        assertEquals(fallbackAction, intents.last().action)
        assertEquals(fallbackTargetClass, intents.last().targetClass)
        val parameter = primary.parameters.single()
        assertEquals(parameterName, parameter.name)
        assertEquals(key, parameter.key)
        assertEquals(mimeType, parameter.mimeType)
        assertEquals(shortcutMatchRequired, parameter.shortcutMatchRequired)
    }

    private fun assertQueryPatterns(capability: Capability, placeholder: String) {
        assertNotEquals(0, capability.queryPatterns)
        val patterns = context.resources.getStringArray(capability.queryPatterns)
        assertTrue(patterns.isNotEmpty())
        assertTrue(patterns.all { it.contains(placeholder) })
    }

    private fun parseShortcuts(): ParsedShortcuts {
        val parser = context.resources.getXml(R.xml.shortcuts)
        val capabilities = mutableListOf<Capability>()
        val shortcuts = mutableListOf<Shortcut>()
        var capability: MutableCapability? = null
        var shortcut: MutableShortcut? = null

        while (parser.eventType != XmlPullParser.END_DOCUMENT) {
            when (parser.eventType) {
                XmlPullParser.START_TAG -> when (parser.name) {
                    "capability" -> capability = MutableCapability(
                        name = parser.androidString("name"),
                        queryPatterns = parser.getAttributeResourceValue(APP_NS, "queryPatterns", 0),
                    )
                    "intent" -> if (capability != null) {
                        capability.intents += MutableFulfillment(
                            action = parser.androidString("action"),
                            targetPackage = parser.androidResolvedString("targetPackage"),
                            targetClass = parser.androidString("targetClass"),
                        )
                    } else if (shortcut != null) {
                        shortcut.action = parser.androidString("action")
                        shortcut.targetClass = parser.androidString("targetClass")
                    }
                    "parameter" -> capability?.intents?.lastOrNull()?.parameters?.add(
                        Parameter(
                            name = parser.androidString("name"),
                            key = parser.androidString("key"),
                            mimeType = parser.androidStringOrNull("mimeType"),
                            required = parser.getAttributeBooleanValue(ANDROID_NS, "required", false),
                            shortcutMatchRequired =
                                parser.getAttributeBooleanValue(APP_NS, "shortcutMatchRequired", false),
                        ),
                    )
                    "shortcut" -> shortcut = MutableShortcut(parser.androidString("shortcutId"))
                    "capability-binding" -> if (
                        shortcut != null &&
                        parser.androidString("key") == "actions.intent.OPEN_APP_FEATURE"
                    ) {
                        shortcut.hasFeatureBinding = true
                    }
                    "parameter-binding" -> if (shortcut?.hasFeatureBinding == true) {
                        shortcut.featureValue = parser.androidString("value")
                    }
                }
                XmlPullParser.END_TAG -> when (parser.name) {
                    "capability" -> capability?.let {
                        capabilities += Capability(
                            it.name,
                            it.queryPatterns,
                            it.intents.map { intent ->
                                Fulfillment(
                                    intent.action,
                                    intent.targetPackage,
                                    intent.targetClass,
                                    intent.parameters.toList(),
                                )
                            },
                        )
                        capability = null
                    }
                    "shortcut" -> shortcut?.let {
                        shortcuts += Shortcut(it.id, it.action, it.targetClass, it.featureValue)
                        shortcut = null
                    }
                }
            }
            parser.next()
        }
        parser.close()
        return ParsedShortcuts(capabilities, shortcuts)
    }

    private fun XmlPullParser.androidString(name: String): String =
        getAttributeValue(ANDROID_NS, name) ?: error("Missing android:$name on <$this>")

    private fun XmlResourceParser.androidResolvedString(name: String): String {
        val id = getAttributeResourceValue(ANDROID_NS, name, 0)
        return if (id == 0) androidString(name) else context.resources.getString(id)
    }

    private fun XmlPullParser.androidStringOrNull(name: String): String? =
        getAttributeValue(ANDROID_NS, name)

    private data class ParsedShortcuts(
        val capabilities: List<Capability>,
        val shortcuts: List<Shortcut>,
    )

    private data class MutableCapability(
        val name: String,
        val queryPatterns: Int,
        val intents: MutableList<MutableFulfillment> = mutableListOf(),
    )

    private data class Capability(
        val name: String,
        val queryPatterns: Int,
        val intents: List<Fulfillment>,
    )

    private data class MutableFulfillment(
        val action: String,
        val targetPackage: String,
        val targetClass: String,
        val parameters: MutableList<Parameter> = mutableListOf(),
    )

    private data class Fulfillment(
        val action: String,
        val targetPackage: String,
        val targetClass: String,
        val parameters: List<Parameter>,
    )

    private data class Parameter(
        val name: String,
        val key: String,
        val mimeType: String?,
        val required: Boolean,
        val shortcutMatchRequired: Boolean,
    )

    private data class MutableShortcut(
        val id: String,
        var action: String = "",
        var targetClass: String = "",
        var hasFeatureBinding: Boolean = false,
        var featureValue: String? = null,
    )

    private data class Shortcut(
        val id: String,
        val action: String,
        val targetClass: String,
        val featureValue: String?,
    )

    private companion object {
        const val ANDROID_NS = "http://schemas.android.com/apk/res/android"
        const val APP_NS = "http://schemas.android.com/apk/res-auto"
        const val ASSISTANT_ACTIVITY = "dev.omnesis.android.assistant.AssistantActionActivity"
        const val ACTION_OPEN_FEATURE = "dev.omnesis.android.action.OPEN_ASSISTANT_FEATURE"
        const val ACTION_SEARCH = MainActivity.ACTION_SEARCH
        const val ACTION_ASK = "dev.omnesis.android.action.ASK_OMNESIS"
        const val ACTION_CAPTURE = "dev.omnesis.android.action.CAPTURE_NOTE"
        const val SCHEMA_TEXT = "https://schema.org/Text"
        val EXPECTED_CAPABILITIES = setOf(
            "actions.intent.OPEN_APP_FEATURE",
            "actions.intent.GET_THING",
            "actions.intent.CREATE_THING",
            "custom.actions.intent.ASK_OMNESIS",
            "custom.actions.intent.CAPTURE_NOTE",
        )
    }
}
