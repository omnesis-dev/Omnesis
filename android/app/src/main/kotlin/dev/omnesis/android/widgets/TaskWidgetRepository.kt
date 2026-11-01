// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.TaskAction
import dev.omnesis.android.transport.client.TaskView
import dev.omnesis.android.transport.client.TasksClient
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.tls.PinnedOkHttp
import java.security.MessageDigest
import java.time.LocalDate
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl.Companion.toHttpUrl

interface WidgetTasksGateway {
    suspend fun tasks(view: TaskView, day: String): List<WidgetTask>
    suspend fun complete(id: String)
}

/** The widget uses the same paired HTTPS trust contract and task routes as the app. */
class PairedWidgetTasksGateway(pairing: Pairing) : WidgetTasksGateway {
    private val url = pairing.url.toHttpUrl().also { require(it.isHttps) }
    private val client = TasksClient(
        GatewayHttp(
            PinnedOkHttp.build(
                fingerprint = pairing.fingerprint,
                requirePin = pairing.tlsMode == PairingTlsMode.PINNED_LEAF,
                host = url.host,
            ).newBuilder().callTimeout(8, TimeUnit.SECONDS).build(),
            url,
            pairing.token,
            pairing.pairingGeneration,
        ),
    )

    override suspend fun tasks(view: TaskView, day: String) = client.view(view, day).tasks.map(WidgetTask::from)
    override suspend fun complete(id: String) { client.act(id, TaskAction.Complete()) }
}

class StaleWidgetAuthority : Exception("The widget belongs to a previous pairing")

data class TaskWidgetRead(val snapshot: TaskWidgetSnapshot?, val status: TaskWidgetStatus)

/**
 * Serializes refreshes and completions so a pre-completion read cannot resurrect
 * a completed row. Every cache write also verifies the exact pairing authority.
 */
class TaskWidgetRepository(
    private val currentPairing: () -> Pairing?,
    private val cache: WidgetSnapshotStore,
    private val gateway: (Pairing) -> WidgetTasksGateway = ::PairedWidgetTasksGateway,
    private val now: () -> Long = System::currentTimeMillis,
    private val today: () -> LocalDate = LocalDate::now,
) {
    suspend fun refresh(): TaskWidgetRead = operations.withLock {
        val pairing = currentPairing() ?: run {
            cache.clear()
            return@withLock TaskWidgetRead(null, TaskWidgetStatus.UNPAIRED)
        }
        val authority = authority(pairing)
        val started = now()
        try {
            val client = gateway(pairing)
            val day = today().toString()
            val tasks = linkedMapOf<String, WidgetTask>()
            // These owned journal views are complete partitions, not paginated.
            for (view in listOf(TaskView.TODAY, TaskView.MONTH, TaskView.FUTURE, TaskView.ANYTIME)) {
                for (task in client.tasks(view, day)) if (task.isOpen) tasks[task.id] = task
            }
            if (currentAuthority() != authority) return@withLock TaskWidgetRead(null, TaskWidgetStatus.UNPAIRED)
            cache.save(authority, TaskWidgetSnapshot(tasks.values.toList(), started))
            TaskWidgetRead(cache.read(authority), TaskWidgetStatus.READY)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (currentAuthority() != authority) return@withLock TaskWidgetRead(null, TaskWidgetStatus.UNPAIRED)
            if (error is GatewayException.Unauthorized || error is GatewayException.Forbidden) {
                cache.clear()
                TaskWidgetRead(null, TaskWidgetStatus.UNPAIRED)
            } else {
                TaskWidgetRead(cache.read(authority), TaskWidgetStatus.OFFLINE)
            }
        }
    }

    suspend fun complete(id: String, expectedAuthority: String) = operations.withLock {
        require(id.isNotBlank() && id.length <= 200 && id.none(Char::isISOControl))
        val pairing = currentPairing()?.takeIf { authority(it) == expectedAuthority } ?: throw StaleWidgetAuthority()
        gateway(pairing).complete(id)
        // A confirmed gateway write remains successful if local cache storage fails.
        runCatching {
            if (currentAuthority() == expectedAuthority) {
                cache.read(expectedAuthority)?.let { snapshot ->
                    cache.save(expectedAuthority, snapshot.copy(tasks = snapshot.tasks.filterNot { it.id == id }, updatedAt = now()))
                }
            }
        }
    }

    fun currentAuthority(): String? = currentPairing()?.let(::authority)

    companion object {
        private val operations = Mutex()

        /** Opaque digest only: rendered PendingIntents never contain a bearer token or gateway URL. */
        fun authority(pairing: Pairing): String {
            val fields = listOf(pairing.url, pairing.token, pairing.pairingGeneration.orEmpty(),
                pairing.deviceId.orEmpty(), pairing.accountId, pairing.tlsMode.name, pairing.fingerprint.orEmpty())
            val identity = fields.joinToString("") { "${it.length}:$it" }
            return MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }
    }
}
