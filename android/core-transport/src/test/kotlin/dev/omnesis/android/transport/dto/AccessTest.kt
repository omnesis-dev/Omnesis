// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class AccessTest {
    @Test fun notes_rules_round_trip_without_corpus_read_access() {
        val json = """{"capability":"notes","sources":{"mode":"all","sourceIds":[]}}"""
        val rule = OmnesisJson.decodeFromString<AccessGrantRule>(json)
        assertEquals(AccessGrantRule.notes(), rule)
        assertEquals(OmnesisJson.parseToJsonElement(json), OmnesisJson.parseToJsonElement(OmnesisJson.encodeToString(AccessGrantRule.serializer(), rule)))
        assertThrows(IllegalArgumentException::class.java) {
            AccessGrantRule(AccessCapability.NOTES, AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("example:source")))
        }
    }

    private val allowlist = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional"))
    private val denylist = AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("files:fictional"))

    @Test fun every_legal_decision_has_an_exact_gateway_wire_shape() {
        assertWire(
            AccessAuthorizationDecision.Approve(AccessAuthorizationSelection.Connect(
                rules = listOf(
                    AccessGrantRule.answer(allowlist, AccessAnswerRelease.reviewed("policy_example")),
                    AccessGrantRule.direct(denylist),
                ),
                credentialLabel = "Fictional assistant",
            )),
            """{"decision":"approve","selection":{"kind":"connect","credentialLabel":"Fictional assistant","rules":[{"capability":"answer","sources":{"mode":"allowlist","sourceIds":["notes:fictional"]},"release":{"mode":"reviewed","policyFamilyId":"policy_example"}},{"capability":"direct","sources":{"mode":"denylist","sourceIds":["files:fictional"]}}]}}""",
        )
        assertWire(AccessAuthorizationDecision.Deny, """{"decision":"deny"}""")
    }

    @Test fun a_new_connection_on_a_new_level_carries_the_level_name_and_rules() {
        assertWire(
            AccessAuthorizationDecision.Approve(
                AccessAuthorizationSelection.NewConnection(
                    name = "Northstar laptop",
                    level = AccessConnectionLevel.New(
                        name = "Northstar Assistant",
                        rules = listOf(AccessGrantRule.notes(), AccessGrantRule.direct(allowlist)),
                    ),
                ),
            ),
            """{"decision":"approve","selection":{"kind":"new-connection","name":"Northstar laptop","level":{"kind":"new","name":"Northstar Assistant","rules":[{"capability":"notes","sources":{"mode":"all","sourceIds":[]}},{"capability":"direct","sources":{"mode":"allowlist","sourceIds":["notes:fictional"]}}]}}}""",
        )
    }

    @Test fun a_new_connection_on_an_existing_level_names_the_level_and_its_reviewed_revision() {
        assertWire(
            AccessAuthorizationDecision.Approve(
                AccessAuthorizationSelection.NewConnection(
                    name = "Northstar laptop",
                    level = AccessConnectionLevel.Existing(levelId = "level_example", expectedLevelRevision = 4),
                ),
            ),
            """{"decision":"approve","selection":{"kind":"new-connection","name":"Northstar laptop","level":{"kind":"existing","levelId":"level_example","expectedLevelRevision":4}}}""",
        )
    }

    @Test fun replacing_a_connection_names_it_and_its_reviewed_grant_revision() {
        assertWire(
            AccessAuthorizationDecision.Approve(
                AccessAuthorizationSelection.ReplaceConnection(connectionId = "principal_example", expectedGrantRevision = 7),
            ),
            """{"decision":"approve","selection":{"kind":"replace-connection","connectionId":"principal_example","expectedGrantRevision":7}}""",
        )
    }

    @Test fun unreviewed_answer_and_all_sources_serialize_without_policy_or_ids() {
        val decision = AccessAuthorizationDecision.Approve(
            AccessAuthorizationSelection.Connect(
                listOf(AccessGrantRule.answer(
                    AccessSourceBoundary(AccessSourceMode.ALL, emptyList()),
                    AccessAnswerRelease.unreviewed(),
                )),
                "Example agent",
            ),
        )
        assertWire(
            decision,
            """{"decision":"approve","selection":{"kind":"connect","credentialLabel":"Example agent","rules":[{"capability":"answer","sources":{"mode":"all","sourceIds":[]},"release":{"mode":"unreviewed"}}]}}""",
        )
    }

    @Test fun a_lookup_reply_carries_the_access_the_client_already_holds() {
        val request = """{"id":"request_example","approvalId":"approval_example","status":"pending","clientId":"client_example","clientName":"Northstar Assistant","redirectOrigin":"http://127.0.0.1:10000","resource":"https://gateway.example.com/mcp","scope":"omnesis:access","expiresAt":2000000000000,"requiresAnswer":false}"""
        val fresh = OmnesisJson.decodeFromString<AccessAuthorizationLookupEnvelope>("""{"request":$request,"reconnect":null}""")
        assertEquals(null, fresh.reconnect)
        assertEquals(null, OmnesisJson.decodeFromString<AccessAuthorizationLookupEnvelope>("""{"request":$request}""").reconnect)
        // A newer gateway may add to the envelope; this version reads what it knows and ignores the rest.
        val extended = OmnesisJson.decodeFromString<AccessAuthorizationLookupEnvelope>(
            """{"request":$request,"reconnect":null,"hint":{"kind":"unknown"}}""",
        )
        assertEquals("request_example", extended.request.id)
        assertEquals(null, extended.reconnect)

        val known = OmnesisJson.decodeFromString<AccessAuthorizationLookupEnvelope>(
            """{"request":$request,"reconnect":{"matchedBy":"client","principal":{"id":"principal_example","name":"Northstar Assistant"},"grant":{"id":"grant_example","name":"Northstar Assistant access","revision":3,"rules":[{"capability":"answer","sources":{"mode":"allowlist","sourceIds":["notes:fictional"]},"release":{"mode":"reviewed","policyFamilyId":"policy_example"}}],"credentials":[{"id":"credential_example","label":"Northstar Assistant","status":"active"}],"createdAt":1,"updatedAt":2,"expiresAt":null,"revokedAt":null}}}""",
        )
        val reconnect = requireNotNull(known.reconnect)
        assertEquals("client", reconnect.matchedBy)
        assertEquals("Northstar Assistant", reconnect.principal.name)
        assertEquals("grant_example", reconnect.grant.id)
        assertEquals(AccessCapability.ANSWER, reconnect.grant.rules.single().capability)
    }

    @Test fun a_lookup_reply_carries_the_connection_proposal_when_the_gateway_knows_connections() {
        val request = """{"id":"request_example","approvalId":"approval_example","status":"pending","clientId":"client_example","clientName":"Northstar Assistant","redirectOrigin":"http://127.0.0.1:10000","resource":"https://gateway.example.com/mcp","scope":"omnesis:access","expiresAt":2000000000000,"requiresAnswer":false}"""
        // A gateway that predates connections sends no proposal at all.
        assertNull(OmnesisJson.decodeFromString<AccessAuthorizationLookupEnvelope>("""{"request":$request}""").connection)

        val proposed = OmnesisJson.decodeFromString<AccessAuthorizationLookupEnvelope>(
            """{"request":$request,"reconnect":null,"connection":{"defaultName":"Northstar Assistant 2","defaultLevelName":"Northstar Assistant 2","match":{"connectionId":"principal_example","connectionName":"Northstar Assistant","matchedBy":"client","levelId":"level_example","grant":{"id":"grant_example","name":"Northstar Assistant access","revision":3,"levelId":"level_example","rules":[{"capability":"answer","sources":{"mode":"all","sourceIds":[]},"release":{"mode":"unreviewed"}}],"credentials":[{"id":"credential_example","label":"Northstar Assistant","status":"active","lastUsedAt":1782000000000,"clientName":"Northstar Assistant","createdAt":1}],"createdAt":1,"updatedAt":2,"expiresAt":null,"revokedAt":null}},"recommended":"existing-level","hint":"ignored"},"extra":{"kind":"unknown"}}""",
        )
        assertNull(proposed.reconnect)
        val connection = requireNotNull(proposed.connection)
        assertEquals("Northstar Assistant 2", connection.defaultName)
        assertEquals("Northstar Assistant 2", connection.defaultLevelName)
        assertEquals("existing-level", connection.recommended)
        val match = requireNotNull(connection.match)
        assertEquals("principal_example", match.connectionId)
        assertEquals("client", match.matchedBy)
        assertEquals("level_example", match.levelId)
        assertEquals("level_example", match.grant.levelId)
        assertEquals(1_782_000_000_000, match.grant.credentials.single().lastUsedAt)
        assertEquals("Northstar Assistant", match.grant.credentials.single().clientName)

        val unmatched = OmnesisJson.decodeFromString<AccessAuthorizationLookupEnvelope>(
            """{"request":$request,"reconnect":null,"connection":{"defaultName":"Agent","defaultLevelName":"Agent","match":null,"recommended":"new-level"}}""",
        )
        assertNull(requireNotNull(unmatched.connection).match)
    }

    @Test fun overview_lists_access_levels_and_reads_as_none_without_the_field() {
        val listed = OmnesisJson.decodeFromString<AccessOverview>(
            """{"principals":[{"id":"principal_example","name":"Northstar Assistant","kind":"interactive","grants":[{"id":"grant_example","name":"Northstar Assistant access","revision":2,"levelId":"level_example","rules":[],"credentials":[]}]}],"sources":[],"policyFamilies":[],"levels":[{"id":"level_example","name":"Research","revision":5,"rules":[{"capability":"notes","sources":{"mode":"all","sourceIds":[]}}],"connectionCount":2,"createdAt":1,"updatedAt":2}]}""",
        )
        assertEquals(
            listOf(AccessLevelSummary("level_example", "Research", 5, listOf(AccessGrantRule.notes()), 2)),
            listed.levels,
        )
        assertEquals("level_example", listed.principals.single().grants.single().levelId)

        val absent = OmnesisJson.decodeFromString<AccessOverview>(
            """{"principals":[{"id":"principal_example","name":"Northstar Assistant","kind":"interactive","grants":[{"id":"grant_example","name":"Northstar Assistant access","revision":2,"rules":[],"credentials":[{"id":"credential_example","label":"Northstar Assistant","status":"active"}]}]}],"sources":[]}""",
        )
        assertEquals(emptyList<AccessLevelSummary>(), absent.levels)
        assertNull(absent.principals.single().grants.single().levelId)
        assertNull(absent.principals.single().grants.single().credentials.single().lastUsedAt)
    }

    @Test fun overview_accepts_the_transitional_privacy_policy_key() {
        val overview = OmnesisJson.decodeFromString<AccessOverview>(
            """{"principals":[],"sources":[],"privacyPolicies":[{"id":"policy_example","name":"Everyday","revision":"2"}]}""",
        )
        assertEquals("policy_example", overview.policyFamilies.single().id)
    }

    @Test fun overview_lists_the_requests_still_waiting_and_reads_as_none_without_the_field() {
        val listed = OmnesisJson.decodeFromString<AccessOverview>(
            """{"principals":[],"sources":[],"policyFamilies":[],"pendingRequests":[""" +
                """{"id":"request_newer","clientName":"Aurora Planner","userCode":"ABCD-EFGH","createdAt":1782000200000,"expiresAt":1782000800000},""" +
                """{"id":"request_older","clientName":"Northstar Assistant","userCode":"JKLM-NPQR","createdAt":1782000100000,"expiresAt":1782000700000}]}""",
        )
        assertEquals(listOf("request_newer", "request_older"), listed.pendingRequests.map { it.id })
        assertEquals(
            AccessPendingRequest("request_newer", "Aurora Planner", "ABCD-EFGH", 1_782_000_200_000, 1_782_000_800_000),
            listed.pendingRequests.first(),
        )
        // A gateway that does not list pending requests reads as nothing waiting.
        val absent = OmnesisJson.decodeFromString<AccessOverview>("""{"principals":[],"sources":[]}""")
        assertEquals(emptyList<AccessPendingRequest>(), absent.pendingRequests)
        val encoded = OmnesisJson.parseToJsonElement(OmnesisJson.encodeToString(AccessOverview.serializer(), listed))
        assertEquals(
            OmnesisJson.parseToJsonElement(
                """{"principals":[],"sources":[],"policyFamilies":[],"pendingRequests":[""" +
                    """{"id":"request_newer","clientName":"Aurora Planner","userCode":"ABCD-EFGH","createdAt":1782000200000,"expiresAt":1782000800000},""" +
                    """{"id":"request_older","clientName":"Northstar Assistant","userCode":"JKLM-NPQR","createdAt":1782000100000,"expiresAt":1782000700000}],"levels":[]}""",
            ),
            encoded,
        )
    }

    @Test fun impossible_authorization_states_are_rejected_at_construction() {
        assertThrows(IllegalArgumentException::class.java) {
            AccessAnswerRelease(AccessAnswerReleaseMode.REVIEWED)
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccessGrantRule(AccessCapability.DIRECT, allowlist, AccessAnswerRelease.unreviewed())
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccessSourceBoundary(AccessSourceMode.ALL, listOf("notes:fictional"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccessAuthorizationSelection.Connect(emptyList(), "Android")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccessAuthorizationSelection.Connect(listOf(AccessGrantRule.notes()), " ")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccessAuthorizationSelection.NewConnection(" ", AccessConnectionLevel.Existing("level_example", 1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccessAuthorizationSelection.NewConnection("n".repeat(121), AccessConnectionLevel.Existing("level_example", 1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccessConnectionLevel.New("Research", emptyList())
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccessConnectionLevel.New("", listOf(AccessGrantRule.notes()))
        }
    }

    private fun assertWire(decision: AccessAuthorizationDecision, expected: String) {
        assertEquals(OmnesisJson.parseToJsonElement(expected), decision.toWireJson())
    }
}
