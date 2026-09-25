// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import dev.omnesis.android.access.AccessPendingRequests
import dev.omnesis.android.access.accessAuthorizationIdentity
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.AccessAuthorizationDecision
import dev.omnesis.android.transport.dto.AccessAuthorizationLookupEnvelope
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessReconnectProposal
import dev.omnesis.android.transport.dto.PrivacyPolicyDocument
import dev.omnesis.android.ui.common.classifyGatewayError
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.async
import javax.inject.Inject

interface AccessAuthorizationGateway {
    /** The pending request behind a code, with the gateway's proposal for approving it. */
    suspend fun lookup(
        code: String,
        expectedPairing: AccessAuthorizationPairingIdentity? = null,
    ): AccessAuthorizationLookupEnvelope

    /** The pending request the overview listed under this id, without its code. */
    suspend fun lookupById(
        id: String,
        expectedPairing: AccessAuthorizationPairingIdentity? = null,
    ): AccessAuthorizationLookupEnvelope
    suspend fun overview(expectedPairing: AccessAuthorizationPairingIdentity? = null): AccessOverview

    /** The full text of one policy family, so a chosen policy can be read before it is used. */
    suspend fun policy(
        familyId: String,
        expectedPairing: AccessAuthorizationPairingIdentity? = null,
    ): PrivacyPolicyDocument
    suspend fun decide(
        id: String,
        decision: AccessAuthorizationDecision,
        expectedPairing: AccessAuthorizationPairingIdentity? = null,
    )

    /**
     * Make sure the source catalog the wizard draws its icons from is loaded,
     * fetching it if the session's own load did not land. Returns whether the
     * catalog is usable.
     */
    suspend fun ensureSourceCatalog(expectedPairing: AccessAuthorizationPairingIdentity? = null): Boolean = true
}

class SessionAccessAuthorizationGateway @Inject constructor(
    private val session: SessionManager,
    private val sourceCatalog: SourceCatalog,
    private val pendingRequests: AccessPendingRequests,
) : AccessAuthorizationGateway {
    override suspend fun lookup(
        code: String,
        expectedPairing: AccessAuthorizationPairingIdentity?,
    ): AccessAuthorizationLookupEnvelope = currentAdmin(expectedPairing).lookupAccessAuthorization(code)
    override suspend fun lookupById(
        id: String,
        expectedPairing: AccessAuthorizationPairingIdentity?,
    ): AccessAuthorizationLookupEnvelope = currentAdmin(expectedPairing).lookupAccessAuthorizationById(id)

    /** Every overview read also refreshes what the main screen's banner knows is waiting. */
    override suspend fun overview(expectedPairing: AccessAuthorizationPairingIdentity?) =
        currentAdmin(expectedPairing).accessOverview().also { pendingRequests.replace(it.pendingRequests) }
    override suspend fun policy(
        familyId: String,
        expectedPairing: AccessAuthorizationPairingIdentity?,
    ) = currentAdmin(expectedPairing).privacyPolicyFamily(familyId)
    override suspend fun decide(
        id: String,
        decision: AccessAuthorizationDecision,
        expectedPairing: AccessAuthorizationPairingIdentity?,
    ) = currentAdmin(expectedPairing).decideAccessAuthorization(id, decision)

    override suspend fun ensureSourceCatalog(expectedPairing: AccessAuthorizationPairingIdentity?) =
        sourceCatalog.ensureLoaded(currentAdmin(expectedPairing))

    private fun currentAdmin(expectedPairing: AccessAuthorizationPairingIdentity?) =
        session.requireSession().let { current ->
            if (expectedPairing != null && current.pairing.accessAuthorizationIdentity() != expectedPairing) {
                throw AccessAuthorizationPairingChanged()
            }
            current.admin
        }
}

data class AccessAuthorizationUiState(
    val code: String = "",
    val loading: Boolean = false,
    val request: AccessAuthorizationRequest? = null,
    /**
     * The access the client already holds, from a gateway that predates connections. It
     * prefilled the form and is the connection the review names.
     */
    val reconnect: AccessReconnectProposal? = null,
    val overview: AccessOverview? = null,
    val lookupError: String? = null,
    val actionError: String? = null,
    /**
     * The gateway refused the new access level's name as taken. The name field shows the
     * refusal until the name is edited, which also clears [actionError].
     */
    val levelNameTaken: Boolean = false,
    val deciding: Boolean = false,
    val completion: AccessAuthorizationCompletion? = null,
    val revision: Long = 0,
    val step: AccessAuthorizationStep = AccessAuthorizationStep.PERMISSIONS,
    val form: AccessAuthorizationForm? = null,
    val policyPreview: AccessPolicyPreview? = null,
)

