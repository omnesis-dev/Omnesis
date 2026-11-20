// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** One model file, where it is published and the digest it must have. */
data class WakeWordModelFile(val fileName: String, val url: String, val sha256: String)

/**
 * One wake word: the openWakeWord classifier that hears it. A catalogue word
 * is fetched from [download]; an imported one has no [download] and lives
 * only on this phone.
 */
data class WakeWord(
    /** Stable id kept in the routes: the catalogue name, or `custom:<file>`. */
    val id: String,
    /** What the wearer says, as shown. */
    val phrase: String,
    val fileName: String,
    val download: WakeWordModelFile?,
    /** Where the model comes from and under which licence, as shown before it is fetched. */
    val origin: String,
) {
    val custom: Boolean get() = download == null
}

/**
 * The openWakeWord models the app can fetch. They are not shipped with the
 * app: the user downloads them from where they are published, and each file
 * is checked against the digest pinned here before it is used.
 *
 * The melspectrogram and embedding models are shared by every word; each word
 * adds only its small classifier. openWakeWord's own words come from its
 * v0.5.1 release (its code is Apache-2.0, its trained models CC BY-NC-SA 4.0).
 * “ok home” was trained by the Home Assistant community and is published, MIT
 * licensed, in a collection pinned here to one commit.
 */
object WakeWordModelCatalog {
    private const val RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
    private const val COMMUNITY =
        "https://raw.githubusercontent.com/fwartner/home-assistant-wakewords-collection/1c6d6a82947ff1367d8e5e50cc999c00943ccb9c"
    private const val OWW_ORIGIN = "openWakeWord project, non-commercial use only (CC BY-NC-SA 4.0)"
    private const val COMMUNITY_ORIGIN = "Home Assistant community wake-word collection (MIT)"

