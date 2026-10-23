import expo.modules.chatyytransport.ChatyyNetJni;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

// Harness JVM: exercita a superfície JNI REAL (mesmos descritores do Kotlin) com a lib do host.
public class JniMain {
  public static void main(String[] a) throws Exception {
    System.load(a[0]);
    int port = Integer.parseInt(a[1]);
    byte[] spk = Base64.getDecoder().decode(a[2]);
    String auth = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(a[3])), StandardCharsets.UTF_8).trim();
    // a[4] (opcional) = pin SPKI b64 → chatyy/2 com o auth DENTRO da msg1
    byte[] pins = a.length > 4 ? Base64.getDecoder().decode(a[4]) : new byte[0];
    int ver = pins.length == 32 ? 2 : 1;
    byte[] ab = auth.getBytes(StandardCharsets.UTF_8);
    java.nio.ByteBuffer fb = java.nio.ByteBuffer.allocate(4 + ab.length); fb.putInt(ab.length); fb.put(ab);
    byte[] frames = ver == 2 ? fb.array() : new byte[0];
    System.out.println("version " + ChatyyNetJni.nativeVersion());
    byte[] kp = ChatyyNetJni.nativeKeypair();
    System.out.println("keypair " + kp.length);
    byte[] priv = java.util.Arrays.copyOfRange(kp, 0, 32);
    // parâmetros inválidos → 0, sem crash
    System.out.println("bad_ip " + ChatyyNetJni.nativeConnect("x", "nao-ip", port, "tst", "t9", spk, priv, 0L, 3000, false, 0, "", "", 1, new byte[0], new byte[0], 0, false));
    System.out.println("bad_key " + ChatyyNetJni.nativeConnect("x", "127.0.0.1", port, "tst", "t9", new byte[5], priv, 0L, 3000, false, 0, "", "", 1, new byte[0], new byte[0], 0, false));
    System.out.println("bad_v2_nopins " + ChatyyNetJni.nativeConnect("x", "127.0.0.1", port, "tst", "t9", spk, priv, 0L, 3000, false, 0, "", "", 2, new byte[0], new byte[0], 0, false));
    System.out.println("bad_frames " + ChatyyNetJni.nativeConnect("x", "127.0.0.1", port, "tst", "t9", spk, priv, 0L, 3000, false, 0, "", "", 2, new byte[32], new byte[]{0,0,0,9,1}, 0, false));
    System.out.println("stale_send " + ChatyyNetJni.nativeSend(99999L, 1, new byte[1]));
    long h = ChatyyNetJni.nativeConnect("api-tst.chatyy.com.br", "127.0.0.1", port, "tst", "t9", spk, priv, 0L, 3000, false, 0, "QTESTDEVICE234", "jni-harness", ver, pins, frames, 1, false);
    System.out.println("handle " + h);
    long t0 = System.currentTimeMillis();
    boolean migrated = false, closing = false;
    while (true) {
      byte[] ev = ChatyyNetJni.nativePoll(h, 500);
      if (ev == null) continue;
      int k = ev[0];
      long ms = System.currentTimeMillis() - t0;
      if (k == 1) {
        System.out.println(ms + " OPEN v" + ev[9] + " " + (char) ev[10] + " msg2=" + new String(ev, 11, ev.length - 11, StandardCharsets.UTF_8));
        if (ev[9] == 1) System.out.println("send_auth " + ChatyyNetJni.nativeSend(h, 1, auth.getBytes(StandardCharsets.UTF_8)));
        else System.out.println("auth_in_msg1");
      } else if (k == 2) {
        String s = new String(ev, 2, ev.length - 2, StandardCharsets.UTF_8);
        System.out.println(ms + " FRAME op=" + ev[1] + " " + (s.length() > 150 ? s.substring(0, 150) : s));
        if (s.contains("auth_success") && !migrated) {
          migrated = true;
          System.out.println("migrate " + ChatyyNetJni.nativeMigrate(h, 0L));
          ChatyyNetJni.nativeSend(h, 1, "{\"type\":\"chat_send\",\"conversation_id\":1033,\"content\":\"oi\",\"client_message_id\":\"jni-1\"}".getBytes(StandardCharsets.UTF_8));
          System.out.println("queued " + ChatyyNetJni.nativeQueued(h) + " stats " + ChatyyNetJni.nativeStats(h));
        } else if (s.contains("chat_send_ack") && !closing) {
          closing = true;
          ChatyyNetJni.nativeClose(h, 1000, "bye", false);
        }
      } else if (k == 3) {
        int code = ((ev[1] & 0xff) << 8) | (ev[2] & 0xff);
        System.out.println(ms + " CLOSED code=" + code + " remote=" + ev[3] + " reason=" + new String(ev, 4, ev.length - 4, StandardCharsets.UTF_8));
      } else if (k == 4) {
        System.out.println(ms + " ERROR " + new String(ev, 1, ev.length - 1, StandardCharsets.UTF_8));
      } else if (k == 5) {
        System.out.println(ms + " MIGRATED ok=" + ev[1]);
      } else if (k == 7) {
        System.out.println(ms + " ACCEPT " + new String(ev, 5, ev.length - 5, StandardCharsets.UTF_8));
      } else if (k == 6) {
        System.out.println(ms + " GONE");
        break;
      }
      if (ms > 8000 && !closing) { closing = true; ChatyyNetJni.nativeClose(h, 1000, "timeout", false); }
    }
    ChatyyNetJni.nativeFree(h);
    System.out.println("after_free_poll " + (ChatyyNetJni.nativePoll(h, 10)[0]));
    ChatyyNetJni.nativeFree(h); // dupla: no-op
    System.out.println("DONE");
  }
}