/**
 * One policy family's text, read without leaving the wizard. The wizard is a stack of steps
 * with its own actions held at the foot, so navigating away to read the policy would unwind
 * the decision the operator is part-way through making.
 */
data class AccessPolicyPreview(
    val familyId: String,
    val name: String,
    val loading: Boolean = true,
    val document: PrivacyPolicyDocument? = null,
    val error: String? = null,
)

enum class AccessAuthorizationCompletion { APPROVED, DENIED }

/** How the request on screen was reached, so a later re-read asks the gateway for the same one. */
private sealed interface AccessLookupKey {
    suspend fun fetch(
        gateway: AccessAuthorizationGateway,
        pairing: AccessAuthorizationPairingIdentity?,
    ): AccessAuthorizationLookupEnvelope

    data class Code(val code: String) : AccessLookupKey {
        override suspend fun fetch(gateway: AccessAuthorizationGateway, pairing: AccessAuthorizationPairingIdentity?) =
            gateway.lookup(code, pairing)
    }

    data class Id(val id: String) : AccessLookupKey {
        override suspend fun fetch(gateway: AccessAuthorizationGateway, pairing: AccessAuthorizationPairingIdentity?) =
            gateway.lookupById(id, pairing)
    }
}

@HiltViewModel
class AccessAuthorizationViewModel @Inject constructor(
    private val gateway: AccessAuthorizationGateway,
    private val sourceCatalog: SourceCatalog,
    private val pendingRequests: AccessPendingRequests,
) : ViewModel() {
    private val _state = MutableStateFlow(AccessAuthorizationUiState())
    val state = _state.asStateFlow()
    private var lookupJob: Job? = null
    private var policyJob: Job? = null
    private var authorizationKey: AccessLookupKey? = null
    private var authorizationPairing: AccessAuthorizationPairingIdentity? = null
    private var handledLaunchNonce: Long? = null

    fun sourceIcon(sourceId: String) = sourceCatalog.iconModel(sourceId)

    fun updateCode(value: String) {
        authorizationPairing = null
        _state.update { it.copy(code = value.uppercase()) }
    }

    fun lookupInitial(
        code: String,
        launchNonce: Long,
        expectedPairing: AccessAuthorizationPairingIdentity,
    ) {
        if (handledLaunchNonce == launchNonce) return
        handledLaunchNonce = launchNonce
        lookup(code, expectedPairing)
    }

    /**
     * Open a request the main screen's banner named, skipping code entry. One delivery is
     * looked up once, however often the screen recomposes.
     */
    fun lookupInitialById(
        id: String,
        launchNonce: Long,
        expectedPairing: AccessAuthorizationPairingIdentity,
    ) {
        if (handledLaunchNonce == launchNonce) return
        handledLaunchNonce = launchNonce
        lookupById(id, expectedPairing)
    }

    fun lookup(
        rawCode: String = state.value.code,
        expectedPairing: AccessAuthorizationPairingIdentity? = null,
    ) {
        val code = rawCode.trim().uppercase()
        if (code.isEmpty()) return
        val pairingForLookup = expectedPairing ?: authorizationPairing?.takeIf {
            code == state.value.code.trim().uppercase()
        }
        startLookup(AccessLookupKey.Code(code), pairingForLookup, code)
    }

    fun lookupById(id: String, expectedPairing: AccessAuthorizationPairingIdentity? = null) =
        startLookup(AccessLookupKey.Id(id), expectedPairing, code = "")

    private fun startLookup(
        key: AccessLookupKey,
        pairingForLookup: AccessAuthorizationPairingIdentity?,
        code: String,
    ) {
        lookupJob?.cancel()
        authorizationKey = null
        authorizationPairing = pairingForLookup
        _state.update {
            AccessAuthorizationUiState(
                code = code,
                loading = true,
                revision = it.revision + 1,
            )
        }
        lookupJob = viewModelScope.launch {
            try {
                val envelope = key.fetch(gateway, pairingForLookup)
                val request = envelope.request
                if (request.status != "pending" || request.expiresAt <= System.currentTimeMillis()) {
                    pendingRequests.settled(request.id)
                    _state.update {
                        it.copy(
                            loading = false,
                            lookupError = if (request.status == "expired" || request.expiresAt <= System.currentTimeMillis()) {
                                "That authorization request has expired. Start the connection again."
                            } else {
                                "That authorization request has already been decided."
                            },
                        )
                    }
                    return@launch
                }
                val overview = coroutineScope {
                    // The source list draws its icons from the catalog. A session
                    // whose first catalog fetch did not land would otherwise show
                    // every source as its initial, so the catalog is fetched
                    // alongside the overview and both are in hand before the
                    // wizard renders. A catalog that still cannot be fetched is
                    // not a reason to withhold the request.
                    val catalogReady = async { runCatching { gateway.ensureSourceCatalog(pairingForLookup) } }
                    val fetched = gateway.overview(pairingForLookup)
                    catalogReady.await()
                    fetched
                }
                ensureActive()
                authorizationKey = key
                val form = AccessAuthorizationForm.initial(
                    request,
                    overview,
                    envelope.connection,
                    envelope.reconnect,
                    System.currentTimeMillis(),
                )
                _state.update {
                    it.copy(
                        loading = false,
                        request = request,
                        reconnect = envelope.reconnect,
                        overview = overview,
                        form = form,
                        step = authorizationSteps(form, request.requiresAnswer).first(),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // A request the gateway no longer holds as pending has left the banner too.
                if (error is GatewayException.NotFound && key is AccessLookupKey.Id) pendingRequests.settled(key.id)
                _state.update { it.copy(loading = false, lookupError = lookupMessage(error, key)) }
            }
        }
    }

    fun updateForm(form: AccessAuthorizationForm) = _state.update { current ->
        val renamed = form.connection?.levelName != current.form?.connection?.levelName
        if (current.levelNameTaken && renamed) {
            current.copy(form = form, levelNameTaken = false, actionError = null)
        } else {
            current.copy(form = form)
        }
    }

    fun showPolicy(familyId: String) {
        val name = state.value.overview?.policyFamilies
            ?.firstOrNull { it.id == familyId }
            ?.name
            ?: "Privacy policy"
        policyJob?.cancel()
        _state.update { it.copy(policyPreview = AccessPolicyPreview(familyId, name)) }
        policyJob = viewModelScope.launch {
            try {
                val document = gateway.policy(familyId, authorizationPairing)
                updatePolicyPreview(familyId) { it.copy(loading = false, document = document) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                updatePolicyPreview(familyId) {
                    it.copy(loading = false, error = policyMessage(error))
                }
            }
        }
    }

    fun dismissPolicy() {
        policyJob?.cancel()
        policyJob = null
        _state.update { it.copy(policyPreview = null) }
    }

    /** A reply is applied only while the preview it answers is still the one on screen. */
    private fun updatePolicyPreview(
        familyId: String,
        transform: (AccessPolicyPreview) -> AccessPolicyPreview,
    ) = _state.update { current ->
        val preview = current.policyPreview
        if (preview?.familyId != familyId) current else current.copy(policyPreview = transform(preview))
    }

    fun goTo(step: AccessAuthorizationStep) = _state.update { it.copy(step = step) }

    fun decide(approve: Boolean, selection: AccessAuthorizationSelection? = null) {
        val request = state.value.request ?: return
        if ((approve && selection == null) || state.value.deciding) return
        if (request.expiresAt <= System.currentTimeMillis()) {
            _state.update {
                it.copy(actionError = "This authorization request expired. Start the connection again.")
            }
            return
        }
        _state.update { it.copy(deciding = true, actionError = null, levelNameTaken = false) }
        viewModelScope.launch {
            val decision = if (approve) {
                AccessAuthorizationDecision.Approve(requireNotNull(selection))
            } else {
                AccessAuthorizationDecision.Deny
            }
            try {
                gateway.decide(request.approvalId, decision, authorizationPairing)
                complete(if (approve) AccessAuthorizationCompletion.APPROVED else AccessAuthorizationCompletion.DENIED)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // The request is read again before the failure is judged: a response can be
                // lost after the gateway commits the decision, and a request still pending
                // carries the connection proposal a stale refusal is rebuilt from.
                val current = currentLookup(request)
                decisionOutcome(current?.request)?.let(::complete) ?: handleDecisionFailure(error, current)
            }
        }
    }

    /**
     * The request on screen, as the gateway holds it now, with the access its client already
     * has — read the way it was first reached, by code or by id. Null when nothing is on
     * screen, the read failed, or the reply no longer names the request on screen.
     */
    private suspend fun currentLookup(
        request: AccessAuthorizationRequest,
    ): AccessAuthorizationLookupEnvelope? {
        val key = authorizationKey ?: return null
        val envelope = try {
            key.fetch(gateway, authorizationPairing)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return null
        }
        return envelope.takeIf { it.request.id == request.id }
    }

    /** The decision a request's status records, or null while it is still pending. */
    private fun decisionOutcome(current: AccessAuthorizationRequest?): AccessAuthorizationCompletion? =
        when (current?.status) {
            "approved", "code-issued", "complete" -> AccessAuthorizationCompletion.APPROVED
            "denied" -> AccessAuthorizationCompletion.DENIED
            else -> null
        }

    private fun complete(completion: AccessAuthorizationCompletion) {
        authorizationKey = null
        authorizationPairing = null
        state.value.request?.let { pendingRequests.settled(it.id) }
        _state.update {
            it.copy(deciding = false, actionError = null, completion = completion)
        }
    }

    private suspend fun handleDecisionFailure(
        error: Throwable,
        current: AccessAuthorizationLookupEnvelope?,
    ) {
        val serverError = error as? GatewayException.ServerError
        val code = serverError?.code ?: serverError?.body
        if (code == "expired") {
            _state.update {
                it.copy(
                    deciding = false,
                    actionError = "This authorization request expired. Start the connection again.",
                )
            }
            return
        }
        if (code == "already-decided") {
            _state.update {
                it.copy(
                    deciding = false,
                    actionError = "This request was completed, but Omnesis could not confirm the outcome.",
                )
            }
            return
        }
        if (code in setOf("inactive-grant", "invalid-selection", "stale-revision")) {
            refreshStaleChoices(current)
            return
        }
        if (code == "level-name-taken") {
            // The name is asked on the Connection step, so that is where it is corrected.
            _state.update {
                it.copy(
                    deciding = false,
                    step = AccessAuthorizationStep.CONNECTION,
                    actionError = LEVEL_NAME_TAKEN_MESSAGE,
                    levelNameTaken = true,
                )
            }
            return
        }
        _state.update {
            it.copy(
                deciding = false,
                actionError = when (error) {
                    is AccessAuthorizationPairingChanged ->
                        "The paired gateway changed. Scan the authorization code again."
                    is GatewayException.Unauthorized, is GatewayException.Forbidden -> classifyGatewayError(error)
                    is GatewayException.ServerError -> if (error.status == 400) {
                        "Some values are invalid. Review the source selections."
                    } else {
                        accessAuthorizationUnmappedMessage(error)
                    }
                    else -> accessAuthorizationUnmappedMessage(error)
                },
            )
        }
    }

    /**
     * The gateway refused the decision because what it was built on has changed: a source
     * went away, or the access level or connection the approval named was edited or removed.
     * The form is rebuilt from the request as just re-read — its connection proposal
     * included, so the step never keeps suggesting a connection that no longer exists — and
     * from a fresh overview, and the wizard reopens on its first step. Without both, the owner
     * is sent back to the code. The connection and access level names the owner typed are kept
     * when the rebuilt step opens on the path they were typed for; the permissions always come
     * from the rebuilt form.
     */
    private suspend fun refreshStaleChoices(envelope: AccessAuthorizationLookupEnvelope?) {
        val overview = envelope?.let {
            try {
                gateway.overview(authorizationPairing)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                null
            }
        }
        if (envelope == null || overview == null) {
            _state.update {
                AccessAuthorizationUiState(
                    lookupError = "Access choices changed, but Omnesis could not reload them. Enter the code again.",
                    revision = it.revision + 1,
                )
            }
            return
        }
        val refreshed = AccessAuthorizationForm.initial(
            envelope.request,
            overview,
            envelope.connection,
            envelope.reconnect,
            System.currentTimeMillis(),
        )
        val typed = state.value.form?.connection
        val choice = refreshed.connection
        val form = if (typed != null && choice != null && choice.path == typed.path) {
            refreshed.copy(connection = choice.copy(name = typed.name, levelName = typed.levelName))
        } else {
            refreshed
        }
        _state.update {
            it.copy(
                deciding = false,
                request = envelope.request,
                reconnect = envelope.reconnect,
                overview = overview,
                form = form,
                step = authorizationSteps(form, envelope.request.requiresAnswer).first(),
                actionError = "Access choices changed. Review the refreshed request.",
                levelNameTaken = false,
                revision = it.revision + 1,
            )
        }
    }

    private fun policyMessage(error: Throwable): String = when (error) {
        is GatewayException.NotFound -> "That policy is no longer published on this gateway."
        is AccessAuthorizationPairingChanged ->
            "The paired gateway changed. Scan the authorization code again."
        else -> accessAuthorizationUnmappedMessage(error)
    }

    private fun lookupMessage(error: Throwable, key: AccessLookupKey): String = when (error) {
        is GatewayException.NotFound -> when (key) {
            is AccessLookupKey.Code -> "No pending authorization matches that code."
            is AccessLookupKey.Id -> "This request is no longer waiting for a decision."
        }
        is AccessAuthorizationPairingChanged ->
            "The paired gateway changed. Scan the authorization code again."
        is GatewayException.Unauthorized, is GatewayException.Forbidden -> classifyGatewayError(error)
        is GatewayException.ServerError -> if (error.status == 400) {
            "The authorization code is invalid. Check it and try again."
        } else {
            accessAuthorizationUnmappedMessage(error)
        }
        else -> accessAuthorizationUnmappedMessage(error)
    }

}

internal class AccessAuthorizationPairingChanged : Exception()
