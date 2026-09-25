// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.ui.access.ACCESS_PENDING_BANNER_ACTION
import dev.omnesis.android.ui.access.ACCESS_PENDING_BANNER_DISMISS
import dev.omnesis.android.ui.access.ACCESS_PENDING_BANNER_TITLE
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The banner the shell shows for an authorization request waiting on the owner: read from
 * the access overview on becoming active, opened by id, dismissed until what waits changes.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class HomeScaffoldAccessBannerTest {
    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val hostActivity = HomeScaffoldHostActivityRule()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<HomeScaffoldHostActivity>()

    private lateinit var harness: HomeScaffoldHarness

    @Before
    fun setUp() {
        harness = HomeScaffoldHarness(compose)
        harness.pair()
    }

    @After
    fun tearDown() {
        harness.close()
    }

    @Test
    fun aGatewayThatListsNoPendingRequestsEarnsNoBanner() {
        harness.composeShell()
        harness.waitUntil { harness.gateway.accessOverviewReads() >= 1 }
        // Becoming active reads the overview once; nothing else on the shell reads it again.
        assertEquals(1, harness.gateway.accessOverviewReads())
        compose.onAllNodesWithText(ACCESS_PENDING_BANNER_TITLE).assertCountEquals(0)
        assertEquals("agent", harness.currentRoute)
    }

    @Test
    fun anOverviewThatCannotBeReadShowsNoBannerAndDropsOneShownBefore() {
        harness.gateway.accessOverviewFails = true
        harness.composeShell()
        harness.waitUntil { harness.gateway.accessOverviewReads() >= 1 }
        compose.onAllNodesWithText(ACCESS_PENDING_BANNER_TITLE).assertCountEquals(0)
        assertEquals("agent", harness.currentRoute)

        // A listing that lands shows the banner; a read that fails afterwards shows nothing
        // rather than a request that may be gone.
        harness.gateway.accessOverviewFails = false
        harness.gateway.pendingAccessRequestsJson = ONE_REQUEST
        harness.background()
        harness.foreground()
        harness.waitUntil { bannerShown() }

        harness.gateway.accessOverviewFails = true
        harness.background()
        harness.foreground()
        harness.waitUntil { harness.gateway.accessOverviewReads() >= 3 && !bannerShown() }
        assertEquals("agent", harness.currentRoute)
    }

    @Test
    fun aWaitingRequestEarnsOneBannerThatOpensTheWizardForTheNewestById() {
        harness.gateway.pendingAccessRequestsJson = TWO_REQUESTS
        harness.composeShell()
        harness.waitUntil { bannerShown() }
        compose.onAllNodesWithText(ACCESS_PENDING_BANNER_TITLE).assertCountEquals(1)
        compose.onNodeWithText("Aurora Planner and 1 more · $ACCESS_PENDING_BANNER_ACTION").assertExists()

        compose.onNodeWithText(ACCESS_PENDING_BANNER_TITLE).performClick()
        harness.waitUntil { harness.currentRoute == ACCESS_AUTHORIZATION_ROUTE_PATTERN }
        assertEquals("request-newer", harness.nav.currentBackStackEntry?.arguments?.getString("request"))
        assertNull(harness.nav.currentBackStackEntry?.arguments?.getString("code"))
        assertNotNull(harness.nav.currentBackStackEntry?.arguments?.getString("gateway"))
        harness.waitUntil { "/admin/access/authorizations/request-newer" in harness.gateway.requestPaths }
        // The wizard deciding the request does not carry the banner over itself.
        compose.onAllNodesWithText(ACCESS_PENDING_BANNER_TITLE).assertCountEquals(0)
        assertTrue(harness.gateway.requestPaths.none { it.startsWith("/admin/access/authorizations/lookup") })
    }

    @Test
    fun dismissingHidesTheBannerUntilTheSetOfWaitingRequestsChanges() {
        harness.gateway.pendingAccessRequestsJson = ONE_REQUEST
        harness.composeShell()
        harness.waitUntil { bannerShown() }

        compose.onNodeWithContentDescription(ACCESS_PENDING_BANNER_DISMISS).performClick()
        compose.waitForIdle()
        compose.onAllNodesWithText(ACCESS_PENDING_BANNER_TITLE).assertCountEquals(0)

        // Becoming active again re-reads the overview; the same set stays dismissed.
        harness.background()
        harness.foreground()
        harness.waitUntil { harness.gateway.accessOverviewReads() >= 2 }
        compose.onAllNodesWithText(ACCESS_PENDING_BANNER_TITLE).assertCountEquals(0)

        // A second request arriving is a change, and the banner names the newer one.
        harness.gateway.pendingAccessRequestsJson = TWO_REQUESTS
        harness.background()
        harness.foreground()
        harness.waitUntil { bannerShown() }
        compose.onNodeWithText("Aurora Planner and 1 more · $ACCESS_PENDING_BANNER_ACTION").assertExists()
    }

    private fun bannerShown(): Boolean =
        compose.onAllNodesWithText(ACCESS_PENDING_BANNER_TITLE).fetchSemanticsNodes().isNotEmpty()

    private companion object {
        const val ONE_REQUEST =
            """[{"id":"request-older","clientName":"Northstar Assistant","userCode":"JKLM-NPQR","createdAt":1782000100000,"expiresAt":2000000000000}]"""
        const val TWO_REQUESTS =
            """[{"id":"request-newer","clientName":"Aurora Planner","userCode":"ABCD-EFGH","createdAt":1782000200000,"expiresAt":2000000000000},""" +
                """{"id":"request-older","clientName":"Northstar Assistant","userCode":"JKLM-NPQR","createdAt":1782000100000,"expiresAt":2000000000000}]"""
    }
}
