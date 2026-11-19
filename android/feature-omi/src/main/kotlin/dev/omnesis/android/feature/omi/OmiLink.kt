// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import dev.omnesis.android.feature.recording.WearableAudio
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** The pendant as the screen shows it. */
sealed interface OmiStatus {
    /** No pendant has been associated with this phone. */
    data object NotPaired : OmiStatus

    /** Associated, but not linked: off, out of range, or held by another phone. */
    data object Disconnected : OmiStatus

    data object Connecting : OmiStatus

    /**
     * Linked and ready to record. [encrypted] when the link runs over a bond;
     * [canMute] when its firmware lets the app mute its microphone (newer
     * firmware). Without it the pendant discards what it hears while linked
     * and keeps it on its own storage while away.
     */
    data class Ready(val battery: Int?, val encrypted: Boolean, val canMute: Boolean = true) : OmiStatus

    /** Linked, but its firmware sends audio this app cannot read. */
    data class Unsupported(val codec: Int?) : OmiStatus
}

/**
 * The Bluetooth LE link to one associated Omi pendant, and the
 * [WearableAudio] the recorder reads. It connects over LE, bonds so the link
 * is encrypted, asks for a large MTU, checks the audio format, listens to the
 * button and the battery, and keeps the pendant's capture muted whenever no
 * recording is streaming, so it neither records nor fills its own storage
 * outside a session. A dropped link reconnects on its own until [disconnect].
 *
 * Android allows one GATT operation at a time per link; every operation goes
 * through [gattOp], which waits for its callback.
 */
