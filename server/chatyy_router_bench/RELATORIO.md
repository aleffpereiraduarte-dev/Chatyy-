# Carga distribuída do roteador BEAM — relatório (22/10/2026)

**Resposta curta:** a meta de 10.000 msg/s **não é alcançável** com o desenho atual: 10 edges, roteador com `CPUQuota=100%`, `ACK_MODE=sister`, fsync em toda escrita e controle HTTP local.

| Medida | Resultado |
|---|---|
| Teto **sustentado** medido | **1.500 msg/s** no total |
| 2.000 msg/s | parou em 32 s |
| Com as 10 regiões fazendo de tudo | **~1.000 msg/s** (o IN limita) |

Em nenhum passo aceito houve perda, duplicata, mensagem fora de ordem ou erro de envio. O gargalo é **CPU**: o serviço só pode usar 1 núcleo e o roteador gasta ~3,5–4 ms de CPU por mensagem no cluster. Não é a rede da WG nem o disco. A RAM vem logo atrás: o dedupe de 7 dias fica em RAM e cada conversa ativa custa ~50 KB.

No caminho apareceram **dois bugs reais no núcleo**, descritos na §5: casa dupla (seq repetido) e AckOutbox girando sem backoff.

## 1. O harness

### Arquivos

| Onde | O quê |
|---|---|
| `/root/roteador-2026-10-22/carga/` | `rtload` (Go, binário estático), `src/main.go`, `rampa.sh`, `analisar.py`, `distribuir.sh` |
| `runs/<run>/<passo>/` | resultados brutos: `<região>.json.gz` (resumo do nó com amostras por segundo), `step.json`, `verdict.txt`, `<região>.log` |
| `server/chatyy_router_bench/` | cópia versionada no repositório |

### Como funciona

- **Gerador `rtload step`:** roda em cada edge sob `systemd-run` com `CPUQuota=150%`, `MemoryMax=1G` e `Nice=15`. Fala **só** com `127.0.0.1:4790` (`/assign`, `/send`, `/fetch`, `/ack`).
- **Conversas:** 1.500 conversas sintéticas por origem (`load:<run>:<origem>:<i>`). A casa é atribuída por `/assign`, sempre com casa ≠ origem e destino ≠ casa ≠ origem.
- **Aparelhos:** sintéticos, `ld:<run>:<destino>:<origem>:<j>`, morando em outra região.
- **Ordem do remetente:** 1 envio em voo por conversa. A taxa vem de um balde de fichas.
- **Aquecimento:** 1 envio por conversa antes de medir (`ensure` + cache de pid), fora das métricas.
- **Receptor:** como o hub é stub, o aparelho fica "offline" e a mensagem vai para a inbox. O `rtload` da região do aparelho faz `fetch` (a cada 150 ms quando vazio) e `ack` até o maior seq. É o caminho completo **origem → casa (+irmã) → região do aparelho → ack → casa apaga**.
- **e2e:** relógio de parede de quem envia, gravado no corpo, contra o de quem recebe. O chrony está com desvio < 1 ms. O e2e inclui ≤ 150 ms de espera do *poll*.

### O que é medido

- vazão ofertada e aceita (por nó e no total);
- latência do ack do envio e e2e (p50/p95/p99/max, histograma com 0,1 ms);
- perdas: k aceito que nenhum receptor viu;
- duplicatas e "fantasmas";
- **conflito de seq**: mesmo (cid, seq) com mensagens diferentes, ou seja, duas casas;
- ordem por conversa (seq e ordem do remetente);
- por segundo: CPU do cgroup do roteador (% de 1 núcleo) e ms estrangulados, RAM anônima do cgroup, CPU do host, CPU do próprio gerador, bytes da `wg0` e `ListenOverflows`;
- latência do health de produção, 1×/s: leaf `:8086/health`, nginx `/_edge_health` em HTTPS local e php-fpm (`app-health.php` via FastCGI direto em `:9000`; no BR por HTTPS).

### Paradas automáticas

O nó para sozinho, e o orquestrador propaga a parada a todos (arquivo `stop`), quando acontece qualquer um destes:

- p99 do envio ou do e2e > 2 s (janela de 5 s, ≥ 200 amostras);
- erro > 1 % com ≥ 5 erros no segundo;
- RAM anônima do roteador > 80 % do `MemoryMax`;
- CPU do host > 85 % por 3 s seguidos;
- health de leaf, nginx ou php > max(3× a base, base + 50 ms) por 3 s, ou falha por 3 s;
- kill switch ligado (`disabled`).

Perda, duplicata e ordem são conferidas no fim de cada passo; se aparecerem, a rampa para.

### Coordenação

- Rodo só se a 1ª linha do `STATUS` for `carga: liberado` e o `chatyy-router` estiver ativo há > 10 min em todos os nós. Isso é conferido antes de cada passo.
- Escrevo a minha linha `# carga-agente: …` no STATUS (EM CURSO ou concluída) sem tocar na linha do outro agente.
- **Nada roda no US**; ele só orquestra por ssh.

### Uso

```bash
cd /root/roteador-2026-10-22/carga
./distribuir.sh                                   # binário p/ os 10 edges (sha256)
./rampa.sh r10 "1000 2000 5000 10000"             # uniforme nos 10
NOSEND=in,usw HOMES=br,br2,scl,eu,mad DSTS=br,br2,scl,mia,mex,sg,eu,mad ./rampa.sh r11 "1000 1500 2000"
# limpeza das inboxes sintéticas de uma rodada (em cada edge):
/var/tmp/rtload/rtload clean -run r10 -me <região> -regions br,br2,scl,mia,mex,usw,sg,in,eu,mad
# custo de CPU do roteador por requisição HTTP:
/var/tmp/rtload/rtload httpbench /nope 3000 4
```

## 2. Rodadas

Todos os passos duraram 60 s. Corpo de 200 B. Configuração do cluster: `ACK_MODE=sister`, `FSYNC=always`, hub stub, `CPUQuota=100%` e `+S 2`.

Notas sobre as rodadas:
- `r1` e `r2` foram de calibração do harness.
- `r4` tem o plano com viés de hash (§5.1); os erros dela vêm do bug da casa dupla.
- `r5` em diante usam o plano corrigido.

| Rodada | Configuração | Passo | Aceitas/s | Ack do envio p50/p95/p99 (ms) | e2e p50/p95/p99 (ms) | Perda / dup / ordem | Resultado |
|---|---|---|---|---|---|---|---|
| r3 | 10 nós, tudo uniforme | 400 | 397 | 227/537/856 | 318/621/906 | 0/0/0 | OK |
| r3 | idem | 600 | 594 | 221/483/813 | 310/568/879 | 0/0/0 | OK |
| r4 | idem | 700 | 691 | 225/503/870 | 314/599/935 | 0/0/0 | OK (*) |
| r4 | idem | 800 | 789 | 223/451/794 | 310/535/819 | 0/0/0 | OK (*) |
| r4 | idem | 900 | 888 | 225/456/796 | 310/535/791 | 0/0/0 | OK (*) |
| r4 | idem | **1.000** | **991** | 226/543/933 | 312/638/986 | 0/0/0 | OK (*); IN estrangulado 66 ms/s |
| r4 | idem | 1.200 | 1.111 | 230/1251/2362 | 326/1688/2694 | 0/0/0 | **PARADA** em 14 s: p99 > 2 s em todos; IN com 100 % e 112 ms/s |
| r5 | idem, plano corrigido | 800 | 784 | 226/553/971 | 311/629/1019 | 0/0/0, conflito 0, erro 0 | **PARADA**: e2e p99 do IN 2,0 s |
| r6 | IN/USW sem origem/casa/destino (ainda irmãs) | 1.000 | 992 | 216/503/924 | 285/564/948 | 0/0/0 | **PARADA**: php do IN 129 ms (base 3) por 3 s |
| r8 | casas só BR/BR2/SCL/EU/MAD; 8 origens; IN/USW só monitorados | 1.000 | 988 | 202/398/764 | 259/420/724 | 0/0/0 | OK |
| r8 | idem | **1.500** | **1.492** | 209/449/852 | 268/494/874 | 0/0/0 | **OK = teto sustentado** |
| r8 | idem | 2.000 | 1.811 | 218/449/817 | 294/733/1295 | 0/0/0 | **PARADA** em 32 s: e2e p99 da MAD 2,5 s; BR e MAD a 96 % e 100 %, estrangulados 138 e 47 ms/s |
| r9 | repetição do r8 a 1.500 | 1.500 | 1.489 | 212/422/845 | 274/485/869 | 0/0/0 | OK (reprodutível) |

