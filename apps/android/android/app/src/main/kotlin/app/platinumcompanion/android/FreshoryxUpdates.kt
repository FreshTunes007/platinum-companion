package app.platinumcompanion.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import java.security.KeyFactory
import java.security.Signature
import java.security.MessageDigest
import java.security.spec.X509EncodedKeySpec
import android.util.Base64

/** Signed public releases only. No credentials, file installation or trophy storage. */
class FreshoryxUpdates(private val context: Context) {
    companion object {
        const val PUBLIC_KEY = "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAuppo1Uw9XopDVYLVNfer2AGGyfOvW4Czl5VrMMzmY2FNyyvJuVU8JqpnhnogWVPJWVp9XCuGPPyLRXHfYQA56/jVxsdIHKe4YDJ6fnAVf0672CT2EmXeTgm0/Wu8BUbtGl0Jhkecroflx/mpalYCWmGVRFU/9EkJJ2mXKY+CkgePnFKth1FMa7CKe2OF3QixHQAvE/5X9xjZJ9cdJroxVQsXmeGrunioX0uuRk9kzOOpa2zH8FDIniZhHAhVHrEQVlOQF7JjiWDB6s66xUEORFVHPBF/QUnJExiTwTGL5WavoEbaLM/rBQyN6GVLLTLiOuSs2GC3VgcZHrTISh8cEm4H8UHIx5NmKqHSJrK72aRtNPY1e7BHhP2URorjyunWlVfoL8xzfV74G53mNqw364rrd0lIH2yuvTA9469ypiGuLLql6x6N291QYvTuv3mG+HJ/UmbuUVvdoUwhB83ePoywVERa3oIbqi1d+N7sXLYsU6qKL0KNJ/xj3uLgXB05AgMBAAE="
        const val CERTIFICATE = "ee9097e5036fdba53fd48add83535e878257f5f1e049b3e9ebaf530fdad90499"
    }
    private val preferences = context.getSharedPreferences("freshoryx_updates", Context.MODE_PRIVATE)
    @Suppress("DEPRECATION")
    fun installed(): Map<String, Any> {
        val info=context.packageManager.getPackageInfo(context.packageName, 0)
        return mapOf("versionName" to (info.versionName ?: ""), "versionCode" to info.versionCode, "sdk" to Build.VERSION.SDK_INT)
    }
    fun check(manual: Boolean, channel: String): Map<String, Any> {
        require(channel in listOf("stable", "beta"))
        val now=System.currentTimeMillis()
        val version=(installed()["versionCode"] as Int)
        val last=preferences.getLong("checked_"+channel, 0)
        if(!manual && now>=last && now-last<86400000) return mapOf("status" to "interval", "installedVersion" to version)
        preferences.edit().putLong("checked_"+channel,now).apply()
        val connection=URL("https://freshoryx.com/releases/platinum-companion/"+channel+".json").openConnection() as HttpsURLConnection
        connection.connectTimeout=10000; connection.readTimeout=10000; connection.instanceFollowRedirects=false
        try {
            check(connection.responseCode==200)
            val bytes=connection.inputStream.use { it.readBytesLimited(65536) }
            val envelope=JSONObject(String(bytes, Charsets.UTF_8))
            require(envelope.getInt("schemaVersion")==1 && envelope.getString("algorithm")=="RS256" && envelope.getString("keyId")=="freshoryx-rsa-2026")
            val payload=Base64.decode(envelope.getString("payload"),Base64.DEFAULT)
            require(payload.size<=32768)
            val verifier=Signature.getInstance("SHA256withRSA")
            verifier.initVerify(KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(Base64.decode(PUBLIC_KEY,Base64.DEFAULT))))
            verifier.update(payload)
            require(verifier.verify(Base64.decode(envelope.getString("signature"),Base64.DEFAULT)))
            val p=JSONObject(String(payload,Charsets.UTF_8))
            require(p.getInt("schemaVersion")==1 && p.getString("appId")=="platinum-companion" && p.getString("packageName")==context.packageName)
            require(p.getString("releaseChannel")==channel)
            val expires=java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",java.util.Locale.ROOT).apply { timeZone=java.util.TimeZone.getTimeZone("UTC"); isLenient=false }.parse(p.getString("expiresAt"))!!.time
            require(expires>=now)
            val sequence=p.getLong("releaseSequence"); require(sequence>0 && sequence>=preferences.getLong("sequence_"+channel,0))
            val remoteVersion=p.getInt("versionCode");require(remoteVersion>0 && p.getLong("apkSize")>0)
            require(Regex("[a-f0-9]{64}").matches(p.getString("sha256")))
            require(p.getString("signingCertificateSha256")==CERTIFICATE)
            @Suppress("DEPRECATION")
            val actual=context.packageManager.getPackageInfo(context.packageName,android.content.pm.PackageManager.GET_SIGNATURES).signatures
            require(actual!=null && actual.any { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { b -> "%02x".format(b) }==CERTIFICATE })
            val url=p.getString("apkUrl"); require(validUrl(url))
            val changes=p.getJSONArray("changelog");require(changes.length()<=20)
            val lines=(0 until changes.length()).map { changes.getString(it).also { line -> require(line.length<=500) } }
            preferences.edit().putLong("sequence_"+channel,sequence).apply()
            val sdk=p.getInt("minimumAndroidVersion");require(sdk>=24)
            val status=if(remoteVersion<=version) "current" else if(sdk>Build.VERSION.SDK_INT) "incompatible" else "available"
            val dismissed=preferences.getInt("dismissed_"+channel,0)==remoteVersion && now-preferences.getLong("dismissedAt_"+channel,0)<7*86400000L
            return mapOf("status" to status,"installedVersion" to version,"versionName" to p.getString("versionName"),"versionCode" to remoteVersion,"apkUrl" to url,"sha256" to p.getString("sha256"),"changelog" to lines,"showNotice" to (manual || !dismissed))
        } finally {connection.disconnect()}
    }
    fun defer(channel: String, version: Int) { require(channel in listOf("stable","beta")); preferences.edit().putInt("dismissed_"+channel,version).putLong("dismissedAt_"+channel,System.currentTimeMillis()).apply() }
    fun open(url: String) { require(validUrl(url)); context.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    private fun validUrl(value: String): Boolean {
        val u=Uri.parse(value)
        return u.scheme=="https" && u.host=="freshoryx.com" && u.port==-1 && u.userInfo==null && u.query==null && u.fragment==null && Regex("/downloads/platinum-companion/PlatinumCompanion-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk").matches(u.path ?: "")
    }
    private fun java.io.InputStream.readBytesLimited(limit: Int): ByteArray {
        val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(4096)
        while(true) { val n=read(buffer); if(n<0) break; require(output.size()+n<=limit);output.write(buffer,0,n) }
        return output.toByteArray()
    }
}
