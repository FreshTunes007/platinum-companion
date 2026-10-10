package app.platinumcompanion.android

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream

/** Selected documents only; no URI permissions, original file, or EXIF retained. */
internal object GameImageImport {
    private const val maxBytes = 3 * 1024 * 1024
    private const val maxPixels = 12000000L

    fun read(resolver: ContentResolver, uris: List<Uri>): List<Map<String, Any>> {
        require(uris.size in 1..3)
        return uris.map { uri ->
            require(uri.scheme == "content")
            val source = resolver.openInputStream(uri)?.use { input ->
                val buffer = ByteArray(16384)
                val output = ByteArrayOutputStream()
                while (true) {
                    val size = input.read(buffer)
                    if (size == -1) break
                    require(output.size() + size <= maxBytes)
                    output.write(buffer, 0, size)
                }
                output.toByteArray()
            } ?: throw IllegalArgumentException()
            val png = source.size > 8 && source.copyOfRange(0, 8).contentEquals(
                byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
            val jpeg = source.size > 3 && source[0] == 0xff.toByte() &&
                source[1] == 0xd8.toByte() && source[2] == 0xff.toByte()
            require(png || jpeg)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(source, 0, source.size, bounds)
            require(bounds.outWidth > 0 && bounds.outHeight > 0)
            require(bounds.outWidth.toLong() * bounds.outHeight <= maxPixels)
            require(bounds.outMimeType == if (png) "image/png" else "image/jpeg")
            val bitmap = BitmapFactory.decodeByteArray(source, 0, source.size,
                BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 })
                ?: throw IllegalArgumentException()
            var normalized: Bitmap = bitmap
            try {
                require(bitmap.width.toLong() * bitmap.height <= maxPixels)
                if (jpeg && Build.VERSION.SDK_INT >= 24) {
                    val orientation = runCatching {
                        ExifInterface(ByteArrayInputStream(source)).getAttributeInt(
                            ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
                    val transform = Matrix()
                    when (orientation) {
                        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> transform.setScale(-1f, 1f)
                        ExifInterface.ORIENTATION_ROTATE_180 -> transform.setRotate(180f)
                        ExifInterface.ORIENTATION_FLIP_VERTICAL -> transform.setScale(1f, -1f)
                        ExifInterface.ORIENTATION_TRANSPOSE -> { transform.setRotate(90f); transform.postScale(-1f, 1f) }
                        ExifInterface.ORIENTATION_ROTATE_90 -> transform.setRotate(90f)
                        ExifInterface.ORIENTATION_TRANSVERSE -> { transform.setRotate(270f); transform.postScale(-1f, 1f) }
                        ExifInterface.ORIENTATION_ROTATE_270 -> transform.setRotate(270f)
                    }
                    if (!transform.isIdentity) normalized = Bitmap.createBitmap(bitmap, 0, 0,
                        bitmap.width, bitmap.height, transform, true)
                }
                val bytes = ByteArrayOutputStream()
                val bounded = object : OutputStream() {
                    override fun write(b: Int) {
                        require(bytes.size() + 1 <= maxBytes)
                        bytes.write(b)
                    }
                    override fun write(b: ByteArray, off: Int, len: Int) {
                        require(bytes.size() + len <= maxBytes)
                        bytes.write(b, off, len)
                    }
                }
                check(normalized.compress(if (png) Bitmap.CompressFormat.PNG else
                    Bitmap.CompressFormat.JPEG, 88, bounded))
                val sanitized = bytes.toByteArray()
                require(sanitized.isNotEmpty() && sanitized.size <= maxBytes)
                mapOf("mimeType" to if (png) "image/png" else "image/jpeg",
                    "width" to normalized.width, "height" to normalized.height,
                    "byteLength" to sanitized.size,
                    "dataBase64" to Base64.encodeToString(sanitized, Base64.NO_WRAP))
            } finally {
                if (normalized !== bitmap) normalized.recycle()
                bitmap.recycle()
            }
        }
    }
}
