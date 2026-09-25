// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Decode-time contract tests using invented (non-corpus) fixtures. */
class DtoDecodeTest {

    @Test
    fun search_response_decodes_results_and_breakdown() {
        val json = """
            {
              "results": [
                {
                  "documentId": "doc-1",
                  "sourceId": "notes:local",
                  "documentType": "note",
                  "title": "Q4 budget review",
                  "sourceCreatedAt": "2026-01-02T10:00:00Z",
                  "author": "Maya Reeves",
                  "chunkText": "Projected spend is on track.",
                  "score": 0.87,
                  "scoreBreakdown": { "bm25Rank": 1, "finalScore": 0.87 }
                }
              ],
              "timing": { "totalMs": 12.5 }
            }
        """.trimIndent()
        val resp = OmnesisJson.decodeFromString<SearchResponse>(json)
        assertEquals(1, resp.results.size)
        assertEquals("doc-1", resp.results[0].documentId)
        assertEquals(0.87, resp.results[0].score, 1e-9)
        assertEquals(1, resp.results[0].scoreBreakdown?.bm25Rank)
    }

    @Test
    fun document_detail_uses_snake_case_keys() {
        val json = """
            {
              "id": "doc-1",
              "provider_id": "local:default",
              "source_id": "notes:local",
              "external_id": "ext-1",
              "title": "Marathon entry form",
              "content": "body",
              "content_hash": "sha256:abc",
              "metadata": {"documentType":"note"},
              "source_created_at": "2026-01-02T10:00:00Z"
            }
        """.trimIndent()
        val doc = OmnesisJson.decodeFromString<DocumentDetail>(json)
        assertEquals("local:default", doc.providerId)
        assertEquals("notes:local", doc.sourceId)
        assertEquals("note", doc.metadata.jsonObject["documentType"]?.jsonPrimitive?.content)
        assertFalse(doc.isInternal)
    }

    @Test
    fun document_detail_internal_flag_defaults_absent_reads_present() {
        val flagged = OmnesisJson.decodeFromString<DocumentDetail>(
            """{"id":"d","provider_id":"p","source_id":"omnesis-notes","external_id":"e","title":"T","source_created_at":"2026-01-02T10:00:00Z","internal":true}""",
        )
        assertTrue(flagged.isInternal)
    }

    @Test
    fun document_detail_metadata_accepts_stringified_json() {
        val json = """
            {
              "id": "doc-2",
              "provider_id": "p",
              "source_id": "s",
              "external_id": "e",
              "title": "T",
              "metadata": "{\"k\":\"v\"}",
              "source_created_at": "2026-01-02T10:00:00Z"
            }
        """.trimIndent()
        val doc = OmnesisJson.decodeFromString<DocumentDetail>(json)
        assertEquals("v", doc.metadata.jsonObject["k"]?.jsonPrimitive?.content)
    }

    @Test
    fun recent_items_tagged_union_resolves_arms() {
        val docs = OmnesisJson.decodeFromString<RecentItemsResponse>(
            """{"kind":"documents","documents":[{"id":"d","sourceId":"s","title":"t","sourceCreatedAt":"2026-01-02T10:00:00Z"}]}""",
        )
        assertTrue(docs is RecentItemsResponse.Documents)

        val analytics = OmnesisJson.decodeFromString<RecentItemsResponse>(
            """{"kind":"analytics","table":"health_body","displayName":"Body","columns":["x","active"],"rows":[[72.5,true]]}""",
        )
        assertTrue(analytics is RecentItemsResponse.Analytics)
        analytics as RecentItemsResponse.Analytics
        assertEquals(listOf("x", "active"), analytics.columns)
        assertEquals("72.5", analytics.rows.single()[0].jsonPrimitive.content)
        assertEquals("true", analytics.rows.single()[1].jsonPrimitive.content)

        val empty = OmnesisJson.decodeFromString<RecentItemsResponse>("""{"kind":"empty"}""")
        assertTrue(empty is RecentItemsResponse.Empty)

        // Unknown kind degrades to Empty (forward-compatible) rather than throwing.
        val unknown = OmnesisJson.decodeFromString<RecentItemsResponse>("""{"kind":"future-thing"}""")
        assertTrue(unknown is RecentItemsResponse.Empty)
    }

