package expo.modules.chatyymessagelist

// [2026-10-18 tg-look, apiVersion 10] Visual "nível Telegram" (P&B) da lista
// nativa. Prop `look` {tg} (0/1) vinda do JS (components/chat/nativeThreadList.js,
// kill switch globalThis.__chatyy_tg_look = false). Ausente/0 = visual antigo
// (rabicho WhatsApp no topo da 1ª bolha do grupo).
//   tg = 1: rabicho suave na ÚLTIMA bolha do grupo (embaixo, lado do autor),
//   cantos do autor justos dentro do grupo; foto/vídeo/álbum sem peças no topo
//   rente à bolha (sem moldura), cantos = cantos da bolha; mídia sem legenda
//   sem fundo/rabicho.
// Lido na main ao criar o MLStyle (MLStyle.tg) — o layout no executor só lê o estilo.
object MLLook {
  @Volatile var tg = false

  /** true = mudou. */
  fun apply(m: Map<String, Any?>?): Boolean {
    val v = m?.get("tg")
    val n = if (v == null) false else MLRow.bool(v)
    if (n == tg) return false
    tg = n
    return true
  }

  // [2026-10-19 tg-style, apiVersion 12] polimento "nível Telegram" — prop `tgStyle`
  // {on: 0/1} (JS: nativeThreadList.js, kill switch globalThis.__chatyy_tg_bubbles = false).
  //   on = 1: 2/8 dp dentro/entre grupos; pílulas de data/sistema/flutuante em cápsula
  //   12sp; duração do vídeo em pílula (mesma linha da hora); nota de voz com botão
  //   cheio na tinta e glifo na cor da bolha; "Encaminhada" 13sp regular; citação r 6.
  @Volatile var style = false

  /** true = mudou. */
  fun applyStyle(m: Map<String, Any?>?): Boolean {
    val v = m?.get("on")
    val n = if (v == null) false else MLRow.bool(v)
    if (n == style) return false
    style = n
    return true
  }

  /** canto do lado do autor entre bolhas do mesmo grupo (dp) */
  const val GROUP_R = 6f
  /** altura da curva do rabicho (dp) */
  const val TAIL_RISE = 13f
}