(*) Na r4 o BR2 teve ~1 erro final/s (`home_unreachable`), todo ele causado pelo bug da §5.1. Esses envios foram recusados e nenhum foi entregue ("fantasmas" = 0).

**Perdas: 0 em todos os passos.** As 551 "perdidas" da r3/3 estavam **na inbox do BR2**, porque o receptor dele saiu cedo depois de uma parada. Conferi por `fetch`: as 551 bateram uma a uma por origem. Foi um defeito do harness, já corrigido: o receptor agora só sai depois do fim *global* do passo. Na prática isso comprovou o store-and-forward.

### Por nó a 1.500 msg/s (r8/2: 5 casas, 187,5 msg/s por origem)

Coluna "RAM": memória anônima do cgroup.

| Nó | Ack p50/p99 | e2e p50/p99 | CPU do roteador méd/máx (% de 1 núcleo) | Estrangulado (ms/s) | RAM (MB) | CPU do host méd/máx | Gerador | WG rx/tx (KB/s) |
|---|---|---|---|---|---|---|---|---|
| br | 166/488 | 266/972 | **92/102** | **36** | 374 | 28/61 % | 36 % | 939/911 |
| br2 | 231/621 | 256/897 | 63/88 | 0,3 | 326 | 31/79 % | 18 % | 1162/915 |
| eu | 209/601 | 260/730 | 66/89 | 0,6 | 357 | 35/71 % | 21 % | 1069/1038 |
| mad | 240/586 | 264/715 | **94/100** | **17** | 350 | 37/74 % | 26 % | 1000/936 |
| scl | 243/496 | 258/566 | 77/92 | 0,8 | 356 | 32/69 % | 24 % | 688/858 |
| mex | 177/435 | 268/597 | 36/42 | 0 | 310 | 18/43 % | 26 % | 243/300 |
| mia | 146/354 | 247/597 | 59/70 | 0 | 284 | 32/82 % | 42 % | 247/305 |
| sg | 375/1097 | 365/1118 | 22/25 | 0 | 292 | 14/39 % | 19 % | 164/240 |
| in (só monitor) | – | – | 9/22 | 0 | 266 | 10/36 % | 30 % | 9/5 |
| usw (só monitor) | – | – | 5/12 | 0 | 249 | 4/14 % | 20 % | 11/11 |

- A latência é quase toda **rede**: origem → casa, mais casa → irmã (modo sister), mais casa → destino.
  - A 1.500 msg/s, o ack p50 de ~210 ms é praticamente o RTT da WG. O roteador soma < 5 ms no p50.
  - O p99 sobe para 0,8–1,1 s com a fila na CPU da casa.
  - O SG, a 300–360 ms de todos, tem o maior p50.

### Uniforme nos 10 a 1.000 msg/s (r4/4)

Coluna "RAM": `memory.current`, que inclui cache de página.

| Nó | CPU do roteador méd/máx | Estrangulado (ms/s) | RAM (MB) | Ack p50/p99 | e2e p50/p99 |
|---|---|---|---|---|---|
| **in** | **90/101** | **66** | 326 | 351/1051 | 392/1262 |
| mia | 63/71 | 0 | 368 | 147/669 | 278/862 |
| usw | 60/72 | 0,5 | 307 | 183/640 | 302/898 |
| br | 53/72 | 0 | 409 | 227/814 | 309/1035 |
| mad | 49/54 | 0 | 369 | 228/558 | 314/868 |
| eu | 39/58 | 0 | 389 | 208/617 | 296/962 |
| scl | 38/45 | 0 | 304 | 243/1246 | 321/975 |
| mex | 36/42 | 0 | 332 | 170/666 | 296/817 |
| br2 | 35/72 | 0 | 363 | 231/687 | 296/786 |
| sg | 27/33 | 0 | 352 | 317/1064 | 333/1067 |

### Impacto em produção

Nos nós saudáveis, o health de leaf, nginx e php ficou na base ± ruído em todos os passos aceitos. Picos isolados de 20–90 ms não se repetiram por 3 s.

