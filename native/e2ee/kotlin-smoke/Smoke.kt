import expo.modules.chatyye2ee.core.*
import java.io.File
import java.util.Base64

fun str(json: String, path: List<String>): String {
    // tiny extractor good enough for the vectors file layout
    var s = json
    for (p in path.dropLast(1)) { s = s.substring(s.indexOf("\"$p\"")) }
    val k = "\"${path.last()}\": \""
    val i = s.indexOf(k) + k.length
    return s.substring(i, s.indexOf('"', i))
}

fun main(args: Array<String>) {
    println(coreVersion())
    val key = ByteArray(32) { 7 }
    val a = OlmAccount(); val b = OlmAccount()
    b.generateOneTimeKeys(2u)
    val otk = Regex("\"[^\"]+\":\"([^\"]+)\"").find(b.oneTimeKeys())!!.groupValues[1]
    b.markKeysAsPublished()
    val sa = a.createOutboundSession(b.curve25519(), otk)
    val m = sa.encrypt("oi kotlin")
    val t = Regex("\"t\":(\\d)").find(m)!!.groupValues[1].toUInt()
    val body = Regex("\"b\":\"([^\"]+)\"").find(m)!!.groupValues[1]
    val r = b.createInboundSession(a.curve25519(), t, body)
    check(r.plaintext == "oi kotlin") { "plaintext" }
    check(preKeySessionId(t, body) == sa.sessionId())
    val sa2 = OlmSession.fromPickle(sa.pickle(key), key)
    check(sa2.sessionId() == sa.sessionId())
    try { OlmSession.fromPickle(sa.pickle(key), ByteArray(32)); error("wrong key accepted") } catch (e: E2eeException) { println("ok wrong key -> ${e::class.simpleName}") }
    try { r.session.decrypt(t, body); error("replay accepted") } catch (e: E2eeException) { println("ok replay rejected") }
    // wasm vectors
    val v = File(args[0]).readText()
    val pk = Base64.getDecoder().decode(str(v, listOf("pickle_key")))
    val bob = OlmAccount.fromPickle(str(v, listOf("bob", "account_pickle")), pk)
    check(bob.curve25519() == str(v, listOf("bob", "curve25519")))
    val msgs = v.substring(v.indexOf("\"messages\""))
    val b0 = Regex("\"b\": \"([^\"]+)\"").find(msgs)!!.groupValues[1]
    val pt0 = Regex("\"pt\": \"([^\"]+)\"").find(msgs)!!.groupValues[1]
    val rr = bob.createInboundSession(str(v, listOf("alice", "curve25519")), 0u, b0)
    check(rr.plaintext == pt0) { "wasm vector: ${rr.plaintext} != $pt0" }
    check(ed25519Verify(str(v, listOf("bob", "ed25519")), str(v, listOf("bob", "otk_sig_msg")), str(v, listOf("bob", "otk_sig"))))
    listOf(a, b, bob).forEach { it.close() }; sa.close(); sa2.close(); r.session.close(); rr.session.close()
    println("KOTLIN OK — wasm vector decrypted: $pt0")
}