    val MELSPECTROGRAM = WakeWordModelFile(
        "melspectrogram.onnx",
        "$RELEASE/melspectrogram.onnx",
        "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    )
    val EMBEDDING = WakeWordModelFile(
        "embedding_model.onnx",
        "$RELEASE/embedding_model.onnx",
        "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
    )

    /** What every word needs besides its own classifier: the melspectrogram model, then the embedding model. */
    val shared = listOf(MELSPECTROGRAM, EMBEDDING)

    private fun release(id: String, phrase: String, sha256: String) =
        WakeWord(id, phrase, "${id}_v0.1.onnx", WakeWordModelFile("${id}_v0.1.onnx", "$RELEASE/${id}_v0.1.onnx", sha256), OWW_ORIGIN)

    val OK_HOME = WakeWord(
        "ok_home",
        "ok home",
        "ok_home.onnx",
        WakeWordModelFile(
            "ok_home.onnx",
            "$COMMUNITY/en/ok_home/ok_home.onnx",
            "93ec44a1b4ce76add6453d5cf52217b0496219dfaf425d376f7481495e005395",
        ),
        COMMUNITY_ORIGIN,
    )
    val HEY_JARVIS = release("hey_jarvis", "hey jarvis", "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb")
    val ALEXA = release("alexa", "alexa", "6ff566a01d12670e8d9e3c59da32651db1575d17272a601b7f8a39283dfbae3e")
    val HEY_MYCROFT = release("hey_mycroft", "hey mycroft", "c2a311e8fa1338de89c31b3b46dc4dffd4af2f9a8d6ddead48893c2d301b1f18")
    val HEY_RHASSPY = release("hey_rhasspy", "hey rhasspy", "5a9b3ed3be2910e35780e097905aa9f35a9c10038df47914cf2b3ec4d670f6ea")

    val words = listOf(OK_HOME, HEY_JARVIS, ALEXA, HEY_MYCROFT, HEY_RHASSPY)
}

/**
 * The wake-word models on this phone, in [directory]; imported words in its
 * `custom` folder. A file counts only once its digest matched (or, imported,
 * once [validate] accepted it); a download is written beside it and moved
 * into place, so a cut download never leaves a half file under the real name.
 */
class WakeWordModelStore(
    private val directory: File,
    private val http: OkHttpClient,
    private val catalog: List<WakeWord> = WakeWordModelCatalog.words,
    /** The melspectrogram model, then the embedding model. */
    private val shared: List<WakeWordModelFile> = WakeWordModelCatalog.shared,
    /** Throws [IOException] when the bytes are not a classifier the detector can run. */
    private val validate: (ByteArray) -> Unit = OpenWakeWordDetector::checkClassifier,
) {
    private val customDir get() = File(directory, CUSTOM_DIR)

    private val _changes = MutableStateFlow(0)

    /** Moves on after every download, import or removal, so listening can pick up what is now on the phone. */
    val changes: StateFlow<Int> = _changes.asStateFlow()

    private fun changed() = _changes.update { it + 1 }

    /** The catalogue, then the imported words. */
    fun words(): List<WakeWord> = catalog + customWords()

    fun word(id: String): WakeWord? = words().firstOrNull { it.id == id }

    /** The word's classifier and the shared models are all on the phone. */
    fun installed(word: WakeWord): Boolean = shared.all { File(directory, it.fileName).isFile } && fileOf(word).isFile

    fun load(words: List<WakeWord>): OpenWakeWordModels = OpenWakeWordModels(
        melspectrogram = File(directory, shared[0].fileName).readBytes(),
        embedding = File(directory, shared[1].fileName).readBytes(),
        classifiers = words.map { fileOf(it).readBytes() },
    )

    /** Fetch whatever [words] still miss. Throws [IOException] on a network failure or a digest that does not match. */
    suspend fun download(words: List<WakeWord>) = withContext(Dispatchers.IO) {
        directory.mkdirs()
        for (file in shared + words.mapNotNull { it.download }) {
            val target = File(directory, file.fileName)
            if (target.isFile) continue
            val bytes = http.newCall(Request.Builder().url(file.url).build()).execute().use { response ->
                if (!response.isSuccessful) throw IOException("${file.fileName}: HTTP ${response.code}")
                response.body?.bytes() ?: throw IOException("${file.fileName}: empty response")
            }
            val digest = sha256(bytes)
            if (!digest.equals(file.sha256, ignoreCase = true)) throw IOException("${file.fileName}: unexpected digest $digest")
            save(target, bytes)
            changed()
        }
    }

    /**
     * Keep a classifier the user trained or found elsewhere, named after
     * [fileName]. Throws [IOException] when it is not a `.onnx` the detector
     * can run, or a word of that name already exists.
     */
    suspend fun import(fileName: String, bytes: ByteArray): WakeWord = withContext(Dispatchers.IO) {
        val stem = fileName.substringAfterLast('/').removeSuffix(".onnx").removeSuffix(".ONNX")
        val safe = stem.lowercase().replace(Regex("[^a-z0-9]+"), "_").trim('_')
        if (safe.isEmpty()) throw IOException("the file needs a name")
        if (bytes.size > MAX_CUSTOM_BYTES) throw IOException("the file is too large for a wake-word model")
        validate(bytes)
        val target = File(customDir, "$safe.onnx")
        if (target.exists()) throw IOException("a wake word named “${phraseOf(safe)}” already exists")
        customDir.mkdirs()
        save(target, bytes)
        changed()
        customWord(target)
    }

    fun removeCustom(word: WakeWord) {
        if (word.custom && fileOf(word).delete()) changed()
    }

    /** Delete every model, the imported ones too. */
    fun remove() {
        directory.deleteRecursively()
        changed()
    }

    private fun customWords(): List<WakeWord> =
        customDir.listFiles { f -> f.isFile && f.name.endsWith(".onnx") }.orEmpty().sortedBy { it.name }.map(::customWord)

    private fun customWord(file: File): WakeWord {
        val stem = file.name.removeSuffix(".onnx")
        return WakeWord("$CUSTOM_PREFIX${file.name}", phraseOf(stem), file.name, download = null, origin = "imported on this phone")
    }

    private fun fileOf(word: WakeWord) = if (word.custom) File(customDir, word.fileName) else File(directory, word.fileName)

    private fun save(target: File, bytes: ByteArray) {
        val partial = File(target.parentFile, "${target.name}.part")
        partial.writeBytes(bytes)
        if (!partial.renameTo(target)) throw IOException("${target.name}: could not be saved")
    }

    companion object {
        const val CUSTOM_PREFIX = "custom:"
        private const val CUSTOM_DIR = "custom"

        /** openWakeWord classifiers are a few hundred KB; anything near this is not one. */
        private const val MAX_CUSTOM_BYTES = 20 * 1024 * 1024

        private fun phraseOf(stem: String) = stem.replace('_', ' ').replace(Regex("\\s+v\\d+([ .]\\d+)*$"), "").trim()

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