**Exceção: o IN.** Lá o php chegou a 100–750 ms, o nginx a 300 ms e o leaf a 300 ms durante a carga, inclusive na r6, em que o IN era só irmã do SG. Em repouso essas sondas ficam abaixo de 10 ms (40 amostras: 1 acima de 50 ms). A parada automática disparou por isso na r6.

Outros dois pontos sobre produção:
- Os crons de :X0 dos edges (`chatyy-heal`, `pg-persistent --guard`, sysstat) sobem a CPU do host para 50–60 % por ~3 s. Com o IN já no teto, isso derrubou a r2 (p99 de 6 s).
- O ssh de *polling* do orquestrador custava ~0,4 s de CPU por sessão no IN. O polling agora é paralelo, a cada 4 s.

## 3. Teto real

| Escopo | Teto sustentado (p99 < 1 s, 0 perda) | Limitado por |
|---|---|---|
| **Total, 10 regiões uniformes** | **~1.000 msg/s** | CPU do **IN**: roteador a 90–100 % de 1 núcleo, estrangulado, e health de produção do IN piorando |
| **Total, 5 casas rápidas (BR/BR2/SCL/EU/MAD), 8 origens/destinos** | **1.500 msg/s** (reprodutível em 2 rodadas); 2.000 falha | CPU de **BR e MAD** no teto do `CPUQuota=100%` |

Por nó, com todas as funções (casa + irmã + destino + origem + HTTP) e 1 núcleo de cota, o teto em msg/s **como casa** é:

| Nó | CPU | Teto como casa |
|---|---|---|
| BR2, EU | EPYC 9355P | ~400–450 msg/s |
| MAD, SCL | Cascadelake | ~300–350 |
| BR | EPYC 9354P (dividido com o php do BR) | ~300 |
| MIA | Broadwell | ~200 (estimado pelo CPU a 1.000 uniforme) |
| **IN, USW** | EPYC antigo 2,0 GHz com mitigações retbleed | **~100** |

O teto "como casa" é estimado pela CPU a 1.500, com a casa no limite. MEX e SG não foram casa no r8. O IN/USW dá ~100 msg/s por nó no uniforme, com o IN no teto.

## 4. O gargalo

### (1) CPU, porque a cota é de 1 núcleo

- Por thread do BEAM, sob 1.500 msg/s: `erts_sched_1` = 53 % (BR2), 82 % (BR), 90 % (MAD). **`erts_sched_2` fica parado.** Com `CPUQuota=100%`, o `+S 2` não acrescenta nada.
- Threads de E/S suja (fsync do Seglog): somam só 2–4 % cada.
- Os hosts têm 4–8 vCPUs e ficaram com 15–37 % de média. **Há CPU sobrando no host; o teto é a cota do serviço.**
- Custo total medido: **3,5–4,0 ms de CPU do roteador por mensagem** somando os nós (r8/r9: 523–544 % para 1.500 msg/s; r4 uniforme: 4,9 ms/msg com o IN). Não conta o gerador, que faz o papel do leaf/app (~2,6 núcleos a 1.500 msg/s).

### O HTTP de controle pesa nos nós lentos

O servidor fecha a conexão a cada requisição (`connection: close`), usa 1 acceptor e faz parse `http_bin`. Custo de CPU do roteador por requisição, medido com `rtload httpbench`:

| Nó | 404 trivial | `/fetch` vazio | `/health` |
|---|---|---|---|
| BR2 | 75 µs | 67 µs | 277 µs |
| MAD | 118 µs | 125 µs | 453 µs |
| MIA | 260 µs | 308 µs | 832 µs |
| **IN** | **574 µs** | 644 µs | 1.095 µs |

- O IN é 7,7× mais caro que o BR2 por syscall. São Zen antigos com retbleed: `sy` de 8–14 % já em repouso.
- Por mensagem há ~3 requisições (send + ack + parte de um fetch). Isso é ~5 % do orçamento no BR2 e ~20 % no IN.
- O resto da CPU vai para a distribuição TLS (cada mensagem cruza a WG ~5–6 vezes: call à casa e resposta, call à irmã e resposta, cast ao destino, `region_stored`, ack), codificação de termos, Seglog e Mnesia.

