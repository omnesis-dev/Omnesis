// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.access

import dev.omnesis.android.transport.dto.AccessPendingRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccessPendingRequestsTest {
    private val older = AccessPendingRequest("request_older", "Northstar Assistant", "JKLM-NPQR", createdAt = 100, expiresAt = 900)
    private val newer = AccessPendingRequest("request_newer", "Aurora Planner", "ABCD-EFGH", createdAt = 200, expiresAt = 950)
    private val third = AccessPendingRequest("request_third", "Harbor Notes", "WXYZ-QRST", createdAt = 150, expiresAt = 980)

    /** The clock the store under test reads; a test moves it to let a request lapse. */
    private var now = 0L
    private val store = AccessPendingRequests { now }

    @Test fun the_banner_names_the_newest_request_and_nothing_when_none_waits() {
        assertNull(store.state.value.banner)
        store.replace(listOf(older, newer))
        assertEquals(AccessPendingBannerOffer(newest = newer, count = 2), store.state.value.banner)
        store.replace(emptyList())
        assertNull(store.state.value.banner)
    }

    @Test fun the_detail_names_the_newest_and_counts_the_rest() {
        assertEquals("Aurora Planner", AccessPendingBannerOffer(newest = newer, count = 1).detail)
        assertEquals("Aurora Planner and 1 more", AccessPendingBannerOffer(newest = newer, count = 2).detail)
        assertEquals("Aurora Planner and 2 more", AccessPendingBannerOffer(newest = newer, count = 3).detail)
    }

    @Test fun a_request_already_past_its_expiry_is_not_offered() {
        now = 920
        store.replace(listOf(older, newer))
        assertEquals(AccessPendingBannerOffer(newest = newer, count = 1), store.state.value.banner)
    }

    @Test fun a_request_lapsing_while_listed_leaves_the_banner_without_a_new_listing() {
        store.replace(listOf(newer, third))
        assertEquals(AccessPendingBannerOffer(newest = newer, count = 2), store.state.value.banner)

        // The newest lapses first: the one still waiting is what the banner now names, alone.
        now = 960
        assertEquals(AccessPendingBannerOffer(newest = third, count = 1), store.state.value.banner)
        // Both past their expiry: nothing waits.
        now = 990
        assertNull(store.state.value.banner)
    }

    @Test fun dismissing_hides_the_banner_until_the_set_of_waiting_requests_changes() {
        store.replace(listOf(older))
        store.dismiss()
        assertNull(store.state.value.banner)

        // The same set listed again keeps the dismissal.
        store.replace(listOf(older))
        assertNull(store.state.value.banner)

        // A request added brings the banner back, naming the newest.
        store.replace(listOf(older, newer))
        assertEquals(AccessPendingBannerOffer(newest = newer, count = 2), store.state.value.banner)

        // Dismissed again; one leaving is also a change.
        store.dismiss()
        store.replace(listOf(newer))
        assertEquals(AccessPendingBannerOffer(newest = newer, count = 1), store.state.value.banner)
    }

    @Test fun a_dismissal_covers_the_requests_waiting_at_that_moment_and_one_expiring_is_a_change() {
        now = 960
        store.replace(listOf(older, newer, third))
        // Only the third is still waiting, so that is the set the dismissal remembers.
        store.dismiss()
        assertNull(store.state.value.banner)
        store.replace(listOf(older, newer, third))
        assertNull(store.state.value.banner)

        // A dismissed pair loses one to expiry: the survivor is a changed set and shows again.
        now = 0
        store.replace(listOf(older, newer))
        store.dismiss()
        assertNull(store.state.value.banner)
        now = 920
        assertEquals(AccessPendingBannerOffer(newest = newer, count = 1), store.state.value.banner)
    }

    @Test fun a_request_settled_from_this_app_leaves_the_list_at_once() {
        store.replace(listOf(older, newer))
        store.settled(newer.id)
        assertEquals(AccessPendingBannerOffer(newest = older, count = 1), store.state.value.banner)
        store.settled(older.id)
        assertNull(store.state.value.banner)
        // A dismissed set that a settlement shrinks to nothing stays quiet, and a later
        // listing of a fresh request shows again.
        store.replace(listOf(older))
        store.dismiss()
        store.settled(older.id)
        assertNull(store.state.value.banner)
        store.replace(listOf(newer))
        assertEquals(AccessPendingBannerOffer(newest = newer, count = 1), store.state.value.banner)
    }
}
