// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.content.Context
import android.util.Log
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.MembershipRefusalCoordinator
import dev.omnesis.android.transport.SourceRemovalReconciler
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.PairingIdentity
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

@Module
@InstallIn(SingletonComponent::class)
object SourceMembershipModule {
    @Provides
    @Singleton
    fun provideSourceRemovalReconciler(
        optIns: Set<@JvmSuppressWildcards HostedSourceOptIn>,
    ): SourceRemovalReconciler = SourceRemovalReconciler(
        waitForPendingAuthority = true,
        log = { Log.w("Omnesis:membership", it) },
        optIns = { optIns },
    )


    /**
     * One membership holder for the whole app, so every phone-hosted source's
     * opt-out lands in the same durable outbox and the same drain. The session
     * is resolved per call rather than captured: an unpaired app records
     * nothing, and a re-pair is picked up without the holder observing the
     * session. The scope is the holder's own, so a detach started from a
     * settings card survives that card going away.
     */
    @Provides
    @Singleton
    fun provideSourceMembership(
        @ApplicationContext context: Context,
        sessionManager: SessionManager,
        removalReconciler: SourceRemovalReconciler,
        optIns: Set<@JvmSuppressWildcards HostedSourceOptIn>,
    ): SourceMembership {
        val prefs = context.getSharedPreferences("omnesis.membership", Context.MODE_PRIVATE)
        return SourceMembership(
            removalReconciler = removalReconciler,
            registerAbsentSource = { op, admin ->
                val pairing = sessionManager.session?.pairing
                check(pairing?.deviceId == op.deviceId && pairing.url == op.gateway && pairing.pairingGeneration == op.pairingGeneration) {
                    "Pairing changed before source registration"
                }
                val source = checkNotNull(optIns.firstOrNull { it.sourceId == op.sourceId }) { "This phone cannot register that source" }
                source.registerForResume(admin, op.deviceId)
            },
            admin = { sessionManager.session?.admin },
            pairingIdentity = {
                sessionManager.session?.pairing?.let { pairing ->
                    pairing.deviceId?.let { deviceId ->
                        PairingIdentity(deviceId, pairing.url, pairing.pairingGeneration)
                    }
                }
            },
            outbox = MembershipOutbox(
                read = { prefs.getString(it, null) },
                write = { key, value ->
                    prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
                },
                log = { Log.w("Omnesis:membership", it) },
            ),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
            log = { Log.i("Omnesis:membership", it) },
        )
    }

    /**
     * The one consumer of [SourceMembership.refusals]. App-scoped rather than
     * screen-scoped: [SourceMembership.retryPending] drains on every
     * foreground, so a resume can be refused with no settings screen alive —
     * and a refusal nobody acted on would leave a persisted opt-in and a
     * periodic worker running against a source the gateway refuses.
     */
    @Provides
    @Singleton
    fun provideMembershipRefusalCoordinator(
        membership: SourceMembership,
        optIns: Set<@JvmSuppressWildcards HostedSourceOptIn>,
    ): MembershipRefusalCoordinator = MembershipRefusalCoordinator(
        membership = membership,
        optIns = { optIns },
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
        log = { Log.w("Omnesis:membership", it) },
    )
}
