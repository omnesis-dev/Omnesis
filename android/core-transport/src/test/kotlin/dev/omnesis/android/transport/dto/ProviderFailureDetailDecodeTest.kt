// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The provider disposition a model failure carries, and the one line it renders as.
 *
 * All fixture data is invented.
 */
class ProviderFailureDetailDecodeTest {

    @Test
    fun full_disposition_renders_every_field_in_order() {
        val line = AgentProviderFailureDetail(
            status = 404,
            type = "invalid_request_error",
            code = "NOT_FOUND",
            param = "model",
            requestId = "req_00000000",
        ).formatLine()
        assertEquals("HTTP 404 · NOT_FOUND · param=model · request req_00000000", line)
    }

    @Test
    fun the_error_type_stands_in_when_the_provider_reported_no_code() {
        val line = AgentProviderFailureDetail(status = 429, type = "rate_limit_error").formatLine()
        assertEquals("HTTP 429 · rate_limit_error", line)
    }

    @Test
    fun absent_and_blank_fields_drop_out_of_the_line() {
        val line = AgentProviderFailureDetail(status = 500, code = "", type = "  ", param = "prompt").formatLine()
        assertEquals("HTTP 500 · param=prompt", line)
    }

    @Test
    fun a_disposition_carrying_nothing_renders_no_line() {
        assertNull(AgentProviderFailureDetail().formatLine())
        assertNull(AgentProviderFailureDetail(code = "", requestId = "").formatLine())
    }

    @Test
    fun error_event_decodes_the_provider_disposition() {
        val event = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.error","payload":{"sessionId":"s1","messageId":"m1",""" +
                """"code":"http_api_error","message":"The model provider does not have the assigned model.",""" +
                """"provider":{"status":404,"type":"invalid_request_error","code":"NOT_FOUND","param":"model"}}}""",
        ) as AgentEvent.ErrorEvent
        assertEquals("http_api_error", event.code)
        assertEquals("HTTP 404 · NOT_FOUND · param=model", event.provider?.formatLine())
    }

    @Test
    fun error_event_without_a_provider_still_decodes() {
        // An older gateway omits the object entirely; the humanized sentence must survive.
        val event = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.error","payload":{"sessionId":"s1","code":"agent_failed","message":"The run stopped."}}""",
        ) as AgentEvent.ErrorEvent
        assertEquals("agent_failed", event.code)
        assertNull(event.provider)
    }

    @Test
    fun message_end_failure_carries_the_provider_disposition() {
        val event = OmnesisJson.decodeFromString<AgentEvent>(
            """{"type":"agent.message.end","payload":{"sessionId":"s1","messageId":"m1","stopReason":"error",""" +
                """"failure":{"code":"http_api_error","message":"The model provider rejected the request.",""" +
                """"backend":"openai-compatible","model":"fictional-model",""" +
                """"provider":{"status":400,"code":"BAD_REQUEST","param":"messages"}}}}""",
        ) as AgentEvent.MessageEnd
        assertEquals("http_api_error", event.failure?.code)
        assertEquals("HTTP 400 · BAD_REQUEST · param=messages", event.failure?.provider?.formatLine())
    }

    @Test
    fun session_failures_decode_with_and_without_a_provider() {
        val withProvider = OmnesisJson.decodeFromString<CreateSessionResponse>(
            """{"sessionId":"s1","lastTurnFailure":{"code":"http_api_error","message":"The provider refused.",""" +
                """"provider":{"status":404,"code":"NOT_FOUND"}},""" +
                """"terminalFailure":{"code":"context_window_exceeded","message":"This conversation no longer fits."}}""",
        )
        assertEquals("HTTP 404 · NOT_FOUND", withProvider.lastTurnFailure?.provider?.formatLine())
        assertNull(withProvider.terminalFailure?.provider)
    }

    @Test
    fun privacy_exchange_failure_decodes_with_and_without_a_detail() {
        val withDetail = OmnesisJson.decodeFromString<PrivacyExchangeFailure>(
            """{"code":"http_api_error","message":"The model provider does not have the assigned model.",""" +
                """"stage":"answer","detail":"HTTP 404 · NOT_FOUND · param=model"}""",
        )
        assertEquals("HTTP 404 · NOT_FOUND · param=model", withDetail.detail)

        val withoutDetail = OmnesisJson.decodeFromString<PrivacyExchangeFailure>(
            """{"code":"answer_failed","message":"Omnesis could not produce an answer.","stage":"answer"}""",
        )
        assertNull(withoutDetail.detail)
        assertEquals("answer_failed", withoutDetail.code)
    }
}
