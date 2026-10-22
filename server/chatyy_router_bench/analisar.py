#!/usr/bin/env python3
"""Junta os summary.json de um passo (um por nó) e calcula vazão, latências,
perdas, duplicatas, ordem e recursos. Uso: analisar.py <dir_do_passo> <total_alvo>
Escreve <dir>/step.json e <dir>/verdict.txt (OK ou motivo)."""
import gzip, json, sys, os, glob, collections

d, target = sys.argv[1], float(sys.argv[2])
S = {}
for f in sorted(glob.glob(os.path.join(d, '*.json.gz'))):
    try:
        S[os.path.basename(f)[:-8]] = json.load(gzip.open(f))
    except Exception as e:
        S[os.path.basename(f)[:-8]] = {'fatal': 'sem summary: %s' % e}

def merge(hs):
    m = collections.Counter()
    for h in hs:
        for k, v in (h or {}).items():
            m[int(k)] += v
    return m

def pct(m, ps=(0.5, 0.95, 0.99, 1.0)):
    n = sum(m.values())
    if not n:
        return [None] * len(ps)
    ks = sorted(m)
    out = []
    for p in ps:
        t = min(n - 1, int(p * n))
        acc = 0
        for k in ks:
            acc += m[k]
            if acc > t:
                out.append(k / 10.0)
                break
    return out

fatal = {r: s['fatal'] for r, s in S.items() if 'fatal' in s}
ok = {r: s for r, s in S.items() if 'fatal' not in s}

# perdas: k aceitos pelo remetente vs k vistos em qualquer receptor
recv_k = collections.defaultdict(set)
for s in ok.values():
    for cid, ks in s.get('recv_k', {}).items():
        recv_k[cid].update(k for k in ks if k)
lost = 0; phantom = 0; seq_gap = 0; seq_nonmono = 0; accepted = 0
lost_by_origin = collections.Counter(); lost_cids = []
for r, s in ok.items():
    for cid, ks in s.get('sent_k', {}).items():
        accepted += len(ks)
        got = recv_k.get(cid, set())
        miss = [k for k in ks if k not in got]
        if miss:
            lost += len(miss); lost_by_origin[r] += len(miss)
            if len(lost_cids) < 20: lost_cids.append((cid, miss[:5]))
        phantom += len([k for k in got if k and k not in set(ks)])  # k=0 = aquecimento
        seqs = s['sent_seq'][cid]
        seq_nonmono += sum(1 for a, b in zip(seqs, seqs[1:]) if b <= a)
        seq_gap += sum(1 for a, b in zip(seqs, seqs[1:]) if b > a + 1)

secs = max([s['send_secs'] for s in ok.values()] or [1])
tot = lambda k: sum(s.get(k, 0) for s in ok.values())
send = merge([s['send_hist'] for s in ok.values()])
e2e = merge([s['e2e_hist'] for s in ok.values()])

per_node = {}
for r, s in ok.items():
    sm = [x for x in s['samples'] if 0 <= x['t'] <= s['send_secs']]
    def avg(k):
        v = [x[k] for x in sm if x.get(k) is not None]
        return round(sum(v) / len(v), 1) if v else None
    def mx(k):
        v = [x[k] for x in sm if x.get(k) is not None]
        return round(max(v), 1) if v else None
    hmax = {}
    for x in sm:
        for k, v in (x.get('health_ms') or {}).items():
            hmax[k] = max(hmax.get(k, -1), v)
    sp = pct(merge([s['send_hist']]))
    ep = pct(merge([s['e2e_hist']]))
    per_node[r] = dict(
        rate=s['rate'], ok_rps=round(s['ok'] / max(s['send_secs'], 1), 1), ok=s['ok'], err=s['err_final'],
        skipped=s['skipped'], retries=s['retries'], err_kinds=s['err_kinds'], recv=s['recv'],
        dup=s['dup'], ooo=s['ooo'], korder=s['korder'], late=s['late'], refetch=s['refetch'],
        acks=s['acks'], ack_err=s['ack_err'], fetches=s['fetches'], fetch_err=s['fetch_err'],
        send_ms=sp, e2e_ms=ep,
        rt_cpu_avg=avg('rt_cpu'), rt_cpu_max=mx('rt_cpu'), rt_thr_ms_avg=avg('rt_thr_ms'),
        rt_mem_max=mx('rt_mem_mb'), mem_lim=sm[0]['rt_mem_max_mb'] if sm else None,
        host_cpu_avg=avg('host_cpu'), host_cpu_max=mx('host_cpu'), self_cpu_avg=avg('self_cpu'),
        wg_rx_kbs=avg('wg_rx_kbs'), wg_tx_kbs=avg('wg_tx_kbs'), listen_ovf=sum(x['listen_ovf'] for x in sm),
        health_base=s.get('baseline_health_ms'), health_max=hmax, trip=s.get('trip') or '',
    )

