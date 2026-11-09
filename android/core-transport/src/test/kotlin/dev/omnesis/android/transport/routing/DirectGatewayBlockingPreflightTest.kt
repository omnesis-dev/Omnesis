// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.routing

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URLClassLoader
import java.util.concurrent.TimeUnit

class DirectGatewayBlockingPreflightTest {
    @Test fun `blocking preflight completes even when its caller occupies the only IO worker`() {
        // A fresh VM makes the IO limit deterministic without changing other tests.
        val entries = linkedSetOf<String>()
        entries.addAll(requireNotNull(System.getProperty("java.class.path")).split(File.pathSeparator))
        var loader: ClassLoader? = javaClass.classLoader
        while (loader != null) {
            if (loader is URLClassLoader) entries.addAll(loader.urLs.filter { it.protocol?.equals("file") == true }.map { File(it.toURI()).path })
            loader = loader.parent
        }
        val output = File.createTempFile("gateway-preflight", ".log")
        val process = ProcessBuilder(File(System.getProperty("java.home"), "bin/java").path,
            "-Dkotlinx.coroutines.io.parallelism=1", "-cp", entries.joinToString(File.pathSeparator),
            BlockingPreflightProcess::class.java.name).redirectErrorStream(true).redirectOutput(output).start()
        try {
            assertTrue("Preflight queued behind its blocked IO caller: ${output.readText()}", process.waitFor(10, TimeUnit.SECONDS))
            assertEquals(output.readText(), 0, process.exitValue())
        } finally { process.destroyForcibly(); process.waitFor(); output.delete() }
    }
}

object BlockingPreflightProcess {
    @JvmStatic fun main(args: Array<String>) = runBlocking {
        // A refused local port needs no TLS fixture; the dispatch itself must finish.
        val port = ServerSocket(0).use { it.localPort }
        val route = DirectGatewayRoute.createValidated("https://gateway.example.test",
            listOf(DirectGatewayCandidate("127.0.0.1", port)), true)!!
        val client = OkHttpClient()
        withContext(Dispatchers.IO) {
            check(!DirectGatewayProbe.verifyCandidate(route, client, InetSocketAddress("127.0.0.1", port), 750))
        }
        route.retire()
    }
}
