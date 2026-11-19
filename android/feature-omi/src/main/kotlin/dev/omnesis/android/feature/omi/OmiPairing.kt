// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi

import android.bluetooth.BluetoothDevice
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothLeDeviceFilter
import android.companion.CompanionDeviceManager
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.util.concurrent.Executor

/** Which pendant this phone is associated with. */
class OmiPairingStore(private val prefs: SharedPreferences) {
    val address: String? get() = prefs.getString(KEY_ADDRESS, null)
    val associationId: Int? get() = prefs.getInt(KEY_ASSOCIATION, -1).takeIf { it >= 0 }

    fun save(address: String, associationId: Int?) {
        prefs.edit().putString(KEY_ADDRESS, address.uppercase()).putInt(KEY_ASSOCIATION, associationId ?: -1).apply()
    }

    fun forget() {
        prefs.edit().clear().apply()
    }

    companion object {
        const val PREFS_NAME = "omnesis.omi"
        private const val KEY_ADDRESS = "address"
        private const val KEY_ASSOCIATION = "association"
    }
}

/**
 * Associates a pendant through the system's companion-device dialog, which
 * finds pendants advertising the Omi audio service without the app holding
 * location or scan permissions. An association also lets the system wake the
 * app when the pendant comes in range ([OmiPresenceService]) and lets the
 * app start its foreground services from the background, which is how a tap
 * on the pendant starts a recording with the phone in a pocket.
 */
class OmiPairing(private val context: Context, private val store: OmiPairingStore) {
    private val manager: CompanionDeviceManager? get() = context.getSystemService(CompanionDeviceManager::class.java)

    /** Ask the system to look for a pendant; [onChooser] receives the dialog to launch. */
    fun request(onChooser: (IntentSender) -> Unit, onError: (String) -> Unit) {
        val cdm = manager ?: return onError("This phone cannot associate companion devices")
        val filter = BluetoothLeDeviceFilter.Builder()
            .setScanFilter(ScanFilter.Builder().setServiceUuid(ParcelUuid(OmiProtocol.AUDIO_SERVICE)).build())
            .build()
        val request = AssociationRequest.Builder().addDeviceFilter(filter).setSingleDevice(false).build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            cdm.associate(
                request,
                Executor { Handler(Looper.getMainLooper()).post(it) },
                object : CompanionDeviceManager.Callback() {
                    override fun onAssociationPending(intentSender: IntentSender) = onChooser(intentSender)
                    override fun onAssociationCreated(associationInfo: AssociationInfo) = Unit // handled in complete()
                    override fun onFailure(error: CharSequence?) = onError(error?.toString() ?: "No pendant found")
                },
            )
        } else {
            @Suppress("DEPRECATION")
            cdm.associate(
                request,
                object : CompanionDeviceManager.Callback() {
                    @Deprecated("Below API 33")
                    override fun onDeviceFound(chooserLauncher: IntentSender) = onChooser(chooserLauncher)
                    override fun onFailure(error: CharSequence?) = onError(error?.toString() ?: "No pendant found")
                },
                Handler(Looper.getMainLooper()),
            )
        }
    }

    /** The chooser's result: store the chosen pendant. False when nothing was chosen. */
    fun complete(data: Intent?): Boolean {
        data ?: return false
        val (address, id) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val info = data.getParcelableExtra(CompanionDeviceManager.EXTRA_ASSOCIATION, AssociationInfo::class.java)
            (info?.deviceMacAddress?.toString() ?: chosenDevice(data)?.address) to info?.id
        } else {
            chosenDevice(data)?.address to null
        }
        address ?: return false
        store.save(address, id)
        observePresence(address)
        Log.i(TAG, "Pendant associated")
        return true
    }

    /** Drop the association; the system stops waking the app for the pendant. */
    fun disassociate() {
        val cdm = manager
        val address = store.address
        if (cdm != null && address != null) {
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    @Suppress("DEPRECATION")
                    cdm.stopObservingDevicePresence(address)
                }
                val id = store.associationId
                if (id != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    cdm.disassociate(id)
                } else {
                    @Suppress("DEPRECATION")
                    cdm.disassociate(address)
                }
            }.onFailure { Log.w(TAG, "Could not drop the association: ${it.message}") }
        }
        store.forget()
    }

    /** Re-arm presence observation for a stored pendant (it does not survive every update). */
    fun observeStored() {
        store.address?.let(::observePresence)
    }

    private fun observePresence(address: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        runCatching {
            @Suppress("DEPRECATION")
            manager?.startObservingDevicePresence(address)
        }.onFailure { Log.w(TAG, "Could not observe the pendant's presence: ${it.message}") }
    }

    private fun chosenDevice(data: Intent): BluetoothDevice? {
        @Suppress("DEPRECATION")
        val extra = data.getParcelableExtra<android.os.Parcelable>(CompanionDeviceManager.EXTRA_DEVICE)
        return when (extra) {
            is ScanResult -> extra.device
            is BluetoothDevice -> extra
            else -> null
        }
    }

    private companion object {
        const val TAG = "Omnesis:Omi"
    }
}
