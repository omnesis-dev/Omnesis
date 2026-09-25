// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview as CameraPreview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/** Whether the CAMERA permission is currently held. */
fun cameraPermissionGranted(context: android.content.Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED

/**
 * Live CameraX preview that runs ML Kit on-device QR analysis on each frame and invokes
 * [onQrCode] exactly once, with the raw decoded string, on the first QR_CODE hit. Mounting
 * this composable assumes the CAMERA permission is already granted — the caller
 * ([PairingScreen]) gates on that and shows a permission/fallback affordance otherwise.
 *
 * Mirrors the iOS `QRScannerViewController`: bind the back camera, decode QR, deliver the
 * first hit and stop. The Android decode/exchange already lives in `PairingService.pair(raw)`;
 * this surface only produces the raw string.
 */
@Composable
fun QrScannerPreview(
    onQrCode: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    // A single-frame analyzer that delivers the first QR exactly once. `delivered` guards
    // against the burst of frames that arrive between the hit and unbinding the use case.
    val analyzer = remember { QrCodeAnalyzer(onQrCode) }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }

    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val previewView = PreviewView(ctx).apply {
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }
                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                providerFuture.addListener({
                    val provider = providerFuture.get()
                    val preview = CameraPreview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .also { it.setAnalyzer(analysisExecutor, analyzer) }
                    runCatching {
                        provider.unbindAll()
                        provider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    }.onFailure { Log.w(TAG, "Failed to bind camera use cases", it) }
                }, ContextCompat.getMainExecutor(ctx))
                previewView
            },
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
            analysisExecutor.shutdown()
        }
    }
}

private const val TAG = "Omnesis:QrScanner"

/** ML Kit analyzer that reports the first decoded QR string, then ignores further frames. */
private class QrCodeAnalyzer(private val onQrCode: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val scanner = BarcodeScanning.getClient()

    @Volatile
    private var delivered = false

    @SuppressLint("UnsafeOptInUsageError")
    @ExperimentalGetImage
    override fun analyze(imageProxy: ImageProxy) {
        if (delivered) {
            imageProxy.close()
            return
        }
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }
        val input = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener { barcodes ->
                val raw = barcodes.firstOrNull { it.format == Barcode.FORMAT_QR_CODE }?.rawValue
                if (raw != null && !delivered) {
                    delivered = true
                    onQrCode(raw)
                }
            }
            .addOnFailureListener { Log.w(TAG, "Barcode scan failed", it) }
            .addOnCompleteListener { imageProxy.close() }
    }
}
