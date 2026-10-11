#!/usr/bin/env python3
# [2026-10-11] Resumo do call_e2e.json (mesma leitura do 01-testar-ligacao.sh) +
# Markdown p/ $GITHUB_STEP_SUMMARY. Sai 0 se TODAS as ligações tiveram áudio nos
# dois sentidos, 2 caso contrário, 3 se não houver resultado.
import json, os, sys

path = sys.argv[1] if len(sys.argv) > 1 else "call_e2e.json"
try:
    runs = json.load(open(path))
except Exception as e:
    print("sem resultado (%s): %s" % (path, e))
    sys.exit(3)

lines = ["| Cenário | Resultado | convite→toque | atender→áudio 2 lados | caminho | RTT | perda | quedas (áudio volta caller/callee) |",
         "|---|---|---|---|---|---|---|---|"]
ok = 0
for r in runs:
    good = bool(r.get("audioBothWays")) and not r.get("error")
    ok += good
    pb = r.get("pairB") or {}
    st = (r.get("steady") or {}).get("B") or {}
    outs = "; ".join("%ss: %s/%s ms" % (o.get("secs"), o.get("audioBackCallerMsAfterRestore"), o.get("audioBackCalleeMsAfterRestore"))
                     for o in (r.get("outages") or []))
    print(("OK   " if good else "FALHA"), r.get("name"))
    print("      convite->toque", r.get("inviteToRingMs"), "ms | atender->áudio nos 2 lados", r.get("answerToMediaBothWaysMs"),
          "ms | caminho", pb.get("local"), pb.get("relayUrl") or "", "| RTT", pb.get("rtt"), "| perda", st.get("lossPct"), "% | jitter",
          st.get("jitterMs"), "ms", ("| ERRO " + r["error"]) if r.get("error") else "")
    if outs:
        print("      quedas:", outs)
    lines.append("| %s | %s | %s | %s | %s %s | %s | %s | %s |" % (
        r.get("name"), "OK" if good else "**FALHA**" + (" (" + r["error"] + ")" if r.get("error") else ""),
        r.get("inviteToRingMs"), r.get("answerToMediaBothWaysMs"), pb.get("local") or "", pb.get("relayProto") or "",
        pb.get("rtt"), st.get("lossPct"), outs or "-"))
summary = "RESUMO: %d/%d ligações com áudio nos dois sentidos" % (ok, len(runs))
print(summary)
gs = os.environ.get("GITHUB_STEP_SUMMARY")
if gs:
    with open(gs, "a") as f:
        f.write("### Teste de ligação (apitest → qa2)\n\n" + summary + "\n\n" + "\n".join(lines) + "\n")
sys.exit(0 if runs and ok == len(runs) else 2)
