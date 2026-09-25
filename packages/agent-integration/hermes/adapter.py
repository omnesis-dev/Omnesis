# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Hermes gateway-mode adapter for the Omnesis agent integration.

The adapter has two independent durable loops:

* it copies ordinary Hermes conversations to ``POST /agent-messages``; and
* it accepts identifier-only subscription deliveries over the device socket.

Subscription work runs in a synthetic per-workflow chat. Replies from that
chat are retained in Hermes' transcript but are never routed to a human chat.
"""

from __future__ import annotations

import asyncio
import hashlib
import http.client
import ipaddress
import json
import logging
import math
import os
import re
import signal
import socket
import sqlite3
import ssl
import threading
import time
import unicodedata
import urllib.parse
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1


def _read_adapter_version() -> str | None:
    """The product version of this adapter, from the manifest beside it.

    The gateway's version ledger reads what each device reports in its hello
    and says so on the devices page; a device that reports nothing is shown as
    unknown, which is honest but useless. The TypeScript integration reads its
    own package manifest for this. The adapter's equivalent is `plugin.yaml`,
    which the release tooling keeps at the product version.

    One line is parsed rather than a YAML document, because the adapter
    deliberately depends on nothing outside the standard library and a
    dependency for a single scalar would be a poor trade. An unreadable or
    unrecognisable manifest yields None: reporting nothing is what the ledger
    already handles, and inventing a version would be worse than admitting
    ignorance.
    """
    try:
        manifest = Path(__file__).resolve().parent / "plugin.yaml"
        for line in manifest.read_text(encoding="utf-8").splitlines():
            match = re.match(r"""^version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+[^"'\s]*)["']?\s*$""", line)
            if match:
                return match.group(1)
    except OSError:
        pass
    return None


ADAPTER_VERSION = _read_adapter_version()
_SOURCE_COMMIT = re.compile(r"^[0-9a-f]{40}$", re.ASCII)


def _read_adapter_source_commit() -> str | None:
    """Exact clean source checkout stamped into this installed plugin."""
    try:
        manifest = Path(__file__).resolve().parent / "plugin.yaml"
        for line in manifest.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^source_commit:\s*([0-9a-f]{40})\s*$", line, re.ASCII)
            if match:
                return match.group(1)
    except OSError:
        pass
    return None


ADAPTER_SOURCE_COMMIT = _read_adapter_source_commit()
# The wake versions this adapter understands, advertised as a range.
#
# A gateway and the plugins that connect to it are deployed separately, so the
# pair is routinely mismatched. The gateway builds each wake at the highest
# version both ends know: pinning one number here would make every contract
# change an outage for whichever side upgrades second.
DELIVERY_PROTOCOL_MIN_VERSION = 3
DELIVERY_PROTOCOL_VERSION = 4
MCP_PROTOCOL_VERSION = "2026-07-28"
MCP_ANSWER_ENDPOINT = "/mcp"
MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion"
MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities"
MCP_NATIVE_CONVERSATION_META_KEY = "dev.omnesis/nativeConversationId"
MCP_ANSWER_ERROR_META_KEY = "dev.omnesis/error"
PAGE_SIZE = 500
MAX_FRAME_BYTES = 1024 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SWEEP_SECONDS = 20.0
# Budget for the integration handshake, matching the budget for opening the
# socket it runs over. It bounds the whole handshake rather than each read,
# because what the handshake waits through is the gateway's own traffic and
# there is no useful bound on how many frames the answer may sit behind. A
# gateway that never answers therefore reconnects rather than hanging.
_HELLO_HANDSHAKE_TIMEOUT_SECONDS = 15.0

# Socket budget for an ordinary gateway call — a read, or a write the gateway
# settles in one transaction. Calls that run an agent turn behind the request
# are far slower than this and state their own budget instead.
GATEWAY_TIMEOUT_SECONDS = 20.0
_OAUTH_REFRESH_LOCK_WAIT_SECONDS = 0.025
_OAUTH_REFRESH_LOCK_TIMEOUT_SECONDS = 30.0
_OAUTH_REFRESH_LOCK_STALE_SECONDS = 120.0
_OAUTH_REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
_OAUTH_REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000
_OAUTH_KEEPALIVE_INTERVAL_SECONDS = 6 * 60 * 60.0
_CAPABILITY_PROBE_TIMEOUT_SECONDS = 3.0


def _process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _remove_stale_refresh_lock(path: Path) -> None:
    """Remove only the stale directory entry inspected by this process."""
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        return
    try:
        inspected = os.fstat(descriptor)
        if time.time() - inspected.st_mtime <= _OAUTH_REFRESH_LOCK_STALE_SECONDS:
            return
        try:
            body = os.read(descriptor, 64).decode("ascii").strip()
            owner_pid = int(body)
        except (UnicodeDecodeError, ValueError):
            owner_pid = 0
        if owner_pid > 0 and _process_is_alive(owner_pid):
            return
        try:
            current = os.stat(path)
        except FileNotFoundError:
            return
        if (inspected.st_dev, inspected.st_ino) == (current.st_dev, current.st_ino):
            path.unlink()
    finally:
        os.close(descriptor)


def _release_owned_refresh_lock(path: Path, descriptor: int) -> None:
    """Release an exclusive-create lease without deleting a successor's lease."""
    try:
        owned = os.fstat(descriptor)
        try:
            current = os.stat(path)
        except FileNotFoundError:
            return
        if (owned.st_dev, owned.st_ino) == (current.st_dev, current.st_ino):
            path.unlink()
    finally:
        os.close(descriptor)


def _acquire_refresh_lock(path: Path) -> int:
    """Acquire the existence-based lease shared with the TypeScript plugin."""
    deadline = time.monotonic() + _OAUTH_REFRESH_LOCK_TIMEOUT_SECONDS
    while True:
        try:
            descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
            os.fsync(descriptor)
            return descriptor
        except FileExistsError as error:
            _remove_stale_refresh_lock(path)
            if time.monotonic() >= deadline:
                raise McpProtocolError(
                    "Timed out waiting for another Omnesis OAuth refresh process"
                ) from error
            time.sleep(_OAUTH_REFRESH_LOCK_WAIT_SECONDS)


def _write_credentials(path: Path, raw: Dict[str, Any]) -> None:
    """Atomically replace a credential document without weakening its mode."""
    temporary = path.with_name(f".integration-{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(raw, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


# Socket budget for subscription management.
#
# Creating a subscription runs a full agentic compile behind the request — the
# model reads the install's ontology, searches the corpus, drafts, validates and
# repairs — so it is measured in minutes. Under the ordinary read budget every
# create times out client-side while the gateway goes on to succeed, and what
# the agent sees is a feature that always fails rather than a watch it now owns.
#
# Declared once in `packages/types/src/subscriptions.ts`
# (`SUBSCRIPTION_MANAGEMENT_TIMEOUT_MS`) because more runtimes have to agree on
# it than can import the gateway. Python cannot import the declaration, so the
# agreement is enforced instead — `management-latency.test.ts` reads this
# constant and reddens if it drifts.
SUBSCRIPTION_MANAGEMENT_TIMEOUT_SECONDS = 300.0
# Asking Omnesis a question runs a full agent turn behind the privacy
# boundary — a corpus search plus several model round-trips, then a privacy
# review — so it is the one gateway call whose cost is measured in tens of
# seconds rather than milliseconds. The first attempt is wide enough that the
# answer normally arrives on it, so the common case makes one round trip.
# Every ask uses this budget: a firing answer and an ordinary question cost
# the same work, so they wait the same way.
ANSWER_SUBMIT_TIMEOUT_SECONDS = 180.0
# Budget for a poll. A poll either returns the finished answer or refuses fast.
ANSWER_POLL_TIMEOUT_SECONDS = 30.0
# Ceiling on the whole ask, across the first attempt and every poll after it.
ANSWER_DEADLINE_SECONDS = 420.0
# How many times one blip may be re-attempted before it settles the ask, and
# how long to pause between those attempts.
_TRANSIENT_RETRY_LIMIT = 2
_TRANSIENT_RETRY_DELAY_SECONDS = 2.0
_ANSWER_POLL_MIN_SECONDS = 2.0
_ANSWER_POLL_MAX_SECONDS = 15.0
# Gateway code for "the turn for this request id is still running".
_ANSWER_IN_PROGRESS = "ANSWER_IN_PROGRESS"
# Gateway code for "the turn limit is full right now". Distinct from a
# gateway that is not serving, which is also a 503 and wants the opposite
# response: this one means the work is about to be possible, so waiting is
# the useful thing to do.
_ANSWER_CAPACITY = "ANSWER_CAPACITY"
# The gateway's error codes are a fixed vocabulary of SCREAMING_SNAKE
# identifiers; anything else in that field is discarded rather than kept.
_GATEWAY_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_ANSWER_MCP_ERROR_STATUSES = {400, 401, 403, 404, 409, 429, 500, 502, 503, 504}
_ANSWER_MCP_ERROR_CODES = {
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "CONTEXT_WINDOW_EXCEEDED",
    "ANSWER_IN_PROGRESS",
    "ANSWER_CAPACITY",
    "ANSWER_EGRESS_LIMIT",
    "INVALID_NATIVE_ANSWER_ROUTE",
    "BAD_GATEWAY",
    "SERVICE_UNAVAILABLE",
    "GATEWAY_TIMEOUT",
    "INTERNAL_ERROR",
}

_END_OF_THREAD = "[End of thread context]"
_DELIVERY_KEYS = {
    "protocolVersion",
    "deliveryId",
    "firingId",
    "subscriptionId",
    "workflowHandle",
    "reaction",
    "answer",
}
# The wake version that introduced reaction bindings and the second short-lived
# authority a run reports its outcome through.
#
# Named in its own right rather than tracked against `DELIVERY_PROTOCOL_VERSION`.
# That constant means "the newest wake this plugin speaks", so a wake carrying
# these fields is recognised by the version that added them, not by whether it
# happens to be the newest — otherwise the day a version 5 exists, every
# perfectly good version 4 wake is checked against the version 3 field set and
# rejected, which is the deploy-skew outage the version range exists to prevent.
_OUTCOME_AND_BINDINGS_VERSION = 4
_DELIVERY_KEYS_V4 = _DELIVERY_KEYS | {"outcome"}
_ANSWER_KEYS = {"token", "expiresAt", "endpoint"}
# Mirrors the `reactionBindings` record in the TypeScript contract.
_MAX_BINDINGS = 32
_MAX_BINDING_KEY = 64
_MAX_BINDING_VALUE = 512
# Ceiling on the workflow report a run posts back, matching the gateway's
# `workflowOutcomeReportSchema` — UTF-16 code units, the unit Zod counts in.
_MAX_OUTCOME_REPORT = 8192
# Ceiling the gateway puts on the whole outcome request body, in bytes on the
# wire. Independent of the field limit above and reached first by any report
# that is not mostly ASCII: the body is serialised with non-ASCII escaped, so
# one code unit outside ASCII costs six bytes.
_MAX_OUTCOME_BODY_BYTES = 16 * 1024
# How many times a run may re-post its outcome before giving up on it.
#
# A report that never lands is not a silent no-op: a firing with no report
# reads as a run that did nothing, so one refused socket turns work that was
# done into a wrong account of it. Bounded and quick, because `send` runs on a
# thread the harness is waiting on and a stopping plugin must not be held open
# by an unreachable gateway.
_OUTCOME_POST_ATTEMPTS = 3
_OUTCOME_RETRY_DELAY_SECONDS = 2.0
# What Hermes' verdict on a finished run means as a workflow outcome.
#
# Keyed by the enum's value rather than the enum, so a host whose lifecycle
# hook predates a member — or does not have the enum at all — degrades to the
# default rather than raising inside a hook whose failures are swallowed.
#
# A cancelled run is `failed` because the vocabulary has no third thing and
# `failed` is what the contract means by it: the run ended without finishing
# and nothing will resume it. Hermes cancels a run when a newer message takes
# the session over or the adapter is shutting down, and in both cases the work
# this firing asked for stopped where it was. The one continuation that does
# exist — a held answer re-entering the run — is a `deferred` this reads off
# the authority instead, before the verdict is consulted at all.
_PROCESSING_OUTCOME_STATUS = {
    "success": "completed",
    "failure": "failed",
    "cancelled": "failed",
}
# The status for a run whose end was never announced. Reported by the backstop
# below, which sees that a run is over without learning how it went.
_UNOBSERVED_OUTCOME_STATUS = "completed"
# How many firings one session may have accounts open for at once.
#
# A memory bound rather than a semantic one. Each firing's account is filed as
# that firing speaks, so dropping the oldest loses only the ability to amend
# it later; the authority behind it expires on its own. Generous enough that
# reaching it means a session whose accounts nothing ever closed, which is a
# harness that stopped announcing rather than a watch firing quickly.
_MAX_OPEN_FIRINGS_PER_SESSION = 16
_ANSWER_COMPLETION_KEYS = {
    "protocolVersion",
    "deliveryId",
    "taskId",
    "nativeConversationId",
}
_HELLO_RESULT_KEYS = {
    "deviceId",
    "scopes",
    "deviceName",
    "deviceKind",
    "protocolVersion",
}
_HANDLE_CHARS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
)
_SUBSCRIPTION_CONDITION_UNSUPPORTED = "SUBSCRIPTION_CONDITION_UNSUPPORTED"
# Why a request to watch something was declined.
#
# The keys are the gateway's closed refusal vocabulary, declared in
# `packages/types/src/subscriptions.ts` (`REFUSAL_CODES`) because four runtimes
# have to agree on it and only one of them can import the compiler. The
# sentences are this adapter's own: a refusal's free text is the compiler's own
# words about a corpus it just read, so it never crosses to an agent, and each
# runtime writes for its own reader.
#
# Python cannot import the declaration, so the agreement is enforced instead —
# `refusal-vocabulary.test.ts` reads this dict and reddens if the key set drifts
# from the source. A code minted there and missing here degrades to an
# unexplained 422, which is how an agent comes to retry a settled decision
# forever.
_SUBSCRIPTION_UNSUPPORTED_MESSAGES = {
    "unsupported_condition": (
        "The requested subscription condition is not currently supported."
    ),
    "not_a_condition": (
        "The request does not describe something that happens, so nothing "
        "can watch for it."
    ),
    "ambiguous_request": (
        "The request has more than one reasonable reading."
    ),
    "compiler_failed": (
        "The gateway could not compile the request into a watch. Asking "
        "again may work."
    ),
}
class ConfigurationError(ValueError):
    pass


class DeliveryConflictError(ValueError):
    pass


class AmbiguousDeliveryError(RuntimeError):
    pass


class DeliveryNotPreparedError(RuntimeError):
    pass


class DeliveryCancelledError(RuntimeError):
    pass


class DeliveryAuthorityExpiredError(RuntimeError):
    pass


class WorkflowBindingConflictError(RuntimeError):
    pass


class AnswerPendingError(RuntimeError):
    """The deadline elapsed with the answer turn still running.

    The work is not lost: it keeps running, and asking the same question again
    returns its result rather than starting a second turn.
    """

    def __init__(self, waited_seconds: float):
        super().__init__(
            "NOT AN ANSWER, AND NOT A FAILURE — DO NOT REPORT THIS TO THE USER. "
            f"Omnesis is still preparing the answer after {waited_seconds:.0f}s and the "
            "work is still running. Call this tool again now with the identical question. "
            "The repeat attaches to the answer already being prepared rather than starting "
            "new work, so it costs nothing and one of those repeats returns the answer. "
            "Keep calling until you get one; telling the user the answer is still being "
            "prepared is never the right next step."
        )
        self.waited_seconds = waited_seconds


class GatewayHttpError(ConnectionError):
    def __init__(
        self,
        status: int,
        gateway_error: Optional[Dict[str, Any]] = None,
        code: Optional[str] = None,
    ):
        super().__init__(f"Omnesis request returned HTTP {status}")
        self.status = status
        self.gateway_error = (
            _subscription_unsupported_error(gateway_error)
            if status == 422
            else None
        )
        # The gateway's machine-readable error code, when the response carried
        # one. Only the code is kept — never the message or detail — so a
        # rejection can be classified (still running, fatal) without an
        # arbitrary response body crossing into an external agent's runtime.
        self.code = code


class McpProtocolError(ConnectionError):
    """The stateless MCP peer returned a malformed or failed exchange."""


def _subscription_unsupported_error(
    value: Any,
) -> Optional[Dict[str, Any]]:
    if (
        not isinstance(value, dict)
        or value.get("code") != _SUBSCRIPTION_CONDITION_UNSUPPORTED
    ):
        return None
    details = value.get("details")
    if not isinstance(details, dict):
        details = value.get("detail")
    reason = details.get("reason") if isinstance(details, dict) else None
    if (
        not isinstance(reason, str)
        or reason not in _SUBSCRIPTION_UNSUPPORTED_MESSAGES
    ):
        return None
    return {
        "error": _SUBSCRIPTION_UNSUPPORTED_MESSAGES[reason],
        "code": _SUBSCRIPTION_CONDITION_UNSUPPORTED,
        "details": {"reason": reason},
    }


def _gateway_error_code(value: Any) -> Optional[str]:
    if not isinstance(value, dict):
        return None
    code = value.get("code")
    if not isinstance(code, str) or not _GATEWAY_ERROR_CODE.match(code):
        return None
    return code


def _gateway_http_error(status: int, response_body: bytes) -> GatewayHttpError:
    # Never forward an arbitrary error response body. Two things are lifted
    # out of it: the machine-readable code, which lets a caller tell "still
    # working" apart from a rejection, and the subscription compiler's typed
    # 422, which is the one rejection an external agent can act on.
    if len(response_body) > 4096:
        return GatewayHttpError(status)
    try:
        value = json.loads(response_body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return GatewayHttpError(status)
    return GatewayHttpError(status, value, _gateway_error_code(value))


def _answer_failure_payload(error: GatewayHttpError) -> Dict[str, Any]:
    """Turn authorization refusals into local, actionable, non-secret guidance."""
    if error.status == 401:
        return {
            "error": "Omnesis corpus authorization needs repair",
            "code": "authorization_required",
            "repair": "Run `omnesis connect hermes --refresh` on this machine.",
        }
    if error.status == 403:
        return {
            "error": "The Omnesis connection's access level does not allow this request",
            "code": "grant_forbidden",
            "repair": "Review the access level this Hermes connection uses in Omnesis Settings → Access.",
        }
    return {
        "error": "Omnesis answer request failed",
        "status": error.status,
        **({"code": error.code} if error.code else {}),
    }


def _decode_http_json(body: bytes, content_type: str) -> Any:
    """Decode a JSON response or the last JSON value in an MCP SSE response."""
    if content_type.split(";", 1)[0].strip().lower() != "text/event-stream":
        return json.loads(body)
    text = body.decode("utf-8")
    decoded: Any = None
    found = False
    for event in re.split(r"\r?\n\r?\n", text):
        data = []
        for line in event.splitlines():
            if line == "data":
                data.append("")
            elif line.startswith("data:"):
                value = line[5:]
                data.append(value[1:] if value.startswith(" ") else value)
        if not data:
            continue
        decoded = json.loads("\n".join(data))
        found = True
    if not found:
        raise McpProtocolError("Omnesis returned an empty MCP event stream")
    return decoded


def _firing_answer_request_id(endpoint: str, question: str) -> str:
    """Idempotency key for one ask — derived, never invented.

    A current gateway derives this identity itself and ignores whatever key it
    is sent, which is what makes the no-second-turn guarantee hold for every
    client rather than only well-behaved ones. Sending a derived key anyway
    costs nothing and carries the same guarantee against a gateway that
    predates that behavior — agent hosts run their own upgrade cycle, so the
    two sides of this conversation are routinely on different versions.
    """
    digest = hashlib.sha256(
        json.dumps(
            [endpoint, question, None],
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    return f"firing_{digest[:48]}"


def _ordinary_answer_request_id(
    native_session_id: str,
    question: str,
    conversation_id: Optional[str],
    ask_id: Optional[str] = None,
    workflow_id: Optional[str] = None,
) -> str:
    """Idempotency key for an ordinary answer bound to a Hermes session.

    `ask_id` is what makes one ask distinct within its session. A scheduled
    run leaves it unset, so every ask it makes for one question is the same
    ask and a repeat attaches to the turn already running. A conversation
    stamps each call, because a person who asks the same question again an
    hour later wants today's answer — a session lasts as long as they keep
    talking, so keying on it alone would serve the first answer for its life.
    """
    digest = hashlib.sha256(
        json.dumps(
            [native_session_id, ask_id, question, conversation_id, workflow_id],
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    return f"hermes-answer_{digest[:48]}"


def _worth_another_attempt(error: BaseException) -> bool:
    """A rejection worth one more attempt rather than one that settles the ask.

    A healthy gateway occasionally rejects a single attempt in a way the ask
    cannot explain — a 404 on a route serving requests either side of it, or a
    server-side error — and asking again immediately has succeeded every time
    it has been observed. Unretried, one such blip ends a scheduled report for
    the day. Retries are few and quick, so a rejection that really is settled
    still reaches the caller in seconds.
    """
    return isinstance(error, GatewayHttpError) and (
        error.status == 404 or error.status >= 500
    )


def _outcome_worth_retrying(error: BaseException) -> bool:
    """A failed outcome post another attempt could still land.

    A 4xx other than a lost route or a rate limit is the gateway refusing this
    report — an expired authority, a body it will not accept — and posting the
    same thing again changes nothing. A broken socket, a timeout or a server
    error is the kind of failure that clears on its own.
    """
    if isinstance(error, GatewayHttpError):
        return error.status in {404, 408, 429} or error.status >= 500
    return isinstance(error, (ConnectionError, TimeoutError, OSError))


def _encode_json(value: Dict[str, Any]) -> bytes:
    """Serialise exactly as a gateway request body is serialised."""
    return json.dumps(value, separators=(",", ":")).encode()


def _truncate_utf16(value: str, limit: int) -> str:
    """The longest prefix of `value` within `limit` UTF-16 code units.

    Cut on a code point, never inside one: a character outside the basic plane
    is two code units, and half of it is a lone surrogate rather than a
    shorter string.
    """
    if _utf16_length(value) <= limit:
        return value
    units = 0
    for index, character in enumerate(value):
        width = _utf16_length(character)
        if units + width > limit:
            return value[:index]
        units += width
    return value


def _outcome_body(status: str, report: str) -> Dict[str, Any]:
    """The outcome body a run posts, trimmed to what the gateway accepts.

    Two independent ceilings apply, and breaching either loses the report
    entirely rather than shortening it: the field is validated in UTF-16 code
    units, and the request is capped in bytes on the wire, where every
    non-ASCII code unit is escaped to six ASCII bytes. So the report is cut to
    the longest prefix that satisfies both, and the status — the part the
    gateway acts on — always goes.
    """
    body: Dict[str, Any] = {"status": status}
    if not report:
        return body
    candidate = _truncate_utf16(report, _MAX_OUTCOME_REPORT)
    low, high = 0, len(candidate)
    while low < high:
        middle = (low + high + 1) // 2
        probe = {**body, "report": candidate[:middle]}
        if len(_encode_json(probe)) <= _MAX_OUTCOME_BODY_BYTES:
            low = middle
        else:
            high = middle - 1
    if low:
        body["report"] = candidate[:low]
    return body


def _answer_still_running(error: BaseException) -> bool:
    """True when the gateway is still working on this exact ask.

    Both shapes mean the same thing — the turn is running — and both are
    resolved by asking again, because the derived request id attaches the
    repeat to that same turn.
    """
    if isinstance(error, (socket.timeout, TimeoutError)):
        return True
    if not isinstance(error, GatewayHttpError):
        return False
    if error.status == 409 and error.code == _ANSWER_IN_PROGRESS:
        return True
    # At capacity is a "not yet", not a "no". The gateway is telling us a
    # turn will be available shortly, and the whole wait budget exists for
    # exactly this. Treating it as a settled failure ended a scheduled
    # report while minutes of its budget were still unspent.
    return error.status in (429, 503) and error.code == _ANSWER_CAPACITY


def _describe_answer_outcome(response: Any) -> Optional[str]:
    """What a non-released outcome means, in words an agent can relay.

    A held or denied answer is a decision the privacy boundary made, not a
    fault — an agent that reports it as a failure tells the user their watch is
    broken when in fact it is waiting on them.
    """
    if not isinstance(response, dict):
        return None
    status = response.get("status")
    if status == "approval_required":
        return (
            "Omnesis is holding this answer for the user's approval and has "
            "already asked them for it in the Omnesis app. This is not a "
            "failure and asking again will not release it. You have NOT been "
            "told what Omnesis found, so do not state or imply that you know "
            "it — anything you say about the cause would be your own guess "
            "from the wake, not Omnesis's answer. Say only that the detail is "
            "waiting on their approval, and that it will reach you once they "
            "give it."
        )
    if status == "denied":
        # A run that asked for a settled outcome gets this instead of a hold.
        # It is the privacy boundary working, so the surrounding work should
        # still finish rather than report the run as broken.
        if response.get("reason") == "approval_not_available":
            return (
                "Omnesis could not include this without an interactive "
                "approval, and this run has nobody present to give one. "
                "Complete the rest of the work and say only that one part "
                "could not be included without the user's approval."
            )
        return (
            "Omnesis withheld this answer under the user's privacy policy. "
            "This is a settled decision, not a failure: do not ask again or "
            "try to work around it. Complete the rest of the work and tell "
            "the user Omnesis kept that detail private."
        )
    if status == "released_with_reductions":
        return (
            "Omnesis released this answer with some detail removed under the "
            "user's privacy policy."
        )
    return None


def _format_answer_completion(answer: Dict[str, Any]) -> str:
    status = answer.get("status")
    if status in {"released", "released_with_reductions"}:
        text = answer.get("answer")
        if isinstance(text, str) and text:
            return text
    elif status == "denied":
        reason = answer.get("reason")
        if reason == "expired":
            return "The Omnesis approval expired before an answer could be released."
        if reason == "user_denied":
            return "The Omnesis approval was declined, so no answer was released."
        if reason == "canceled":
            return "The Omnesis request was cancelled before an answer could be released."
        return "Omnesis kept that answer private, so no answer was released."
    raise ValueError("Omnesis returned a non-terminal completion answer")


_ANSWER_BASE_KEYS = {"workflowId", "conversationId", "taskId", "status"}
_ANSWER_DENIAL_REASONS = {
    "privacy_policy",
    "hard_stop",
    "user_denied",
    "expired",
    "canceled",
    "approval_not_available",
}


def _validate_answer_response(value: Any) -> Dict[str, Any]:
    """Accept only the public Answer union; unknown fields fail closed."""
    if not isinstance(value, dict):
        raise McpProtocolError("Omnesis MCP result has no structured answer")
    status = value.get("status")
    expected = set(_ANSWER_BASE_KEYS)
    if status == "released":
        expected.update({"releaseId", "answer"})
    elif status == "released_with_reductions":
        expected.update({"releaseId", "answer", "reductions"})
    elif status == "approval_required":
        expected.update({"approvalId", "approvalExpiresAt"})
    elif status == "denied":
        expected.add("reason")
    else:
        raise McpProtocolError("Omnesis returned an invalid Answer status")
    if set(value) != expected:
        raise McpProtocolError("Omnesis returned unexpected Answer fields")
    if any(not isinstance(value.get(key), str) for key in _ANSWER_BASE_KEYS - {"status"}):
        raise McpProtocolError("Omnesis returned invalid Answer identifiers")
    if status in {"released", "released_with_reductions"}:
        if not isinstance(value.get("releaseId"), str) or not isinstance(value.get("answer"), str):
            raise McpProtocolError("Omnesis returned an invalid released Answer")
    if status == "released_with_reductions" and (
        not isinstance(value.get("reductions"), list)
        or not all(isinstance(item, str) for item in value["reductions"])
    ):
        raise McpProtocolError("Omnesis returned invalid Answer reductions")
    if status == "approval_required" and (
        not isinstance(value.get("approvalId"), str)
        or not isinstance(value.get("approvalExpiresAt"), (int, float))
        or isinstance(value.get("approvalExpiresAt"), bool)
        or not math.isfinite(value["approvalExpiresAt"])
        or value["approvalExpiresAt"] <= 0
    ):
        raise McpProtocolError("Omnesis returned an invalid Answer approval")
    if status == "denied" and value.get("reason") not in _ANSWER_DENIAL_REASONS:
        raise McpProtocolError("Omnesis returned an invalid Answer denial")
    return value


@dataclass(frozen=True)
class Credentials:
    gateway_url: str
    delivery_token: str
    ingestion_token: str
    management_token: Optional[str]
    oauth_client_id: Optional[str]
    oauth_access_token: Optional[str]
    oauth_refresh_token: Optional[str]
    ca_pem: Optional[str]
    leaf_fingerprint_sha256: Optional[str]


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))


def _credentials_path(config: Optional[PlatformConfig] = None) -> Path:
    del config
    return _hermes_home() / "omnesis" / "integration.json"


def _is_loopback(host: Optional[str]) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        # Never trust a DNS answer for plaintext credentials: a hostname that
        # resolves to loopback now can be rebound to a remote address later.
        return False


def _normalized_url_origin(
    parsed: urllib.parse.ParseResult,
) -> Optional[tuple[str, str, int]]:
    """Normalize an HTTP origin before choosing paired TLS trust or WebPKI."""
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    return (
        parsed.scheme.lower(),
        parsed.hostname.lower(),
        port or (443 if parsed.scheme.lower() == "https" else 80),
    )


def _normalize_fingerprint(value: str) -> str:
    normalized = value.replace(":", "").strip().lower()
    if len(normalized) != 64 or any(c not in "0123456789abcdef" for c in normalized):
        raise ConfigurationError("TLS leaf fingerprint must be a SHA-256 hex digest")
    return normalized


def _load_credentials(path: Path) -> Credentials:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ConfigurationError("credential file must contain an object")
    # Unknown top-level keys are tolerated on purpose. `omnesis connect` writes
    # this file and then installs the plugin that reads it, so during an
    # upgrade — and durably, if anything later in the ceremony fails — a newer
    # CLI's file can sit in front of an older adapter. Refusing it there takes
    # the whole integration down over a field this version does not need. Every
    # field it does need is still validated below.
    required = ("gatewayUrl", "deliveryToken", "ingestionToken")
    if any(not isinstance(raw.get(key), str) or not raw[key] for key in required):
        raise ConfigurationError("credential file is missing a required string")
    parsed = urllib.parse.urlparse(raw["gatewayUrl"])
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConfigurationError("gatewayUrl must be an HTTP(S) URL")
    if parsed.scheme == "http" and not _is_loopback(parsed.hostname):
        raise ConfigurationError("remote integrations require HTTPS")
    ca_pem = None
    fingerprint = None
    tls = raw.get("tls")
    if parsed.scheme == "https":
        if not isinstance(tls, dict) or set(tls) != {
            "caPem",
            "leafFingerprintSha256",
        }:
            raise ConfigurationError("HTTPS requires exact CA and leaf-pin trust material")
        if not isinstance(tls["caPem"], str) or not tls["caPem"]:
            raise ConfigurationError("caPem must be non-empty")
        if not isinstance(tls["leafFingerprintSha256"], str):
            raise ConfigurationError("leafFingerprintSha256 must be a string")
        ca_pem = tls["caPem"]
        fingerprint = _normalize_fingerprint(tls["leafFingerprintSha256"])
    management_token = raw.get("managementToken")
    oauth = raw.get("oauth")
    if management_token is None and oauth is None:
        # Pre-access-grants installations still have valid, deliberately
        # narrow authorities for transcript ingestion and wake delivery. Keep
        # those operational while corpus and management tools explain how to
        # finish the upgrade, rather than taking the whole plugin offline.
        client_id = access_token = refresh_token = None
    else:
        if not isinstance(management_token, str) or not management_token:
            raise ConfigurationError("credential file has an invalid management token")
        if not isinstance(oauth, dict):
            raise ConfigurationError("credential file is missing OAuth state")
        client = oauth.get("clientInformation")
        tokens = oauth.get("tokens")
        if not isinstance(client, dict) or not isinstance(client.get("client_id"), str):
            raise ConfigurationError("credential file is missing an OAuth client")
        if not isinstance(tokens, dict) or not isinstance(tokens.get("access_token"), str):
            raise ConfigurationError("credential file is missing an OAuth access token")
        if not isinstance(tokens.get("refresh_token"), str):
            raise ConfigurationError("credential file is missing an OAuth refresh token")
        client_id = client["client_id"]
        access_token = tokens["access_token"]
        refresh_token = tokens["refresh_token"]
    return Credentials(
        gateway_url=raw["gatewayUrl"].rstrip("/"),
        delivery_token=raw["deliveryToken"],
        ingestion_token=raw["ingestionToken"],
        management_token=management_token,
        oauth_client_id=client_id,
        oauth_access_token=access_token,
        oauth_refresh_token=refresh_token,
        ca_pem=ca_pem,
        leaf_fingerprint_sha256=fingerprint,
    )


def _subscriptions_enabled(raw: Any) -> bool:
    """Whether the gateway this installation talks to offers Watch management.

    Watch management rides on a gateway runtime that ships separately from the
    rest of this integration, so the tool is registered only where it exists;
    offering it otherwise would put a lever in front of the model that answers
    404. ``omnesis connect`` records the gateway's answer here.

    A file with no recorded capability predates the field, and could only have
    been written by a CLI that refused to install against a gateway without
    Watches — so the honest reading of its silence is "available".
    """
    capabilities = raw.get("capabilities") if isinstance(raw, dict) else None
    if not isinstance(capabilities, dict):
        return True
    return capabilities.get("subscriptions") is True


def _parse_gateway_health(value: Any) -> tuple[bool, Optional[str]]:
    if not isinstance(value, dict) or not isinstance(value.get("status"), str):
        raise McpProtocolError("the gateway did not return an Omnesis health response")
    capabilities = value.get("capabilities")
    subscriptions = (
        capabilities.get("subscriptions") is True
        if isinstance(capabilities, dict)
        else value.get("experimental") is True
    )
    version = value.get("version")
    return subscriptions, version if isinstance(version, str) else None


def _version_triplet(value: Optional[str]) -> Optional[tuple[int, int, int]]:
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", value.strip())
    return tuple(map(int, match.groups())) if match else None


def _version_drift_warning(gateway_version: Optional[str]) -> Optional[str]:
    adapter = _version_triplet(ADAPTER_VERSION)
    gateway = _version_triplet(gateway_version)
    if adapter is None or gateway is None or adapter == gateway:
        return None
    if adapter < gateway:
        return (
            f"The installed Omnesis hermes plugin is version {ADAPTER_VERSION}, older than "
            f"the gateway's {gateway_version}. Update Omnesis on this machine, then run "
            "`omnesis connect hermes --refresh`."
        )
    return (
        f"The installed Omnesis hermes plugin is version {ADAPTER_VERSION}, newer than "
        f"the gateway's {gateway_version}. Upgrade the gateway first — it serves the wire "
        "contracts this plugin expects."
    )


# The fleet update's device half, restated from the TypeScript integration's
# `self-update.ts` because this adapter imports nothing of Omnesis.
#
# The gateway names a release or exact commit; the `omnesis` CLI installed on this machine does
# the work, including reinstalling this plugin into Hermes. The CLI stops there,
# and the adapter then asks Hermes to restart itself so the new build is loaded
# without anyone at the machine. Hermes refuses `hermes gateway restart` from
# any process descended from its gateway, so the adapter — which runs inside
# the gateway — uses Hermes's own planned restart instead: SIGUSR1 to its own
# process, on which the gateway lets in-flight agent runs finish (up to its
# drain budget), exits, and is started again by its service manager. When the
# signal cannot be sent, or Hermes is still running well past that budget, the
# adapter reports the restart still owed and names the command.

# A lockstep product version and nothing else. The string becomes an argument
# to a command this machine runs on itself, so its shape is refused at the
# frame rather than trusted downstream. The literal is held equal to the
# TypeScript schema's by `wake-contract-parity.test.ts`; `re.ASCII` and a full
# match give it the JavaScript `/u` meaning of `\d`, `\w` and `$`.
_RELEASE_VERSION_PATTERN = r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][\w.-]+)?$"
_RELEASE_VERSION = re.compile(_RELEASE_VERSION_PATTERN, re.ASCII)

# Arguments passed to `omnesis update` between the fixed flags and the version.
# `--wait-for-lock` makes an update already running on this machine — the
# collector's, commanded by the same fleet update — something to wait for
# rather than a refusal. Thirty minutes is two thirds of the deadline below,
# which the wait counts against; `self-update.ts` passes the same value.
_UPDATE_EXTRA_ARGS: tuple[str, ...] = ("--wait-for-lock=30",)

# How much of the update's output is kept for the line reported back. A failing
# build is verbose and only its tail explains itself.
_CAPTURED_OUTPUT_BYTES = 8_000

# How long the update may run before the adapter stops believing in it. A cold
# install plus a build is minutes, so the budget is generous — but unbounded is
# worse than long: a wedged child never settles, no result is ever reported,
# and the gateway's row reads "dispatched" forever.
UPDATE_DEADLINE_SECONDS = 45 * 60.0

# The gateway drops a `device.update.result` whose detail is longer than this,
# which would leave its row "dispatched" as surely as silence would.
_MAX_UPDATE_DETAIL = 2_000


def _validate_update_command(value: Any) -> Dict[str, Any]:
    """The release or exact commit a `device.update` payload names.

    `allowRewind` is the operator's permission for a target that is neither a
    newer release nor a descendant of this build; the gateway sends it only
    when granted, and only as `true`.
    """
    if not isinstance(value, dict):
        raise ValueError("invalid update command")
    rewind = value.get("allowRewind")
    if "allowRewind" in value and rewind is not True:
        raise ValueError("invalid update command")
    keys = set(value) - {"allowRewind"}
    extra: Dict[str, Any] = {"allowRewind": True} if rewind is True else {}
    if keys == {"version"}:
        version = value["version"]
        if isinstance(version, str) and _RELEASE_VERSION.fullmatch(version) is not None:
            return {"version": version, **extra}
    if keys == {"commit"}:
        commit = value["commit"]
        if isinstance(commit, str) and _SOURCE_COMMIT.fullmatch(commit) is not None:
            return {"commit": commit, **extra}
    raise ValueError("invalid update command")


def _normalise_update_target(target: Any) -> Dict[str, str]:
    # Keep the private test/injection seam compatible with its historical
    # version-string input while the wire contract carries a tagged target.
    return {"version": target} if isinstance(target, str) else target


def _update_target_label(target: Dict[str, str] | str) -> str:
    target = _normalise_update_target(target)
    return target["version"] if "version" in target else f"commit {target['commit']}"


def _harness_restart_command() -> str:
    """What an operator runs to load a refreshed plugin.

    The CLI's `harnessRestartSpec` builds the same line for the plan it prints
    on this host.
    """
    return "hermes gateway restart"


def _restart_owed_detail(version: str, reason: str) -> str:
    """What a `restart-pending` result says when Hermes could not be restarted.

    Why, then the command the operator runs instead; `restartOwedDetail` in
    `self-update.ts` words it the same way.
    """
    return _truncate_utf16(
        f"Installed {version}. Restarting hermes failed: {reason}. "
        f"Restart hermes to load it: {_harness_restart_command()}",
        _MAX_UPDATE_DETAIL,
    )


# How long a result that must precede a Hermes restart may take to leave the
# socket's write buffer. A socket that has not written it by then is not
# carrying frames, and the restart goes ahead regardless: the reconnect on the
# new build is what marks the device current.
_RESULT_WRITE_TIMEOUT_SECONDS = 5.0


# How long the adapter waits, after sending SIGUSR1, for Hermes to stop it
# before reporting the restart still owed. Hermes lets in-flight agent runs
# finish before it exits, for up to `agent.restart_drain_timeout` (180 seconds
# unless configured otherwise), then shuts its platforms down, which stops this
# adapter. The wait outlasts that default budget by a minute so a restart that
# drains for the whole of it, then spends a few seconds shutting down, is never
# reported as failed. A Hermes configured with a longer drain can report a
# restart owed that then happens anyway; its reconnection on the new plugin
# clears the row.
PLANNED_RESTART_WAIT_SECONDS = 240.0


def _planned_restart_unavailable(signum: Optional[int]) -> Optional[str]:
    """Why SIGUSR1 cannot restart this Hermes, or None when it can.

    Hermes's gateway installs its restart handler on its event loop. A process
    where SIGUSR1 still has its default disposition would be killed outright by
    the signal, without draining, and one that ignores it would never restart,
    so both are reported instead of signalled.
    """
    if signum is None:
        return "this platform has no SIGUSR1"
    try:
        handler = signal.getsignal(signum)
    except (OSError, ValueError) as error:
        return f"the SIGUSR1 handler could not be read ({error})"
    if handler in (signal.SIG_DFL, signal.SIG_IGN, None):
        return "this Hermes process has no SIGUSR1 restart handler"
    return None


def _resolve_cli_path(env: Optional[Dict[str, str]] = None) -> str:
    """The `omnesis` this adapter updates through.

    The source installer's wrapper lives at `~/.local/bin/omnesis`, which a
    Hermes started by a service manager will not have on PATH;
    `OMNESIS_CLI_BIN` overrides both guesses.
    """
    environ = os.environ if env is None else env
    override = (environ.get("OMNESIS_CLI_BIN") or "").strip()
    if override:
        return override
    home = environ.get("HOME") or str(Path.home())
    wrapper = Path(home) / ".local" / "bin" / "omnesis"
    return str(wrapper) if wrapper.exists() else "omnesis"


# The summary of a failed update, on the rules `summarizeCommandFailure` in
# `@omnesis/core` follows: at most three lines of the final block, 600 characters.
_SUMMARY_MAX_LINES = 3
_SUMMARY_MAX_CHARS = 600
_OSC_SEQUENCE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_CSI_SEQUENCE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_OTHER_ESCAPE = re.compile(r"\x1b[@-_]")
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _update_failure_summary(output: str) -> str:
    """The part of a failed update's output that explains it.

    A CLI refusal is often several lines whose first names the cause, so the
    last line alone keeps the advice and loses the reason. What is kept is the
    final block: the last run of non-empty lines, at most three, joined with
    spaces. Over 600 characters a line gives way from the front — a third
    line, or a first line too long to fit on its own — and otherwise the end is
    cut. Terminal control sequences and carriage-return redraws are removed.
    """
    text = _OTHER_ESCAPE.sub("", _CSI_SEQUENCE.sub("", _OSC_SEQUENCE.sub("", output)))
    lines = [
        _CONTROL_CHARACTERS.sub("", line[line.rfind("\r") + 1 :]).strip()
        for line in re.split(r"\r?\n", text)
    ]
    end = len(lines)
    while end > 0 and not lines[end - 1]:
        end -= 1
    start = end
    while start > 0 and lines[start - 1] and end - start < _SUMMARY_MAX_LINES:
        start -= 1
    block = lines[start:end]
    while len(" ".join(block)) > _SUMMARY_MAX_CHARS and (
        len(block) > 2 or (len(block) == 2 and len(block[0]) > _SUMMARY_MAX_CHARS)
    ):
        block = block[1:]
    summary = " ".join(block)
    if len(summary) > _SUMMARY_MAX_CHARS:
        return summary[: _SUMMARY_MAX_CHARS - 1].rstrip() + "…"
    return summary


async def _run_cli_update(
    target: Dict[str, str] | str,
    *,
    cli_path: Optional[str] = None,
    deadline_seconds: Optional[float] = None,
    spawn: Any = None,
) -> Dict[str, Any]:
    """Run one local update and describe how it ended.

    `--no-restart` covers both daemons and Hermes itself, so what comes back is
    a plugin on disk: a clean exit is `installed`, and the caller restarts
    Hermes once that result is sent. The target is one `--target-version=<v>`
    or `--commit=<sha>` token, so it cannot be read as a separate flag.
    """
    cli = cli_path if cli_path is not None else _resolve_cli_path()
    deadline = UPDATE_DEADLINE_SECONDS if deadline_seconds is None else deadline_seconds
    create = spawn if spawn is not None else asyncio.create_subprocess_exec
    target = _normalise_update_target(target)
    label = _update_target_label(target)
    target_arg = (
        f"--target-version={target['version']}"
        if "version" in target
        else f"--commit={target['commit']}"
    )
    try:
        process = await create(
            cli,
            "update",
            "--yes",
            "--no-restart",
            *_UPDATE_EXTRA_ARGS,
            target_arg,
            *(["--allow-rewind"] if target.get("allowRewind") else []),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "NO_COLOR": "1"},
        )
    except OSError as error:
        return {
            "state": "failed",
            "detail": _truncate_utf16(
                f"Could not run `{cli} update` on this machine: {error}. "
                "Set OMNESIS_CLI_BIN if the CLI is installed elsewhere.",
                _MAX_UPDATE_DETAIL,
            ),
        }

    output = bytearray()

    async def finish() -> int:
        while True:
            chunk = await process.stdout.read(65_536)
            if not chunk:
                break
            output.extend(chunk)
            del output[:-_CAPTURED_OUTPUT_BYTES]
        return await process.wait()

    try:
        code = await asyncio.wait_for(finish(), timeout=deadline)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        return {
            "state": "failed",
            "detail": (
                f"The update did not finish within {round(deadline / 60)} minutes "
                "and was stopped."
            ),
        }
    if code == 0:
        return {
            "state": "installed",
            "detail": _truncate_utf16(
                f"Installed {label}; restarting hermes through its planned restart",
                _MAX_UPDATE_DETAIL,
            ),
        }
    # A negative return code is a signal, which Node reports as no code at all.
    exit_text = str(code) if code >= 0 else "with no code"
    summary = _update_failure_summary(output.decode("utf-8", errors="replace"))
    return {
        "state": "failed",
        "detail": _truncate_utf16(
            f"`{cli} update` exited {exit_text}. {summary}", _MAX_UPDATE_DETAIL
        ),
    }


def _refresh_keepalive_due(raw: Any, now_ms: int) -> bool:
    oauth = raw.get("oauth") if isinstance(raw, dict) else None
    if not isinstance(oauth, dict) or oauth.get("codeVerifier") is not None:
        return False
    obtained = oauth.get("tokensObtainedAt")
    if not isinstance(obtained, (int, float)) or isinstance(obtained, bool):
        return True
    if obtained > now_ms:
        return True
    return now_ms - obtained >= _OAUTH_REFRESH_TOKEN_LIFETIME_MS - _OAUTH_REFRESH_MARGIN_MS


def _record_gateway_capabilities(path: Path, subscriptions: bool) -> None:
    lock_path = Path(f"{path}.refresh.lock")
    descriptor = _acquire_refresh_lock(lock_path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ConfigurationError("credential file must contain an object")
        capabilities = raw.get("capabilities")
        next_capabilities = dict(capabilities) if isinstance(capabilities, dict) else {}
        if next_capabilities.get("subscriptions") is subscriptions:
            return
        next_capabilities["subscriptions"] = subscriptions
        raw["capabilities"] = next_capabilities
        _write_credentials(path, raw)
    finally:
        _release_owned_refresh_lock(lock_path, descriptor)


def _reconcile_gateway_capabilities(path: Path) -> bool:
    credentials = _load_credentials(path)
    probe = OmnesisAdapter.for_tools()
    probe._credential_path = path
    probe._credentials = credentials
    health = probe._request_json(
        "GET", "/health", "", None, _CAPABILITY_PROBE_TIMEOUT_SECONDS
    )
    subscriptions, version = _parse_gateway_health(health)
    _record_gateway_capabilities(path, subscriptions)
    warning = _version_drift_warning(version)
    if warning:
        logger.warning("%s", warning)
    return subscriptions


# The re-issue route's refusal when no approved credential is bound to this
# device. Declared in `packages/gateway/src/http/routes/oauth-access-authorization.ts`.
_NO_APPROVED_CREDENTIAL = "NO_APPROVED_CREDENTIAL"


def _is_invalid_grant(status: int, body: bytes) -> bool:
    """Did the token endpoint say the refresh token itself is no longer valid?

    RFC 6749 puts several unrelated conditions behind the same 400, so the
    error code is the only thing that separates a spent ticket from a
    malformed request or a misconfigured client.
    """
    if status not in (400, 401):
        return False
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        return False
    return isinstance(parsed, dict) and parsed.get("error") == "invalid_grant"


def _oauth_resource(raw: Any, gateway_url: str) -> str:
    """Use the protected resource discovered during OAuth, not the transport URL."""
    oauth = raw.get("oauth") if isinstance(raw, dict) else None
    discovery = oauth.get("discoveryState") if isinstance(oauth, dict) else None
    metadata = (
        discovery.get("resourceMetadata") if isinstance(discovery, dict) else None
    )
    resource = metadata.get("resource") if isinstance(metadata, dict) else None
    if isinstance(resource, str):
        parsed = urllib.parse.urlparse(resource)
        try:
            valid_port = parsed.port is None or 0 < parsed.port <= 65535
        except ValueError:
            valid_port = False
        if (
            parsed.scheme in {"http", "https"}
            and parsed.hostname
            and valid_port
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
            and parsed.path.endswith("/mcp")
            and (parsed.scheme == "https" or _is_loopback(parsed.hostname))
        ):
            return resource
    return f"{gateway_url.rstrip('/')}/mcp"


def _oauth_token_endpoint(raw: Any, gateway_url: str) -> str:
    """Use the authorization server discovered during OAuth when available."""
    oauth = raw.get("oauth") if isinstance(raw, dict) else None
    discovery = oauth.get("discoveryState") if isinstance(oauth, dict) else None
    metadata = (
        discovery.get("authorizationServerMetadata")
        if isinstance(discovery, dict)
        else None
    )
    endpoint = metadata.get("token_endpoint") if isinstance(metadata, dict) else None
    if isinstance(endpoint, str):
        parsed = urllib.parse.urlparse(endpoint)
        try:
            valid_port = parsed.port is None or 0 < parsed.port <= 65535
        except ValueError:
            valid_port = False
        if (
            parsed.scheme in {"http", "https"}
            and parsed.hostname
            and valid_port
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
            and parsed.path.endswith("/oauth/token")
            and (parsed.scheme == "https" or _is_loopback(parsed.hostname))
        ):
            return endpoint
    return f"{gateway_url.rstrip('/')}/oauth/token"


def _ssl_context(credentials: Credentials) -> Optional[ssl.SSLContext]:
    if credentials.ca_pem is None:
        return None
    context = ssl.create_default_context(cadata=credentials.ca_pem)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    if hasattr(ssl, "VERIFY_X509_PARTIAL_CHAIN"):
        context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    return context


def _verify_leaf(ssl_object: Any, expected: Optional[str]) -> None:
    if expected is None:
        return
    if ssl_object is None:
        raise ssl.SSLError("TLS peer certificate unavailable for pin validation")
    certificate = ssl_object.getpeercert(binary_form=True)
    if not certificate:
        raise ssl.SSLError("TLS peer did not provide a leaf certificate")
    actual = hashlib.sha256(certificate).hexdigest()
    if actual != expected:
        raise ssl.SSLError("TLS leaf certificate pin mismatch")


def _validate_handle(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 256
        or any(char not in _HANDLE_CHARS for char in value)
    ):
        raise ValueError(f"{field} must be an opaque Omnesis handle")
    return value


def _utf16_length(value: str) -> int:
    """Match JavaScript/Zod string limits, which count UTF-16 code units."""
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _supported_delivery_protocol(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and DELIVERY_PROTOCOL_MIN_VERSION <= value <= DELIVERY_PROTOCOL_VERSION
    )


def _read_manage_bindings(raw: Any) -> Dict[str, str]:
    """The referents a caller supplied for a watch it is authoring.

    Validated here as well as by the gateway so a malformed map is refused with
    something the model can act on, rather than as a schema error about a
    request whose shape it has already forgotten. Control characters are
    rejected because a binding is rendered into a woken run's prompt as a
    referent to trust, and a newline in one could forge a line of its own.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("bindings must be an object of key/value strings")
    if len(raw) > _MAX_BINDINGS:
        raise ValueError(f"at most {_MAX_BINDINGS} bindings")
    clean: Dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError("every binding key and value must be a string")
        if not 1 <= _utf16_length(key) <= _MAX_BINDING_KEY:
            raise ValueError(f'binding "{key}" has a name outside the permitted length')
        if not 1 <= _utf16_length(value) <= _MAX_BINDING_VALUE:
            raise ValueError(f'binding "{key}" has a value outside the permitted length')
        if any(unicodedata.category(ch) == "Cc" for ch in key + value):
            raise ValueError(f'binding "{key}" must not contain control characters')
        clean[key] = value
    return clean


def _validate_bindings(value: Any) -> None:
    """The author's referents, checked against the same limits Zod applies.

    Their meaning is whatever the instruction says it is, so nothing here
    inspects a key or a value beyond its shape.
    """
    if not isinstance(value, dict) or len(value) > _MAX_BINDINGS:
        raise ValueError("invalid reaction bindings")
    for key, binding in value.items():
        if (
            not isinstance(key, str)
            or not 1 <= _utf16_length(key) <= _MAX_BINDING_KEY
            or not isinstance(binding, str)
            or not 1 <= _utf16_length(binding) <= _MAX_BINDING_VALUE
        ):
            raise ValueError("invalid reaction bindings")


def _validate_authority(value: Any, expected_endpoint: str, field: str) -> None:
    if not isinstance(value, dict) or set(value) != _ANSWER_KEYS:
        raise ValueError(f"invalid {field} authority")
    if (
        not isinstance(value.get("token"), str)
        or not 1 <= _utf16_length(value["token"]) <= 512
    ):
        raise ValueError(f"invalid {field} authority")
    expires_at = value.get("expiresAt")
    if (
        not isinstance(expires_at, int)
        or isinstance(expires_at, bool)
        or not 1 <= expires_at <= MAX_SAFE_INTEGER
    ):
        raise ValueError(f"invalid {field} expiry")
    if value.get("endpoint") != expected_endpoint:
        raise ValueError(f"{field} endpoint is not bound to this firing")


def _validate_delivery(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("delivery has unexpected fields")
    version = value.get("protocolVersion")
    if not _supported_delivery_protocol(version):
        raise ValueError("unsupported delivery protocol")
    versioned = version >= _OUTCOME_AND_BINDINGS_VERSION
    if set(value) != (_DELIVERY_KEYS_V4 if versioned else _DELIVERY_KEYS):
        raise ValueError("delivery has unexpected fields")
    for field in ("deliveryId", "firingId", "subscriptionId", "workflowHandle"):
        _validate_handle(value.get(field), field)
    reaction = value.get("reaction")
    allowed_reaction = {"instruction", "bindings"} if versioned else {"instruction"}
    if (
        not isinstance(reaction, dict)
        or not set(reaction) <= allowed_reaction
        or not isinstance(reaction.get("instruction"), str)
        or not 1 <= _utf16_length(reaction["instruction"]) <= 16384
    ):
        raise ValueError("invalid reaction instruction")
    if "bindings" in reaction:
        _validate_bindings(reaction["bindings"])
    _validate_authority(
        value.get("answer"),
        f"/subscriptions/firings/{value['firingId']}/answer",
        "answer",
    )
    if versioned:
        _validate_authority(
            value.get("outcome"),
            f"/subscriptions/firings/{value['firingId']}/outcome",
            "outcome",
        )
    return value


def _delivery_bindings(delivery: Dict[str, Any]) -> Dict[str, str]:
    """The bindings a wake carried, or none when it predates them."""
    bindings = delivery.get("reaction", {}).get("bindings")
    return bindings if isinstance(bindings, dict) else {}


def _validate_delivery_control(value: Any) -> str:
    if (
        not isinstance(value, dict)
        or set(value) != {"protocolVersion", "deliveryId"}
        or not _supported_delivery_protocol(value.get("protocolVersion"))
    ):
        raise ValueError("invalid delivery control payload")
    return _validate_handle(value.get("deliveryId"), "deliveryId")


def _validate_answer_completion_delivery(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _ANSWER_COMPLETION_KEYS:
        raise ValueError("completion delivery has unexpected fields")
    # Version 4 removes the one-use completion bearer. The wake carries only
    # task identity; corpus retrieval uses the installation's OAuth principal.
    if value.get("protocolVersion") != DELIVERY_PROTOCOL_VERSION:
        raise ValueError("unsupported completion delivery protocol")
    for field in ("deliveryId", "taskId", "nativeConversationId"):
        _validate_handle(value.get(field), field)
    return value


def _answer_completion_payload_hash(delivery: Dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(delivery, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
    ).hexdigest()


def _validate_hello_response(value: Any, correlation_id: str) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"kind", "correlationId", "ok", "result"}
        or value.get("kind") != "response"
        or value.get("correlationId") != correlation_id
        or value.get("ok") is not True
    ):
        raise ConnectionError("Omnesis rejected integration hello")
    result = value.get("result")
    if (
        not isinstance(result, dict)
        or set(result) != _HELLO_RESULT_KEYS
        or result.get("protocolVersion") != PROTOCOL_VERSION
        or not isinstance(result.get("deviceId"), str)
        or not result["deviceId"]
        or not isinstance(result.get("deviceName"), str)
        or not result["deviceName"]
        or not isinstance(result.get("deviceKind"), str)
        or not result["deviceKind"]
        or not isinstance(result.get("scopes"), list)
        or any(not isinstance(scope, str) for scope in result["scopes"])
    ):
        raise ConnectionError("Omnesis returned an invalid integration hello")


def _payload_hash(delivery: Dict[str, Any]) -> str:
    # Both bearers are transport authority rather than business identity: the
    # gateway mints fresh ones whenever it re-sends a wake whose acknowledgement
    # was lost. Were either part of the identity, that ordinary redelivery would
    # read as a different wake for the same delivery id -- a conflict this
    # refuses, permanently, for a firing that is otherwise perfectly runnable.
    identity = {
        **delivery,
        "answer": {"endpoint": delivery["answer"]["endpoint"]},
    }
    if "outcome" in identity:
        identity["outcome"] = {"endpoint": delivery["outcome"]["endpoint"]}
    canonical = json.dumps(
        identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


class DurableState:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path.parent, 0o700)
        self.connection = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.connection.execute("PRAGMA journal_mode = WAL")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS integration_inbox (
              delivery_id TEXT PRIMARY KEY,
              payload_hash TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              state TEXT NOT NULL
                CHECK(state IN ('prepared','starting','accepted','cancelled')),
              accepted_at INTEGER,
              local_run_id TEXT,
              last_error TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS integration_delivery_cancellations (
              delivery_id TEXT PRIMARY KEY,
              cancelled_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS integration_workflow_bindings (
              workflow_handle TEXT PRIMARY KEY,
              native_session_id TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS integration_cursors (
              stream TEXT PRIMARY KEY,
              cursor TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS integration_authorities (
              delivery_id TEXT PRIMARY KEY,
              firing_id TEXT NOT NULL,
              endpoint TEXT NOT NULL,
              token TEXT NOT NULL,
              expires_at INTEGER NOT NULL
            );
            -- The authority a woken run reports its outcome through, and
            -- whether that run is known to have ended waiting on something.
            --
            -- Separate from `integration_authorities` because the two expire on
            -- different clocks: an inbound report has to stay postable after
            -- the outbound answer authority is long gone.
            CREATE TABLE IF NOT EXISTS integration_outcome_authorities (
              delivery_id TEXT PRIMARY KEY,
              firing_id TEXT NOT NULL,
              native_session_id TEXT NOT NULL,
              endpoint TEXT NOT NULL,
              token TEXT NOT NULL,
              expires_at INTEGER NOT NULL,
              deferred INTEGER NOT NULL DEFAULT 0,
              -- Which held answer will re-enter this run, while it is waiting
              -- on one. The handle is minted per firing-bound answer endpoint,
              -- so it names exactly one firing; the release comes back
              -- carrying it, and it is the only thing that tells two waiting
              -- firings of the same watch apart. NULL when nothing is held.
              deferred_answer_id TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_integration_outcome_authorities_session
            ON integration_outcome_authorities(native_session_id, updated_at);
            CREATE TABLE IF NOT EXISTS integration_answer_origins (
              request_id TEXT PRIMARY KEY,
              native_conversation_id TEXT NOT NULL UNIQUE,
              native_session_id TEXT NOT NULL,
              task_id TEXT UNIQUE,
              created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_integration_answer_origins_task
            ON integration_answer_origins(task_id)
            WHERE task_id IS NOT NULL;
            CREATE TABLE IF NOT EXISTS integration_answer_completion_inbox (
              delivery_id TEXT PRIMARY KEY,
              payload_hash TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('prepared','starting','accepted','cancelled')),
              accepted_at INTEGER,
              local_run_id TEXT,
              last_error TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS integration_answer_completion_cancellations (
              delivery_id TEXT PRIMARY KEY,
              cancelled_at INTEGER NOT NULL
            );
            """
        )
        inbox_schema = self.connection.execute(
            """
            SELECT sql FROM sqlite_master
            WHERE type = 'table' AND name = 'integration_inbox'
            """
        ).fetchone()
        schema_sql = inbox_schema[0].lower() if inbox_schema and inbox_schema[0] else ""
        if "'received'" in schema_sql or "'retryable_failure'" in schema_sql:
            self._rebuild_legacy_inbox()
        else:
            # Early development builds had no CHECK constraint. They can be
            # upgraded in place, unlike the released legacy schema above.
            self.connection.execute(
                """
                UPDATE integration_inbox SET state = 'prepared'
                WHERE state IN ('received', 'retryable_failure')
                """
            )
            self.connection.commit()
        self.connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_integration_inbox_recover
            ON integration_inbox(state, updated_at)
            """
        )
        # `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a
        # database predating a column never gains it that way. Adding it here
        # keeps the schema self-upgrading; a row written before it existed
        # carries NULL, which the resume lookup accounts for.
        outcome_columns = {
            row[1]
            for row in self.connection.execute(
                "PRAGMA table_info(integration_outcome_authorities)"
            )
        }
        if "deferred_answer_id" not in outcome_columns:
            self.connection.execute(
                """
                ALTER TABLE integration_outcome_authorities
                ADD COLUMN deferred_answer_id TEXT
                """
            )
        self.connection.commit()

    def _rebuild_legacy_inbox(self) -> None:
        """Replace the v1 CHECK-constrained inbox without executing queued work."""
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            self.connection.execute(
                "DROP INDEX IF EXISTS idx_integration_inbox_recover"
            )
            self.connection.execute(
                "ALTER TABLE integration_inbox RENAME TO integration_inbox_legacy"
            )
            self.connection.execute(
                """
                CREATE TABLE integration_inbox (
                  delivery_id TEXT PRIMARY KEY,
                  payload_hash TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  state TEXT NOT NULL
                    CHECK(state IN ('prepared','starting','accepted','cancelled')),
                  accepted_at INTEGER,
                  local_run_id TEXT,
                  last_error TEXT,
                  updated_at INTEGER NOT NULL
                )
                """
            )
            self.connection.execute(
                """
                INSERT INTO integration_inbox (
                  delivery_id, payload_hash, payload_json, state, accepted_at,
                  local_run_id, last_error, updated_at
                )
                SELECT delivery_id, payload_hash, payload_json,
                       CASE
                         WHEN state IN ('received','retryable_failure') THEN 'prepared'
                         ELSE state
                       END,
                       accepted_at, local_run_id, last_error, updated_at
                FROM integration_inbox_legacy
                """
            )
            self.connection.execute("DROP TABLE integration_inbox_legacy")
            self.connection.commit()
        except BaseException:
            self.connection.rollback()
            raise

    def close(self) -> None:
        self.connection.close()

    def cursor(self, stream: str) -> int:
        row = self.connection.execute(
            "SELECT cursor FROM integration_cursors WHERE stream = ?", (stream,)
        ).fetchone()
        return int(row[0]) if row else 0

    def set_cursor(self, stream: str, cursor: int) -> None:
        now = int(time.time() * 1000)
        self.connection.execute(
            """
            INSERT INTO integration_cursors(stream, cursor, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(stream) DO UPDATE SET
              cursor = excluded.cursor, updated_at = excluded.updated_at
            """,
            (stream, str(cursor), now),
        )
        self.connection.commit()

    def prepare(self, delivery: Dict[str, Any], digest: str) -> Dict[str, Any]:
        delivery_id = delivery["deliveryId"]
        now = int(time.time() * 1000)
        cancelled = self.connection.execute(
            "SELECT 1 FROM integration_delivery_cancellations WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if cancelled:
            raise DeliveryCancelledError("delivery was cancelled before commit")
        row = self.connection.execute(
            "SELECT payload_hash FROM integration_inbox WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if row and row[0] != digest:
            raise DeliveryConflictError("delivery identifier was rebound")
        with self.connection:
            if row is None:
                self.connection.execute(
                    """
                    INSERT INTO integration_inbox(
                      delivery_id, payload_hash, payload_json, state, updated_at
                    ) VALUES (?, ?, ?, 'prepared', ?)
                    """,
                    (
                        delivery_id,
                        digest,
                        json.dumps(delivery, separators=(",", ":")),
                        now,
                    ),
                )
            else:
                self.connection.execute(
                    """
                    UPDATE integration_inbox SET payload_json = ?, updated_at = ?
                    WHERE delivery_id = ?
                    """,
                    (
                        json.dumps(delivery, separators=(",", ":")),
                        now,
                        delivery_id,
                    ),
                )
                self.connection.execute(
                    """
                    UPDATE integration_authorities
                    SET token = ?, expires_at = ?, endpoint = ?
                    WHERE delivery_id = ? AND firing_id = ?
                    """,
                    (
                        delivery["answer"]["token"],
                        delivery["answer"]["expiresAt"],
                        delivery["answer"]["endpoint"],
                        delivery_id,
                        delivery["firingId"],
                    ),
                )
        return {"status": "prepared", "preparedAt": now, "duplicate": row is not None}

    def delivery_for_commit(
        self, delivery_id: str
    ) -> tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        cancelled = self.connection.execute(
            "SELECT 1 FROM integration_delivery_cancellations WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if cancelled:
            raise DeliveryCancelledError("delivery was cancelled before commit")
        row = self.connection.execute(
            """
            SELECT payload_json, state, accepted_at, local_run_id
            FROM integration_inbox WHERE delivery_id = ?
            """,
            (delivery_id,),
        ).fetchone()
        if row is None:
            raise DeliveryNotPreparedError("delivery has not been prepared")
        if row[1] == "starting":
            raise AmbiguousDeliveryError(
                "delivery start outcome is ambiguous and cannot be replayed safely"
            )
        if row[1] == "accepted":
            return None, {
                "status": "accepted",
                "acceptedAt": row[2],
                "localRunId": row[3],
                "duplicate": True,
            }
        if row[1] != "prepared":
            raise DeliveryCancelledError("delivery was cancelled before commit")
        return _validate_delivery(json.loads(row[0])), None

    def delivery_state(self, delivery_id: str) -> Optional[str]:
        row = self.connection.execute(
            "SELECT state FROM integration_inbox WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        return row[0] if row else None

    def begin(self, delivery_id: str) -> None:
        now = int(time.time() * 1000)
        changed = self.connection.execute(
            """
            UPDATE integration_inbox
            SET state = 'starting', last_error = NULL, updated_at = ?
            WHERE delivery_id = ? AND state = 'prepared'
            """,
            (now, delivery_id),
        )
        self.connection.commit()
        if changed.rowcount != 1:
            raise DeliveryNotPreparedError("delivery has not been prepared")

    def cancel(self, delivery_id: str) -> Dict[str, Any]:
        now = int(time.time() * 1000)
        row = self.connection.execute(
            "SELECT state FROM integration_inbox WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if row and row[0] in {"starting", "accepted"}:
            return {
                "status": "too_late",
                "cancelledAt": now,
                "duplicate": False,
            }
        existing = self.connection.execute(
            "SELECT 1 FROM integration_delivery_cancellations WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        with self.connection:
            self.connection.execute(
                """
                INSERT OR IGNORE INTO integration_delivery_cancellations(
                  delivery_id, cancelled_at
                ) VALUES (?, ?)
                """,
                (delivery_id, now),
            )
            self.connection.execute(
                """
                UPDATE integration_inbox
                SET state = 'cancelled', last_error = NULL, updated_at = ?
                WHERE delivery_id = ?
                """,
                (now, delivery_id),
            )
        return {
            "status": "cancelled",
            "cancelledAt": now,
            "duplicate": existing is not None,
        }

    def fail(self, delivery_id: str, error: BaseException) -> None:
        self.connection.execute(
            """
            UPDATE integration_inbox
            SET state = 'prepared', last_error = ?, updated_at = ?
            WHERE delivery_id = ?
            """,
            (str(error)[:1000], int(time.time() * 1000), delivery_id),
        )
        self.connection.commit()

    def park_ambiguous(self, delivery_id: str, error: BaseException) -> None:
        """Record an uncertain native start without making it replayable."""
        self.connection.execute(
            """
            UPDATE integration_inbox
            SET state = 'starting', last_error = ?, updated_at = ?
            WHERE delivery_id = ? AND state <> 'accepted'
            """,
            (str(error)[:1000], int(time.time() * 1000), delivery_id),
        )
        self.connection.commit()

    def finish(
        self, delivery: Dict[str, Any], local_run_id: str, native_session_id: str
    ) -> Dict[str, Any]:
        now = int(time.time() * 1000)
        existing = self.connection.execute(
            """
            SELECT native_session_id FROM integration_workflow_bindings
            WHERE workflow_handle = ?
            """,
            (delivery["workflowHandle"],),
        ).fetchone()
        if existing and existing[0] != native_session_id:
            raise WorkflowBindingConflictError(
                "workflow was rebound to another native session"
            )
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO integration_workflow_bindings(
                  workflow_handle, native_session_id, updated_at
                ) VALUES (?, ?, ?)
                ON CONFLICT(workflow_handle) DO UPDATE SET updated_at = excluded.updated_at
                """,
                (delivery["workflowHandle"], native_session_id, now),
            )
            self.connection.execute(
                """
                INSERT INTO integration_authorities(
                  delivery_id, firing_id, endpoint, token, expires_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(delivery_id) DO UPDATE SET
                  token = excluded.token, expires_at = excluded.expires_at
                """,
                (
                    delivery["deliveryId"],
                    delivery["firingId"],
                    delivery["answer"]["endpoint"],
                    delivery["answer"]["token"],
                    delivery["answer"]["expiresAt"],
                ),
            )
            self.connection.execute(
                """
                UPDATE integration_inbox SET
                  state = 'accepted', accepted_at = ?, local_run_id = ?,
                  last_error = NULL, updated_at = ?
                WHERE delivery_id = ?
                """,
                (now, local_run_id, now, delivery["deliveryId"]),
            )
        return {
            "status": "accepted",
            "acceptedAt": now,
            "localRunId": local_run_id,
            "duplicate": False,
        }

    def authority_for_chat(
        self, native_chat_id: str, firing_id: str
    ) -> Optional[tuple[str, str]]:
        now = int(time.time() * 1000)
        connection = sqlite3.connect(self.path)
        try:
            connection.execute(
                "DELETE FROM integration_authorities WHERE expires_at <= ?", (now,)
            )
            row = connection.execute(
                """
                SELECT endpoint, token FROM integration_authorities
                WHERE firing_id = ? AND expires_at > ?
                  AND delivery_id IN (
                    SELECT i.delivery_id FROM integration_inbox i
                    JOIN integration_workflow_bindings b
                      ON b.workflow_handle = json_extract(i.payload_json, '$.workflowHandle')
                    WHERE b.native_session_id = ?
                  )
                """,
                (firing_id, now, native_chat_id),
            ).fetchone()
            connection.commit()
            return (row[0], row[1]) if row else None
        finally:
            connection.close()

    def record_outcome_authority(
        self, delivery: Dict[str, Any], native_session_id: str
    ) -> None:
        """Bind this firing's outcome authority to the session about to run it.

        Written before the run starts, and kept after it: a run that ends
        following a restart still has somewhere to report. A wake that carried
        no outcome authority records nothing, and that run reports nothing.
        """
        outcome = delivery.get("outcome")
        if not isinstance(outcome, dict):
            return
        now = int(time.time() * 1000)
        with self.connection:
            self.connection.execute(
                "DELETE FROM integration_outcome_authorities WHERE expires_at <= ?",
                (now,),
            )
            self.connection.execute(
                """
                INSERT INTO integration_outcome_authorities(
                  delivery_id, firing_id, native_session_id, endpoint, token,
                  expires_at, deferred, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(delivery_id) DO UPDATE SET
                  native_session_id = excluded.native_session_id,
                  endpoint = excluded.endpoint,
                  token = excluded.token,
                  expires_at = excluded.expires_at,
                  deferred = 0,
                  deferred_answer_id = NULL,
                  updated_at = excluded.updated_at
                """,
                (
                    delivery["deliveryId"],
                    delivery["firingId"],
                    native_session_id,
                    outcome["endpoint"],
                    outcome["token"],
                    outcome["expiresAt"],
                    now,
                ),
            )

    # The accessors below open their own short-lived connection. A run ends,
    # and asks its questions, on a Hermes agent-worker thread, while the
    # long-lived connection belongs to the event-loop thread that owns the
    # delivery socket — the same reason `authority_for_chat` does.
    #
    # Every one of them is keyed by delivery id, or by the firing that names
    # one. A native session is not: it is named after the workflow, so every
    # firing of the same watch shares it, and a report addressed to a session
    # is a report addressed to whichever of that watch's firings happens to be
    # newest.
    def outcome_authority_for_delivery(
        self, delivery_id: str
    ) -> Optional[tuple[str, str, bool]]:
        """The live outcome authority this delivery reports through."""
        now = int(time.time() * 1000)
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            row = connection.execute(
                """
                SELECT endpoint, token, deferred
                FROM integration_outcome_authorities
                WHERE delivery_id = ? AND expires_at > ?
                """,
                (delivery_id, now),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            return None
        return row[0], row[1], bool(row[2])

    def outcome_delivery_for_firing(
        self, firing_id: str, native_session_id: str
    ) -> Optional[str]:
        """Which delivery carries this firing's outcome authority.

        Both halves of the key matter: the firing says which of the watch's
        runs this is, and the session says the caller is entitled to it.
        """
        now = int(time.time() * 1000)
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            row = connection.execute(
                """
                SELECT delivery_id FROM integration_outcome_authorities
                WHERE firing_id = ? AND native_session_id = ? AND expires_at > ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (firing_id, native_session_id, now),
            ).fetchone()
        finally:
            connection.close()
        return row[0] if row else None

    def deferred_outcome_delivery(
        self, native_session_id: str, held_answer_id: str
    ) -> Optional[str]:
        """The waiting delivery whose held answer this release belongs to.

        The route a released answer comes back on names the session it
        re-enters, never the firing — and a session is named after the
        workflow, so two firings of one watch can both be waiting inside it.
        The answer handle is what separates them: it is minted per
        firing-bound answer endpoint, so it names one firing and needs no
        assumption about the order the two runs stopped or resume in.

        A row written before the handle was recorded has none to match on. It
        is resolved only when it is the session's sole waiting delivery, where
        there is nothing it could be confused with; otherwise the release is
        left unattributed rather than credited to the wrong firing.
        """
        now = int(time.time() * 1000)
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            rows = connection.execute(
                """
                SELECT delivery_id, deferred_answer_id
                FROM integration_outcome_authorities
                WHERE native_session_id = ? AND expires_at > ? AND deferred = 1
                """,
                (native_session_id, now),
            ).fetchall()
        finally:
            connection.close()
        for delivery_id, answer_id in rows:
            if answer_id == held_answer_id:
                return delivery_id
        if len(rows) == 1 and rows[0][1] is None:
            return rows[0][0]
        return None

    def set_outcome_deferred(
        self,
        delivery_id: str,
        deferred: bool,
        held_answer_id: Optional[str] = None,
    ) -> None:
        """Record whether this delivery's run is waiting on a held answer.

        Set when the gateway says an answer is held — the asking run ends
        there — along with the handle of the answer that will re-enter the
        run. Cleared when that answer arrives, so the second run reports on
        its own behalf rather than inheriting the first one's wait. Scoped to
        the one delivery: a sibling firing of the same watch is a different
        run and is not waiting on this answer.
        """
        now = int(time.time() * 1000)
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            connection.execute(
                """
                UPDATE integration_outcome_authorities
                SET deferred = ?, deferred_answer_id = ?
                WHERE delivery_id = ? AND expires_at > ?
                """,
                (
                    1 if deferred else 0,
                    held_answer_id if deferred else None,
                    delivery_id,
                    now,
                ),
            )
            connection.commit()
        finally:
            connection.close()

    def clear_outcome_authority(self, delivery_id: str) -> None:
        """Retire an authority whose run has reported a final outcome."""
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            connection.execute(
                "DELETE FROM integration_outcome_authorities WHERE delivery_id = ?",
                (delivery_id,),
            )
            connection.commit()
        finally:
            connection.close()

    def prepare_answer_origin(self, request_id: str, native_session_id: str) -> str:
        """Persist the trusted Hermes origin before starting an answer task."""
        now = int(time.time() * 1000)
        with self.connection:
            row = self.connection.execute(
                "SELECT native_conversation_id, native_session_id FROM integration_answer_origins WHERE request_id = ?",
                (request_id,),
            ).fetchone()
            if row is not None and row[1] != native_session_id:
                raise DeliveryConflictError("answer request origin conflict")
            if row is not None:
                return row[0]
            native_conversation_id = uuid.uuid4().hex
            self.connection.execute(
                """
                INSERT OR IGNORE INTO integration_answer_origins(
                  request_id, native_conversation_id, native_session_id, created_at
                ) VALUES (?, ?, ?, ?)
                """,
                (request_id, native_conversation_id, native_session_id, now),
            )
            return native_conversation_id

    def bind_answer_task(self, request_id: str, task_id: str) -> None:
        """Attach the gateway task id after its durable task has been created."""
        with self.connection:
            row = self.connection.execute(
                "SELECT task_id FROM integration_answer_origins WHERE request_id = ?",
                (request_id,),
            ).fetchone()
            if row is None:
                raise DeliveryConflictError("answer request origin is missing")
            if row[0] is not None and row[0] != task_id:
                raise DeliveryConflictError("answer request task conflict")
            self.connection.execute(
                "UPDATE integration_answer_origins SET task_id = ? WHERE request_id = ?",
                (task_id, request_id),
            )

    def answer_origin_for_completion(
        self, native_conversation_id: str, task_id: str
    ) -> Optional[str]:
        row = self.connection.execute(
            """
            SELECT native_session_id, task_id FROM integration_answer_origins
            WHERE native_conversation_id = ?
            """,
            (native_conversation_id,),
        ).fetchone()
        if row is None or (row[1] is not None and row[1] != task_id):
            return None
        if row[1] is None:
            # The gateway may have created the durable task just as the HTTP
            # response to the originating tool call timed out. The completion
            # is authenticated, carries the same opaque native conversation
            # id, and is the first safe point at which that task can be bound.
            with self.connection:
                changed = self.connection.execute(
                    """
                    UPDATE integration_answer_origins
                    SET task_id = ?
                    WHERE native_conversation_id = ? AND task_id IS NULL
                    """,
                    (task_id, native_conversation_id),
                )
            if changed.rowcount != 1:
                return None
        return row[0]

    def prepare_answer_completion(self, delivery: Dict[str, Any]) -> Dict[str, Any]:
        digest = _answer_completion_payload_hash(delivery)
        delivery_id = delivery["deliveryId"]
        now = int(time.time() * 1000)
        cancelled = self.connection.execute(
            "SELECT 1 FROM integration_answer_completion_cancellations WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if cancelled:
            raise DeliveryCancelledError("completion was cancelled before prepare")
        row = self.connection.execute(
            "SELECT payload_hash, payload_json FROM integration_answer_completion_inbox WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if row is not None and row[0] != digest:
            raise DeliveryConflictError("completion delivery identifier was rebound")
        with self.connection:
            if row is None:
                self.connection.execute(
                    """
                    INSERT INTO integration_answer_completion_inbox(
                      delivery_id, payload_hash, payload_json, state, updated_at
                    ) VALUES (?, ?, ?, 'prepared', ?)
                    """,
                    (delivery_id, digest, json.dumps(delivery, separators=(",", ":")), now),
                )
            else:
                self.connection.execute(
                    """
                    UPDATE integration_answer_completion_inbox
                    SET payload_hash = ?, payload_json = ?, updated_at = ? WHERE delivery_id = ?
                    """,
                    (digest, json.dumps(delivery, separators=(",", ":")), now, delivery_id),
                )
        return {"status": "prepared", "preparedAt": now, "duplicate": row is not None}

    def answer_completion_for_commit(
        self, delivery_id: str
    ) -> tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        cancelled = self.connection.execute(
            "SELECT 1 FROM integration_answer_completion_cancellations WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if cancelled:
            raise DeliveryCancelledError("completion was cancelled before commit")
        row = self.connection.execute(
            """
            SELECT payload_json, state, accepted_at, local_run_id
            FROM integration_answer_completion_inbox WHERE delivery_id = ?
            """,
            (delivery_id,),
        ).fetchone()
        if row is None:
            raise DeliveryNotPreparedError("completion has not been prepared")
        if row[1] == "accepted":
            return None, {
                "status": "accepted", "acceptedAt": row[2], "localRunId": row[3], "duplicate": True
            }
        if row[1] != "prepared":
            raise DeliveryCancelledError("completion cannot be committed")
        return _validate_answer_completion_delivery(json.loads(row[0])), None

    def begin_answer_completion(self, delivery_id: str) -> None:
        changed = self.connection.execute(
            """
            UPDATE integration_answer_completion_inbox
            SET state = 'starting', last_error = NULL, updated_at = ?
            WHERE delivery_id = ? AND state = 'prepared'
            """,
            (int(time.time() * 1000), delivery_id),
        )
        self.connection.commit()
        if changed.rowcount != 1:
            raise DeliveryNotPreparedError("completion has not been prepared")

    def finish_answer_completion(self, delivery_id: str, local_run_id: str) -> Dict[str, Any]:
        now = int(time.time() * 1000)
        changed = self.connection.execute(
            """
            UPDATE integration_answer_completion_inbox
            SET state = 'accepted', accepted_at = ?, local_run_id = ?, last_error = NULL, updated_at = ?
            WHERE delivery_id = ? AND state = 'starting'
            """,
            (now, local_run_id, now, delivery_id),
        )
        self.connection.commit()
        if changed.rowcount != 1:
            raise DeliveryNotPreparedError("completion start was lost")
        return {"status": "accepted", "acceptedAt": now, "localRunId": local_run_id, "duplicate": False}

    def fail_answer_completion(self, delivery_id: str, error: BaseException) -> None:
        self.connection.execute(
            """
            UPDATE integration_answer_completion_inbox
            SET state = 'prepared', last_error = ?, updated_at = ?
            WHERE delivery_id = ? AND state = 'starting'
            """,
            (str(error)[:1000], int(time.time() * 1000), delivery_id),
        )
        self.connection.commit()

    def cancel_answer_completion(self, delivery_id: str) -> Dict[str, Any]:
        now = int(time.time() * 1000)
        row = self.connection.execute(
            "SELECT state FROM integration_answer_completion_inbox WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if row and row[0] in {"starting", "accepted"}:
            return {"status": "too_late", "cancelledAt": now, "duplicate": False}
        existing = self.connection.execute(
            "SELECT 1 FROM integration_answer_completion_cancellations WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        with self.connection:
            self.connection.execute(
                "INSERT OR IGNORE INTO integration_answer_completion_cancellations(delivery_id, cancelled_at) VALUES (?, ?)",
                (delivery_id, now),
            )
            self.connection.execute(
                "UPDATE integration_answer_completion_inbox SET state = 'cancelled', updated_at = ? WHERE delivery_id = ?",
                (now, delivery_id),
            )
        return {"status": "cancelled", "cancelledAt": now, "duplicate": existing is not None}


def _strip_user_content(raw: str) -> str:
    index = raw.rfind(_END_OF_THREAD)
    text = raw[index + len(_END_OF_THREAD) :] if index >= 0 else raw
    stripped = text.lstrip()
    if stripped.startswith("[Replying to:"):
        end = stripped.find("]")
        if end >= 0:
            text = stripped[end + 1 :]
    return text.strip()


def _read_transcript_page(path: Path, since_id: int) -> tuple[list[dict], int]:
    if not path.exists():
        return [], since_id
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        connection.execute("PRAGMA query_only = 1")
        rows = connection.execute(
            """
            SELECT m.id, s.source, COALESCE(s.chat_id, ''), s.chat_type,
                   s.display_name, s.origin_json, m.role, m.content, m.timestamp
            FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.id > ? AND m.role IN ('user', 'assistant')
              AND s.source <> 'omnesis'
            ORDER BY m.id LIMIT ?
            """,
            (since_id, PAGE_SIZE),
        ).fetchall()
    finally:
        connection.close()
    messages = []
    maximum = since_id
    for row in rows:
        mid, source, chat_id, chat_type, display_name, origin_json, role, content, ts = row
        maximum = max(maximum, mid)
        chat_name = display_name
        if origin_json:
            try:
                origin = json.loads(origin_json)
                chat_name = origin.get("chat_name") or chat_name
                chat_type = origin.get("chat_type") or chat_type
            except (TypeError, ValueError):
                pass
        text = _strip_user_content(content or "") if role == "user" else (content or "").strip()
        if not text:
            continue
        message = {
            "id": f"hermes:{source}:{chat_id}:{mid}",
            "harness": "hermes",
            "channel": source,
            "chatId": chat_id,
            "role": role,
            "text": text,
            "occurredAt": int(float(ts) * 1000),
        }
        if chat_name and chat_name != chat_id:
            message["chatName"] = chat_name
        if chat_type:
            message["chatType"] = chat_type
        messages.append(message)
    return messages, maximum


class OmnesisAdapter(BasePlatformAdapter):
    supports_async_delivery = False
    interactive_resume = False

    # Bounds the map for a long-lived gateway; runs are short and never revisited.
    MAX_TRACKED_RUNS = 256

    @classmethod
    def for_tools(cls) -> "OmnesisAdapter":
        """An adapter that can serve tool calls with no delivery connection.

        Delivery connects only inside the Hermes gateway, but tool handlers run
        wherever Hermes executes a turn — a CLI session and a scheduled run
        among them. Those calls need the credential file and the durable state,
        both of which are per-machine rather than per-process, and nothing the
        platform machinery provides. Building one here keeps a question
        answerable from any of those places.
        """
        adapter = cls.__new__(cls)
        adapter._credential_path = _credentials_path()
        adapter._credentials = None
        adapter._state = None
        adapter._run_threads = {}
        adapter._pending_answer_requests = {}
        adapter._session_runs = {}
        adapter._oauth_refresh_lock = threading.Lock()
        return adapter

    def _ensure_tool_resources(self) -> bool:
        """Load what a tool call needs, if this process has not already."""
        if self._credentials is None:
            try:
                self._credentials = _load_credentials(self._credential_path)
            except Exception:
                logger.warning("Omnesis credentials are unavailable")
                return False
        if self._state is None:
            self._state = DurableState(_hermes_home() / "omnesis" / "integration.sqlite")
        return True

    def _subscriptions_available(self) -> bool:
        """Use the last successful gateway probe for an already-registered tool."""
        try:
            raw = json.loads(self._credential_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # A legacy credential has no recorded capability. Registration is
            # optimistic for that file shape, so an existing tool call must be
            # consistent with the tool set Hermes already received.
            return True
        return _subscriptions_enabled(raw)

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("omnesis"))
        self._credential_path = _credentials_path(config)
        self._credentials: Optional[Credentials] = None
        self._state: Optional[DurableState] = None
        # Workflow and answer conversation Omnesis minted, per run. A workflow
        # is one bounded external job and cumulative disclosure accumulates
        # against it, so asks in one run have to join the same one.
        self._run_threads: Dict[str, Dict[str, Any]] = {}
        # A conversational repeat after the local wait budget is the same ask,
        # not a new turn. It remains here only while that ask is known pending.
        self._pending_answer_requests: Dict[tuple[str, str], str] = {}
        # The firings each synthetic session still owes an account for, in the
        # order they woke it. A session is named after the workflow, so every
        # firing of one watch lands in the same session, and more than one can
        # be open at once: `maxConcurrentRuns` bounds how many deliveries the
        # gateway hands over in a single sweep, not how many runs the harness
        # has in flight, so a firing a minute later is dispatched whether or
        # not the one before it has finished. Hermes then merges the second
        # wake into the session already running, and one harness turn produces
        # both firings' work. So the account is kept per firing rather than
        # per run: runs and firings are not one to one.
        self._session_runs: Dict[str, list[Dict[str, Any]]] = {}
        self._oauth_refresh_lock = threading.Lock()
        self._socket: Any = None
        self._stop = asyncio.Event()
        self._wake = asyncio.Event()
        self._tasks: list[asyncio.Task] = []
        self._oauth_maintenance_task: Optional[asyncio.Task] = None
        self._delivery_lock = asyncio.Lock()
        # Runs one local update; tests substitute it. At most one runs per
        # adapter, and it outlives any single delivery connection.
        self._self_updater: Any = _run_cli_update
        self._self_update_task: Optional[asyncio.Task] = None
        # How an install restarts Hermes: SIGUSR1 to this process, which is
        # the Hermes gateway. Tests substitute each part.
        self._restart_signal: Optional[int] = getattr(signal, "SIGUSR1", None)
        self._restart_unavailable: Any = _planned_restart_unavailable
        self._restart_pid: Any = os.getpid
        self._restart_kill: Any = os.kill
        self._restart_wait_seconds = PLANNED_RESTART_WAIT_SECONDS
        self._restart_tasks: set[asyncio.Task] = set()

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        del is_reconnect
        if self._message_handler is None:
            raise ConfigurationError("Omnesis integration requires Hermes gateway mode")
        self._credentials = _load_credentials(self._credential_path)
        try:
            await asyncio.to_thread(
                _reconcile_gateway_capabilities, self._credential_path
            )
            self._credentials = _load_credentials(self._credential_path)
        except Exception as error:
            logger.warning("Could not read Omnesis gateway capabilities: %s", error)
        self._state = DurableState(_hermes_home() / "omnesis" / "integration.sqlite")
        self._stop.clear()
        self._tasks = [
            asyncio.create_task(self._delivery_loop(), name="omnesis-delivery"),
            asyncio.create_task(self._ingestion_loop(), name="omnesis-ingestion"),
        ]
        if (
            self._credentials.oauth_access_token is not None
            and self._credentials.oauth_refresh_token is not None
        ):
            self._oauth_maintenance_task = asyncio.create_task(
                self._oauth_maintenance_loop(), name="omnesis-oauth-maintenance"
            )
            self._tasks.append(self._oauth_maintenance_task)
        return True

    async def disconnect(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._socket is not None:
            await self._socket.close()
            self._socket = None
        for task in self._tasks:
            if task is not self._oauth_maintenance_task:
                task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._oauth_maintenance_task = None
        # An install is not interrupted halfway by a disconnect, though its
        # result then has no socket to go to.
        if self._self_update_task is not None:
            await asyncio.gather(self._self_update_task, return_exceptions=True)
        if self._state is not None:
            self._state.close()
            self._state = None

    def _maintain_oauth_once(self) -> None:
        """Renew a quiet installation before its rotating refresh ticket expires."""
        raw = json.loads(self._credential_path.read_text(encoding="utf-8"))
        if not _refresh_keepalive_due(raw, int(time.time() * 1000)):
            return
        current = _load_credentials(self._credential_path)
        if current.oauth_access_token is None or current.oauth_refresh_token is None:
            return
        self._credentials = current
        self._refresh_oauth_token(current.oauth_access_token)

    async def _oauth_maintenance_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.to_thread(self._maintain_oauth_once)
            except Exception as error:
                logger.warning("Omnesis corpus-access renewal failed: %s", error)
            try:
                await asyncio.wait_for(
                    self._stop.wait(), timeout=_OAUTH_KEEPALIVE_INTERVAL_SECONDS
                )
            except asyncio.TimeoutError:
                pass

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Hold a woken run's text as the account it would give of itself.

        A wake session is one this plugin synthesised; it has no human on the
        other end and no conversation to post into. Text sent to it is
        therefore not a message being delivered anywhere — it is the run
        talking about its own work. Nothing is reported from here, because
        what arrives here is not knowably the run's conclusion: a harness
        notice with nowhere else to go arrives by the same door, and the only
        thing that distinguishes the two is that the run has not finished yet.
        `on_processing_complete` below is told when it has, and reports then.

        Reports success whatever happens to the text. It is the truth — there
        is nowhere for this to fail to be delivered to — and Hermes reads a
        refused send as a run that failed, so the alternative would be every
        wake reporting `failed` on its way to succeeding.
        """
        # `reply_to` is deliberately unused. It carries an id on some of the
        # harness's delivery paths, but on the merged path it carries the
        # *first* wake's id for the second wake's text — an identifier that
        # looks authoritative and names the wrong firing. See
        # `_account_for_text`.
        del reply_to, metadata
        await asyncio.to_thread(self._record_run_text, chat_id, content)
        return SendResult(
            success=True,
            message_id=f"omnesis-background:{chat_id}:{time.time_ns()}",
        )

    def _account_for_text(self, open_accounts: list) -> Optional[Dict[str, Any]]:
        """Which open firing this text is talking about.

        Order is the only evidence there is, and it is real evidence: the
        harness finishes and flushes one turn's response before it starts the
        turn merged in behind it, so firings speak in the order they woke the
        session. A firing that has not spoken yet takes the next text; once
        every open firing has spoken, further text is the newest one refining
        what it said.

        Nothing on the message itself can be used instead. The reply anchor a
        text carries is derived from the message that started the *batch*, so
        on the merged path the second firing's text arrives stamped with the
        first firing's identifier — an attribution that would be confidently
        wrong rather than absent. The wake's own identifiers never reach the
        send boundary at all.

        What this cannot separate is one firing speaking twice while a later
        firing is open: the second remark reads as the later firing's first.
        Both firings still get an account and a status; only which words
        landed on which can be wrong, and only in that shape.
        """
        for account in open_accounts:
            if not account["text"]:
                return account
        return open_accounts[-1] if open_accounts else None

    def _record_run_text(self, native_session_id: str, content: str) -> None:
        """Attribute this text to a firing and file it as that firing's account.

        Filed as it arrives rather than when the harness says the run ended,
        because that announcement is not dependable enough to be the only
        trigger: Hermes sends it once for a whole merged batch, so every
        firing but the first would never be filed at all, and on its
        queued-drain and error paths it precedes the text it is supposed to
        certify. What a firing has said is a fact about that firing whenever
        it arrives, and the gateway keeps the latest account of a firing, so
        filing early costs a superseded report rather than a wrong one.

        Text belonging to no open firing — a background release callback can
        still deliver after a firing's account is settled — is dropped rather
        than reopening it.
        """
        if not isinstance(content, str) or not content.strip():
            return
        # Snapshotted because this runs on a Hermes worker thread while the
        # delivery loop can be opening an account in the same session.
        account = self._account_for_text(
            list(self._session_runs.get(native_session_id, ()))
        )
        if account is None:
            return
        account["text"] = content.strip()
        self._file_outcome(account, _UNOBSERVED_OUTCOME_STATUS)

    async def on_processing_complete(self, event: Any, outcome: Any) -> None:
        """File the firing's outcome, now that its run is actually over.

        Hermes calls this once a woken run has finished and its answer has
        been delivered — the only moment at which the run's last word is known
        to be its last. The event is the one this adapter built for the wake,
        so `message_id` identifies the run without inference.

        It applies to the session rather than to the one wake it names. When
        Hermes merges a second wake into a turn already running, that whole
        batch produces a single announcement carrying the *first* wake's
        event, so reading its `message_id` as the firing it speaks for would
        credit the verdict to one firing and leave every other one waiting for
        an announcement that has already been and gone.

        It is what speaks for a run that ended having said nothing, which is
        the one thing no arriving text can do. It does not settle a firing
        that has said nothing, though: the announcement can arrive before the
        text on the queued-drain and error paths, so an empty account is not
        yet evidence of silence — only of not having spoken yet.

        The verdict is read for its value rather than compared to the enum
        that carries it, and both parameters are typed loosely, for the same
        reason: this signature has to be satisfiable on a host whose base
        class predates either of them.
        """
        session_id = getattr(getattr(event, "source", None), "chat_id", None)
        open_accounts = (
            list(self._session_runs.get(session_id, ())) if session_id else []
        )
        if not open_accounts:
            return
        status = _PROCESSING_OUTCOME_STATUS.get(
            getattr(outcome, "value", outcome), _UNOBSERVED_OUTCOME_STATUS
        )
        for account in open_accounts:
            # Filed again only when the gateway has not already been told
            # this: a firing that has said nothing has no account yet, and a
            # verdict the harness has just changed is news whatever it said
            # before.
            filed = True
            if account["reported"] is None or account["status"] != status:
                filed = await asyncio.to_thread(self._file_outcome, account, status)
            if filed and account["text"]:
                # It has spoken and its turn is over: nothing further is
                # coming for this firing. An account that could not be filed
                # stays open instead, so the next thing to happen for that
                # firing files it rather than losing it.
                self._settle_account(session_id, account)

    def _begin_outcome_run(
        self, native_session_id: str, delivery_id: Optional[str]
    ) -> None:
        """Open an account for a firing that has just woken this session.

        It joins whatever is already open rather than displacing it. A second
        wake is no evidence that the first firing's run has ended — it is
        routinely dispatched into a session still working, which is how two
        firings come to share one harness turn in the first place — and a
        firing whose account was closed on that assumption loses the
        conclusion it had not yet reached.

        `delivery_id` is None where there is nothing to report through: a wake
        carrying no outcome authority, or a released answer that could not be
        matched to the wake waiting for it. The account is opened all the
        same, so text belonging to it is held and then dropped rather than
        filed against a firing that did not produce it.
        """
        open_accounts = self._session_runs.pop(native_session_id, [])
        # Dropped oldest-first when a session accumulates accounts nothing
        # ever closed. This is a memory bound and nothing more: the account
        # each one stands for was filed as its firing spoke, and the authority
        # it would have been settled through expires on its own.
        while len(open_accounts) >= _MAX_OPEN_FIRINGS_PER_SESSION:
            open_accounts.pop(0)
        open_accounts.append(
            {
                "deliveryId": delivery_id,
                "text": "",
                "status": None,
                "reported": None,
            }
        )
        # Reinserted rather than updated in place: a dict keeps a key at its
        # original position, so refreshing one would leave the eviction below
        # dropping the session that has been live longest.
        self._session_runs[native_session_id] = open_accounts
        while len(self._session_runs) > self.MAX_TRACKED_RUNS:
            self._session_runs.pop(next(iter(self._session_runs)))

    def _settle_account(self, native_session_id: str, account: Dict[str, Any]) -> None:
        """Close a firing's account: nothing more will be filed against it."""
        open_accounts = self._session_runs.get(native_session_id)
        if not open_accounts or account not in open_accounts:
            return
        open_accounts.remove(account)
        if not open_accounts:
            self._session_runs.pop(native_session_id, None)
        delivery_id = account["deliveryId"]
        state = self._state
        if state is None or delivery_id is None or account["status"] == "deferred":
            return
        try:
            state.clear_outcome_authority(delivery_id)
        except sqlite3.Error as error:
            # The account is filed and the authority expires on its own, so
            # failing to close it early costs nothing that matters.
            logger.warning("Omnesis outcome authority cleanup failed: %s", error)

    def _file_outcome(self, account: Dict[str, Any], status: str) -> bool:
        """Post one firing's account of itself as it currently stands.

        The status the harness observed is overridden by a firing that ended
        waiting: a held answer is work still in progress whatever the harness
        made of the turn it stopped in, and the run the release re-enters
        files again.

        A firing that has said nothing still reports. Its status is the whole
        of what there is to say, and a firing with no outcome at all is
        indistinguishable from one whose harness never came back.

        Filing the same thing twice is skipped rather than sent. The gateway
        keeps the latest account of a firing and counts the attempts, so a
        repeat would cost a write and change nothing.
        """
        state = self._state
        delivery_id = account["deliveryId"]
        if state is None or self._credentials is None or delivery_id is None:
            return True
        try:
            authority = state.outcome_authority_for_delivery(delivery_id)
        except sqlite3.Error as error:
            logger.warning("Omnesis outcome authority lookup failed: %s", error)
            return False
        if authority is None:
            return True
        endpoint, token, deferred = authority
        if deferred:
            status = "deferred"
        body = _outcome_body(status, account["text"])
        if account["reported"] == body:
            return True
        if not self._post_outcome(endpoint, token, body):
            return False
        account["reported"] = body
        account["status"] = status
        return True

    def _post_outcome(
        self, endpoint: str, token: str, body: Dict[str, Any]
    ) -> bool:
        """Post one outcome, re-attempting a failure that could still clear."""
        for attempt in range(1, _OUTCOME_POST_ATTEMPTS + 1):
            try:
                self._post_json(endpoint, token, body)
                return True
            except Exception as error:
                logger.warning("Omnesis workflow outcome report failed: %s", error)
                if attempt >= _OUTCOME_POST_ATTEMPTS or not _outcome_worth_retrying(
                    error
                ):
                    return False
                stop = getattr(self, "_stop", None)
                if stop is not None and stop.is_set():
                    return False
                time.sleep(_OUTCOME_RETRY_DELAY_SECONDS)
        return False

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": f"Omnesis workflow {chat_id}", "type": "dm"}

    async def _delivery_loop(self) -> None:
        delay = 1
        while not self._stop.is_set():
            try:
                await self._delivery_connection()
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning("Omnesis delivery disconnected: %s", error)
            if self._stop.is_set():
                return
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass
            delay = min(delay * 2, 30)

    async def _delivery_connection(self) -> None:
        import websockets

        assert self._credentials is not None
        parsed = urllib.parse.urlparse(self._credentials.gateway_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        ws_url = urllib.parse.urlunparse(
            parsed._replace(
                scheme=scheme,
                path=f"{parsed.path.rstrip('/')}/device/ws",
                params="",
                query="",
                fragment="",
            )
        )
        socket_connection = websockets.connect(
            ws_url,
            subprotocols=[f"omnesis-token.{self._credentials.delivery_token}"],
            ssl=_ssl_context(self._credentials),
            open_timeout=15,
            max_size=MAX_FRAME_BYTES,
        )
        async with socket_connection as websocket:
            self._socket = websocket
            transport = getattr(websocket, "transport", None)
            ssl_object = transport.get_extra_info("ssl_object") if transport else None
            _verify_leaf(ssl_object, self._credentials.leaf_fingerprint_sha256)
            hello_id = f"hermes-{time.time_ns()}"
            await websocket.send(
                json.dumps(
                    {
                        "kind": "command",
                        "id": hello_id,
                        "type": "hello",
                        "payload": {
                            "protocolVersion": PROTOCOL_VERSION,
                            "capabilities": {
                                "hostname": "hermes",
                                "platform": "hermes",
                                # Omitted rather than guessed when the manifest
                                # cannot be read: the ledger renders a missing
                                # version as unknown, which is the truth.
                                **({"version": ADAPTER_VERSION} if ADAPTER_VERSION else {}),
                                **(
                                    {"sourceCommit": ADAPTER_SOURCE_COMMIT}
                                    if ADAPTER_SOURCE_COMMIT
                                    else {}
                                ),
                                "agentIntegration": {
                                    "harness": "hermes",
                                    "deliveryProtocolMin": DELIVERY_PROTOCOL_MIN_VERSION,
                                    "deliveryProtocolMax": DELIVERY_PROTOCOL_VERSION,
                                    "maxConcurrentRuns": 1,
                                    "watchPrivacyPolicyVersion": 1,
                                },
                            },
                        },
                    },
                    separators=(",", ":"),
                )
            )
            await asyncio.wait_for(
                self._await_hello_response(websocket, hello_id),
                timeout=_HELLO_HANDSHAKE_TIMEOUT_SECONDS,
            )
            async for raw in websocket:
                await self._handle_frame(websocket, raw)
        self._socket = None

    async def _await_hello_response(self, websocket: Any, hello_id: str) -> None:
        """Read until the frame that answers this hello, not merely the first.

        The gateway heartbeats every open connection on a fixed timer, so a
        `ping` event routinely arrives in the window between the hello being
        sent and its response coming back. Treating whatever arrives first as
        the answer reads that heartbeat as a rejected hello — and since the
        reconnect backoff settles at the same period as the heartbeat, the two
        keep step and every attempt meets the same ping, which is a connection
        that never establishes rather than one that occasionally stumbles.

        Frames that arrive ahead of the answer get exactly the handling the
        main loop gives them, so a delivery that arrives early is served
        rather than dropped for being early.

        Only the correlation is matched here. A frame that answers this hello
        and is malformed is a protocol violation and still fails the
        connection, because the question this settles is which frame is the
        answer, not whether the answer is acceptable.
        """
        while True:
            raw = await websocket.recv()
            frame: Any = None
            if isinstance(raw, str) and len(raw.encode("utf-8")) <= MAX_FRAME_BYTES:
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    frame = None
            if isinstance(frame, dict) and frame.get("correlationId") == hello_id:
                _validate_hello_response(frame, hello_id)
                return
            await self._handle_frame(websocket, raw)

    async def _handle_frame(self, websocket: Any, raw: Any) -> None:
        correlation_id = ""
        command_type = ""
        delivery_id = ""
        try:
            if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
                raise ValueError("invalid frame")
            frame = json.loads(raw)
            if not isinstance(frame, dict):
                raise ValueError("invalid frame")
            correlation_id = frame.get("id", "")
            if (
                set(frame) != {"kind", "id", "type", "payload"}
                or frame.get("kind") != "command"
                or not isinstance(correlation_id, str)
                or not correlation_id
            ):
                raise ValueError("invalid integration command")
            command_type = frame.get("type")
            if command_type == "subscription.prepare":
                delivery = _validate_delivery(frame["payload"])
                if delivery["answer"]["expiresAt"] <= int(time.time() * 1000):
                    await self._send_error(websocket, correlation_id, "expired")
                    return
                result = await self._prepare_delivery(delivery)
            elif command_type == "subscription.commit":
                delivery_id = _validate_delivery_control(frame["payload"])
                result = await self._commit_delivery(delivery_id)
            elif command_type == "subscription.cancel":
                delivery_id = _validate_delivery_control(frame["payload"])
                async with self._delivery_lock:
                    assert self._state is not None
                    result = self._state.cancel(delivery_id)
            elif command_type == "answer-completion.prepare":
                delivery = _validate_answer_completion_delivery(frame["payload"])
                async with self._delivery_lock:
                    assert self._state is not None
                    result = self._state.prepare_answer_completion(delivery)
            elif command_type == "answer-completion.commit":
                delivery_id = _validate_delivery_control(frame["payload"])
                result = await self._commit_answer_completion(delivery_id)
            elif command_type == "answer-completion.cancel":
                delivery_id = _validate_delivery_control(frame["payload"])
                async with self._delivery_lock:
                    assert self._state is not None
                    result = self._state.cancel_answer_completion(delivery_id)
            elif command_type == "device.update":
                target = _validate_update_command(frame["payload"])
                await self._start_self_update(websocket, correlation_id, target)
                return
            else:
                await self._send_error(websocket, correlation_id, "unsupported")
                return
            await self._send_result(websocket, correlation_id, result)
        except DeliveryConflictError:
            if correlation_id:
                await self._send_error(websocket, correlation_id, "delivery_conflict")
        except AmbiguousDeliveryError:
            if correlation_id:
                await self._send_error(websocket, correlation_id, "ambiguous_start")
        except DeliveryNotPreparedError:
            if correlation_id:
                await self._send_error(websocket, correlation_id, "not_prepared")
        except DeliveryCancelledError:
            if correlation_id:
                await self._send_error(websocket, correlation_id, "cancelled")
        except DeliveryAuthorityExpiredError:
            if correlation_id:
                await self._send_error(websocket, correlation_id, "expired")
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            if correlation_id:
                await self._send_error(websocket, correlation_id, "invalid_payload")
        except Exception:
            if correlation_id:
                parked_ambiguous = (
                    command_type == "subscription.commit"
                    and bool(delivery_id)
                    and self._state is not None
                    and self._state.delivery_state(delivery_id) == "starting"
                )
                await self._send_error(
                    websocket,
                    correlation_id,
                    (
                        "ambiguous_start"
                        if parked_ambiguous
                        else "prepare_failed"
                        if command_type == "subscription.prepare"
                        else "retryable_start_failure"
                    ),
                )

    async def _start_self_update(
        self, websocket: Any, correlation_id: str, target: Dict[str, str]
    ) -> None:
        """Acknowledge an update command and start the work behind it.

        The answer is a receipt: the update is minutes of install work, far
        past any command timeout, so it runs as its own task and the frame
        loop moves on. The outcome arrives as a `device.update.result` event.
        An install then restarts Hermes, which lets in-flight runs finish
        first: the result goes out and leaves the write buffer before the
        restart is requested, because the restart ends this process.
        """
        label = _update_target_label(target)
        if "version" in target and ADAPTER_VERSION is not None and target["version"] == ADAPTER_VERSION:
            await self._send_result(
                websocket,
                correlation_id,
                {"accepted": False, "reason": f"Already running {label}."},
            )
            return
        if self._self_update_task is not None:
            await self._send_result(
                websocket,
                correlation_id,
                {
                    "accepted": False,
                    "reason": "An update is already running on this machine.",
                },
            )
            return
        await self._send_result(websocket, correlation_id, {"accepted": True})
        self._self_update_task = asyncio.create_task(
            self._run_self_update(websocket, target), name="omnesis-self-update"
        )

    async def _run_self_update(
        self, websocket: Any, target: Dict[str, str] | str
    ) -> None:
        target = _normalise_update_target(target)
        label = _update_target_label(target)
        try:
            updater_target: Any = target["version"] if "version" in target else target
            attempt = await self._self_updater(updater_target)
        except Exception as error:
            attempt = {
                "state": "failed",
                "detail": _truncate_utf16(str(error), _MAX_UPDATE_DETAIL),
            }
        finally:
            self._self_update_task = None
        # Sent on the socket the command arrived on: a result that outlived its
        # connection belongs to an adapter the gateway will ask again.
        if self._socket is websocket:
            await self._send_update_result(
                websocket, target, attempt["state"], attempt.get("detail")
            )
        # An adapter being disconnected belongs to a Hermes already on its way
        # down; the plugin on disk loads when it starts again.
        if attempt["state"] != "installed" or self._stop.is_set():
            return
        task = asyncio.create_task(
            self._restart_harness(websocket, target), name="omnesis-hermes-restart"
        )
        self._restart_tasks.add(task)
        task.add_done_callback(self._restart_tasks.discard)

    async def _restart_harness(self, websocket: Any, target: Dict[str, str]) -> None:
        """Ask Hermes for the planned restart that loads an installed plugin.

        Its own task, which `disconnect()` does not await: the restart
        disconnects this adapter, and waiting on it from there would deadlock
        the shutdown it requested. A signal that cannot be sent, or a Hermes
        still running after `PLANNED_RESTART_WAIT_SECONDS`, turns the result
        into `restart-pending`, naming the command the operator runs instead.
        Once the adapter is stopping the restart is under way, and nothing more
        is reported.
        """
        reason = self._restart_unavailable(self._restart_signal)
        if reason is None:
            logger.info(
                "Omnesis plugin %s installed; restarting Hermes through its planned "
                "restart (SIGUSR1)",
                _update_target_label(target),
            )
            try:
                self._restart_kill(self._restart_pid(), self._restart_signal)
            except OSError as error:
                reason = f"SIGUSR1 could not be sent ({error})"
        if reason is None:
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._restart_wait_seconds)
                return
            except asyncio.TimeoutError:
                reason = (
                    f"hermes was still running {round(self._restart_wait_seconds)} "
                    "seconds after SIGUSR1 asked it to restart"
                )
        await self._report_restart_owed(websocket, target, reason)

    async def _report_restart_owed(
        self, websocket: Any, target: Dict[str, str], reason: str
    ) -> None:
        if self._stop.is_set() or self._socket is not websocket:
            return
        detail = _restart_owed_detail(_update_target_label(target), reason)
        logger.warning("Hermes restart failed: %s", detail)
        await self._send_update_result(websocket, target, "restart-pending", detail)

    @staticmethod
    async def _send_update_result(
        websocket: Any, target: Dict[str, str], state: str, detail: Optional[str]
    ) -> None:
        """Send a `device.update.result` and wait for it to leave the buffer."""
        # The result names the target only: the gateway's schema is strict.
        named = {"version": target["version"]} if "version" in target else {"commit": target["commit"]}
        payload: Dict[str, Any] = {**named, "state": state}
        if detail is not None:
            payload["detail"] = detail
        try:
            await websocket.send(
                json.dumps(
                    {"kind": "event", "type": "device.update.result", "payload": payload},
                    separators=(",", ":"),
                )
            )
        except Exception as error:
            logger.warning("Could not report the Omnesis update result: %s", error)
            return
        transport = getattr(websocket, "transport", None)
        if transport is None:
            return
        deadline = time.monotonic() + _RESULT_WRITE_TIMEOUT_SECONDS
        while transport.get_write_buffer_size() > 0 and time.monotonic() < deadline:
            await asyncio.sleep(0.01)

    @staticmethod
    async def _send_result(websocket: Any, correlation_id: str, result: Any) -> None:
        await websocket.send(
            json.dumps(
                {
                    "kind": "response",
                    "correlationId": correlation_id,
                    "ok": True,
                    "result": result,
                },
                separators=(",", ":"),
            )
        )

    @staticmethod
    async def _send_error(websocket: Any, correlation_id: str, code: str) -> None:
        await websocket.send(
            json.dumps(
                {
                    "kind": "response",
                    "correlationId": correlation_id,
                    "ok": False,
                    "error": {"code": code, "message": "integration delivery rejected"},
                },
                separators=(",", ":"),
            )
        )

    async def _prepare_delivery(self, untrusted: Any) -> Dict[str, Any]:
        delivery = _validate_delivery(untrusted)
        digest = _payload_hash(delivery)
        async with self._delivery_lock:
            assert self._state is not None
            return self._state.prepare(delivery, digest)

    async def _commit_delivery(self, delivery_id: str) -> Dict[str, Any]:
        async with self._delivery_lock:
            assert self._state is not None
            delivery, accepted = self._state.delivery_for_commit(delivery_id)
            if accepted is not None:
                return accepted
            assert delivery is not None
            if delivery["answer"]["expiresAt"] <= int(time.time() * 1000):
                raise DeliveryAuthorityExpiredError(
                    "firing answer authority expired"
                )
            self._state.begin(delivery_id)
            session_id = f"omnesis-{delivery['workflowHandle']}"
            local_run_id = f"hermes:{delivery_id}"
            # Filed before the run rather than after it: the run may end —
            # and report — inside `handle_message` below.
            self._state.record_outcome_authority(delivery, session_id)
            self._begin_outcome_run(
                session_id,
                delivery_id if isinstance(delivery.get("outcome"), dict) else None,
            )
            try:
                source = self.build_source(
                    chat_id=session_id,
                    chat_name=f"Omnesis workflow {delivery['workflowHandle']}",
                    chat_type="dm",
                    user_id="omnesis",
                    user_name="Omnesis",
                    message_id=delivery_id,
                    role_authorized=True,
                )
                event = MessageEvent(
                    text=self._background_prompt(delivery),
                    message_type=MessageType.TEXT,
                    source=source,
                    message_id=delivery_id,
                    raw_message={
                        "deliveryId": delivery["deliveryId"],
                        "firingId": delivery["firingId"],
                        "subscriptionId": delivery["subscriptionId"],
                    },
                    timestamp=datetime.now(tz=timezone.utc),
                    internal=True,
                )
            except Exception as error:
                # No native handler was invoked, so this failure is proven safe
                # to retry after the gateway redelivers.
                self._state.fail(delivery_id, error)
                raise
            try:
                await self.handle_message(event)
                return self._state.finish(delivery, local_run_id, session_id)
            except Exception as error:
                # handle_message may have scheduled the run before returning or
                # raising. Without a durable Hermes receipt, any error from
                # this point onward is ambiguous and must remain parked.
                self._state.park_ambiguous(delivery_id, error)
                raise

    async def _commit_answer_completion(self, delivery_id: str) -> Dict[str, Any]:
        async with self._delivery_lock:
            assert self._state is not None
            delivery, accepted = self._state.answer_completion_for_commit(delivery_id)
            if accepted is not None:
                return accepted
            assert delivery is not None
            self._state.begin_answer_completion(delivery_id)
            try:
                # The delivery is an operational wake. Corpus retrieval still
                # authenticates as the installation's OAuth principal so the
                # current grant and revocation state remain authoritative.
                answer = self._mcp_call_tool(
                    self._credentials.oauth_access_token,
                    "get_answer_status",
                    {"taskId": delivery["taskId"]},
                )
                await self._send_answer_completion(
                    delivery["nativeConversationId"], delivery["taskId"], answer
                )
                return self._state.finish_answer_completion(
                    delivery_id, f"hermes:{delivery_id}"
                )
            except Exception as error:
                # A failed transport call is retryable. The gateway's delivery
                # ledger retains the same completion identity across retries.
                self._state.fail_answer_completion(delivery_id, error)
                raise

    async def _send_answer_completion(
        self, native_conversation_id: str, task_id: str, answer: Any
    ) -> None:
        if not isinstance(answer, dict):
            raise ValueError("Omnesis returned an invalid completion answer")
        assert self._state is not None
        native_session_id = self._state.answer_origin_for_completion(
            native_conversation_id, task_id
        )
        if native_session_id is None:
            raise ValueError("completion is not bound to a Hermes conversation")
        route = self._completion_route(native_session_id)
        if route is None:
            raise ValueError("completion Hermes conversation is unavailable")
        source, chat_id, chat_type, thread_id, profile = route
        if source == "omnesis":
            # A firing wake has no conversation to reply into: its session is
            # one this plugin synthesised, and that adapter's `send` reports
            # success and discards the text. Posting there would mark the
            # delivery accepted while the agent never saw the answer. Re-enter
            # the run instead, the way a wake itself arrives.
            await self._resume_omnesis_session(
                chat_id, native_conversation_id, task_id, answer
            )
            return
        runner = getattr(self, "gateway_runner", None)
        if runner is None:
            raise RuntimeError("Hermes gateway runner is unavailable")
        platform = Platform(source)
        adapter = None
        if profile:
            adapter = getattr(runner, "_profile_adapters", {}).get(profile, {}).get(platform)
        if adapter is None:
            adapter = getattr(runner, "adapters", {}).get(platform)
        if adapter is None:
            raise RuntimeError("Hermes source adapter is unavailable")
        metadata_builder = getattr(runner, "_thread_metadata_for_target", None)
        metadata = (
            metadata_builder(platform, chat_id, thread_id, chat_type=chat_type, adapter=adapter)
            if callable(metadata_builder)
            else {"thread_id": thread_id} if thread_id else None
        )
        result = await adapter.send(
            chat_id, _format_answer_completion(answer), metadata=metadata
        )
        if not getattr(result, "success", False):
            raise RuntimeError("Hermes source adapter rejected the completion send")

    async def _resume_omnesis_session(
        self,
        chat_id: str,
        native_conversation_id: str,
        task_id: str,
        answer: Dict[str, Any],
    ) -> None:
        """Hand a released answer back to the wake run that asked for it.

        The run ended when the gateway said the answer was held, so this is a
        fresh turn in the same session. It is told so explicitly: without that
        framing the model reads an unexplained answer as a new instruction.

        The wait that made the earlier run report `deferred` is over, so this
        turn's own ending reports on its own terms — as the same wake, which
        the answer's own handle identifies among however many of this watch's
        firings are waiting in this session.

        A release that cannot be matched to a waiting wake still re-enters the
        session, because the agent is owed the answer it asked for either way.
        It reports for no firing at all: the wake it belongs to is exactly
        what could not be established, and the alternative — reporting against
        whichever firing the session ran last — files this run's account over
        a sibling's and flips a status nobody here can vouch for.
        """
        assert self._state is not None
        deferred_delivery = self._state.deferred_outcome_delivery(
            chat_id, native_conversation_id
        )
        if deferred_delivery is not None:
            # Cleared before the run begins, so the account this turn files is
            # read as the finished work it is rather than as a wait still
            # outstanding.
            self._state.set_outcome_deferred(deferred_delivery, False)
        self._begin_outcome_run(chat_id, deferred_delivery)
        source = self.build_source(
            chat_id=chat_id,
            chat_name="Omnesis answer completion",
            chat_type="dm",
            user_id="omnesis",
            user_name="Omnesis",
            message_id=f"answer-completion:{task_id}",
            role_authorized=True,
        )
        event = MessageEvent(
            text=(
                "The Omnesis answer you asked for earlier was held for the "
                "user's approval, and they have now approved it. This is that "
                "answer — it is the reply to your earlier question, not a new "
                "request:\n\n" + _format_answer_completion(answer)
            ),
            message_type=MessageType.TEXT,
            source=source,
            message_id=f"answer-completion:{task_id}",
            raw_message={"taskId": task_id},
            timestamp=datetime.now(tz=timezone.utc),
            internal=True,
        )
        await self.handle_message(event)

    @staticmethod
    def _completion_route(
        native_session_id: str,
    ) -> Optional[tuple[str, str, Optional[str], Optional[str], Optional[str]]]:
        state_db = _hermes_home() / "state.db"
        if not state_db.exists():
            return None
        connection = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=5)
        try:
            try:
                row = connection.execute(
                    """
                    SELECT source, chat_id, chat_type, thread_id, profile_name
                    FROM sessions WHERE id = ?
                    """,
                    (native_session_id,),
                ).fetchone()
            except sqlite3.Error:
                row = connection.execute(
                    "SELECT source, chat_id FROM sessions WHERE id = ?",
                    (native_session_id,),
                ).fetchone()
        finally:
            connection.close()
        if not row or not isinstance(row[0], str) or not isinstance(row[1], str):
            return None
        source = row[0].strip().lower()
        chat_id = row[1].strip()
        if not source or not chat_id or source in {"omnesis", "cli"}:
            return None
        chat_type = row[2] if len(row) > 2 and isinstance(row[2], str) else None
        thread_id = row[3] if len(row) > 3 and isinstance(row[3], str) else None
        profile = row[4] if len(row) > 4 and isinstance(row[4], str) else None
        return source, chat_id, chat_type, thread_id, profile

    @staticmethod
    def _bindings_section(bindings: Dict[str, str]) -> list[str]:
        """The author's referents, laid out so the instruction's nouns resolve.

        An instruction is prose written by someone who knew which conversation,
        address or record they meant. Without these the woken run has to guess,
        and a guess either lands somewhere wrong or the work is done and
        dropped.
        """
        if not bindings:
            return []
        return [
            "",
            "The instruction above refers to these resources. They are the real "
            "ones — use them exactly as given rather than searching for or "
            "inventing your own:",
            *(f"- {key}: {value}" for key, value in bindings.items()),
        ]

    @staticmethod
    def _background_prompt(delivery: Dict[str, Any]) -> str:
        return "\n".join(
            [
                f"Omnesis workflow {delivery['workflowHandle']} received firing "
                f"{delivery['firingId']}.",
                "",
                "Follow this exact subscriber-authored reaction instruction:",
                delivery["reaction"]["instruction"],
                *OmnesisAdapter._bindings_section(_delivery_bindings(delivery)),
                "",
                "The wake intentionally contains no private corpus detail. Use the "
                "Omnesis subscription-answer tool to learn what caused the firing.",
                "For a catalog-backed SQL watch, Answer only confirms that the "
                "approved condition became true; it never returns query rows or "
                "computed values.",
                "This is a dedicated background session. Do not send output to an "
                "unrelated human chat.",
                "Notify the user only when and how the reaction instruction calls for it.",
                "",
                "Nobody is reading this session. Every effect the instruction asks "
                "for — a message, an email, a filed record — happens only if you "
                "make the tool call that causes it. When you end your turn with "
                "text, that text is not delivered to anyone: it is reported to "
                "Omnesis as this run's account of what you did. Write it as that "
                "account, and never as the notification itself.",
            ]
        )

    async def _ingestion_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._sweep_transcripts()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning("Omnesis transcript sweep failed: %s", error)
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=SWEEP_SECONDS)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    async def _sweep_transcripts(self) -> None:
        assert self._state is not None
        while not self._stop.is_set():
            since = self._state.cursor("hermes")
            messages, maximum = await asyncio.to_thread(
                _read_transcript_page, _hermes_home() / "state.db", since
            )
            if maximum == since:
                return
            if messages:
                await asyncio.to_thread(self._post_messages, messages)
            self._state.set_cursor("hermes", maximum)
            if maximum - since < PAGE_SIZE:
                return

    def _post_messages(self, messages: list[dict]) -> None:
        assert self._credentials is not None
        parsed = urllib.parse.urlparse(self._credentials.gateway_url)
        body = json.dumps({"messages": messages}, separators=(",", ":")).encode()
        headers = {
            "Authorization": f"Bearer {self._credentials.ingestion_token}",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        }
        if parsed.scheme == "https":
            connection: Any = http.client.HTTPSConnection(
                parsed.hostname,
                parsed.port or 443,
                context=_ssl_context(self._credentials),
                timeout=GATEWAY_TIMEOUT_SECONDS,
            )
            connection.connect()
            _verify_leaf(
                connection.sock, self._credentials.leaf_fingerprint_sha256
            )
        else:
            connection = http.client.HTTPConnection(
                parsed.hostname, parsed.port or 80, timeout=GATEWAY_TIMEOUT_SECONDS
            )
        try:
            base_path = parsed.path.rstrip("/")
            connection.request("POST", f"{base_path}/agent-messages", body, headers)
            response = connection.getresponse()
            response.read()
            if not 200 <= response.status < 300:
                raise ConnectionError(f"Omnesis ingestion returned HTTP {response.status}")
        finally:
            connection.close()

    def answer_subscription(
        self, args: Dict[str, Any], session_id: Optional[str]
    ) -> str:
        firing_id = args.get("firingId")
        question = args.get("question")
        if (
            not isinstance(session_id, str)
            or not session_id
            or not isinstance(firing_id, str)
            or not firing_id
            or not isinstance(question, str)
            or not question
        ):
            return json.dumps({"error": "invalid Omnesis subscription-answer input"})
        state_db = _hermes_home() / "state.db"
        if not state_db.exists() or not self._ensure_tool_resources():
            return json.dumps({"error": "Omnesis integration is unavailable"})
        if not self._subscriptions_available():
            return json.dumps(
                {"error": "Omnesis Watches are unavailable on this gateway"}
            )
        connection = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=5)
        try:
            row = connection.execute(
                "SELECT source, chat_id FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        finally:
            connection.close()
        if not row or row[0] != "omnesis" or not isinstance(row[1], str):
            return json.dumps(
                {"error": "this Hermes session has no Omnesis firing authority"}
            )
        authority = self._state.authority_for_chat(row[1], firing_id)
        if authority is None:
            return json.dumps(
                {"error": "this firing is not bound to the invoking Hermes session"}
            )
        endpoint, token = authority
        request_id = _firing_answer_request_id(endpoint, question)
        # Where an answer held for approval is delivered once released. This
        # tool call ends the moment the gateway says it is held, so without a
        # route the approval lands later with nowhere to go. Filed against this
        # session before the ask, through the same origin store an ordinary
        # answer uses — a firing wake has no conversation to reply into, so the
        # destination is the session that asked. The gateway binds the handle
        # to the authenticated device: it says which run to resume, never who
        # may be resumed.
        # A short-lived connection rather than the gateway-thread one: Hermes
        # runs native-tool handlers on an agent-worker thread, and the
        # long-lived state connection belongs to the event-loop thread.
        answer_state = DurableState(self._state.path)
        try:
            native_conversation_id = answer_state.prepare_answer_origin(
                request_id, session_id
            )
        except DeliveryConflictError:
            # The same firing asked the same question from another session.
            # Every other failure here answers with JSON; an exception escaping
            # the handler would surface as a tool crash instead.
            return json.dumps(
                {"error": "this firing ask is bound to another Hermes session"}
            )
        finally:
            answer_state.close()
        body = {
            "question": question,
            "clientRequestId": request_id,
            "nativeConversationId": native_conversation_id,
        }
        try:
            answer = self._await_answer(endpoint, token, body)
        except AnswerPendingError as pending:
            return json.dumps({"pending": True, "agentGuidance": str(pending)})
        except Exception:
            logger.warning("Omnesis subscription answer request failed")
            return json.dumps({"error": "Omnesis subscription answer request failed"})
        # A held answer ends this run: it stops here and the release re-enters
        # it later. That is a run still in progress, not one that finished, and
        # the outcome it reports has to say so.
        if isinstance(answer, dict) and answer.get("status") == "approval_required":
            # Marked against the wake that asked, found through the firing the
            # ask named: a sibling firing of the same watch shares this session
            # but is not the run that is waiting. The handle of the answer
            # being held goes with it, so the release that arrives later
            # resolves back to this wake and no other.
            deferring = self._state.outcome_delivery_for_firing(firing_id, row[1])
            if deferring is not None:
                self._state.set_outcome_deferred(
                    deferring, True, native_conversation_id
                )
        guidance = _describe_answer_outcome(answer)
        if guidance is not None:
            answer = {**answer, "agentGuidance": guidance}
        return json.dumps(answer, ensure_ascii=False)

    def answer(self, args: Dict[str, Any], session_id: Optional[str]) -> str:
        """Ask an ordinary question while retaining the trusted Hermes origin."""
        question = args.get("question")
        # Threaded from what Omnesis minted earlier in this run, never taken
        # from the model: these identifiers mean nothing outside Omnesis, and
        # the ones a model holds belong to the harness. A wrong one names
        # something that does not exist and is rejected as not-found.
        # Only a scheduled run carries a workflow forward: its bounds are one
        # firing, whereas a conversation lasts as long as someone keeps
        # talking. Only the workflow is carried, never the answer
        # conversation — a conversation admits one active task, so reusing one
        # still holding an approval would refuse every later ask until a human
        # resolved it. A workflow with no conversation mints a fresh one.
        conversation_id = None
        if (
            not isinstance(session_id, str)
            or not session_id
            or not isinstance(question, str)
            or not question.strip()
            or len(question) > 10_000
        ):
            return json.dumps({"error": "invalid Omnesis answer input"})
        if not self._ensure_tool_resources():
            return json.dumps({"error": "Omnesis integration is unavailable"})
        assert self._credentials is not None
        if self._credentials.oauth_access_token is None:
            return json.dumps(_answer_failure_payload(GatewayHttpError(401)))
        identity = self._session_identity(session_id)
        if identity is None or identity[0] == "omnesis":
            return json.dumps(
                {"error": "Omnesis answers require an active Hermes conversation"}
            )
        # Hermes names a scheduled session `cron_<job>_<timestamp>`, so its id
        # is already distinct per run: today's run and tomorrow's ask the same
        # question as two different asks rather than one served from a cache.
        scheduled = identity[0] == "cron"
        carried = self._thread_for_ask(session_id, question) if scheduled else None
        pending_key = (session_id, question)
        request_id = self._pending_answer_requests.get(pending_key)
        if request_id is None:
            request_id = _ordinary_answer_request_id(
                session_id,
                question,
                conversation_id,
                None if scheduled else uuid.uuid4().hex,
                carried,
            )
        # Hermes runs native-tool handlers on an agent-worker thread, while
        # the long-lived state connection belongs to the gateway event-loop
        # thread. Use a short-lived WAL connection here rather than crossing
        # SQLite's thread boundary. Completion delivery continues to resolve
        # the origin through the gateway-thread connection after this commits.
        answer_state = DurableState(self._state.path)
        try:
            native_conversation_id = answer_state.prepare_answer_origin(
                request_id, session_id
            )
            common = {
                "question": question,
                **({"conversationId": conversation_id} if conversation_id else {}),
                **({"workflowId": carried} if carried else {}),
                "workflowName": (
                    "Hermes scheduled run" if scheduled else "Hermes conversation"
                ),
                **({"approval": "never"} if scheduled else {}),
            }
            answer = self._await_mcp_answer(
                self._credentials.oauth_access_token,
                {**common, "requestId": request_id},
                {
                    MCP_NATIVE_CONVERSATION_META_KEY: native_conversation_id,
                },
            )
            if isinstance(answer, dict) and isinstance(answer.get("taskId"), str):
                answer_state.bind_answer_task(request_id, answer["taskId"])
            if scheduled and isinstance(answer, dict):
                self._record_ask(session_id, question, carried)
                self._remember_run_thread(session_id, answer)
        except DeliveryConflictError:
            self._pending_answer_requests.pop(pending_key, None)
            return json.dumps({"error": "Omnesis answer origin conflict"})
        except AnswerPendingError as pending:
            self._pending_answer_requests[pending_key] = request_id
            return json.dumps({"pending": True, "agentGuidance": str(pending)})
        except GatewayHttpError as failure:
            # Say which refusal it was. Without the status and code, a
            # capacity refusal, a timeout and a malformed reply all reach
            # the model as the same sentence, and it reports the whole
            # service as down.
            logger.warning(
                "Omnesis answer request failed: HTTP %s%s",
                failure.status,
                f" ({failure.code})" if failure.code else "",
                exc_info=True,
            )
            self._pending_answer_requests.pop(pending_key, None)
            return json.dumps(_answer_failure_payload(failure))
        except Exception:
            self._pending_answer_requests.pop(pending_key, None)
            logger.warning("Omnesis answer request failed", exc_info=True)
            return json.dumps({"error": "Omnesis answer request failed"})
        finally:
            answer_state.close()
        self._pending_answer_requests.pop(pending_key, None)
        if not isinstance(answer, dict):
            return json.dumps({"error": "Omnesis returned an invalid answer"})
        if answer.get("status") == "approval_required":
            answer = {
                **answer,
                "agentGuidance": (
                    "Omnesis is holding this answer for the user's approval. "
                    "The resolved result will be delivered to this Hermes "
                    "conversation automatically; do not ask the user to wake you."
                ),
            }
        else:
            guidance = _describe_answer_outcome(answer)
            if guidance is not None:
                answer = {**answer, "agentGuidance": guidance}
        return json.dumps(answer, ensure_ascii=False)

    def _thread_for_ask(self, session_id: str, question: str) -> Optional[str]:
        """The workflow this ask must be sent under.

        A question already asked in this run is re-sent under the workflow it
        was first sent under, so repeating it stays the same ask rather than
        becoming a new one that buys a second agent turn. A new question joins
        whatever the run has minted so far.
        """
        thread = self._run_threads.get(session_id)
        if not thread:
            return None
        asks = thread.get("asks", {})
        if question in asks:
            return asks[question]
        return thread.get("workflowId")

    def _record_ask(
        self, session_id: str, question: str, workflow_id: Optional[str]
    ) -> None:
        thread = self._run_threads.pop(session_id, None) or {"asks": {}}
        while len(self._run_threads) >= self.MAX_TRACKED_RUNS:
            self._run_threads.pop(next(iter(self._run_threads)))
        thread.setdefault("asks", {}).setdefault(question, workflow_id)
        self._run_threads[session_id] = thread

    def _remember_run_thread(self, session_id: str, answer: Dict[str, Any]) -> None:
        """Adopt the workflow this run's first answer minted."""
        workflow_id = answer.get("workflowId")
        if not isinstance(workflow_id, str) or not workflow_id:
            return
        thread = self._run_threads.get(session_id)
        if thread is not None and not thread.get("workflowId"):
            thread["workflowId"] = workflow_id

    def _forget_run_thread(self, session_id: str) -> None:
        """Stop carrying a workflow the gateway refused.

        It can be deleted, expire or close while a run is still going, and a
        carried identifier that has gone bad would refuse every remaining ask
        identically. Dropping it lets the next ask mint a fresh workflow.
        """
        self._run_threads.pop(session_id, None)

    def _await_answer(
        self, endpoint: str, token: str, body: Dict[str, Any]
    ) -> Any:
        """Post one ask and wait it out without ever paying for it twice.

        Repeating the request is how you wait. The request id is derived from
        the ask, so every repeat — after the socket budget elapsed, or after
        the gateway said the turn is still running — lands on the turn already
        running instead of buying a second one. Both asks use this: a firing
        answer bound to the wake that arrived, and an ordinary question from a
        conversation or a scheduled run.
        """
        return self._await_answer_attempts(
            lambda timeout: self._post_json(endpoint, token, body, timeout=timeout)
        )

    def _await_mcp_answer(
        self,
        token: str,
        arguments: Dict[str, Any],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Call the canonical stateless Answer MCP tool with retry identity intact."""
        return self._await_answer_attempts(
            lambda timeout: self._mcp_call_tool(
                token,
                "ask_omnesis",
                arguments,
                metadata,
                timeout,
            )
        )

    def _await_answer_attempts(self, attempt_call: Any) -> Any:
        """Wait out one idempotent Answer operation through either transport."""
        started_at = time.monotonic()
        deadline = started_at + ANSWER_DEADLINE_SECONDS
        interval = _ANSWER_POLL_MIN_SECONDS
        retries_left = _TRANSIENT_RETRY_LIMIT
        attempt = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AnswerPendingError(time.monotonic() - started_at)
            budget = min(
                ANSWER_SUBMIT_TIMEOUT_SECONDS
                if attempt == 0
                else ANSWER_POLL_TIMEOUT_SECONDS,
                remaining,
            )
            attempt += 1
            try:
                return attempt_call(budget)
            except Exception as error:
                if not _answer_still_running(error):
                    if retries_left <= 0 or not _worth_another_attempt(error):
                        raise
                    retries_left -= 1
                    if deadline - time.monotonic() <= 0:
                        raise
                    time.sleep(_TRANSIENT_RETRY_DELAY_SECONDS)
                    continue
                until_deadline = deadline - time.monotonic()
                if until_deadline <= 0:
                    raise AnswerPendingError(
                        time.monotonic() - started_at
                    ) from None
                time.sleep(min(interval, until_deadline))
                interval = min(interval * 2, _ANSWER_POLL_MAX_SECONDS)

    def _mcp_call_tool(
        self,
        token: str,
        name: str,
        arguments: Dict[str, Any],
        metadata: Optional[Dict[str, Any]] = None,
        timeout: float = GATEWAY_TIMEOUT_SECONDS,
    ) -> Dict[str, Any]:
        """Make one dependency-free modern stateless MCP tool call.

        Hermes already owns the pinned HTTP/TLS transport. Keeping the tiny
        modern envelope here avoids adding an MCP runtime (and its lifecycle)
        to a Python plugin that needs exactly two tools on one fixed server.
        """
        if name not in {"ask_omnesis", "get_answer_status"}:
            raise ValueError("unsupported Omnesis MCP tool")
        if not isinstance(arguments, dict):
            raise ValueError("Omnesis MCP arguments must be an object")
        request_meta: Dict[str, Any] = {
            MCP_PROTOCOL_VERSION_META_KEY: MCP_PROTOCOL_VERSION,
            MCP_CLIENT_CAPABILITIES_META_KEY: {},
        }
        if metadata is not None:
            if set(metadata) != {MCP_NATIVE_CONVERSATION_META_KEY}:
                raise ValueError("unsupported Omnesis MCP request metadata")
            request_meta[MCP_NATIVE_CONVERSATION_META_KEY] = _validate_handle(
                metadata[MCP_NATIVE_CONVERSATION_META_KEY],
                "nativeConversationId",
            )
        result = self._mcp_request(
            token,
            "tools/call",
            {
                "name": name,
                "arguments": arguments,
                "_meta": request_meta,
            },
            timeout,
            name,
        )
        if result.get("isError") is True:
            metadata_value = result.get("_meta")
            error_value = (
                metadata_value.get(MCP_ANSWER_ERROR_META_KEY)
                if isinstance(metadata_value, dict)
                else None
            )
            if (
                not isinstance(error_value, dict)
                or "status" not in error_value
                or not set(error_value) <= {"status", "code", "taskId"}
                or not isinstance(error_value.get("status"), int)
                or isinstance(error_value["status"], bool)
                or error_value["status"] not in _ANSWER_MCP_ERROR_STATUSES
                or (
                    "code" in error_value
                    and (
                        not isinstance(error_value["code"], str)
                        or error_value["code"] not in _ANSWER_MCP_ERROR_CODES
                    )
                )
                or (
                    "taskId" in error_value
                    and (
                        not isinstance(error_value["taskId"], str)
                        or not re.fullmatch(
                            r"[A-Za-z0-9_.:-]{1,160}", error_value["taskId"]
                        )
                    )
                )
            ):
                raise McpProtocolError("Omnesis returned an invalid MCP tool error")
            raise GatewayHttpError(
                error_value["status"], None, error_value.get("code")
            )
        return _validate_answer_response(result.get("structuredContent"))

    def _mcp_request(
        self,
        token: str,
        method: str,
        params: Dict[str, Any],
        timeout: float,
        name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send one modern stateless MCP request over the pinned HTTP seam."""
        is_principal_credential = (
            isinstance(self._credentials, Credentials)
            and token == self._credentials.oauth_access_token
        )
        call_id = f"hermes-{uuid.uuid4().hex}"
        payload = {
            "jsonrpc": "2.0",
            "id": call_id,
            "method": method,
            "params": params,
        }
        headers = {
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
            "Mcp-Method": method,
            **({"Mcp-Name": name} if name else {}),
        }
        try:
            response = self._request_json(
                "POST", MCP_ANSWER_ENDPOINT, token, payload, timeout, headers
            )
        except GatewayHttpError as error:
            if error.status != 401:
                raise
            # Only the persisted principal credential is valid at /mcp. Never
            # turn an arbitrary bearer into the installation's OAuth identity.
            if not is_principal_credential:
                raise
            token = self._refresh_oauth_token(token)
            response = self._request_json(
                "POST", MCP_ANSWER_ENDPOINT, token, payload, timeout, headers
            )
        if (
            not isinstance(response, dict)
            or response.get("jsonrpc") != "2.0"
            or response.get("id") != call_id
        ):
            raise McpProtocolError("Omnesis returned an invalid MCP response")
        if "error" in response:
            if set(response) != {"jsonrpc", "id", "error"}:
                raise McpProtocolError("Omnesis returned an invalid MCP error")
            raise McpProtocolError("Omnesis rejected the MCP request")
        if set(response) != {"jsonrpc", "id", "result"}:
            raise McpProtocolError("Omnesis returned an invalid MCP result")
        result = response.get("result")
        if not isinstance(result, dict):
            raise McpProtocolError("Omnesis returned an invalid MCP result payload")
        return result

    def _refresh_oauth_token(self, stale_access_token: str) -> str:
        """Refresh the principal credential and atomically persist it for later runs."""
        with self._oauth_refresh_lock:
            lock_path = Path(f"{self._credential_path}.refresh.lock")
            descriptor = _acquire_refresh_lock(lock_path)
            try:
                persisted = _load_credentials(self._credential_path)
                self._credentials = persisted
                if self._credentials.oauth_access_token != stale_access_token:
                    if self._credentials.oauth_access_token is None:
                        raise McpProtocolError("Omnesis corpus authorization needs repair")
                    return self._credentials.oauth_access_token
                return self._refresh_oauth_token_locked()
            finally:
                _release_owned_refresh_lock(lock_path, descriptor)

    def _refresh_oauth_token_locked(self) -> str:
        """Refresh while holding ``_oauth_refresh_lock`` so rotation cannot race."""
        assert self._credentials is not None
        if (
            self._credentials.oauth_refresh_token is None
            or self._credentials.oauth_client_id is None
        ):
            raise McpProtocolError(
                "Omnesis corpus authorization needs repair. "
                "Run `omnesis connect hermes --refresh` on this machine."
            )
        raw = json.loads(self._credential_path.read_text(encoding="utf-8"))
        resource = _oauth_resource(raw, self._credentials.gateway_url)
        token_endpoint = _oauth_token_endpoint(raw, self._credentials.gateway_url)
        parsed = urllib.parse.urlparse(token_endpoint)
        gateway = urllib.parse.urlparse(self._credentials.gateway_url)
        body = urllib.parse.urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": self._credentials.oauth_refresh_token,
                "client_id": self._credentials.oauth_client_id,
                "resource": resource,
            }
        ).encode("ascii")
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": str(len(body)),
            "Accept": "application/json",
        }
        if parsed.scheme == "https":
            same_gateway_origin = _normalized_url_origin(parsed) == _normalized_url_origin(gateway)
            connection: Any = http.client.HTTPSConnection(
                parsed.hostname,
                parsed.port or 443,
                context=(
                    _ssl_context(self._credentials)
                    if same_gateway_origin
                    else ssl.create_default_context()
                ),
                timeout=GATEWAY_TIMEOUT_SECONDS,
            )
            connection.connect()
            # The operational gateway keeps its paired leaf pin. A distinct
            # authorization server discovered from that pinned gateway uses
            # ordinary CA and hostname validation, as OAuth permits.
            if same_gateway_origin:
                _verify_leaf(connection.sock, self._credentials.leaf_fingerprint_sha256)
        else:
            connection = http.client.HTTPConnection(
                parsed.hostname, parsed.port or 80, timeout=GATEWAY_TIMEOUT_SECONDS
            )
        # A refresh token that rotated out, expired, or was revoked comes back
        # as an OAuth error, not a transport failure. That is the cliff a quiet
        # installation falls off, and the browser redirect that would repair it
        # is the one thing this adapter cannot perform — so that one case falls
        # through to the headless re-issue instead of ending the call.
        spent_refresh_token = False
        refreshed: Any = None
        try:
            connection.request("POST", parsed.path, body, headers)
            response = connection.getresponse()
            response_body = response.read(MAX_FRAME_BYTES + 1)
            if not 200 <= response.status < 300:
                failure = _gateway_http_error(response.status, response_body)
                # Only `invalid_grant` means the refresh token itself is gone.
                # `invalid_request`, `invalid_client`, a proxy's 401 and the
                # rest are failures of this attempt, and folding them into
                # recovery would hide a permanently broken refresh behind a
                # management token that always succeeds.
                if not _is_invalid_grant(response.status, response_body):
                    raise failure
                spent_refresh_token = True
            else:
                refreshed = json.loads(response_body)
        finally:
            connection.close()
        if spent_refresh_token:
            return self._reissue_oauth_tokens_locked(raw)
        if not isinstance(refreshed, dict) or not isinstance(
            refreshed.get("access_token"), str
        ):
            raise McpProtocolError("Omnesis returned an invalid OAuth refresh response")
        return self._persist_oauth_tokens(raw, refreshed)

    def _reissue_oauth_tokens_locked(self, raw: Dict[str, Any]) -> str:
        """Re-key this device's approved OAuth credential without a browser.

        The device presents the management token it was paired with — an
        authority that cannot read the corpus itself — and the gateway re-keys
        the credential the operator already approved for this exact device. It
        cannot produce a grant nobody approved: with the grant revoked the
        route answers 404 and this raises, naming the interactive repair.
        """
        assert self._credentials is not None
        try:
            reissued = self._request_json(
                "POST",
                "/agent-integration/oauth-reissue",
                self._credentials.management_token,
                {"clientId": self._credentials.oauth_client_id},
            )
        except GatewayHttpError as error:
            # The gateway's own code, not the bare 404: a gateway too old to
            # serve this route answers 404 too, and telling that operator their
            # grant was revoked would send them to repair what is not broken.
            if error.code == _NO_APPROVED_CREDENTIAL:
                raise McpProtocolError(
                    "Omnesis corpus access for this installation is no longer "
                    "authorized. Run `omnesis connect hermes --refresh` on this machine."
                ) from error
            raise
        if not isinstance(reissued, dict) or not isinstance(
            reissued.get("access_token"), str
        ):
            raise McpProtocolError("Omnesis returned an invalid re-issue response")
        return self._persist_oauth_tokens(raw, reissued)

    def _persist_oauth_tokens(
        self, raw: Dict[str, Any], issued: Dict[str, Any]
    ) -> str:
        """Atomically replace the stored token set and return the new bearer."""
        path = self._credential_path
        previous = raw["oauth"]["tokens"]
        rotated = issued.get("refresh_token", previous.get("refresh_token")) != previous.get(
            "refresh_token"
        )
        raw["oauth"]["tokens"] = {
            **previous,
            **issued,
            "refresh_token": issued.get(
                "refresh_token", previous.get("refresh_token")
            ),
        }
        # The stamp measures the ticket's age, not the age of the last write,
        # so it moves only when the refresh token itself was replaced. A server
        # that returns no new one leaves the old one — and its clock — running.
        if rotated:
            raw["oauth"]["tokensObtainedAt"] = int(time.time() * 1000)
        _write_credentials(path, raw)
        self._credentials = _load_credentials(path)
        return self._credentials.oauth_access_token

    def _post_json(
        self,
        endpoint: str,
        token: str,
        value: Dict[str, Any],
        timeout: float = GATEWAY_TIMEOUT_SECONDS,
    ) -> Any:
        return self._request_json("POST", endpoint, token, value, timeout)

    def _request_json(
        self,
        method: str,
        endpoint: str,
        token: str,
        value: Optional[Dict[str, Any]] = None,
        timeout: float = GATEWAY_TIMEOUT_SECONDS,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        assert self._credentials is not None
        parsed = urllib.parse.urlparse(self._credentials.gateway_url)
        body = _encode_json(value) if value is not None else b""
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        }
        if extra_headers:
            headers.update(extra_headers)
        if parsed.scheme == "https":
            connection: Any = http.client.HTTPSConnection(
                parsed.hostname,
                parsed.port or 443,
                context=_ssl_context(self._credentials),
                timeout=timeout,
            )
            connection.connect()
            _verify_leaf(connection.sock, self._credentials.leaf_fingerprint_sha256)
        else:
            connection = http.client.HTTPConnection(
                parsed.hostname, parsed.port or 80, timeout=timeout
            )
        try:
            base_path = parsed.path.rstrip("/")
            connection.request(method, f"{base_path}{endpoint}", body, headers)
            response = connection.getresponse()
            response_body = response.read(MAX_FRAME_BYTES + 1)
            if len(response_body) > MAX_FRAME_BYTES:
                raise ConnectionError("Omnesis answer exceeded 1 MiB")
            if not 200 <= response.status < 300:
                raise _gateway_http_error(response.status, response_body)
            # Not every gateway write answers with a document.
            if not response_body:
                return None
            return _decode_http_json(response_body, response.getheader("Content-Type", ""))
        finally:
            connection.close()

    def _session_identity(
        self, session_id: Optional[str]
    ) -> Optional[tuple[str, str]]:
        if not isinstance(session_id, str) or not session_id:
            return None
        state_db = _hermes_home() / "state.db"
        if not state_db.exists():
            return None
        try:
            connection = sqlite3.connect(
                f"file:{state_db}?mode=ro", uri=True, timeout=5
            )
            try:
                row = connection.execute(
                    "SELECT source, chat_id FROM sessions WHERE id = ?", (session_id,)
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error:
            return None
        if not row or not isinstance(row[0], str):
            return None
        source = row[0].strip().lower()
        chat_id = row[1].strip() if isinstance(row[1], str) else ""
        if not source:
            return None
        return source, chat_id

    def manage_subscriptions(
        self, args: Dict[str, Any], session_id: Optional[str]
    ) -> str:
        if not self._ensure_tool_resources():
            return json.dumps({"error": "Omnesis integration is unavailable"})
        assert self._credentials is not None
        if not self._subscriptions_available():
            return json.dumps(
                {"error": "Omnesis Watches are unavailable on this gateway"}
            )
        if self._credentials.management_token is None:
            return json.dumps(_answer_failure_payload(GatewayHttpError(401)))
        action = args.get("action")
        identifier = args.get("id")
        if action not in {"create", "list", "get", "update", "revoke"}:
            return json.dumps({"error": "unsupported subscription action"})
        identity = self._session_identity(session_id)
        if identity is None:
            return json.dumps(
                {"error": "Omnesis subscription access requires an active Hermes session"}
            )
        if action in {"get", "update", "revoke"} and (
            not isinstance(identifier, str) or not identifier
        ):
            return json.dumps({"error": "id is required for this action"})
        try:
            if action == "list":
                result = self._request_json(
                    "GET", "/subscriptions", self._credentials.management_token
                )
            elif action == "get":
                result = self._request_json(
                    "GET",
                    f"/subscriptions/{urllib.parse.quote(identifier, safe='')}",
                    self._credentials.management_token,
                )
            elif action == "revoke":
                result = self._request_json(
                    "DELETE",
                    f"/subscriptions/{urllib.parse.quote(identifier, safe='')}",
                    self._credentials.management_token,
                )
            elif action == "create":
                condition = args.get("condition")
                reaction = args.get("reaction")
                idempotency_key = args.get("idempotencyKey")
                if (
                    not isinstance(condition, str)
                    or not condition
                    or not isinstance(reaction, str)
                    or not reaction
                    or not isinstance(idempotency_key, str)
                    or len(idempotency_key) < 8
                ):
                    return json.dumps(
                        {
                            "error": (
                                "condition, reaction, and an idempotencyKey of "
                                "at least 8 characters are required"
                            )
                        }
                    )
                body: Dict[str, Any] = {
                    "condition": {
                        "kind": "natural-language",
                        "description": condition,
                    },
                    "reaction": {
                        "kind": "agent-workflow",
                        "instruction": reaction,
                    },
                    "idempotencyKey": idempotency_key,
                }
                try:
                    bindings = _read_manage_bindings(args.get("bindings"))
                except ValueError as error:
                    return json.dumps({"error": str(error)})
                if bindings:
                    body["reaction"]["bindings"] = bindings
                if isinstance(args.get("workflowId"), str):
                    body["workflowId"] = args["workflowId"]
                if isinstance(args.get("expiresAt"), int):
                    body["expiresAt"] = args["expiresAt"]
                result = self._request_json(
                    "POST",
                    "/subscriptions",
                    self._credentials.management_token,
                    body,
                    SUBSCRIPTION_MANAGEMENT_TIMEOUT_SECONDS,
                )
            else:
                expected_revision = args.get("expectedRevision")
                if (
                    not isinstance(expected_revision, int)
                    or isinstance(expected_revision, bool)
                    or expected_revision < 1
                ):
                    return json.dumps(
                        {
                            "error": (
                                "a positive expectedRevision from list or get "
                                "is required for update"
                            )
                        }
                    )
                body = {"expectedRevision": expected_revision}
                if isinstance(args.get("condition"), str):
                    body["condition"] = {
                        "kind": "natural-language",
                        "description": args["condition"],
                    }
                if isinstance(args.get("reaction"), str):
                    body["reaction"] = {
                        "kind": "agent-workflow",
                        "instruction": args["reaction"],
                    }
                if isinstance(args.get("expiresAt"), int) or args.get("expiresAt") is None:
                    if "expiresAt" in args:
                        body["expiresAt"] = args["expiresAt"]
                if args.get("status") in {"active", "paused"}:
                    body["status"] = args["status"]
                if len(body) == 1:
                    return json.dumps(
                        {"error": "at least one subscription update is required"}
                    )
                if "status" in body and any(
                    field in body
                    for field in ("condition", "reaction", "expiresAt")
                ):
                    return json.dumps(
                        {
                            "error": (
                                "change the subscription definition and status "
                                "in separate requests"
                            )
                        }
                    )
                result = self._request_json(
                    "PATCH",
                    f"/subscriptions/{urllib.parse.quote(identifier, safe='')}",
                    self._credentials.management_token,
                    body,
                    SUBSCRIPTION_MANAGEMENT_TIMEOUT_SECONDS,
                )
            return json.dumps(result, ensure_ascii=False)
        except GatewayHttpError as error:
            if action == "update" and error.status == 409:
                return json.dumps(
                    {
                        "error": (
                            "subscription revision conflict; fetch the current "
                            "subscription and ask the user before retrying"
                        ),
                        "code": "revision_conflict",
                    }
                )
            if error.status == 422 and error.gateway_error is not None:
                return json.dumps(error.gateway_error, ensure_ascii=False)
            logger.warning(
                "Omnesis %s declined with HTTP %s", action, error.status
            )
            return json.dumps(
                {
                    "error": (
                        f"Omnesis declined the {action} with HTTP "
                        f"{error.status}. This is a decision, not a blip — read "
                        "it and change the request rather than repeating it."
                    ),
                    "kind": "refused",
                    "status": error.status,
                    **({"code": error.code} if error.code else {}),
                }
            )
        except (socket.timeout, TimeoutError):
            # Not a failure. The gateway is very likely still compiling, and a
            # blind retry is what turns one intent into several subscriptions —
            # a reworded retry carries a different idempotency key by design, so
            # the guard that would have caught it never fires.
            logger.warning("Omnesis %s exceeded its socket budget", action)
            return json.dumps(
                {
                    "error": (
                        f"Omnesis did not answer the {action} within "
                        f"{int(SUBSCRIPTION_MANAGEMENT_TIMEOUT_SECONDS)}s. It may "
                        "still be working: creating a subscription runs a compile "
                        "that can take minutes. List subscriptions to see whether "
                        "it landed before trying again — retrying blind can create "
                        "a second subscription for the same intent."
                    ),
                    "kind": "timed_out",
                }
            )
        except Exception:
            # No answer reached us. Usually that means nothing happened, but a
            # response discarded on the way back looks identical from here, so
            # this does not promise that nothing was created — it says how to
            # find out.
            logger.warning("Omnesis %s did not complete", action)
            return json.dumps(
                {
                    "error": (
                        f"The {action} did not complete — no answer came back "
                        "from Omnesis. List subscriptions to see the current "
                        "state before trying again."
                    ),
                    "kind": "unreachable",
                }
            )


def check_requirements() -> bool:
    try:
        import websockets  # noqa: F401

        _load_credentials(_credentials_path())
        return True
    except (ImportError, OSError, ValueError, json.JSONDecodeError):
        return False


def validate_config(config: PlatformConfig) -> bool:
    try:
        _load_credentials(_credentials_path(config))
        return True
    except (OSError, ValueError, json.JSONDecodeError):
        return False


def is_connected(config: PlatformConfig) -> bool:
    return validate_config(config)


def _env_enablement() -> Dict[str, Any]:
    path = _credentials_path()
    return {"enabled": True} if path.exists() else {}


_ACTIVE_ADAPTER: Optional[OmnesisAdapter] = None


def _adapter_factory(config: PlatformConfig) -> OmnesisAdapter:
    global _ACTIVE_ADAPTER
    adapter = OmnesisAdapter(config)
    _ACTIVE_ADAPTER = adapter
    return adapter


_TOOL_ADAPTER: Optional[OmnesisAdapter] = None


def _tool_adapter() -> OmnesisAdapter:
    """The adapter a tool call should use in this process.

    Prefer the connected one when the delivery platform is running here, since
    it already holds its credentials and state. Otherwise serve the call from a
    connection-free host: a question asked from a CLI session or a scheduled
    run is as answerable as one asked in the gateway, and reporting the
    integration as unavailable there would be untrue.
    """
    global _TOOL_ADAPTER
    if _ACTIVE_ADAPTER is not None:
        return _ACTIVE_ADAPTER
    if _TOOL_ADAPTER is None:
        _TOOL_ADAPTER = OmnesisAdapter.for_tools()
    return _TOOL_ADAPTER


def _answer_tool_handler(args: Dict[str, Any], **kwargs: Any) -> str:
    return _tool_adapter().answer_subscription(args, kwargs.get("session_id"))


def _ordinary_answer_tool_handler(args: Dict[str, Any], **kwargs: Any) -> str:
    return _tool_adapter().answer(args, kwargs.get("session_id"))


def _management_tool_handler(args: Dict[str, Any], **kwargs: Any) -> str:
    return _tool_adapter().manage_subscriptions(args, kwargs.get("session_id"))


def _registered_subscriptions_available() -> bool:
    """Settle the Watch tool inventory before Hermes registers it.

    Prefer a short live probe, persisting its answer for later tool calls. If
    the gateway is temporarily unreachable, retain the last successful answer.
    A machine where the integration is not configured has no evidence either
    way, so registration keeps its optimistic behavior.
    """
    try:
        path = _credentials_path()
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    try:
        return _reconcile_gateway_capabilities(path)
    except Exception as error:
        logger.warning("Could not read Omnesis gateway capabilities: %s", error)
    return _subscriptions_enabled(raw)


def register(ctx: Any) -> None:
    ctx.register_tool(
        name="omnesis_answer",
        toolset="omnesis",
        schema={
            "name": "omnesis_answer",
            "description": (
                "Use this first for questions about the user's personal data: "
                "calendar events and meeting links, email, messages, contacts, "
                "files, notes, tasks, or activity stored in Omnesis. Omnesis "
                "cannot browse or search the live internet: it answers only "
                "from the user's already-captured corpus, fixed at capture "
                "time, so combine its answer with your own search or browse "
                "tools when the question also needs current outside-world "
                "facts. Do not try other calendar, mail, or filesystem tools "
                "for those questions, "
                "and never run the `omnesis` CLI from a shell to ask one. It "
                "works in scheduled and background runs as well as "
                "conversations. Preparing an answer takes a few minutes and this "
                "tool waits for it. If a call ever comes back saying the answer "
                "is still being prepared, that is not a failure and not "
                "something to tell the user: call again immediately with the "
                "identical question, which attaches to the answer already being "
                "prepared rather than starting new work. The invoking Hermes session is "
                "bound to this ask, so an answer held for approval is delivered "
                "back to this conversation automatically after it resolves. Do "
                "not ask the user to wake you after approving."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "minLength": 1, "maxLength": 10_000},
                },
                "required": ["question"],
                "additionalProperties": False,
            },
        },
        handler=_ordinary_answer_tool_handler,
        description="Ask an ordinary Omnesis question in the current conversation.",
        emoji="◉",
    )
    # The two Watch tools exist only where the gateway's Watch runtime does.
    # Registering them anyway would put a lever in front of the model that
    # answers 404, and leave it explaining the absence as a fault.
    if _registered_subscriptions_available():
        ctx.register_tool(
            name="omnesis_subscription_answer",
            toolset="omnesis",
            schema={
                "name": "omnesis_subscription_answer",
                "description": (
                    "Ask Omnesis a question within the active subscription firing. "
                    "The firing credential is resolved from the trusted Hermes "
                    "session. Answering runs a full agent turn and can take a "
                    "minute; asking the identical question again is safe and "
                    "attaches to the answer already being prepared rather than "
                    "starting a second one. An answer held for approval or "
                    "withheld by policy is a decision, not a failure."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "firingId": {"type": "string"},
                        "question": {"type": "string", "minLength": 1},
                    },
                    "required": ["firingId", "question"],
                    "additionalProperties": False,
                },
            },
            handler=_answer_tool_handler,
            description="Ask within an active Omnesis subscription firing.",
            emoji="◉",
        )
        ctx.register_tool(
            name="omnesis_subscriptions",
            toolset="omnesis",
            schema={
                "name": "omnesis_subscriptions",
                "description": (
                    "Create and manage natural-language Omnesis subscriptions from any "
                    "active Hermes session. The paired Hermes installation is one "
                    "integration identity. Creating or revising a subscription may "
                    "activate it, leave it pending for approval, or deny it according "
                    "to the user's Omnesis privacy policy. Report the returned status "
                    "accurately and retry failures with the exact same idempotencyKey."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["create", "list", "get", "update", "revoke"],
                        },
                        "id": {"type": "string"},
                        "condition": {"type": "string"},
                        "reaction": {
                            "type": "string",
                            "description": (
                                "Instruction for a future firing. Analytics watches "
                                "can report only that the approved condition became "
                                "true and when; never promise query rows or computed "
                                "values."
                            ),
                        },
                        "bindings": {
                            "type": "object",
                            "description": (
                                "What the reaction's words point at, as key/value "
                                "pairs -- the conversation to post in, the address "
                                "to write to, the record to update. Omnesis never "
                                "interprets them: a key means whatever the reaction "
                                "says it means, and both are carried to the run "
                                "verbatim. Set them when the reaction names "
                                "something a woken run could not otherwise resolve. "
                                "Creation only, since they are part of what the "
                                "user approves."
                            ),
                            "additionalProperties": {"type": "string"},
                        },
                        "idempotencyKey": {"type": "string", "minLength": 8},
                        "workflowId": {
                            "type": "string",
                            "description": "Existing workflow to continue.",
                        },
                        "expiresAt": {
                            "anyOf": [{"type": "integer"}, {"type": "null"}]
                        },
                        "status": {
                            "type": "string",
                            "enum": ["active", "paused"],
                        },
                        "expectedRevision": {
                            "type": "integer",
                            "minimum": 1,
                            "description": (
                                "Current revision returned by list or get; "
                                "required for update."
                            ),
                        },
                    },
                    "required": ["action"],
                    "allOf": [
                        {
                            "if": {
                                "properties": {
                                    "action": {"const": "update"}
                                },
                                "required": ["action"],
                            },
                            "then": {
                                "required": ["expectedRevision"],
                                "not": {
                                    "anyOf": [
                                        {"required": ["status", "condition"]},
                                        {"required": ["status", "reaction"]},
                                        {"required": ["status", "expiresAt"]},
                                    ]
                                },
                            },
                        }
                    ],
                    "additionalProperties": False,
                },
            },
            handler=_management_tool_handler,
            description="Manage privacy-reviewed Omnesis subscriptions.",
            emoji="◉",
        )
    ctx.register_platform(
        name="omnesis",
        label="Omnesis",
        adapter_factory=_adapter_factory,
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[],
        install_hint="pip install websockets",
        env_enablement_fn=_env_enablement,
        max_message_length=16384,
        emoji="◉",
        pii_safe=True,
        allow_update_command=False,
        platform_hint=(
            "This is a private, non-interactive Omnesis subscription workflow. "
            "Never deliver a response to another chat unless the reaction says to."
        ),
    )
