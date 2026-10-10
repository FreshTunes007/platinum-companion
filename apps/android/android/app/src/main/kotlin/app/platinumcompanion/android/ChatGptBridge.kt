package app.platinumcompanion.android

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import io.flutter.plugin.common.MethodChannel
import java.math.BigInteger
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec

/** No token persistence, analytics, WebView, fallback endpoints or secret logging. */
class ChatGptBridge(private val activity: Activity) {
    fun handle(call: io.flutter.plugin.common.MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "openAuthorization" -> {
                    val uri = Uri.parse(call.argument<String>("url") ?: throw IllegalArgumentException())
                    require(uri.scheme == "https" && uri.host == "auth.openai.com" && uri.path == "/api/accounts/authorize" && uri.port == -1 && uri.userInfo == null)
                    activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
                    result.success(null)
                }
                "verifySignature" -> {
                    fun bytes(name: String): ByteArray = Base64.decode(call.argument<String>(name) ?: throw IllegalArgumentException(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                    val modulus = BigInteger(1, bytes("n"))
                    require(modulus.bitLength() in 2048..8192)
                    val exponent = BigInteger(1, bytes("e"))
                    require(exponent >= BigInteger.valueOf(3) && exponent.bitLength() <= 32 && exponent.testBit(0))
                    val input = call.argument<String>("input") ?: throw IllegalArgumentException()
                    require(input.length <= 32768 && input.all { it.code in 32..126 })
                    val key = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(modulus, exponent))
                    val verifier = Signature.getInstance("SHA256withRSA")
                    verifier.initVerify(key); verifier.update(input.toByteArray(Charsets.US_ASCII))
                    result.success(verifier.verify(bytes("signature")))
                }
                else -> result.notImplemented()
            }
        } catch (_: Exception) { result.error("chatgpt_native_failure", "Не удалось выполнить безопасную операцию ChatGPT.", null) }
    }
}