res = dict(
    target=target, nodes=len(S), fatal=fatal, secs=round(secs, 1),
    accepted=accepted, accepted_rps=round(accepted / secs, 1), offered=tot('offered'), skipped=tot('skipped'),
    err_final=tot('err_final'), retries=tot('retries'), recv=tot('recv'),
    lost=lost, lost_by_origin=dict(lost_by_origin), lost_sample=lost_cids, phantom=phantom,
    dup=tot('dup'), seq_conflict=tot('seq_conflict'), ooo=tot('ooo'), korder=tot('korder'), seq_nonmono=seq_nonmono, seq_gap=seq_gap,
    late=tot('late'), send_ms=pct(send), e2e_ms=pct(e2e), per_node=per_node,
    trips={r: n['trip'] for r, n in per_node.items() if n['trip']},
)
json.dump(res, open(os.path.join(d, 'step.json'), 'w'), indent=1)

f = lambda v: '-' if v is None else ('%.0f' % v if v >= 10 else '%.1f' % v)
print('== alvo %d msg/s | aceitas %d (%.0f/s) em %.0fs | ofertadas %d, sem conversa livre %d | erro final %d, retries %d'
      % (target, accepted, res['accepted_rps'], secs, res['offered'], res['skipped'], res['err_final'], res['retries']))
print('   conflito de seq (2 casas) %d' % res['seq_conflict'])
print('   entregues %d | perdidas %d | fantasmas %d | dup %d | fora de ordem %d (k %d, seq não-monot %d, buracos seq %d) | atrasadas %d'
      % (res['recv'], lost, phantom, res['dup'], res['ooo'], res['korder'], seq_nonmono, seq_gap, res['late']))
print('   ack do envio p50/p95/p99/max %s ms | e2e %s ms' % ('/'.join(map(f, res['send_ms'])), '/'.join(map(f, res['e2e_ms']))))
print('   nó    rate  ok/s   err  skip  send p50/p99  e2e p50/p99 | rtCPU avg/max thr  RAM  | host avg/max self | wg rx/tx KB/s | ovf | health max (base)  trip')
for r, n in sorted(per_node.items()):
    hb = n['health_base'] or {}
    hs = ' '.join('%s %s(%s)' % (k[:2], f(v), f(hb.get(k))) for k, v in sorted(n['health_max'].items()))
    print('   %-5s %5.0f %5.0f %5d %5d  %6s/%-6s %6s/%-6s | %5s/%-5s %5s %4s | %4s/%-4s %4s | %6s/%-6s | %3d | %s %s'
          % (r, n['rate'], n['ok_rps'], n['err'], n['skipped'], f(n['send_ms'][0]), f(n['send_ms'][2]), f(n['e2e_ms'][0]), f(n['e2e_ms'][2]),
             f(n['rt_cpu_avg']), f(n['rt_cpu_max']), f(n['rt_thr_ms_avg']), f(n['rt_mem_max']),
             f(n['host_cpu_avg']), f(n['host_cpu_max']), f(n['self_cpu_avg']), f(n['wg_rx_kbs']), f(n['wg_tx_kbs']), n['listen_ovf'], hs, n['trip']))
reasons = []
if fatal: reasons.append('fatal %s' % fatal)
if res['trips']: reasons.append('limite %s' % res['trips'])
if lost: reasons.append('perda %d' % lost)
if res['dup']: reasons.append('dup %d' % res['dup'])
if res['seq_conflict']: reasons.append('conflito de seq %d' % res['seq_conflict'])
if res['ooo'] or res['korder'] or seq_nonmono: reasons.append('ordem')
if accepted and res['err_final'] / max(accepted, 1) > 0.01: reasons.append('erro %d' % res['err_final'])
if res['e2e_ms'][2] and res['e2e_ms'][2] > 2000: reasons.append('e2e p99 %.0f' % res['e2e_ms'][2])
if res['send_ms'][2] and res['send_ms'][2] > 2000: reasons.append('send p99 %.0f' % res['send_ms'][2])
if res['accepted_rps'] < 0.9 * target: reasons.append('vazão %.0f < 90%% do alvo' % res['accepted_rps'])
v = 'OK' if not reasons else '; '.join(reasons)
print('   veredito:', v)
open(os.path.join(d, 'verdict.txt'), 'w').write(v + '\n')
