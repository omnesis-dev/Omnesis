// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Direct static card mapping: every audited tool renders the portal's rows; unknowns keep a header. */
class DirectAuditCardsTest {

    private fun record(tool: String, args: JsonElement, result: JsonElement?): JsonElement =
        buildJsonObject {
            put("tool", JsonPrimitive(tool))
            put("args", args)
            if (result != null) put("result", result)
            put("outcome", JsonPrimitive("ok"))
        }

    private fun docRef(id: String, sourceId: String = "gmail", title: String): JsonElement =
        buildJsonObject {
            put("documentId", JsonPrimitive(id))
            put("sourceType", JsonPrimitive("email"))
            put("sourceId", JsonPrimitive(sourceId))
            put("title", JsonPrimitive(title))
        }

    @Test
    fun search_batch_projects_one_section_per_child() {
        val content = directCardContent(
            "search_many",
            record(
                "search_many",
                buildJsonObject {
                    put(
                        "queries",
                        buildJsonArray {
                            add(buildJsonObject { put("query", JsonPrimitive("first")) })
                            add(buildJsonObject { put("query", JsonPrimitive("second")) })
                        },
                    )
                },
                buildJsonObject {
                    put("kind", JsonPrimitive("search.batch"))
                    put(
                        "items",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("kind", JsonPrimitive("search.results"))
                                    put("query", JsonPrimitive("first"))
                                    put(
                                        "results",
                                        buildJsonArray { add(docRef("doc_1", title = "First hit")) },
                                    )
                                },
                            )
                            add(
                                buildJsonObject {
                                    put("kind", JsonPrimitive("error"))
                                    put("code", JsonPrimitive("search_failed"))
                                    put("message", JsonPrimitive("Search failed."))
                                },
                            )
                        },
                    )
                },
            ),
        )
        assertEquals("Search", content.label)
        val sections = content.sections ?: throw AssertionError("expected sections")
        assertEquals(2, sections.size)
        assertEquals("first", sections[0].heading)
        assertEquals(1, sections[0].rows.size)
        assertEquals("First hit", sections[0].rows[0].title)
        assertEquals(
            DirectCardDestination.Document(id = "doc_1", sourceId = "gmail", title = "First hit"),
            sections[0].rows[0].destination,
        )
        assertFalse(sections[0].showsEmpty)
        assertEquals("second", sections[1].heading)
        assertEquals(
            DirectCardError("search_failed", "Search failed."),
            sections[1].error,
        )
        assertFalse(sections[1].showsEmpty)
    }

    @Test
    fun search_batch_child_without_hits_reads_no_result() {
        val content = directCardContent(
            "search_many",
            record(
                "search_many",
                buildJsonObject {
                    put(
                        "queries",
                        buildJsonArray {
                            add(buildJsonObject { put("query", JsonPrimitive("nothing")) })
                        },
                    )
                },
                buildJsonObject {
                    put("kind", JsonPrimitive("search.batch"))
                    put(
                        "items",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("kind", JsonPrimitive("search.results"))
                                    put("query", JsonPrimitive("nothing"))
                                    put("results", buildJsonArray { })
                                },
                            )
                        },
                    )
                },
            ),
        )
        assertEquals(1, content.sections?.size)
        assertEquals(emptyList<DirectCardRow>(), content.sections?.single()?.rows)
        assertEquals(true, content.sections?.single()?.showsEmpty)
    }

    @Test
    fun fetch_batch_renders_document_rows() {
        val content = directCardContent(
            "fetch_many",
            record(
                "fetch_many",
                buildJsonObject {
                    put(
                        "documents",
                        buildJsonArray {
                            add(buildJsonObject { put("documentId", JsonPrimitive("doc_1")) })
                        },
                    )
                },
                buildJsonObject {
                    put("kind", JsonPrimitive("document.batch"))
                    put(
                        "items",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("kind", JsonPrimitive("document"))
                                    put("ref", docRef("doc_1", title = "Opened doc"))
                                },
                            )
                        },
                    )
                },
            ),
        )
        val sections = content.sections ?: throw AssertionError("expected sections")
        assertEquals(1, sections.single().rows.size)
        assertEquals("Opened doc", sections.single().rows.single().title)
    }

    @Test
    fun url_lookup_links_http_arg_and_renders_ref() {
        val content = directCardContent(
            "lookup_document_by_url",
            record(
                "lookup_document_by_url",
                buildJsonObject { put("url", JsonPrimitive("https://example.com/plan")) },
                buildJsonObject {
                    put("kind", JsonPrimitive("document.byUrl"))
                    put("url", JsonPrimitive("https://example.com/plan"))
                    put("ref", docRef("doc_1", title = "Plan"))
                },
            ),
        )
        assertEquals("Look up URL", content.label)
        assertEquals("https://example.com/plan", content.arg)
        assertEquals(
            DirectCardDestination.External("https://example.com/plan"),
            content.argLink,
        )
        assertEquals(1, content.rows.size)
        assertFalse(content.showsEmpty)
    }

    @Test
    fun url_lookup_without_match_reads_no_result() {
        val content = directCardContent(
            "lookup_document_by_url",
            record(
                "lookup_document_by_url",
                buildJsonObject { put("url", JsonPrimitive("https://example.com/missing")) },
                buildJsonObject {
                    put("kind", JsonPrimitive("document.byUrl"))
                    put("url", JsonPrimitive("https://example.com/missing"))
                },
            ),
        )
        assertTrue(content.rows.isEmpty())
        assertTrue(content.showsEmpty)
    }

    @Test
    fun non_http_urls_stay_plain_text() {
        assertNull(directExternalDestination("ftp://example.com/plan"))
        assertNull(directExternalDestination("not a url"))
        assertNull(directExternalDestination(""))
        assertEquals(
            DirectCardDestination.External("https://example.com/plan"),
            directExternalDestination("  https://example.com/plan  "),
        )
    }

    @Test
    fun people_results_render_linked_rows() {
        val content = directCardContent(
            "lookup_people",
            record(
                "lookup_people",
                buildJsonObject { put("name", JsonPrimitive("Maya")) },
                buildJsonObject {
                    put("kind", JsonPrimitive("person.results"))
                    put("query", JsonPrimitive("Maya"))
                    put(
                        "results",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("canonicalId", JsonPrimitive("person_1"))
                                    put("displayName", JsonPrimitive("Maya Reeves"))
                                    put(
                                        "aliases",
                                        buildJsonArray { add(JsonPrimitive("maya.reeves@example.com")) },
                                    )
                                },
                            )
                        },
                    )
                },
            ),
        )
        assertEquals("Look up people", content.label)
        assertEquals("Maya", content.arg)
        assertEquals(1, content.rows.size)
        assertEquals("Maya Reeves", content.rows.single().title)
        assertEquals(
            DirectCardDestination.Person("person_1", "Maya Reeves"),
            content.rows.single().destination,
        )
        assertFalse(content.showsEmpty)
    }

    @Test
    fun trail_flattens_and_deduplicates_docs() {
        fun trailDoc(id: String): JsonElement =
            buildJsonObject {
                put("documentId", JsonPrimitive(id))
                put("title", JsonPrimitive("Title $id"))
                put("sourceId", JsonPrimitive("gmail"))
            }
        fun trailEvent(id: String, doc: JsonElement, attachments: JsonElement): JsonElement =
            buildJsonObject {
                put("eventId", JsonPrimitive(id))
                put("kind", JsonPrimitive("document"))
                put("doc", doc)
                put("attachments", attachments)
                put("people", buildJsonArray { })
                put("related", buildJsonArray { })
            }
        val content = directCardContent(
            "trace_connections",
            record(
                "trace_connections",
                buildJsonObject { },
                buildJsonObject {
                    put("kind", JsonPrimitive("event_trail.built"))
                    put("seeds", buildJsonArray { add(JsonPrimitive("doc_1")) })
                    put(
                        "events",
                        buildJsonArray {
                            add(
                                trailEvent(
                                    "ev_1",
                                    trailDoc("doc_1"),
                                    buildJsonArray { add(trailEvent("ev_1a", trailDoc("doc_2"), buildJsonArray { })) },
                                ),
                            )
                            add(trailEvent("ev_2", trailDoc("doc_1"), buildJsonArray { }))
                        },
                    )
                },
            ),
        )
        assertEquals("Trace connections", content.label)
        assertEquals(listOf("Title doc_1", "Title doc_2"), content.rows.map { it.title })
        assertFalse(content.showsEmpty)
    }

    @Test
    fun sql_renders_rowblock() {
        val content = directCardContent(
            "run_sql",
            record(
                "run_sql",
                buildJsonObject { put("sql", JsonPrimitive("SELECT  a\n  FROM t")) },
                buildJsonObject {
                    put("kind", JsonPrimitive("sql.rows"))
                    put("sql", JsonPrimitive("SELECT a FROM t"))
                    put("columns", buildJsonArray { add(JsonPrimitive("a")); add(JsonPrimitive("b")) })
                    put(
                        "rows",
                        buildJsonArray {
                            add(buildJsonArray { add(JsonPrimitive(1)); add(JsonPrimitive("x")); add(JsonPrimitive(true)) })
                            add(buildJsonArray { add(JsonPrimitive(2)) })
                        },
                    )
                    put("rowCount", JsonPrimitive(12))
                },
            ),
        )
        assertEquals("Run SQL", content.label)
        assertEquals("SELECT a FROM t", content.arg)
        val block = content.sql ?: throw AssertionError("expected sql block")
        assertEquals(listOf("a", "b"), block.columns)
        assertEquals(listOf(listOf("1", "x"), listOf("2", "null")), block.rows)
        assertEquals(12, block.totalRows)
        assertFalse(content.showsEmpty)
    }

    @Test
    fun structured_entity_context_groups_rows() {
        val content = directCardContent(
            "entity_context",
            record(
                "entity_context",
                buildJsonObject { },
                buildJsonObject {
                    put("kind", JsonPrimitive("structured"))
                    put("resultType", JsonPrimitive("entity_context.reaped"))
                    put(
                        "data",
                        buildJsonObject {
                            put(
                                "documents",
                                buildJsonArray {
                                    add(
                                        buildJsonObject {
                                            put("documentId", JsonPrimitive("doc_1"))
                                            put("title", JsonPrimitive("A doc"))
                                            put("sourceId", JsonPrimitive("gmail"))
                                        },
                                    )
                                },
                            )
                            put(
                                "people",
                                buildJsonArray {
                                    add(
                                        buildJsonObject {
                                            put("personId", JsonPrimitive("person_1"))
                                            put("name", JsonPrimitive("Maya Reeves"))
                                        },
                                    )
                                },
                            )
                            put(
                                "loops",
                                buildJsonArray {
                                    add(
                                        buildJsonObject {
                                            put("loopId", JsonPrimitive("loop_1"))
                                            put("title", JsonPrimitive("Pay the deposit"))
                                            put("state", JsonPrimitive("open"))
                                        },
                                    )
                                },
                            )
                            put(
                                "temporalAnnotations",
                                buildJsonArray {
                                    add(buildJsonObject { put("sentence", JsonPrimitive("Paid on Friday")) })
                                },
                            )
                        },
                    )
                },
            ),
        )
        assertEquals(4, content.rows.size)
        assertEquals(
            DirectCardDestination.Document(id = "doc_1", sourceId = "gmail", title = "A doc"),
            content.rows[0].destination,
        )
        assertEquals(
            DirectCardDestination.Person("person_1", "Maya Reeves"),
            content.rows[1].destination,
        )
        assertEquals(DirectCardDestination.Loop("loop_1"), content.rows[2].destination)
        assertNull(content.rows[3].destination)
        assertFalse(content.showsEmpty)
    }

    @Test
    fun error_result_uses_error_card_on_any_tool() {
        val content = directCardContent(
            "run_sql",
            record(
                "run_sql",
                buildJsonObject { put("sql", JsonPrimitive("SELECT 1")) },
                buildJsonObject {
                    put("kind", JsonPrimitive("error"))
                    put("code", JsonPrimitive("sql_failed"))
                    put("message", JsonPrimitive("Binder Error."))
                },
            ),
        )
        assertEquals(DirectCardError("sql_failed", "Binder Error."), content.error)
        assertFalse(content.showsEmpty)
    }

    @Test
    fun unknown_tool_keeps_a_generic_header() {
        val content = directCardContent(
            "future_tool",
            record(
                "future_tool",
                buildJsonObject { },
                buildJsonObject { put("kind", JsonPrimitive("future.kind")) },
            ),
        )
        assertEquals("future_tool", content.label)
        assertTrue(content.rows.isEmpty())
        assertNull(content.error)
        assertFalse(content.showsEmpty)
    }

    @Test
    fun missing_result_decodes_as_missing() {
        assertEquals(
            DirectDecodedResult.Missing,
            directDecodeResult(null),
        )
        assertEquals(
            DirectDecodedResult.Missing,
            directDecodeResult(buildJsonObject { put("tool", JsonPrimitive("fetch_many")) }),
        )
    }

    @Test
    fun sql_cells_format_scalars() {
        assertEquals("null", directSqlCell(Json.parseToJsonElement("null")))
        assertEquals("true", directSqlCell(JsonPrimitive(true)))
        assertEquals("42", directSqlCell(JsonPrimitive(42)))
        assertEquals("x", directSqlCell(JsonPrimitive("x")))
    }

    @Test
    fun blank_tool_keeps_an_unknown_tool_header() {
        val content = directCardContent(
            "",
            record("", buildJsonObject { }, buildJsonObject { put("kind", JsonPrimitive("future.kind")) }),
        )
        assertEquals("Unknown tool", content.label)
    }

    @Test
    fun malformed_result_shapes_keep_a_generic_header() {
        val content = directCardContent(
            "search_many",
            record(
                "search_many",
                buildJsonObject { },
                buildJsonObject {
                    put("kind", buildJsonArray { add(JsonPrimitive("search.batch")) })
                },
            ),
        )
        assertEquals("Search", content.label)
        assertNull(content.sections)
        assertFalse(content.showsEmpty)
    }

    @Test
    fun non_primitive_result_type_falls_back_to_a_generic_header() {
        val content = directCardContent(
            "list_loops",
            record(
                "list_loops",
                buildJsonObject { },
                buildJsonObject {
                    put("kind", JsonPrimitive("structured"))
                    put("resultType", buildJsonArray { add(JsonPrimitive("loops.listed")) })
                    put("data", buildJsonObject { })
                },
            ),
        )
        assertEquals("List loops", content.label)
        assertFalse(content.showsEmpty)
    }

    @Test
    fun non_string_arg_fields_read_as_blank() {
        val content = directCardContent(
            "lookup_people",
            record(
                "lookup_people",
                buildJsonObject {
                    put("name", buildJsonObject { put("first", JsonPrimitive("Maya")) })
                },
                buildJsonObject {
                    put("kind", JsonPrimitive("person.results"))
                    put("query", JsonPrimitive("Maya"))
                    put("results", buildJsonArray { })
                },
            ),
        )
        assertEquals("", content.arg)
        assertTrue(content.showsEmpty)
    }

    @Test
    fun structured_entity_context_names_its_entity_in_the_header() {
        val content = directCardContent(
            "entity_context",
            record(
                "entity_context",
                buildJsonObject {
                    put("kind", JsonPrimitive("person"))
                    put("id", JsonPrimitive("person_1"))
                },
                buildJsonObject {
                    put("kind", JsonPrimitive("structured"))
                    put("resultType", JsonPrimitive("entity_context.reaped"))
                    put("data", buildJsonObject { })
                },
            ),
        )
        assertEquals("Entity context", content.label)
        assertEquals("person person_1", content.arg)
    }

    @Test
    fun trace_connections_names_its_seeds_in_the_header() {
        val content = directCardContent(
            "trace_connections",
            record(
                "trace_connections",
                buildJsonObject {
                    put(
                        "seedIds",
                        buildJsonArray {
                            add(JsonPrimitive("doc_1"))
                            add(JsonPrimitive("doc_2"))
                        },
                    )
                },
                buildJsonObject {
                    put("kind", JsonPrimitive("event_trail.built"))
                    put("events", buildJsonArray { })
                },
            ),
        )
        assertEquals("Trace connections", content.label)
        assertEquals("doc_1, doc_2", content.arg)
        assertNull(content.argIcon)
    }

    @Test
    fun trace_seeds_resolve_to_titles_with_source_icon() {
        val record = record(
            "trace_connections",
            buildJsonObject {
                put(
                    "seedIds",
                    buildJsonArray {
                        add(JsonPrimitive("doc_1"))
                        add(JsonPrimitive("doc_9"))
                    },
                )
            },
            buildJsonObject {
                put("kind", JsonPrimitive("event_trail.built"))
                put(
                    "seeds",
                    buildJsonArray {
                        add(JsonPrimitive("doc_1"))
                        add(JsonPrimitive("doc_9"))
                    },
                )
                put(
                    "events",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("eventId", JsonPrimitive("ev_1"))
                                put("kind", JsonPrimitive("document"))
                                put(
                                    "doc",
                                    buildJsonObject {
                                        put("documentId", JsonPrimitive("doc_1"))
                                        put("title", JsonPrimitive("First doc"))
                                        put("sourceId", JsonPrimitive("gmail"))
                                    },
                                )
                            },
                        )
                    },
                )
            },
        )
        val content = directCardContent("trace_connections", record)
        assertEquals("First doc, doc_9", content.arg)
        assertEquals(DirectArgIcon.Document("gmail"), content.argIcon)
    }

    @Test
    fun entity_seed_resolves_to_title_with_source_icon() {
        val data = buildJsonObject {
            put(
                "seed",
                buildJsonObject {
                    put("kind", JsonPrimitive("document"))
                    put("id", JsonPrimitive("doc_1"))
                    put("label", JsonPrimitive("First doc"))
                },
            )
            put(
                "documents",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("documentId", JsonPrimitive("doc_1"))
                            put("sourceId", JsonPrimitive("gmail"))
                            put("title", JsonPrimitive("First doc"))
                        },
                    )
                },
            )
        }
        val display = directEntitySeedDisplay(
            buildJsonObject {
                put("kind", JsonPrimitive("document"))
                put("id", JsonPrimitive("doc_1"))
            },
            data,
        )
        assertEquals(DirectSeedDisplay(DirectArgIcon.Document("gmail"), "First doc"), display)
        val content = directCardContent(
            "entity_context",
            record(
                "entity_context",
                buildJsonObject {
                    put("kind", JsonPrimitive("document"))
                    put("id", JsonPrimitive("doc_1"))
                },
                buildJsonObject {
                    put("kind", JsonPrimitive("structured"))
                    put("resultType", JsonPrimitive("entity_context.reaped"))
                    put("data", data)
                },
                ),
            )
        assertEquals("First doc", content.arg)
        assertEquals(DirectArgIcon.Document("gmail"), content.argIcon)
    }

    @Test
    fun entity_seed_without_data_falls_back_to_kind_and_id() {
        val display = directEntitySeedDisplay(
            buildJsonObject {
                put("kind", JsonPrimitive("loop"))
                put("id", JsonPrimitive("loop_9"))
            },
            buildJsonObject { },
        )
        assertEquals(DirectSeedDisplay(null, "loop loop_9"), display)
    }

    private fun searchBatchRecord(): JsonElement = record(
        "search_many",
        buildJsonObject {
            put(
                "queries",
                buildJsonArray {
                    add(buildJsonObject { put("query", JsonPrimitive("first")) })
                    add(buildJsonObject { put("query", JsonPrimitive("second")) })
                },
            )
        },
        buildJsonObject {
            put("kind", JsonPrimitive("search.batch"))
            put(
                "items",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("kind", JsonPrimitive("search.results"))
                            put("query", JsonPrimitive("first"))
                            put(
                                "results",
                                buildJsonArray { add(docRef("doc_1", title = "First hit")) },
                            )
                        },
                    )
                    add(
                        buildJsonObject {
                            put("kind", JsonPrimitive("error"))
                            put("code", JsonPrimitive("search_failed"))
                            put("message", JsonPrimitive("Search failed."))
                        },
                    )
                },
            )
        },
    )

    @Test
    fun search_batch_splits_into_one_search_card_per_child() {
        val cards = directTranscriptCards("search_many", searchBatchRecord())
        assertEquals(2, cards.size)
        assertEquals("search_documents", cards[0].tool)
        assertEquals("Search", cards[0].content.label)
        assertEquals("first", cards[0].content.arg)
        assertEquals(listOf("First hit"), cards[0].content.rows.map { it.title })
        assertEquals("search_documents", cards[1].tool)
        assertEquals("second", cards[1].content.arg)
        assertEquals(DirectCardError("search_failed", "Search failed."), cards[1].content.error)
    }

    @Test
    fun fetch_batch_splits_into_one_open_document_card_per_child() {
        val cards = directTranscriptCards(
            "fetch_many",
            record(
                "fetch_many",
                buildJsonObject {
                    put(
                        "documents",
                        buildJsonArray {
                            add(buildJsonObject { put("documentId", JsonPrimitive("doc_1")) })
                            add(buildJsonObject { put("documentId", JsonPrimitive("doc_2")) })
                        },
                    )
                },
                buildJsonObject {
                    put("kind", JsonPrimitive("document.batch"))
                    put(
                        "items",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("kind", JsonPrimitive("document"))
                                    put("ref", docRef("doc_1", title = "First doc"))
                                },
                            )
                            add(
                                buildJsonObject {
                                    put("kind", JsonPrimitive("document"))
                                    put("ref", docRef("doc_2", title = ""))
                                },
                            )
                        },
                    )
                },
            ),
        )
        assertEquals(2, cards.size)
        assertEquals(listOf("fetch_document", "fetch_document"), cards.map { it.tool })
        assertEquals(listOf("Open document", "Open document"), cards.map { it.content.label })
        assertEquals(listOf("First doc"), cards[0].content.rows.map { it.title })
        // An untitled document falls back to its requested id, as before.
        assertEquals(listOf("doc_2"), cards[1].content.rows.map { it.title })
    }

    @Test
    fun undecodable_batch_keeps_its_single_header_card() {
        val cards = directTranscriptCards(
            "fetch_many",
            record("fetch_many", buildJsonObject { }, null),
        )
        assertEquals(1, cards.size)
        assertEquals("fetch_many", cards[0].tool)
    }

    @Test
    fun singular_tool_yields_its_own_card() {
        val rec = record(
            "run_sql",
            buildJsonObject { put("sql", JsonPrimitive("select 1")) },
            null,
        )
        val cards = directTranscriptCards("run_sql", rec)
        assertEquals(1, cards.size)
        assertEquals("run_sql", cards[0].tool)
        assertEquals(directCardContent("run_sql", rec), cards[0].content)
    }
}
