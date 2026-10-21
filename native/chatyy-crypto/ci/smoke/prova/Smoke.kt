// Smoke Kotlin/JVM do núcleo TEMPORÁRIO (prova): bindings UniFFI + JNA + lib do host.
import com.chatyy.crypto.core.coreVersion
import com.chatyy.crypto.core.provaRoundtrip
import com.chatyy.crypto.core.provaStoreOpen
import kotlinx.coroutines.runBlocking
import java.nio.file.Files

fun main() = runBlocking {
    val v = coreVersion()
    check(v.startsWith("chatyy-crypto")) { "coreVersion inesperado" }
    val msg = "Olá, isto é E2EE de verdade 🔒"
    check(provaRoundtrip(msg) == msg) { "roundtrip divergente" }
    val dir = Files.createTempDirectory("chatyy-prova").toFile()
    check(provaStoreOpen(dir.absolutePath, "k".repeat(32)) == 43u) { "store" }
    dir.deleteRecursively()
    println("KOTLIN SMOKE OK: $v | roundtrip Olm/Megolm ok | store SQLite ok")
}
