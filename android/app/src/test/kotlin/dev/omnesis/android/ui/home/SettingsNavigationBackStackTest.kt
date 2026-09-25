// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsNavigationBackStackTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var nav: NavHostController

    @Composable
    private fun TestGraph() {
        nav = rememberNavController()
        NavHost(navController = nav, startDestination = "agent") {
            composable("agent") { Text("Agent") }
            composable(SETTINGS_ROUTE) { Text("Settings") }
            composable(MODELS_ROUTE) { Text("Models") }
            composable("models/backends") { Text("Backends") }
            composable("models/backends/provider") { Text("Backend provider") }
            composable(DEVICES_ROUTE) { Text("Devices") }
            composable(POLICIES_ROUTE) { Text("Policies") }
            composable(POLICY_ROUTE_PATTERN) { Text("Policy") }
            composable("privacy") { Text("Privacy") }
        }
    }

    private fun startGraph() {
        compose.setContent { TestGraph() }
        compose.waitForIdle()
    }

    private fun assertRoute(expected: String) {
        compose.runOnIdle { assertEquals(expected, nav.currentDestination?.route) }
    }

    @Test
    fun eachSettingsChildHasSettingsThenThePreviousSurfaceBeneathIt() {
        startGraph()

        compose.runOnIdle {
            nav.navigate(SETTINGS_ROUTE)
            nav.navigateToSettingsChild(MODELS_ROUTE)
        }
        assertRoute(MODELS_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute(SETTINGS_ROUTE)
        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")

        compose.runOnIdle {
            nav.navigate(SETTINGS_ROUTE)
            nav.navigateToSettingsChild(DEVICES_ROUTE)
        }
        assertRoute(DEVICES_ROUTE)
        compose.runOnIdle { nav.popBackStack() }
        assertRoute(SETTINGS_ROUTE)
        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    @Test
    fun policiesIsASettingsChildWithSettingsBeneathIt() {
        startGraph()

        compose.runOnIdle {
            nav.navigate(SETTINGS_ROUTE)
            nav.navigateToSettingsChild(POLICIES_ROUTE)
        }
        assertRoute(POLICIES_ROUTE)

        // Its own leading action returns to Settings rather than growing a second parent.
        compose.runOnIdle { nav.returnToSettings() }
        assertRoute(SETTINGS_ROUTE)
        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    @Test
    fun aPolicyOpenedFromTheListSitsAboveItAndItsSettingsParent() {
        startGraph()

        compose.runOnIdle {
            nav.navigate(SETTINGS_ROUTE)
            nav.navigateToSettingsChild(POLICIES_ROUTE)
            nav.navigate(policyRoute("family-example", "Everyday policy"))
        }
        assertRoute(POLICY_ROUTE_PATTERN)
        compose.runOnIdle {
            assertEquals("family-example", nav.currentBackStackEntry?.arguments?.getString("familyId"))
            assertEquals("Everyday policy", nav.currentBackStackEntry?.arguments?.getString("name"))
        }

        compose.runOnIdle { nav.popBackStack() }
        assertRoute(POLICIES_ROUTE)
        compose.runOnIdle { nav.returnToSettings() }
        assertRoute(SETTINGS_ROUTE)
        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    /** Ids and names with route-significant characters and non-ASCII text arrive intact. */
    @Test
    fun policyRouteArgumentsRoundTripThroughEncoding() {
        startGraph()
        val familyId = "family/with slash?and=query#and&amp"
        val name = "R&D / 100% sûr? #1 — 家族の方針"

        compose.runOnIdle { nav.navigate(policyRoute(familyId, name)) }
        assertRoute(POLICY_ROUTE_PATTERN)
        compose.runOnIdle {
            assertEquals(familyId, nav.currentBackStackEntry?.arguments?.getString("familyId"))
            assertEquals(name, nav.currentBackStackEntry?.arguments?.getString("name"))
        }

        compose.runOnIdle { nav.navigate(policyRoute("family-plain")) }
        compose.runOnIdle {
            assertEquals("family-plain", nav.currentBackStackEntry?.arguments?.getString("familyId"))
            assertEquals(null, nav.currentBackStackEntry?.arguments?.getString("name"))
        }
    }

    /** A policy reached from an exchange is Settings lineage, so "Open settings" from it installs one parent. */
    @Test
    fun returningToSettingsFromAnOrphanPolicyReplacesTheWholeLineage() {
        startGraph()

        compose.runOnIdle {
            nav.navigate("privacy")
            nav.navigate(policyRoute("family-example"))
            nav.returnToSettings()
        }
        assertRoute(SETTINGS_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute("privacy")
    }

    @Test
    fun switchingChildrenAndRapidRepeatedCallsKeepOneSettingsParent() {
        startGraph()

        compose.runOnIdle {
            nav.navigate(SETTINGS_ROUTE)
            nav.navigateToSettingsChild(MODELS_ROUTE)
            nav.navigateToSettingsChild(DEVICES_ROUTE)
            nav.navigateToSettingsChild(DEVICES_ROUTE)
            nav.returnToSettings()
        }
        assertRoute(SETTINGS_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    @Test
    fun restoredSettingsChildSandwichCollapsesToTheCanonicalParent() {
        startGraph()

        compose.runOnIdle {
            // A restored noncanonical Settings/child stack still resolves to one parent.
            nav.navigate(SETTINGS_ROUTE)
            nav.navigate(MODELS_ROUTE)
            nav.navigate(SETTINGS_ROUTE)
            nav.navigateToSettingsChild(DEVICES_ROUTE)
            nav.returnToSettings()
        }
        assertRoute(SETTINGS_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    @Test
    fun returningFromAnOrphanChildCreatesSettingsWithoutLeavingTheOrphanBehind() {
        startGraph()

        compose.runOnIdle {
            nav.navigate(MODELS_ROUTE)
            nav.returnToSettings()
        }
        assertRoute(SETTINGS_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    @Test
    fun openingFromAnOrphanChildCanonicalizesBeforePushingTheRequestedChild() {
        startGraph()

        compose.runOnIdle {
            nav.navigate(MODELS_ROUTE)
            nav.navigateToSettingsChild(DEVICES_ROUTE)
        }
        assertRoute(DEVICES_ROUTE)

        compose.runOnIdle { nav.returnToSettings() }
        assertRoute(SETTINGS_ROUTE)
        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    @Test
    fun returningFromOrphanModelsDescendantsRemovesTheWholeLineage() {
        startGraph()

        compose.runOnIdle {
            nav.navigate(MODELS_ROUTE)
            nav.navigate("models/backends")
            nav.navigate("models/backends/provider")
            nav.returnToSettings()
        }
        assertRoute(SETTINGS_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    @Test
    fun openingAChildFromRestoredSettingsAboveModelsDescendantsRemovesOrphans() {
        startGraph()

        compose.runOnIdle {
            nav.navigate(MODELS_ROUTE)
            nav.navigate("models/backends")
            nav.navigate(SETTINGS_ROUTE)
            nav.navigateToSettingsChild(DEVICES_ROUTE)
        }
        assertRoute(DEVICES_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute(SETTINGS_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }

    @Test
    fun openingASettingsChildFromAgentInstallsItsCanonicalParent() {
        startGraph()

        compose.runOnIdle { nav.navigateToSettingsChild(MODELS_ROUTE) }
        assertRoute(MODELS_ROUTE)

        compose.runOnIdle { nav.popBackStack() }
        assertRoute(SETTINGS_ROUTE)
        compose.runOnIdle { nav.popBackStack() }
        assertRoute("agent")
    }
}