    @Test
    fun recent_items_envelope_internal_flag_rides_every_arm() {
        val docs = OmnesisJson.decodeFromString<RecentItemsResponse>(
            """{"kind":"documents","internal":true,"documents":[]}""",
        )
        assertTrue(docs is RecentItemsResponse.Documents)
        assertTrue((docs as RecentItemsResponse.Documents).isInternal)

        val analytics = OmnesisJson.decodeFromString<RecentItemsResponse>(
            """{"kind":"analytics","internal":true,"table":"t"}""",
        )
        assertTrue((analytics as RecentItemsResponse.Analytics).isInternal)

        val empty = OmnesisJson.decodeFromString<RecentItemsResponse>(
            """{"kind":"empty","internal":true}""",
        )
        assertTrue((empty as RecentItemsResponse.Empty).isInternal)

        // Absent on older gateways → false, never a decode failure.
        val legacy = OmnesisJson.decodeFromString<RecentItemsResponse>("""{"kind":"empty"}""")
        assertFalse((legacy as RecentItemsResponse.Empty).isInternal)
    }

    @Test
    fun internal_source_entry_tolerates_a_blank_id() {
        val blank = OmnesisJson.decodeFromString<InternalSource>("""{}""")
        assertEquals("", blank.id)
        val flagged = OmnesisJson.decodeFromString<InternalSource>("""{"id":"omnesis-notes"}""")
        assertEquals("omnesis-notes", flagged.id)
    }

    @Test
    fun descriptor_remaps_id_to_typeId_and_keeps_unknown_fields() {
        val json = """
            {
              "id": "gmail",
              "name": "Gmail",
              "authType": "oauth",
              "provider": {"id":"google","name":"Google"},
              "unitName": "emails",
              "icon": {"sfSymbol":"envelope","color":"#EA4335"},
              "somethingNew": true
            }
        """.trimIndent()
        val d = OmnesisJson.decodeFromString<SerializedDescriptor>(json)
        assertEquals("gmail", d.typeId)
        assertEquals("Gmail", d.name)
        assertEquals("emails", d.unitName)
        assertEquals("#EA4335", d.icon?.color)
    }

    @Test
    fun page_envelope_decodes() {
        val page = OmnesisJson.decodeFromString<Page<SourceRecord>>(
            """{"items":[{"id":"notes:local","type":"notes"}],"pageInfo":{"hasMore":false,"limit":50}}""",
        )
        assertEquals(1, page.items.size)
        assertEquals("notes:local", page.items[0].id)
        assertEquals(false, page.pageInfo.hasMore)
    }

    @Test
    fun near_dupes_decodes_with_stat_fields() {
        val resp = OmnesisJson.decodeFromString<DocumentNearDupes>(
            """{"edges":[{"otherDocId":"d2","otherTitle":"Re: Q4 budget review","otherSourceId":"gmail:a","otherDocType":"email","jaccard":0.88,"pairUniqueDf2":2,"containmentMin":0.7,"gateFamily":"text"}],"nextCursor":null}""",
        )
        assertEquals(1, resp.edges.size)
        assertEquals("d2", resp.edges[0].otherDocId)
        assertEquals(0.88, resp.edges[0].jaccard, 1e-9)
        assertEquals(2, resp.edges[0].pairUniqueDf2)
        assertEquals("text", resp.edges[0].gateFamily)
    }

    @Test
    fun near_dupes_empty_edges_default() {
        val resp = OmnesisJson.decodeFromString<DocumentNearDupes>("""{}""")
        assertTrue(resp.edges.isEmpty())
    }

    @Test
    fun event_trail_decodes_seeds_events_and_people() {
        val trail = OmnesisJson.decodeFromString<DocumentEventTrail>(
            """{"seeds":["d1"],"truncated":true,"events":[{"eventId":"e0","at":"2026-01-02T10:00:00Z","kind":"event","doc":{"documentId":"d1","title":"Marathon entry form","sourceId":"notes:local"},"people":[{"personId":"self","name":"You","isSelf":true}]}]}""",
        )
        assertEquals(listOf("d1"), trail.seeds)
        assertEquals(1, trail.events.size)
        assertEquals("Marathon entry form", trail.events[0].doc?.title)
        assertTrue(trail.events[0].people[0].isSelf)
        assertTrue(trail.truncated)
    }

