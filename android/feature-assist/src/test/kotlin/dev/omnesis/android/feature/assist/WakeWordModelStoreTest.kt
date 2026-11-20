// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files

class WakeWordModelStoreTest {
    private val bodies = mutableMapOf<String, ByteArray>()
    private val failing = mutableSetOf<String>()
    private val dir: File = Files.createTempDirectory("wakeword").toFile()

    /** Started at once: the words below need its address. */
    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val name = request.path!!.removePrefix("/")
                if (name in failing) return MockResponse().setResponseCode(404)
                return bodies[name]?.let { MockResponse().setBody(Buffer().write(it)) } ?: MockResponse().setResponseCode(404)
            }
        }
        start()
    }

    @After fun tearDown() {
        server.shutdown()
        dir.deleteRecursively()
    }

    private fun file(name: String, body: ByteArray, digestOf: ByteArray = body): WakeWordModelFile {
        bodies[name] = body
        return WakeWordModelFile(name, server.url("/$name").toString(), WakeWordModelStore.sha256(digestOf))
    }

    private fun word(id: String, body: ByteArray, digestOf: ByteArray = body) =
        WakeWord(id, id.replace('_', ' '), "$id.onnx", file("$id.onnx", body, digestOf), "test")

    private val mel = byteArrayOf(1, 2, 3)
    private val emb = byteArrayOf(4, 5)
    private val one = word("word_one", byteArrayOf(6))
    private val two = word("word_two", byteArrayOf(7))

    private fun store(validate: (ByteArray) -> Unit = {}) =
        WakeWordModelStore(dir, OkHttpClient(), listOf(one, two), listOf(file("mel", mel), file("emb", emb)), validate)

    @Test fun onlyTheWordsAskedForAreFetchedBesideTheSharedModels() = runBlocking {
        val store = store()
        assertFalse(store.installed(one))
        store.download(listOf(one))
        assertTrue(store.installed(one))
        assertFalse(store.installed(two))
        assertEquals(3, server.requestCount)

        // Nothing is fetched again; a second word costs one more file.
        store.download(listOf(one, two))
        assertEquals(4, server.requestCount)
        assertTrue(store.installed(two))
    }

    @Test fun theDetectorGetsTheSharedModelsAndOneClassifierPerWordInOrder() = runBlocking {
        val store = store()
        store.download(listOf(one, two))
        val models = store.load(listOf(two, one))
        assertArrayEquals(byteArrayOf(1, 2, 3), models.melspectrogram)
        assertArrayEquals(byteArrayOf(4, 5), models.embedding)
        assertEquals(listOf(7.toByte(), 6.toByte()), models.classifiers.map { it.single() })
    }

    @Test fun aFileWithTheWrongDigestIsRefusedAndNotSaved() = runBlocking {
        val bad = word("bad", byteArrayOf(1), digestOf = byteArrayOf(9))
        val store = WakeWordModelStore(dir, OkHttpClient(), listOf(bad), emptyList())
        try {
            store.download(listOf(bad))
            fail("expected a refused digest")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("digest"))
        }
        assertFalse(store.installed(bad))
        assertTrue(dir.listFiles()!!.isEmpty())
    }

    @Test fun aFailedRequestSavesNothing() = runBlocking {
        val store = store()
        failing += "word_one.onnx"
        try {
            store.download(listOf(one))
            fail("expected a failure")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("404"))
        }
        assertFalse(store.installed(one))
    }

    @Test fun anImportedModelBecomesAWordNamedAfterItsFile() = runBlocking {
        val store = store()
        store.download(emptyList())
        val word = store.import("Ehi_Casa_v0.1.onnx", byteArrayOf(42))
        assertEquals("custom:ehi_casa_v0_1.onnx", word.id)
        assertEquals("ehi casa", word.phrase)
        assertTrue(word.custom)
        assertTrue(store.installed(word))
        assertEquals(word, store.word(word.id))
        assertEquals(listOf(one, two, word), store.words())
        assertEquals(42.toByte(), store.load(listOf(word)).classifiers.single().single())

        store.removeCustom(word)
        assertNull(store.word(word.id))
    }

    @Test fun anImportTheCheckRefusesIsNotKept() = runBlocking {
        val store = store(validate = { throw IOException("not a wake-word classifier") })
        try {
            store.import("noise.onnx", byteArrayOf(1))
            fail("expected a refusal")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("classifier"))
        }
        assertEquals(listOf(one, two), store.words())
    }

    @Test fun aSecondImportUnderTheSameNameIsRefused() = runBlocking {
        val store = store()
        store.import("ehi_casa.onnx", byteArrayOf(1))
        try {
            store.import("ehi casa.onnx", byteArrayOf(2))
            fail("expected a refusal")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("already exists"))
        }
    }

    @Test fun removeForgetsEveryModelImportedOnesToo() = runBlocking {
        val store = store()
        store.download(listOf(one))
        val custom = store.import("mine.onnx", byteArrayOf(1))
        store.remove()
        assertFalse(store.installed(one))
        assertNull(store.word(custom.id))
    }

    @Test fun everyChangeOnDiskIsSignalled() = runBlocking {
        val store = store()
        val start = store.changes.value
        store.download(listOf(one))
        val afterDownload = store.changes.value
        assertTrue(afterDownload > start)
        store.download(listOf(one))
        assertEquals("nothing new, nothing signalled", afterDownload, store.changes.value)
        val custom = store.import("mine.onnx", byteArrayOf(1))
        assertTrue(store.changes.value > afterDownload)
        val afterImport = store.changes.value
        store.removeCustom(custom)
        assertTrue(store.changes.value > afterImport)
        val afterRemoval = store.changes.value
        store.remove()
        assertTrue(store.changes.value > afterRemoval)
    }

    @Test fun theCatalogueNamesDistinctPinnedFilesAndStartsWithOkHome() {
        val catalog = WakeWordModelCatalog.words
        assertEquals(WakeWordModelCatalog.OK_HOME, catalog.first())
        val files = WakeWordModelCatalog.shared + catalog.mapNotNull { it.download }
        assertEquals(files.size, files.map { it.fileName }.toSet().size)
        assertEquals(catalog.size, catalog.map { it.id }.toSet().size)
        assertTrue(files.all { it.sha256.matches(Regex("[0-9a-f]{64}")) && it.url.startsWith("https://") })
        assertTrue(catalog.none { it.custom })
    }
}