### (2) RAM, que vem logo depois

- **Cada conversa ativa custa ~50 KB.** Com ~3.000 ConvServers vivos, o BEAM ficou em ~330 MB; 5 min depois (`idle_ms`) voltou a ~160 MB. A RAM anônima do cgroup **não volta** (fica no topo, 370–480 MB, por fragmentação). Na r7 a parada disparou com 616 MB de `memory.current`, a 80 % de 768 MB.
- **`rt_dedupe` fica em Mnesia `disc_copies` (RAM) com janela de 7 dias, 1 linha por mensagem.**
  - Na r8 cresceu ~30 mil linhas para ~50 mil mensagens com casa no BR.
  - A 300 msg/s por casa, são ~26 milhões de linhas por dia e ~180 milhões por semana: dezenas de GB.
  - **Inviável em carga sustentada, com qualquer `MemoryMax`.**
- **`rt_home`: todo nó guarda a casa de TODAS as conversas** (difusão). Já são 112 mil linhas por nó só com o sintético. A troca por `conv_home` no PG (R1/R2) resolve.

### Rede (WG) e armazenamento não são o gargalo hoje

- **WG:** ~3,7 KB por mensagem somando o tx de todos os nós (corpo de 200 B; o resto são o TLS da distribuição, os termos e as confirmações).
  - A 1.500 msg/s: 5,5 MB/s no total, com ~1,0–1,2 MB/s por casa.
  - A 10.000 msg/s: ~37 MB/s, ≈ 300 Mbit/s no agregado, ~30 Mbit/s por edge em cada sentido.
  - Cabe nas NICs dos edges, mas é preciso conferir a franquia e o teto de cada provedor.
- **`ListenOverflows`:** 0, salvo 13 no IN no colapso da r2.
- **Disco:** o Seglog ficou em 90–145 MB por nó e as threads de fsync somaram poucos %.

## 5. Bugs e achados do núcleo (para o agente do roteador; não editei nada)

### 5.1 Casa dupla com o mesmo epoch → seq repetido (correção quebrada)

**Reprodução:** a conversa `load:r4:br2:1392` tinha casa BR (epoch 1) e já tinha recebido dezenas de envios a partir do BR2. Mandei 1 envio a partir de MIA, BR e SG: as respostas vieram com `{"epoch":1,"seq":1}`, `seq 2` e `seq 3`. Ou seja, **outra casa (SG) começou do zero com o mesmo epoch.** Do BR2, 17 das 185 conversas br2→br ficaram presas em `home_unreachable`.

**Causa provável:**
1. O `assign` sai da origem só por `cast`, e só para as regiões vivas. O SG não tem TCP com o BR2, então nunca recebe o assign.
2. O ack do aparelho no SG entra no `AckOutbox.flush` → `Router.home_cast_ack` → `conv_pid`.
3. Ali, `HomeTable.lookup` cai no **HRW padrão**. Quando o HRW dá o próprio SG, ele faz **`Home.ensure` local, cria um ConvServer e grava o registro explícito com epoch 1**.
4. Com epoch empatado, vence o maior nome de região ("sg" > "br"). Todos os nós, menos o BR2, passam a apontar para o SG.

**O mesmo vale sem partição:** qualquer região que não recebeu o `assign` (cast perdido, reinício antes do sync) pode "tomar" a conversa num ack ou num envio.

**Sugestões:**
- o caminho do ack nunca cria casa (só encaminha ou espera);
- `ensure` de cid sem registro só por CAS (o `conv_home` no PG do R1) ou com confirmação da maioria;
- empate de epoch não pode ser resolvido pelo nome: epoch novo = max + 1 via CAS;
- o assign precisa de entrega garantida (call com retry ou sync), não só de cast.

O harness passou a detectar isso (`conflito de seq`) e não monta mais conversas que envolvam um par sem rota (destino também precisa de rota com a origem). Desde a r5: 0 conflitos.

### 5.2 AckOutbox sem backoff

As linhas presas por casa inalcançável (as do 5.1) são reenviadas a cada **20 ms para sempre**.

- **Medido em repouso:** 61 linhas no SG e 70 no BR2 custam **11–14 % de 1 núcleo**.
- **Sugestão:** backoff exponencial por linha e prazo máximo, com métrica.