    @Test
    fun event_trail_defaults_to_empty() {
        val trail = OmnesisJson.decodeFromString<DocumentEventTrail>("""{}""")
        assertTrue(trail.seeds.isEmpty())
        assertTrue(trail.events.isEmpty())
        assertFalse(trail.truncated)
    }

    @Test
    fun delete_all_response_decodes() {
        val r = OmnesisJson.decodeFromString<DeleteAllResponse>(
            """{"deleted":12,"analyticsDropped":["health_body","health_hr"]}""",
        )
        assertEquals(12, r.deleted)
        assertEquals(listOf("health_body", "health_hr"), r.analyticsDropped)
    }

    @Test
    fun patch_source_body_drops_null_fields() {
        // explicitNulls=false: a null `config` must not appear on the wire.
        assertEquals("""{"enabled":true}""", OmnesisJson.encodeToString(PatchSourceBody(enabled = true)))
        assertEquals("{}", OmnesisJson.encodeToString(PatchSourceBody()))
    }

    @Test
    fun status_experimental_decodes_true_and_false() {
        val on = OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"documents":{"total":3},"experimental":true}""",
        )
        assertTrue(on.experimental)

        val off = OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"documents":{"total":3},"experimental":false}""",
        )
        assertFalse(off.experimental)
    }

    @Test
    fun status_on_disk_prefers_the_whole_footprint_and_falls_back_to_the_main_database() {
        val measured = OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"documents":{"total":3},"dbSizeBytes":1000,"diskUsage":{"totalBytes":3000,""" +
                """"measuredAt":"2026-06-04T10:00:00.000Z","stores":[{"id":"documents","label":"Main database","bytes":1000}]}}""",
        )
        assertEquals(1000L, measured.dbSizeBytes)
        assertEquals(3000L, measured.onDiskBytes)

        // A gateway that predates the field, and one still on its first measurement.
        val older = OmnesisJson.decodeFromString<StatusSnapshot>("""{"documents":{"total":3},"dbSizeBytes":1000}""")
        assertEquals(1000L, older.onDiskBytes)
        val measuring = OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"documents":{"total":3},"dbSizeBytes":1000,"diskUsage":null}""",
        )
        assertEquals(1000L, measuring.onDiskBytes)
    }

    @Test
    fun status_developer_decodes_and_defaults_to_false() {
        val on = OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"documents":{"total":3},"developer":true}""",
        )
        assertTrue(on.developer)

        // A gateway that predates developer mode omits the field — the
        // affordance stays hidden rather than the decode failing.
        val absent = OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"documents":{"total":3}}""",
        )
        assertFalse(absent.developer)
    }

    @Test
    fun annotations_response_decodes() {
        // Both /people/:id/annotations and /documents/:id/annotations return this camelCase shape.
        val json = """
            {
              "annotations": [
                {
                  "id": "an-1",
                  "claimType": "preference",
                  "claimText": "Prefers async written updates over live meetings.",
                  "evidenceDocId": "doc-9",
                  "evidenceQuote": "Let's keep this to email — I can't do a call this week.",
                  "confidence": 0.82,
                  "claimBasis": "inferred",
                  "createdAt": "2026-05-04T09:30:00Z",
                  "verificationState": "verified",
                  "lastVerifiedAt": "2026-05-06T09:30:00Z"
                },
                {
                  "id": "an-2",
                  "claimType": "profile",
                  "claimText": "Goes by Maya; based in the Pacific timezone.",
                  "confidence": 0.95
                }
              ]
            }
        """.trimIndent()
        val resp = OmnesisJson.decodeFromString<AnnotationsResponse>(json)
        assertEquals(2, resp.annotations.size)
        assertEquals("preference", resp.annotations[0].claimType)
        assertEquals("Prefers async written updates over live meetings.", resp.annotations[0].claimText)
        assertEquals(0.82, resp.annotations[0].confidence, 1e-9)
        assertEquals("Let's keep this to email — I can't do a call this week.", resp.annotations[0].evidenceQuote)
        assertEquals("inferred", resp.annotations[0].claimBasis)
        assertEquals("verified", resp.annotations[0].verificationState)
        assertEquals("2026-05-06T09:30:00Z", resp.annotations[0].lastVerifiedAt)
        // High-confidence self-memory-flavored row with no grounding quote — nullable defaults to
        // null, as do the claim-basis and verification fields an older gateway omits.
        assertEquals("profile", resp.annotations[1].claimType)
        assertEquals(0.95, resp.annotations[1].confidence, 1e-9)
        assertNull(resp.annotations[1].evidenceQuote)
        assertNull(resp.annotations[1].claimBasis)
        assertNull(resp.annotations[1].verificationState)
        assertNull(resp.annotations[1].lastVerifiedAt)
    }

    @Test
    fun annotations_response_defaults_to_empty() {
        // An older / non-experimental gateway shape must decode to an empty list, never crash.
        val resp = OmnesisJson.decodeFromString<AnnotationsResponse>("""{}""")
        assertTrue(resp.annotations.isEmpty())
    }

    @Test
    fun capability_meta_decodes_section() {
        // The `section` hint keeps core capabilities before cognition roles in the unified
        // models list; an older gateway that omits it decodes to null (treated as core).
        val cap = OmnesisJson.decodeFromString<CapabilityMeta>(
            """{"role":"background-agent","title":"Background agent","description":"d","icon":"bot","experimental":true,"section":"cognition"}""",
        )
        assertEquals("cognition", cap.section)
        val legacy = OmnesisJson.decodeFromString<CapabilityMeta>(
            """{"role":"agent","title":"Agent","description":"d","icon":"bot"}""",
        )
        assertNull(legacy.section)
    }

    @Test
    fun status_experimental_defaults_false_when_absent() {
        // An older gateway omits the field entirely — it must decode as `false`
        // so experimental surfaces stay hidden rather than crashing the decode.
        val older = OmnesisJson.decodeFromString<StatusSnapshot>("""{"documents":{"total":3}}""")
        assertFalse(older.experimental)
    }

    @Test
    fun an_exchange_without_an_outcome_is_still_being_checked_not_failed() {
        // A payload this client could not fully read says nothing about what
        // became of the exchange; reporting a definite failure would be a lie
        // about the user's data, and the harsher of the two possible readings.
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","conversationId":"conversation-example"}""",
        )
        assertEquals("checking", exchange.outcome)
        assertNull(exchange.draftAnswer)
        assertNull(exchange.denialReason)
    }

    @Test
    fun an_exchange_from_an_older_gateway_carries_no_traces_and_no_error() {
        // Gateways from before the traces projection omit both fields; the
        // answer detail shows no tool section, never an error.
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","conversationId":"conversation-example"}""",
        )
        assertTrue(exchange.agentTraces.isEmpty())
        assertEquals(0, exchange.agentTraceOmittedAttempts)
    }

    @Test
    fun agent_traces_decode_with_unreadable_parts_kept_raw() {
        // Messages stay raw JSON so a part this client cannot read is skipped
        // when pairing tool calls, never fatal to the attempt or the exchange.
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","conversationId":"conversation-example",
               "agentTraces":[{"attempt":2,"provider":"example-provider","model":"example-model",
               "sessionId":"session-example",
               "messages":[{"role":"assistant","parts":[
               {"kind":"tool_use","toolCallId":"call-example","tool":"list_loops","args":{}},
               {"kind":"tool_result","toolCallId":"call-example",
                "result":{"kind":"structured","resultType":"loops.listed","data":{}}},
               "a future part shape",
               {"kind":"thinking","text":"hmm"},
               {"kind":"novel","payload":[1,2]}]},
               {"role":"assistant"},
               "a future message shape"],
               "terminalStopReason":"context_window_exceeded","createdAt":150,
               "truncated":true,"omittedParts":3}],
               "agentTraceOmittedAttempts":1}""",
        )
        val trace = exchange.agentTraces.single()
        assertEquals(2, trace.attempt)
        assertEquals("example-provider", trace.provider)
        assertEquals("context_window_exceeded", trace.terminalStopReason)
        assertTrue(trace.truncated)
        assertEquals(3, trace.omittedParts)
        assertEquals(1, exchange.agentTraceOmittedAttempts)
    }

    @Test
    fun an_unattended_exchange_decodes_its_local_draft_and_denial_reason() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","conversationId":"conversation-example",
               "draftAnswer":"The fictional reception desk is open until 17:00.",
               "denialReason":"approval_not_available"}""",
        )

        assertEquals("The fictional reception desk is open until 17:00.", exchange.draftAnswer)
        assertEquals("approval_not_available", exchange.denialReason)
    }

    @Test
    fun a_failed_exchange_decodes_the_authoritative_failure_stage() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","conversationId":"conversation-example",
               "status":"failed","outcome":"failed","failure":{"code":"http_request_timeout",
               "message":"The model request timed out.","stage":"answer_generation"}}""",
        )

        assertEquals("answer_generation", exchange.failure?.stage)
    }

    @Test
    fun an_audit_status_outside_the_closed_set_is_dropped_at_decode() {
        // Audit rows persist a raw producer token; a model's terminal stop
        // reason must never reach a consumer that would print it.
        val unknown = OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
            """{"id":"event-example","taskId":"task-example","display":{"title":"Step","status":{"code":"stop","label":"stop"}}}""",
        )
        assertNull(unknown.display.status)

        val blankLabel = OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
            """{"id":"event-example","taskId":"task-example","display":{"title":"Step","status":{"code":"held","label":"  "}}}""",
        )
        assertNull(blankLabel.display.status)

        val known = OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
            """{"id":"event-example","taskId":"task-example","display":{"title":"Step","status":{"code":"held","label":"Held for you"}}}""",
        )
        assertEquals("Held for you", known.display.status?.label)
    }

    @Test
    fun an_identical_release_decodes_without_a_body_to_compare() {
        val event = OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
            """{"id":"event-example","taskId":"task-example","kind":"released",
               "display":{"title":"Left this machine","text":null},
               "answerComparison":{"kind":"identical"}}""",
        )
        assertEquals(PrivacyAnswerComparison.Identical, event.answerComparison)
    }

    @Test
    fun a_diff_decodes_its_lines_and_their_spans() {
        val event = OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
            """{"id":"event-example","taskId":"task-example","kind":"released","answerComparison":{
                 "kind":"diff",
                 "lines":[
                   {"op":"equal","text":"The review is planned.","spans":null},
                   {"op":"removed","text":"It starts at 10:00.","spans":[
                     {"op":"equal","text":"It starts"},
                     {"op":"removed","text":" at 10:00"},
                     {"op":"equal","text":"."}
                   ]},
                   {"op":"added","text":"It starts."},
                   {"op":"removed","text":"A line with no counterpart."}
                 ]}}""",
        )
        val diff = event.answerComparison as PrivacyAnswerComparison.Diff
        assertEquals(4, diff.lines.size)
        assertEquals(PrivacyAnswerDiffOp.EQUAL, diff.lines[0].op)
        // An equal line is whole: null spans never mean "unchanged".
        assertNull(diff.lines[0].spans)
        assertEquals(3, diff.lines[1].spans?.size)
        assertEquals(PrivacyAnswerDiffOp.REMOVED, diff.lines[1].spans?.get(1)?.op)
        assertEquals(" at 10:00", diff.lines[1].spans?.get(1)?.text)
        // An absent `spans` key decodes the same as an explicit null.
        assertNull(diff.lines[2].spans)
        assertEquals(PrivacyAnswerDiffOp.REMOVED, diff.lines[3].op)
    }

    @Test
    fun a_whitespace_only_change_keeps_its_spans() {
        // A reduction can be exactly this, so the spans must survive decode for
        // the record to be able to show it at all.
        val event = OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
            """{"id":"event-example","taskId":"task-example","answerComparison":{
                 "kind":"diff",
                 "lines":[{"op":"removed","text":"Two  spaces","spans":[
                   {"op":"equal","text":"Two"},
                   {"op":"removed","text":"  "},
                   {"op":"equal","text":"spaces"}
                 ]}]}}""",
        )
        val diff = event.answerComparison as PrivacyAnswerComparison.Diff
        assertEquals("  ", diff.lines.single().spans?.get(1)?.text)
    }

    @Test
    fun both_no_diff_reasons_decode_and_an_unknown_one_does_not() {
        fun comparisonOf(reason: String) = OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
            """{"id":"event-example","taskId":"task-example","answerComparison":{"kind":"no_diff","reason":"$reason"}}""",
        ).answerComparison

        assertEquals(
            PrivacyAnswerComparison.NoDiff(PrivacyAnswerComparison.NoDiff.Reason.DISSIMILAR),
            comparisonOf("dissimilar"),
        )
        assertEquals(
            PrivacyAnswerComparison.NoDiff(PrivacyAnswerComparison.NoDiff.Reason.TOO_LARGE),
            comparisonOf("too_large"),
        )
        assertNull(comparisonOf("some-future-reason"))
    }

    @Test
    fun an_absent_comparison_is_null_rather_than_a_claim_that_nothing_changed() {
        val event = OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
            """{"id":"event-example","taskId":"task-example","kind":"released","display":{"title":"Left this machine"}}""",
        )
        assertNull(event.answerComparison)
    }

    @Test
    fun a_comparison_this_client_cannot_state_renders_nothing_and_fails_no_page() {
        // An unknown kind, an unknown line op, and a diff with no lines each
        // leave the step with no comparison — never a partial one, which would
        // be read as a complete account of what left the machine.
        val page = OmnesisJson.decodeFromString<PrivacyAuditEventPage>(
            """{"events":[
                 {"id":"e1","taskId":"t","answerComparison":{"kind":"future-shape","lines":[]}},
                 {"id":"e2","taskId":"t","answerComparison":{"kind":"diff","lines":[
                   {"op":"equal","text":"Kept."},
                   {"op":"moved","text":"Somewhere else."}
                 ]}},
                 {"id":"e3","taskId":"t","answerComparison":{"kind":"diff","lines":[]}},
                 {"id":"e4","taskId":"t","answerComparison":{"kind":"identical"}}
               ]}""",
        )
        assertEquals(4, page.events.size)
        assertNull(page.events[0].answerComparison)
        assertNull(page.events[1].answerComparison)
        assertNull(page.events[2].answerComparison)
        assertEquals(PrivacyAnswerComparison.Identical, page.events[3].answerComparison)
    }

    @Test
    fun direct_audit_sessions_decode_newest_first_with_nullable_explicit_key() {
        val resp = OmnesisJson.decodeFromString<DirectAuditSessionsResponse>(
            """{"sessions":[
                 {"id":"direct_session_two","ownerId":"owner_example","principalId":"principal_example",
                  "principalName":"Atlas","credentialId":"credential_example","grantId":"grant_example",
                  "explicitKey":"conversation:conversation_example","heuristicKey":"principal_example|credential_example",
                  "createdAt":1700000005000,"lastEventAt":1700000005000,"eventCount":2},
                 {"id":"direct_session_one","ownerId":"owner_example","principalId":"principal_example",
                  "principalName":null,"credentialId":"credential_example","grantId":"grant_example",
                  "explicitKey":null,"heuristicKey":"principal_example|credential_example",
                  "createdAt":1700000000000,"lastEventAt":1700000000000,"eventCount":1}
               ]}""",
        )
        assertEquals(2, resp.sessions.size)
        assertEquals("direct_session_two", resp.sessions[0].id)
        assertEquals("Atlas", resp.sessions[0].principalName)
        assertEquals("conversation:conversation_example", resp.sessions[0].explicitKey)
        assertEquals(2, resp.sessions[0].eventCount)
        assertNull(resp.sessions[1].principalName)
        assertNull(resp.sessions[1].explicitKey)
    }

    @Test
    fun direct_audit_sessions_tolerate_missing_names_and_unknown_fields() {
        val resp = OmnesisJson.decodeFromString<DirectAuditSessionsResponse>(
            """{"sessions":[
                 {"id":"direct_session_one","ownerId":"owner_example","principalId":"principal_example",
                  "credentialId":"credential_example","grantId":"grant_example",
                  "explicitKey":null,"heuristicKey":"principal_example|credential_example",
                  "bytesTotal":1234,"createdAt":1700000000000,"lastEventAt":1700000000000,"eventCount":1}
               ]}""",
        )
        assertEquals(1, resp.sessions.size)
        assertNull(resp.sessions.single().principalName)
    }

    @Test
    fun direct_audit_session_events_decode_oldest_first_with_truncation_flags() {
        val resp = OmnesisJson.decodeFromString<DirectAuditSessionEventsResponse>(
            """{"events":[
                 {"sequence":1,"id":"directevent_one","sessionId":"direct_session_one",
                  "tool":"search_many","outcome":"ok","requestId":"request_example",
                  "display":{"title":"Direct search_many","text":"Raw corpus read finished with outcome ok."},
                  "payloadTruncated":false,"payloadBytes":120,"originalPayloadBytes":120,
                  "createdAt":1700000000000},
                 {"sequence":2,"id":"directevent_two","sessionId":"direct_session_one",
                  "tool":"fetch_many","outcome":"refused","requestId":"request_example_two",
                  "display":{"title":"Direct fetch_many","text":null},
                  "payloadTruncated":true,"payloadBytes":90,"originalPayloadBytes":200000,
                  "createdAt":1700000001000}
               ]}""",
        )
        assertEquals(2, resp.events.size)
        assertEquals("search_many", resp.events[0].tool)
        assertEquals("ok", resp.events[0].outcome)
        assertEquals("Direct search_many", resp.events[0].display.title)
        assertTrue(resp.events[1].payloadTruncated)
        assertEquals(200000, resp.events[1].originalPayloadBytes)
        assertNull(resp.events[1].display.text)
    }

    @Test
    fun direct_audit_event_detail_decodes_its_bounded_payload() {
        val envelope = OmnesisJson.decodeFromString<DirectAuditEventEnvelope>(
            """{"event":{"sequence":1,"id":"directevent_one","sessionId":"direct_session_one",
               "tool":"search_many","outcome":"ok","requestId":"request_example",
               "display":{"title":"Direct search_many","text":"Raw corpus read finished with outcome ok."},
               "payloadTruncated":false,"payloadBytes":120,"originalPayloadBytes":120,
               "createdAt":1700000000000,
               "payload":{"tool":"search_many","args":{"query":"fictional schedule"},
                          "result":{"documents":[]},"outcome":"ok"}}}""",
        )
        assertEquals("directevent_one", envelope.event.id)
        assertEquals(
            "fictional schedule",
            envelope.event.payload?.jsonObject?.get("args")
                ?.jsonObject?.get("query")?.jsonPrimitive?.content,
        )
    }

    @Test
    fun direct_audit_event_detail_tolerates_a_missing_payload() {
        val envelope = OmnesisJson.decodeFromString<DirectAuditEventEnvelope>(
            """{"event":{"sequence":1,"id":"directevent_one","sessionId":"direct_session_one",
               "tool":"search_many","outcome":"ok","requestId":"request_example",
               "display":{"title":"Direct search_many"},
               "payloadTruncated":false,"payloadBytes":0,"originalPayloadBytes":0,
               "createdAt":1700000000000}}""",
        )
        assertNull(envelope.event.payload)
        assertNull(envelope.event.display.text)
    }

    @Test
    fun spans_that_cannot_describe_their_line_are_dropped_and_the_line_kept() {
        fun lineOf(spans: String) = (
            OmnesisJson.decodeFromString<PrivacyAuditEventSummary>(
                """{"id":"event-example","taskId":"task-example","answerComparison":{"kind":"diff",
                   "lines":[{"op":"removed","text":"It starts at 10:00.","spans":$spans}]}}""",
            ).answerComparison as PrivacyAnswerComparison.Diff
            ).lines.single()

        // A run whose op this client does not know.
        val unknownOp = lineOf(
            """[{"op":"equal","text":"It starts"},{"op":"moved","text":" at 10:00."}]""",
        )
        assertNull(unknownOp.spans)
        assertEquals("It starts at 10:00.", unknownOp.text)

        // A run belonging to the side this line is not on.
        val wrongSide = lineOf(
            """[{"op":"equal","text":"It starts"},{"op":"added","text":" at 10:00."}]""",
        )
        assertNull(wrongSide.spans)

        // Runs that do not concatenate back to the recorded line.
        val notTheLine = lineOf("""[{"op":"equal","text":"Something else entirely."}]""")
        assertNull(notTheLine.spans)

        val faithful = lineOf(
            """[{"op":"equal","text":"It starts"},{"op":"removed","text":" at 10:00."}]""",
        )
        assertEquals(2, faithful.spans?.size)
    }

}