@SuppressLint("MissingPermission") // every entry point checks BLUETOOTH_CONNECT first
class OmiLink(
    private val context: Context,
    private val pairing: OmiPairingStore,
) : WearableAudio {
    override val name = "Omi"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val _status = MutableStateFlow<OmiStatus>(if (pairing.address == null) OmiStatus.NotPaired else OmiStatus.Disconnected)
    val status: StateFlow<OmiStatus> = _status.asStateFlow()
    private val _ready = MutableStateFlow(false)
    override val ready: StateFlow<Boolean> = _ready.asStateFlow()
    private val _details = MutableStateFlow<OmiDetails?>(null)

    /** What the pendant reports about itself; null until it has linked once in this process. */
    val details: StateFlow<OmiDetails?> = _details.asStateFlow()
    private var linkMtu: Int? = null
    private val _buttons = MutableSharedFlow<OmiButton>(extraBufferCapacity = 8)
    val buttons: SharedFlow<OmiButton> = _buttons.asSharedFlow()

    private val ops = Mutex()
    private var pendingOp: CompletableDeferred<Pair<Int, ByteArray?>>? = null
    private var gatt: BluetoothGatt? = null
    private var setup: Job? = null
    @Volatile private var wanted = false
    @Volatile private var sink: WearableAudio.FrameSink? = null
    private val assembler = OmiFrameAssembler { frame -> sink?.onFrame(frame, System.currentTimeMillis()) }
    private var bondWait: CompletableDeferred<Int>? = null
    @Volatile private var canMute = true

    /** Streaming and vibration commands, each run whole and in order so their writes never interleave. */
    private val commands = Channel<suspend () -> Unit>(Channel.UNLIMITED)

    private val bondReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val device = deviceExtra(intent) ?: return
            if (!device.address.equals(pairing.address, ignoreCase = true)) return
            val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE)
            if (state != BluetoothDevice.BOND_BONDING) bondWait?.complete(state)
            (_status.value as? OmiStatus.Ready)?.let { _status.value = it.copy(encrypted = state == BluetoothDevice.BOND_BONDED) }
        }
    }

    init {
        scope.launch {
            for (command in commands) {
                try {
                    command()
                } catch (e: Exception) {
                    Log.w(TAG, "Pendant command failed: ${e.message}")
                }
            }
        }
        ContextCompat.registerReceiver(
            context,
            bondReceiver,
            IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED),
            ContextCompat.RECEIVER_EXPORTED,
        )
    }

    fun hasPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    /** Link to the associated pendant and keep the link up. */
    @Synchronized
    fun connect() {
        val address = pairing.address ?: run { _status.value = OmiStatus.NotPaired; return }
        if (!hasPermission()) {
            Log.w(TAG, "Bluetooth permission not granted; not connecting")
            return
        }
        if (wanted && gatt != null) return
        wanted = true
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter ?: return
        val device = try {
            adapter.getRemoteDevice(address)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "Stored pendant address is invalid: ${e.message}")
            return
        }
        _status.value = OmiStatus.Connecting
        // Direct first, then let the stack reconnect whenever the pendant is back.
        gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
    }

    /** Drop the link and stop reconnecting. */
    @Synchronized
    fun disconnect() {
        wanted = false
        setup?.cancel()
        sink?.let { s -> sink = null; s.onLinkLost() }
        gatt?.let { g ->
            runCatching { g.disconnect() }
            runCatching { g.close() }
        }
        gatt = null
        _ready.value = false
        _status.value = if (pairing.address == null) OmiStatus.NotPaired else OmiStatus.Disconnected
    }

    /** The pendant was forgotten ([OmiPairing.disassociate]): drop the link and show it unpaired. */
    fun forgotten() {
        disconnect()
        _status.value = OmiStatus.NotPaired
    }

    /** A pendant was just associated: show it, then [connect]. */
    fun associated() {
        if (_status.value == OmiStatus.NotPaired) _status.value = OmiStatus.Disconnected
    }

    fun vibrate(pattern: Haptic) {
        commands.trySend {
            pattern.pulses.forEachIndexed { i, pulse ->
                if (i > 0) delay(Haptic.GAP_MS)
                write(OmiProtocol.HAPTIC_SERVICE, OmiProtocol.HAPTIC, byteArrayOf(pulse))
            }
        }
    }

    override fun startStreaming(sink: WearableAudio.FrameSink): Boolean {
        if (!_ready.value) return false
        assembler.reset()
        this.sink = sink
        commands.trySend {
            if (canMute) write(OmiProtocol.SETTINGS_SERVICE, OmiProtocol.CAPTURE_MUTE, OmiProtocol.mute(false))
            notify(OmiProtocol.AUDIO_SERVICE, OmiProtocol.AUDIO_DATA, true)
            gatt?.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
        }
        return true
    }

    override fun stopStreaming() {
        sink = null
        commands.trySend { quiet() }
    }

    /** Read everything the pendant reports about itself again (the details panel opening). */
    fun refreshDetails() {
        if (_ready.value) commands.trySend { readDetails() }
    }

    /** Make the pendant vibrate so it can be found. */
    fun find() {
        commands.trySend {
            repeat(3) { i ->
                if (i > 0) delay(700)
                write(OmiProtocol.HAPTIC_SERVICE, OmiProtocol.HAPTIC, byteArrayOf(3))
            }
        }
    }

    private suspend fun readDetails() {
        val g = gatt ?: return
        val rssi = gattOp { g.readRemoteRssi() }?.takeIf { it.first == BluetoothGatt.GATT_SUCCESS }?.second?.firstOrNull()?.toInt()
        _details.value = OmiDetails(
            name = runCatching { g.device.name }.getOrNull(),
            address = g.device.address,
            manufacturer = OmiProtocol.text(read(OmiProtocol.DEVICE_INFO_SERVICE, OmiProtocol.MANUFACTURER)),
            model = OmiProtocol.text(read(OmiProtocol.DEVICE_INFO_SERVICE, OmiProtocol.MODEL_NUMBER)),
            hardware = OmiProtocol.text(read(OmiProtocol.DEVICE_INFO_SERVICE, OmiProtocol.HARDWARE_REVISION)),
            firmware = OmiProtocol.text(read(OmiProtocol.DEVICE_INFO_SERVICE, OmiProtocol.FIRMWARE_REVISION)),
            serial = OmiProtocol.text(read(OmiProtocol.DEVICE_INFO_SERVICE, OmiProtocol.SERIAL_NUMBER)),
            battery = read(OmiProtocol.BATTERY_SERVICE, OmiProtocol.BATTERY_LEVEL)?.let(OmiProtocol::battery),
            charging = OmiProtocol.byte(read(OmiProtocol.SETTINGS_SERVICE, OmiProtocol.CHARGING))?.let { it == 1 },
            encrypted = g.device.bondState == BluetoothDevice.BOND_BONDED,
            mtu = linkMtu,
            rssi = rssi,
            ledBrightness = OmiProtocol.byte(read(OmiProtocol.SETTINGS_SERVICE, OmiProtocol.LED_DIM_RATIO)),
            micGain = OmiProtocol.byte(read(OmiProtocol.SETTINGS_SERVICE, OmiProtocol.MIC_GAIN)),
            canMute = canMute,
            features = OmiProtocol.features(read(OmiProtocol.FEATURES_SERVICE, OmiProtocol.FEATURES)),
            storage = OmiProtocol.storage(read(OmiProtocol.STORAGE_SERVICE, OmiProtocol.STORAGE_STATUS)),
            framesLost = if (sink != null) assembler.lost else null,
        )
    }

    /** No audio flowing and the pendant's capture muted. */
    private suspend fun quiet() {
        notify(OmiProtocol.AUDIO_SERVICE, OmiProtocol.AUDIO_DATA, false)
        if (canMute) write(OmiProtocol.SETTINGS_SERVICE, OmiProtocol.CAPTURE_MUTE, OmiProtocol.mute(true))
        gatt?.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_BALANCED)
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                Log.i(TAG, "Linked to the pendant")
                setup?.cancel()
                setup = scope.launch { prepare(g) }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                Log.i(TAG, "Pendant link dropped (status $status)")
                setup?.cancel()
                pendingOp?.complete(-1 to null)
                _ready.value = false
                sink?.let { s -> sink = null; s.onLinkLost() }
                if (!wanted) return
                _status.value = OmiStatus.Disconnected
                // Reconnect in the background whenever it comes back in range.
                synchronized(this@OmiLink) {
                    runCatching { g.close() }
                    if (wanted && gatt === g) gatt = g.device.connectGatt(context, true, this, BluetoothDevice.TRANSPORT_LE)
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            pendingOp?.complete(status to null)
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            Log.i(TAG, "MTU $mtu")
            linkMtu = mtu
            pendingOp?.complete(status to null)
        }

        @Deprecated("Below API 33")
        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            @Suppress("DEPRECATION")
            pendingOp?.complete(status to c.value)
        }

        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            pendingOp?.complete(status to value)
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            pendingOp?.complete(status to null)
        }

        override fun onReadRemoteRssi(g: BluetoothGatt, rssi: Int, status: Int) {
            pendingOp?.complete(status to byteArrayOf(rssi.toByte()))
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            pendingOp?.complete(status to null)
        }

        @Deprecated("Below API 33")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            changed(c.uuid, c.value ?: return)
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            changed(c.uuid, value)
        }
    }

    private fun changed(uuid: UUID, value: ByteArray) {
        when (uuid) {
            OmiProtocol.AUDIO_DATA -> if (sink != null) assembler.accept(value)
            OmiProtocol.BUTTON_EVENT -> OmiProtocol.buttonEvent(value)?.let {
                Log.i(TAG, "Pendant button $it")
                _buttons.tryEmit(it)
            }
            OmiProtocol.BATTERY_LEVEL -> OmiProtocol.battery(value)?.let { level ->
                (_status.value as? OmiStatus.Ready)?.let { _status.value = it.copy(battery = level) }
                _details.value = _details.value?.copy(battery = level)
            }
            OmiProtocol.CHARGING -> OmiProtocol.byte(value)?.let { c -> _details.value = _details.value?.copy(charging = c == 1) }
        }
    }

    /** From a fresh connection to ready: bond, MTU, services, format check, listeners, muted. */
    private suspend fun prepare(g: BluetoothGatt) {
        _status.value = OmiStatus.Connecting
        val device = g.device
        if (device.bondState != BluetoothDevice.BOND_BONDED) {
            val wait = CompletableDeferred<Int>().also { bondWait = it }
            // The firmware may start pairing itself; a second request would restart it.
            if (device.bondState == BluetoothDevice.BOND_NONE) device.createBond()
            val result = withTimeoutOrNull(BOND_TIMEOUT_MS) { wait.await() }
            bondWait = null
            if (result != BluetoothDevice.BOND_BONDED) Log.w(TAG, "Pendant not bonded; the link is not encrypted")
        }
        gattOp { g.requestMtu(OmiProtocol.MTU) }
        if (gattOp { g.discoverServices() }?.first != BluetoothGatt.GATT_SUCCESS) {
            Log.w(TAG, "Service discovery failed; dropping the link to retry")
            g.disconnect()
            return
        }
        Log.i(TAG, "Pendant services ${g.services.joinToString { it.uuid.toString().take(8) }}")
        val codec = read(OmiProtocol.AUDIO_SERVICE, OmiProtocol.AUDIO_CODEC)?.firstOrNull()?.toInt()?.and(0xFF)
        if (codec == null) {
            // No answer is a struggling link, not a verdict on the firmware: drop it and try again.
            Log.w(TAG, "The pendant did not report its audio format; dropping the link to retry")
            g.disconnect()
            return
        }
        if (codec != OmiProtocol.CODEC_OPUS_16K_20MS) {
            Log.w(TAG, "Unsupported pendant audio codec $codec")
            _status.value = OmiStatus.Unsupported(codec)
            return
        }
        // The pendant's clock dates what it stores and, unset, makes its LED blink red. Setting it
        // is saved to the pendant's flash in its Bluetooth thread, which stalls the link while it
        // writes, so it is set only when the pendant says it is not.
        if (OmiProtocol.storage(read(OmiProtocol.STORAGE_SERVICE, OmiProtocol.STORAGE_STATUS))?.clockSet == false) {
            Log.i(TAG, "Setting the pendant's clock")
            write(OmiProtocol.TIME_SYNC_SERVICE, OmiProtocol.TIME_SYNC, OmiProtocol.epochSeconds(System.currentTimeMillis()))
        }
        notify(OmiProtocol.BUTTON_SERVICE, OmiProtocol.BUTTON_EVENT, true)
        notify(OmiProtocol.BATTERY_SERVICE, OmiProtocol.BATTERY_LEVEL, true)
        val battery = read(OmiProtocol.BATTERY_SERVICE, OmiProtocol.BATTERY_LEVEL)?.let(OmiProtocol::battery)
        canMute = g.getService(OmiProtocol.SETTINGS_SERVICE)?.getCharacteristic(OmiProtocol.CAPTURE_MUTE) != null
        if (!canMute) Log.i(TAG, "This firmware cannot mute the pendant's microphone")
        quiet()
        _status.value = OmiStatus.Ready(battery, encrypted = device.bondState == BluetoothDevice.BOND_BONDED, canMute = canMute)
        _ready.value = true
    }

    private suspend fun read(service: UUID, characteristic: UUID): ByteArray? {
        val g = gatt ?: return null
        val c = g.getService(service)?.getCharacteristic(characteristic) ?: return null
        val result = gattOp { g.readCharacteristic(c) } ?: return null
        return result.second.takeIf { result.first == BluetoothGatt.GATT_SUCCESS }
    }

    private suspend fun write(service: UUID, characteristic: UUID, value: ByteArray): Boolean {
        val g = gatt ?: return false
        val c = g.getService(service)?.getCharacteristic(characteristic) ?: run {
            Log.w(TAG, "Pendant has no characteristic $characteristic")
            return false
        }
        val type = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        return gattOp {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(c, value, type) == BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                c.value = value
                c.writeType = type
                @Suppress("DEPRECATION")
                g.writeCharacteristic(c)
            }
        }?.first == BluetoothGatt.GATT_SUCCESS
    }

    private suspend fun notify(service: UUID, characteristic: UUID, on: Boolean): Boolean {
        val g = gatt ?: return false
        val c = g.getService(service)?.getCharacteristic(characteristic) ?: return false
        if (!g.setCharacteristicNotification(c, on)) return false
        val d = c.getDescriptor(OmiProtocol.CCC) ?: return false
        val value = if (on) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        return gattOp {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(d, value) == BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                d.value = value
                @Suppress("DEPRECATION")
                g.writeDescriptor(d)
            }
        }?.first == BluetoothGatt.GATT_SUCCESS
    }

    /** Start one GATT operation and wait for its callback; null when it could not start or timed out. */
    private suspend fun gattOp(start: () -> Boolean): Pair<Int, ByteArray?>? = ops.withLock {
        val done = CompletableDeferred<Pair<Int, ByteArray?>>().also { pendingOp = it }
        try {
            val started = try {
                start()
            } catch (e: SecurityException) {
                Log.w(TAG, "Bluetooth permission revoked: ${e.message}")
                false
            }
            if (!started) return@withLock null
            withTimeoutOrNull(OP_TIMEOUT_MS) { done.await() }
        } finally {
            pendingOp = null
        }
    }

    private fun deviceExtra(intent: Intent): BluetoothDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
        }

    private companion object {
        const val TAG = "Omnesis:Omi"
        const val OP_TIMEOUT_MS = 5_000L
        const val BOND_TIMEOUT_MS = 30_000L
    }
}
