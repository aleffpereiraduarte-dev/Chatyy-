// Smoke Kotlin/JVM do núcleo REAL (CONTRATO §6): funções livres, mídia, HttpTransport
// estrangeiro (Kotlin → Rust) e CryptoCore.open suspend com store SQLite. Sem rede.
import com.chatyy.crypto.core.*
import kotlinx.coroutines.runBlocking
import java.nio.file.Files

class SemRede : HttpTransport {
    override suspend fun call(action: String, bodyJson: String): HttpResponse =
        HttpResponse(503u, "{\"success\":false,\"data\":{\"code\":\"smoke\"}}")
}

fun main() = runBlocking {
    val v = coreVersion()
    check(v.startsWith("chatyy-crypto ")) { "coreVersion inesperado" }
    check(envelopeVersion("{\"e2e\":5,\"c\":{}}") == 5uL) { "envelopeVersion" }
    val dev = newDeviceId("P")
    val plain = "foto 🔒".toByteArray()
    val enc = encryptBytes(plain)
    check(decryptBytes(enc.data, enc.infoJson).contentEquals(plain)) { "mídia" }
    val dir = Files.createTempDirectory("chatyy-smoke").toFile()
    val core = CryptoCore.open(
        OpenOptions(dir.absolutePath, "k".repeat(32), "1", dev, ProcessRole.APP, "smoke"), SemRede())
    val me = core.thisDevice()
    check(me.deviceId == dev && me.ed25519.length == 43) { "thisDevice" }
    dir.deleteRecursively()
    println("KOTLIN SMOKE OK: $v | device ${dev.length} chars | mídia ok | CryptoCore.open+thisDevice ok")
}