### 5.3 HTTP de controle

- Ver a tabela da §4: 75–574 µs por requisição trivial, com `connection: close`.
- Para o leaf/PHP, sugiro:
  - keep-alive;
  - `/send` e `/ack` em lote (1 requisição para N mensagens ou N acks);
  - um `/fetch` multi-aparelho, ou só o push pelo `Hub.Http`.
- O `/health` custa 3–4× um 404 (`alive_regions`, quórum). O monitor deve sondar pouco.

### 5.4 `+S 2` com `CPUQuota=100%`

O 2º scheduler não faz nada. Ou se sobe a cota (ex.: `CPUQuota=300%` com `+S 4`), ou se fica com `+S 1`.

### 5.5 Resíduos sintéticos (expiram sozinhos em 30 d pelo Janitor)

`rt_msg`/`rt_pend` de casas com acks que nunca chegaram:

| Nó | Linhas |
|---|---|
| IN | 1.324 |
| BR | 993 |
| MIA | 644 |
| BR2 | 147 |

Também há `rt_replica` correspondentes: SG 1.324, BR2 1.034, USW 663. A maior parte vem da casa dupla da r4 e dos testes de diagnóstico. A inbox do BR tem 1.124 linhas que **não são de rodadas minhas**: o `clean` de r1–r9 não achou nada lá. As inboxes de todas as minhas rodadas foram limpas (fetch + ack).

## 6. O que seria preciso para 10.000 msg/s sustentados com folga

Medidas usadas na conta:
- ~3,5–4 ms de CPU por mensagem;
- teto de ~300–450 msg/s como casa por núcleo moderno;
- meta de no máximo 60 % de CPU em regime.

**(a) Sem mudar o código:**
- ≈ 35–40 núcleos-equivalentes de BR2/MAD só para o roteador, ≈ **60–65 núcleos** com folga;
- com a cota de hoje (1 núcleo por edge), seriam ~30+ edges: **não serve**;
- caminho viável: **VMs dedicadas ao roteador**, fora dos edges de produção (nginx/php/leaf não podem disputar CPU; o IN já mostrou o efeito);
- a conta: ~**8–10 VMs de 8 vCPU** modernas (EPYC 9xx4 / Sapphire Rapids, **nada de Zen1/Zen2 nem Broadwell**), com `CPUQuota=600–700%` e `+S 8`, 16 GB de RAM.

Antes de comprar, há que validar a escala com mais schedulers. Ela **não foi medida**: o processo único do Seglog por tabela, o acceptor HTTP e o processo TLS por link podem virar teto antes. Para isso, um ensaio com `CPUQuota=300%` / `+S 4` em 3 nós.

**(b) Antes disso, as otimizações que mais rendem:**
1. **dedupe fora da RAM** (Seglog/índice em disco ou janela curta + idempotência por seq): sem isso nenhum tamanho de VM sustenta horas;
2. **lote no HTTP** (send/ack N:1) e keep-alive;
3. **lote de fan-out e de réplica por região** (hoje são 1 call e 1 cast por mensagem e por região); o README já prevê agrupar as escritas Mnesia por mensagem;
4. `ACK_MODE=local`, se o founder aceitar RPO ≤ lag: tira a perna da irmã do caminho crítico (−1 RTT na latência; na CPU ganha pouco);
5. `idle_ms` menor ou hibernação dos ConvServers (~50 KB por conversa ativa).

Com (b)1–3 dá para esperar algo como 2–3× menos CPU por mensagem. Isso é uma estimativa, não uma medida. Com esse ganho, 10.000 msg/s cabem em ~**4–5 VMs dedicadas de 8 vCPU**, mais a irmã de cada uma.

**(c) A WG não precisa mudar** para 10.000 msg/s (≈ 300 Mbit/s no agregado), mas é preciso conferir a franquia de tráfego e o limite de banda dos provedores Vultr e Contabo de cada edge.

**Regiões:** IN e USW (EPYC antigo) e MIA (Broadwell) não devem ser casa de volume. Conversas dessas regiões teriam casa numa VM dedicada próxima (ex.: SG ou EU para o IN, MEX ou uma VM nova para o USW e a MIA).
