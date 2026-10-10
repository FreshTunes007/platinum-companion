package app.platinumcompanion.android

import android.app.Activity
import android.content.Intent
import android.util.AtomicFile
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors

/** File access is scoped to the selected document. No broad storage access or Sony credentials. */
class MainActivity : FlutterActivity() {
    private val maximumBytes = 64 * 1024 * 1024
    private val worker = Executors.newSingleThreadExecutor()
    private var pendingPicker: MethodChannel.Result? = null
    private var pendingImagePicker: MethodChannel.Result? = null
    private val store: AtomicFile get() = AtomicFile(File(noBackupFilesDir, "library.json"))

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val chatgpt = ChatGptBridge(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "platinum_companion/chatgpt")
            .setMethodCallHandler { call, result -> chatgpt.handle(call, result) }
        val updates = FreshoryxUpdates(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "platinum_companion/updates")
            .setMethodCallHandler { call, result ->
                when(call.method) {
                    "installed" -> result.success(updates.installed())
                    "check" -> worker.execute {
                        try {
                            val value=updates.check(call.argument<Boolean>("manual") ?: false,call.argument<String>("channel") ?: "stable")
                            runOnUiThread { result.success(value) }
                        } catch (_: Exception) { runOnUiThread { result.error("update_unavailable", "Не удалось безопасно проверить обновление. Попробуйте позже.", null) } }
                    }
                    "defer" -> { updates.defer(call.argument<String>("channel") ?: "stable",call.argument<Int>("versionCode") ?: 0); result.success(null) }
                    "open" -> try { updates.open(call.argument<String>("url") ?: ""); result.success(null) } catch (_: Exception) { result.error("update_link", "Не удалось открыть официальную загрузку.", null) }
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "platinum_companion/files")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "pickSnapshot" -> {
                        if (pendingPicker != null || pendingImagePicker != null) {
                            result.error("busy", "Выбор файла уже открыт", null)
                        } else {
                            pendingPicker = result
                            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = "*/*"
                                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "application/octet-stream"))
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            try { startActivityForResult(intent, 4101) }
                            catch (_: Exception) {
                                pendingPicker = null
                                result.error("picker_unavailable", "Системный выбор файла недоступен", null)
                            }
                        }
                    }
                    "pickGameImages" -> {
                        if (pendingPicker != null || pendingImagePicker != null) {
                            result.error("busy", "Выбор файла уже открыт", null)
                        } else {
                            pendingImagePicker = result
                            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = "image/*"
                                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/jpeg", "image/png"))
                                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            try { startActivityForResult(intent, 4102) }
                            catch (_: Exception) {
                                pendingImagePicker = null
                                result.error("picker_unavailable", "Системный выбор изображений недоступен", null)
                            }
                        }
                    }
                    "imageCacheDirectory" -> safely(result) { val dir=File(noBackupFilesDir,"sony-image-cache");dir.mkdirs();dir.absolutePath }
                    "readConversations" -> safely(result) { val f=AtomicFile(File(noBackupFilesDir,"conversations.json"));if (!f.baseFile.exists()) null else f.openRead().use { readBounded(it,4*1024*1024) } }
                    "writeConversations" -> safely(result) { val bytes=(call.argument<String>("json") ?: throw IllegalArgumentException()).toByteArray(Charsets.UTF_8);require(bytes.size<=4*1024*1024);val f=AtomicFile(File(noBackupFilesDir,"conversations.json"));val out=f.startWrite();try{out.write(bytes);f.finishWrite(out)}catch(e:Exception){f.failWrite(out);throw e};null }
                    "readJourneys" -> safely(result) { val f=AtomicFile(File(noBackupFilesDir,"journeys.json"));if (!f.baseFile.exists()) null else f.openRead().use { readBounded(it,4*1024*1024) } }
                    "writeJourneys" -> safely(result) { val bytes=(call.argument<String>("json") ?: throw IllegalArgumentException()).toByteArray(Charsets.UTF_8);require(bytes.size<=4*1024*1024);val f=AtomicFile(File(noBackupFilesDir,"journeys.json"));val out=f.startWrite();try{out.write(bytes);f.finishWrite(out)}catch(e:Exception){f.failWrite(out);throw e};null }
                    "readIndex" -> safely(result) { val f=AtomicFile(File(noBackupFilesDir,"library-index.json")); if (!f.baseFile.exists()) null else f.openRead().use { readBounded(it,4*1024*1024) } }
                    "writeIndex" -> safely(result) { val bytes=(call.argument<String>("json") ?: throw IllegalArgumentException()).toByteArray(Charsets.UTF_8); require(bytes.size<=4*1024*1024); val f=AtomicFile(File(noBackupFilesDir,"library-index.json"));val out=f.startWrite();try{out.write(bytes);f.finishWrite(out)}catch(e:Exception){f.failWrite(out);throw e};null }
                    "readSnapshot" -> safely(result) {
                        if (!store.baseFile.exists()) null else store.openRead().use { readBounded(it, maximumBytes + 1024) }
                    }
                    "writeSnapshot" -> safely(result) {
                        val json = call.argument<String>("json") ?: throw IllegalArgumentException()
                        val bytes = json.toByteArray(Charsets.UTF_8)
                        require(bytes.size <= maximumBytes + 1024)
                        // Dart validates the complete schema before this atomic durable commit.
                        val output = store.startWrite()
                        try { output.write(bytes); store.finishWrite(output) }
                        catch (e: Exception) { store.failWrite(output); throw e }
                        null
                    }
                    "clearSnapshot" -> safely(result) {
                        store.delete()
                        check(!store.baseFile.exists())
                        null
                    }
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "platinum_companion/preferences")
            .setMethodCallHandler { call, result ->
                val preferences = getSharedPreferences("appearance", MODE_PRIVATE)
                when (call.method) {
                    "readTrophyLanguage" -> result.success(preferences.getString("trophyLanguage", "ru"))
                    "writeTrophyLanguage" -> {
                        val language = call.argument<String>("language")
                        if (language !in listOf("ru", "original")) result.error("invalid_language", "Неизвестный язык", null)
                        else { preferences.edit().putString("trophyLanguage", language).apply(); result.success(null) }
                    }
                    "readTheme" -> result.success(preferences.getString("theme", "dark"))
                    "writeTheme" -> {
                        val theme = call.argument<String>("theme")
                        if (theme !in listOf("dark", "light", "system")) result.error("invalid_theme", "Неизвестная тема", null)
                        else { preferences.edit().putString("theme", theme).apply(); result.success(null) }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun safely(result: MethodChannel.Result, action: () -> Any?) {
        worker.execute {
            try {
                val value = action()
                runOnUiThread { result.success(value) }
            } catch (_: Exception) {
                runOnUiThread { result.error("local_file_error", "Не удалось прочитать или сохранить файл. Проверьте формат и размер до 10 МБ.", null) }
            }
        }
    }

    private fun readBounded(input: InputStream, limit: Int = maximumBytes): String {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16384)
        while (true) {
            val read = input.read(buffer)
            if (read == -1) break
            require(output.size() + read <= limit)
            output.write(buffer, 0, read)
        }
        return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString()
    }

    @Deprecated("Android activity result bridge for FlutterActivity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 4102) {
            val result = pendingImagePicker ?: return
            pendingImagePicker = null
            if (resultCode != Activity.RESULT_OK || data == null) { result.success(null); return }
            val uris = buildList {
                val selected = data.clipData
                if (selected != null) {
                    for (i in 0 until selected.itemCount) add(selected.getItemAt(i).uri)
                } else data.data?.let { add(it) }
            }.distinct()
            worker.execute {
                try {
                    val images = GameImageImport.read(contentResolver, uris)
                    runOnUiThread { result.success(images) }
                } catch (_: Exception) {
                    runOnUiThread { result.error("invalid_game_images", "Выберите до 3 JPEG/PNG, каждый до 3 МБ и 12 мегапикселей. Повреждённые файлы не принимаются.", null) }
                }
            }
            return
        }
        if (requestCode != 4101) return
        val result = pendingPicker ?: return
        pendingPicker = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) { result.success(null); return }
        safely(result) {
            require(uri.scheme == "content")
            contentResolver.openInputStream(uri)?.use { readBounded(it) } ?: throw IllegalArgumentException()
        }
    }
}
