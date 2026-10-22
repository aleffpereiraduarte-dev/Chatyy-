// rtload — gerador de carga DISTRIBUÍDO do roteador BEAM (chatyy_router), 22/10/2026.
//
// Roda em cada edge (nunca no US). Fala SÓ com o HTTP de controle local do
// roteador (127.0.0.1:4790): POST /assign, /send, /ack e GET /fetch.
// Tráfego 100 % sintético: cids "load:<run>:<origem>:<i>", aparelhos
// "ld:<run>:<destino>:<origem>:<j>" (hub stub: aparelho offline → fica na
// inbox; este processo, na região do aparelho, faz o papel do app: fetch + ack).
//
// Cada nó é ao mesmo tempo:
//   - REMETENTE: C conversas próprias (uma goroutine por conversa, 1 envio em voo
//     por conversa = ordem do remetente), casa != origem, destino != casa;
//     taxa por balde de fichas; ficha sem conversa livre = "skipped" (saturação).
//   - RECEPTOR: faz fetch dos aparelhos que moram nesta região e ack até o maior seq.
//   - MONITOR: CPU/RAM/throttling do cgroup do roteador, CPU do host, bytes da wg0,
//     ListenOverflows, latência do health de produção (leaf :8086, nginx, php-fpm)
//     e do /health do roteador. Para sozinho ao passar dos limites.
//
// Uso: rtload step -run R -step N -me br2 -regions br,br2,... -rate 1000 -dur 60 -at <unix> -out DIR
//      rtload probe            (só testa as sondas de saúde)
package main

import (
	"bufio"
	"context"
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---------------- configuração ----------------

type cfg struct {
	run, me, out          string
	step                  int
	regions               []string
	ban                   map[string]bool // "a:b" sem rota TCP (vale nos dois sentidos)
	homes                 map[string]bool // se não vazio: só estas regiões são casa
	dstsOK                map[string]bool // se não vazio: só estas regiões têm aparelho destino
	rate                  float64
	dur, drain            time.Duration
	at                    time.Time
	convs, devs           int
	poll                  time.Duration
	bytes                 int
	ctl                   string
	p99max                time.Duration
	memFrac, hostCPU      float64
	healthX               float64
	healthAbsMs           float64
	errFrac               float64
	noTrip                bool
}

var C cfg

func banned(a, b string) bool { return C.ban[a+":"+b] || C.ban[b+":"+a] }

func hsh(parts ...string) uint32 {
	h := fnv.New64a()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	z := h.Sum64() + 0x9e3779b97f4a7c15
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return uint32((z ^ (z >> 31)) >> 32)
}

type conv struct {
	idx            int
	origin, home   string
	dst, cid, dev  string
}

// plano determinístico: todos os nós calculam o mesmo
func planFor(origin string) []conv {
	var out []conv
	for i := 0; i < C.convs; i++ {
		var homes []string
		for _, r := range C.regions {
			if r != origin && !banned(origin, r) && (len(C.homes) == 0 || C.homes[r]) {
				homes = append(homes, r)
			}
		}
		if len(homes) == 0 {
			continue
		}
		si := strconv.Itoa(i)
		h := homes[hsh(C.run, origin, si, "h")%uint32(len(homes))]
		var dsts []string
		for _, r := range C.regions {
			if r != h && r != origin && !banned(h, r) && !banned(origin, r) && (len(C.dstsOK) == 0 || C.dstsOK[r]) {
				dsts = append(dsts, r)
			}
		}
		if len(dsts) == 0 {
			for _, r := range C.regions {
				if r != h && !banned(h, r) && !banned(origin, r) && (len(C.dstsOK) == 0 || C.dstsOK[r]) {
					dsts = append(dsts, r)
				}
			}
		}
		if len(dsts) == 0 {
			continue
		}
		d := dsts[hsh(C.run, origin, si, "d")%uint32(len(dsts))]
		out = append(out, conv{
			idx: i, origin: origin, home: h, dst: d,
			cid: fmt.Sprintf("load:%s:%s:%d", C.run, origin, i),
			dev: fmt.Sprintf("ld:%s:%s:%s:%d", C.run, d, origin, i%C.devs),
		})
	}
	return out
}

// ---------------- histograma (chave = 0,1 ms) ----------------

type hist struct {
	mu sync.Mutex
	m  map[int64]int64
	n  int64
}

func newHist() *hist { return &hist{m: map[int64]int64{}} }
func (h *hist) add(d time.Duration) {
	k := d.Microseconds() / 100
	if k < 0 {
		k = 0
	}
	h.mu.Lock()
	h.m[k]++
	h.n++
	h.mu.Unlock()
}
func (h *hist) snapshot() map[string]int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	o := make(map[string]int64, len(h.m))
	for k, v := range h.m {
		o[strconv.FormatInt(k, 10)] = v
	}
	return o
}
func pctOf(m map[int64]int64, ps ...float64) []float64 {
	var keys []int64
	var n int64
	for k, v := range m {
		keys = append(keys, k)
		n += v
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	res := make([]float64, len(ps))
	if n == 0 {
		return res
	}
	for pi, p := range ps {
		target := int64(p * float64(n))
		if target >= n {
			target = n - 1
		}
		var acc int64
		for _, k := range keys {
			acc += m[k]
			if acc > target {
				res[pi] = float64(k) / 10
				break
			}
		}
	}
	return res
}

// janela deslizante (últimos 5 s) p/ p99 ao vivo
type window struct {
	mu   sync.Mutex
	buck [5]map[int64]int64
	sec  [5]int64
}

func (w *window) add(d time.Duration) {
	s := time.Now().Unix()
	i := s % 5
	k := d.Microseconds() / 1000
	w.mu.Lock()
	if w.sec[i] != s || w.buck[i] == nil {
		w.sec[i] = s
		w.buck[i] = map[int64]int64{}
	}
	w.buck[i][k]++
	w.mu.Unlock()
}
func (w *window) p99() (float64, int64) {
	now := time.Now().Unix()
	m := map[int64]int64{}
	var n int64
	w.mu.Lock()
	for i := 0; i < 5; i++ {
		if now-w.sec[i] < 5 && w.buck[i] != nil {
			for k, v := range w.buck[i] {
				m[k*10] += v
				n += v
			}
		}
	}
	w.mu.Unlock()
	return pctOf(m, 0.99)[0], n
}

// ---------------- HTTP do roteador ----------------

var hc = &http.Client{
	Timeout: 15 * time.Second,
	Transport: &http.Transport{
		DisableKeepAlives:   true, // o Control fecha a conexão a cada resposta
		MaxIdleConnsPerHost: 0,
		DialContext:         (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
	},
}

func postJSON(path string, v any) (int, []byte, error) {
	b, _ := json.Marshal(v)
	resp, err := hc.Post(C.ctl+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return resp.StatusCode, body, err
}

// ---------------- estado ----------------

type senderStats struct {
	okByCid  map[string][]int64 // k aceitos (por conversa, em ordem)
	seqByCid map[string][]int64
	mu       sync.Mutex
}

var (
	cntOK, cntErrFinal, cntRetry, cntSkipped, cntOffered atomic.Int64
	cntRecv, cntRefetch, cntDup, cntOOO, cntKOrder        atomic.Int64
	cntLate, cntForeign, cntFetchErr, cntAckErr, cntAcks  atomic.Int64
	cntFetches, cntSeqConflict                            atomic.Int64
	errKinds                                              sync.Map // string -> *atomic.Int64
	sendH, e2eH                                           = newHist(), newHist()
	e2eByOrigin                                           sync.Map // origin -> *hist
	sendWin, e2eWin                                       window
	stopFlag                                              atomic.Bool
	tripReason                                            atomic.Value
	sStats                                                = senderStats{okByCid: map[string][]int64{}, seqByCid: map[string][]int64{}}
)

func errKind(k string) {
	v, _ := errKinds.LoadOrStore(k, new(atomic.Int64))
	v.(*atomic.Int64).Add(1)
}

func trip(reason string) {
	if C.noTrip {
		return
	}
	if tripReason.Load() == nil {
		tripReason.Store(reason)
		fmt.Fprintf(os.Stderr, "%s TRIP %s\n", time.Now().UTC().Format(time.RFC3339), reason)
	}
	stopFlag.Store(true)
}

// ---------------- remetente ----------------

func runSender(plan []conv, sendUntil time.Time, wg *sync.WaitGroup) {
	tokens := make(chan struct{}, len(plan))
	pad := make([]byte, C.bytes)
	rand.Read(pad)
	for _, cv := range plan {
		wg.Add(1)
		go func(cv conv) {
			defer wg.Done()
			k := int64(C.step) * 1_000_000 // k único entre passos da mesma rodada
			for range tokens {
				if stopFlag.Load() {
					continue
				}
				k++
				sendOne(cv, k, pad)
			}
		}(cv)
	}
	// gerador de fichas
	go func() {
		defer close(tokens)
		tick := time.NewTicker(time.Millisecond)
		defer tick.Stop()
		start := time.Now()
		var issued float64
		for now := range tick.C {
			if now.After(sendUntil) || stopFlag.Load() {
				return
			}
			want := now.Sub(start).Seconds() * C.rate
			for issued+1 <= want {
				issued++
				cntOffered.Add(1)
				select {
				case tokens <- struct{}{}:
				default:
					cntSkipped.Add(1)
				}
			}
		}
	}()
}

func sendOne(cv conv, k int64, pad []byte) {
	cmi := fmt.Sprintf("L%s-%d-%s-%d-%d", C.run, C.step, cv.origin, cv.idx, k)
	t0 := time.Now()
	hdr := fmt.Sprintf("L1|%s|%d|%s|%d|%d|%d|", C.run, C.step, cv.origin, cv.idx, k, t0.UnixNano())
	body := []byte(hdr)
	if len(body) < C.bytes {
		body = append(body, pad[:C.bytes-len(body)]...)
	}
	req := map[string]any{
		"cid": cv.cid, "from": "load-" + cv.origin, "device": "ldsrc:" + C.run + ":" + cv.origin,
		"cmi": cmi, "body_b64": base64.StdEncoding.EncodeToString(body),
		"devices": [][]string{{cv.dev, cv.dst}},
	}
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			cntRetry.Add(1)
			time.Sleep(time.Duration(100*attempt) * time.Millisecond)
		}
		code, rb, err := postJSON("/send", req)
		if err != nil {
			k := "net"
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				k = "timeout"
			}
			errKind(k)
			errKind(k + "@" + cv.home)
			continue
		}
		var r struct {
			OK    bool   `json:"ok"`
			Seq   int64  `json:"seq"`
			Error string `json:"error"`
		}
		json.Unmarshal(rb, &r)
		if code == 200 && r.OK {
			d := time.Since(t0)
			sendH.add(d)
			sendWin.add(d)
			cntOK.Add(1)
			sStats.mu.Lock()
			sStats.okByCid[cv.cid] = append(sStats.okByCid[cv.cid], k)
			sStats.seqByCid[cv.cid] = append(sStats.seqByCid[cv.cid], r.Seq)
			sStats.mu.Unlock()
			return
		}
		e := r.Error
		if e == "" {
			e = "http_" + strconv.Itoa(code)
		}
		errKind(e)
		errKind(e + "@" + cv.home)
		if e == "disabled" {
			trip("router_disabled")
			break
		}
	}
	cntErrFinal.Add(1)
}

// ---------------- receptor ----------------

type rstate struct {
	maxSeq   int64
	kAtMax   int64
	seen     map[int64]int64 // seq -> k
	ks       map[int64]bool
	acked    int64
	origin   string
}

var (
	rmu    sync.Mutex
	rconvs = map[string]*rstate{}
)

func myDevices() []string {
	var out []string
	for _, o := range C.regions {
		if o == C.me {
			// destino != origem no plano (salvo fallback); incluo mesmo assim
		}
		for j := 0; j < C.devs; j++ {
			out = append(out, fmt.Sprintf("ld:%s:%s:%s:%d", C.run, C.me, o, j))
		}
	}
	return out
}

func runReceiver(until func() bool, wg *sync.WaitGroup, lastRecv *atomic.Int64) {
	for _, d := range myDevices() {
		wg.Add(1)
		go func(dev string) {
			defer wg.Done()
			for !until() {
				n := fetchOnce(dev, lastRecv)
				if n == 0 {
					time.Sleep(C.poll)
				}
			}
		}(d)
	}
}

func fetchOnce(dev string, lastRecv *atomic.Int64) int {
	cntFetches.Add(1)
	resp, err := hc.Get(C.ctl + "/fetch?device=" + url.QueryEscape(dev))
	if err != nil {
		cntFetchErr.Add(1)
		time.Sleep(200 * time.Millisecond)
		return 0
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		cntFetchErr.Add(1)
		time.Sleep(200 * time.Millisecond)
		return 0
	}
	var r struct {
		Messages []struct {
			Cid  string `json:"cid"`
			Seq  int64  `json:"seq"`
			Body string `json:"body_b64"`
		} `json:"messages"`
	}
	if json.Unmarshal(b, &r) != nil {
		cntFetchErr.Add(1)
		return 0
	}
	now := time.Now()
	ackTo := map[string]int64{}
	fresh := 0
	sort.SliceStable(r.Messages, func(i, j int) bool {
		if r.Messages[i].Cid != r.Messages[j].Cid {
			return r.Messages[i].Cid < r.Messages[j].Cid
		}
		return r.Messages[i].Seq < r.Messages[j].Seq
	})
	for _, m := range r.Messages {
		if m.Seq > ackTo[m.Cid] {
			ackTo[m.Cid] = m.Seq
		}
		raw, _ := base64.StdEncoding.DecodeString(m.Body)
		f := strings.SplitN(string(raw), "|", 8)
		if len(f) < 8 || f[0] != "L1" || f[1] != C.run {
			cntForeign.Add(1)
			continue
		}
		step, _ := strconv.Atoi(f[2])
		origin := f[3]
		k, _ := strconv.ParseInt(f[5], 10, 64)
		tns, _ := strconv.ParseInt(f[6], 10, 64)
		rmu.Lock()
		st := rconvs[m.Cid]
		if st == nil {
			st = &rstate{seen: map[int64]int64{}, ks: map[int64]bool{}, origin: origin}
			rconvs[m.Cid] = st
		}
		if pk, ok := st.seen[m.Seq]; ok {
			rmu.Unlock()
			if pk != k {
				cntSeqConflict.Add(1)
			} else {
				cntRefetch.Add(1)
			}
			continue
		}
		st.seen[m.Seq] = k
		if st.ks[k] {
			cntDup.Add(1) // mesmo k (mesma msg do remetente) com outro seq
		}
		st.ks[k] = true
		if m.Seq < st.maxSeq {
			cntOOO.Add(1)
		} else {
			if k < st.kAtMax {
				cntKOrder.Add(1)
			}
			st.maxSeq, st.kAtMax = m.Seq, k
		}
		rmu.Unlock()
		if step != C.step {
			cntLate.Add(1)
			continue
		}
		fresh++
		cntRecv.Add(1)
		lastRecv.Store(now.UnixNano())
		d := time.Duration(now.UnixNano() - tns)
		e2eH.add(d)
		e2eWin.add(d)
		hv, _ := e2eByOrigin.LoadOrStore(origin, newHist())
		hv.(*hist).add(d)
	}
	for cid, upto := range ackTo {
		rmu.Lock()
		st := rconvs[cid]
		skip := st != nil && st.acked >= upto
		rmu.Unlock()
		if skip {
			continue
		}
		code, _, err := postJSON("/ack", map[string]any{"device": dev, "cid": cid, "upto": upto})
		cntAcks.Add(1)
		if err != nil || code != 200 {
			cntAckErr.Add(1)
			continue
		}
		rmu.Lock()
		if st != nil && upto > st.acked {
			st.acked = upto
		}
		rmu.Unlock()
	}
	return len(r.Messages) + fresh
}

// ---------------- monitor ----------------

type sample struct {
	T          float64            `json:"t"`
	SentOK     int64              `json:"ok"`
	Recv       int64              `json:"recv"`
	Skipped    int64              `json:"skip"`
	ErrFinal   int64              `json:"err"`
	RtCPU      float64            `json:"rt_cpu"`      // % de 1 núcleo
	RtThrMs    float64            `json:"rt_thr_ms"`   // ms estrangulado no segundo
	RtMemMB    float64            `json:"rt_mem_mb"`
	RtMemMaxMB float64            `json:"rt_mem_max_mb"`
	RtMemCurMB float64            `json:"rt_mem_cur_mb"` // memory.current (inclui cache de página)
	HostCPU    float64            `json:"host_cpu"`
	SelfCPU    float64            `json:"self_cpu"`
	WgRxKB     float64            `json:"wg_rx_kbs"`
	WgTxKB     float64            `json:"wg_tx_kbs"`
	ListenOvf  int64              `json:"listen_ovf"`
	Health     map[string]float64 `json:"health_ms"` // -1 = falhou
	SendP99    float64            `json:"send_p99_ms"`
	E2eP99     float64            `json:"e2e_p99_ms"`
}

func readInt(path string) int64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return -1
	}
	s := strings.TrimSpace(string(b))
	if s == "max" {
		return -2
	}
	v, _ := strconv.ParseInt(s, 10, 64)
	return v
}

const cg = "/sys/fs/cgroup/system.slice/chatyy-router.service"

func cgCPU() (usage, thr int64) {
	f, err := os.Open(cg + "/cpu.stat")
	if err != nil {
		return -1, -1
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		p := strings.Fields(sc.Text())
		if len(p) == 2 {
			v, _ := strconv.ParseInt(p[1], 10, 64)
			switch p[0] {
			case "usage_usec":
				usage = v
			case "throttled_usec":
				thr = v
			}
		}
	}
	return
}

func cgAnon() int64 {
	b, err := os.ReadFile(cg + "/memory.stat")
	if err != nil {
		return readInt(cg + "/memory.current")
	}
	var v int64
	for _, l := range strings.Split(string(b), "\n") {
		p := strings.Fields(l)
		if len(p) == 2 && (p[0] == "anon" || p[0] == "kernel") {
			x, _ := strconv.ParseInt(p[1], 10, 64)
			v += x
		}
	}
	return v
}

func hostCPU() (busy, total int64) {
	b, _ := os.ReadFile("/proc/stat")
	line := strings.SplitN(string(b), "\n", 2)[0]
	p := strings.Fields(line)[1:]
	var v []int64
	for _, x := range p {
		n, _ := strconv.ParseInt(x, 10, 64)
		v = append(v, n)
	}
	for _, n := range v[:8] {
		total += n
	}
	busy = total - v[3] - v[4]
	return
}

func selfCPU() int64 {
	b, _ := os.ReadFile("/proc/self/stat")
	s := string(b)
	i := strings.LastIndex(s, ")")
	p := strings.Fields(s[i+2:])
	u, _ := strconv.ParseInt(p[11], 10, 64)
	st, _ := strconv.ParseInt(p[12], 10, 64)
	return u + st
}

func listenOverflows() int64 {
	b, _ := os.ReadFile("/proc/net/netstat")
	lines := strings.Split(string(b), "\n")
	for i := 0; i+1 < len(lines); i += 2 {
		if strings.HasPrefix(lines[i], "TcpExt:") {
			h := strings.Fields(lines[i])
			v := strings.Fields(lines[i+1])
			for j, n := range h {
				if n == "ListenOverflows" && j < len(v) {
					x, _ := strconv.ParseInt(v[j], 10, 64)
					return x
				}
			}
		}
	}
	return 0
}


// ---------------- sondas de produção ----------------

var probeHC = &http.Client{
	Timeout: 3 * time.Second,
	Transport: &http.Transport{
		DisableKeepAlives: true,
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: true, ServerName: "chatyy.com.br"},
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			// "chatyy.com.br:443" -> 127.0.0.1:443 (como curl --resolve)
			if strings.HasSuffix(addr, ":443") {
				addr = "127.0.0.1:443"
			}
			return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, network, addr)
		},
	},
}

func probeHTTP(u string) float64 {
	t0 := time.Now()
	resp, err := probeHC.Get(u)
	if err != nil {
		return -1
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return -1
	}
	return float64(time.Since(t0).Microseconds()) / 1000
}

// FastCGI mínimo: executa app-health.php direto no php-fpm 127.0.0.1:9000
func fcgiRec(w *bytes.Buffer, typ byte, content []byte) {
	h := []byte{1, typ, 0, 1, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(h[4:], uint16(len(content)))
	w.Write(h)
	w.Write(content)
}
func fcgiKV(b *bytes.Buffer, k, v string) {
	for _, s := range []string{k, v} {
		if len(s) < 128 {
			b.WriteByte(byte(len(s)))
		} else {
			var x [4]byte
			binary.BigEndian.PutUint32(x[:], uint32(len(s))|0x80000000)
			b.Write(x[:])
		}
	}
	b.WriteString(k)
	b.WriteString(v)
}

func probeFCGI(script string) float64 {
	t0 := time.Now()
	c, err := net.DialTimeout("tcp", "127.0.0.1:9000", 2*time.Second)
	if err != nil {
		return -1
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	var w bytes.Buffer
	fcgiRec(&w, 1, []byte{0, 1, 0, 0, 0, 0, 0, 0})
	var p bytes.Buffer
	for _, kv := range [][2]string{
		{"SCRIPT_FILENAME", script}, {"SCRIPT_NAME", "/api/app-health.php"}, {"REQUEST_URI", "/api/app-health.php"},
		{"REQUEST_METHOD", "GET"}, {"QUERY_STRING", ""}, {"SERVER_PROTOCOL", "HTTP/1.1"},
		{"GATEWAY_INTERFACE", "CGI/1.1"}, {"REMOTE_ADDR", "127.0.0.1"}, {"SERVER_NAME", "localhost"},
		{"SERVER_PORT", "80"}, {"HTTP_HOST", "localhost"},
	} {
		fcgiKV(&p, kv[0], kv[1])
	}
	fcgiRec(&w, 4, p.Bytes())
	fcgiRec(&w, 4, nil)
	fcgiRec(&w, 5, nil)
	if _, err := c.Write(w.Bytes()); err != nil {
		return -1
	}
	var out []byte
	hdr := make([]byte, 8)
	for {
		if _, err := io.ReadFull(c, hdr); err != nil {
			return -1
		}
		n := int(binary.BigEndian.Uint16(hdr[4:])) + int(hdr[6])
		buf := make([]byte, n)
		if _, err := io.ReadFull(c, buf); err != nil {
			return -1
		}
		if hdr[1] == 6 {
			out = append(out, buf[:binary.BigEndian.Uint16(hdr[4:])]...)
		}
		if hdr[1] == 3 {
			break
		}
	}
	if !bytes.Contains(out, []byte("ok")) {
		return -1
	}
	return float64(time.Since(t0).Microseconds()) / 1000
}

func fpmListening() bool {
	c, err := net.DialTimeout("tcp", "127.0.0.1:9000", time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

type probe struct {
	name string
	fn   func() float64
}

func probes() []probe {
	ps := []probe{
		{"leaf", func() float64 { return probeHTTP("http://127.0.0.1:8086/health") }},
		{"nginx", func() float64 { return probeHTTP("https://chatyy.com.br/_edge_health") }},
		{"router", func() float64 { return probeHTTP(C.ctl + "/health") }},
	}
	if fpmListening() {
		ps = append(ps, probe{"php", func() float64 { return probeFCGI("/var/www/mail/api/app-health.php") }})
	} else {
		ps = append(ps, probe{"php", func() float64 { return probeHTTP("https://chatyy.com.br/api/app-health.php") }})
	}
	return ps
}

// ---------------- monitor ----------------

func median(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	c := append([]float64(nil), v...)
	sort.Float64s(c)
	return c[len(c)/2]
}

type monitor struct {
	mu       sync.Mutex
	samples  []sample
	baseline map[string]float64
	t0       time.Time
}

func (m *monitor) loop(done <-chan struct{}, loadStart time.Time) {
	ps := probes()
	base := map[string][]float64{}
	bad := map[string]int{}
	hot := map[string]int{}
	pu, pt := cgCPU()
	hb, ht := hostCPU()
	ps0 := selfCPU()
	rx0, tx0 := readInt("/sys/class/net/wg0/statistics/rx_bytes"), readInt("/sys/class/net/wg0/statistics/tx_bytes")
	lo0 := listenOverflows()
	var ok0, rc0, sk0, er0 int64
	last := time.Now()
	tk := time.NewTicker(time.Second)
	defer tk.Stop()
	memMax := float64(readInt(cg + "/memory.max"))
	for {
		select {
		case <-done:
			return
		case now := <-tk.C:
			dt := now.Sub(last).Seconds()
			last = now
			u, t := cgCPU()
			b, tt := hostCPU()
			sc := selfCPU()
			rx, tx := readInt("/sys/class/net/wg0/statistics/rx_bytes"), readInt("/sys/class/net/wg0/statistics/tx_bytes")
			lo := listenOverflows()
			// RAM não recuperável (anon+kernel) — o cache de página dos segmentos (file) o kernel devolve antes do OOM
			mem := float64(cgAnon())
			memCur := float64(readInt(cg + "/memory.current"))
			s := sample{
				T:          now.Sub(m.t0).Seconds(),
				RtCPU:      float64(u-pu) / 1e6 / dt * 100,
				RtThrMs:    float64(t-pt) / 1000 / dt,
				RtMemMB:    mem / 1048576,
				RtMemMaxMB: memMax / 1048576,
				RtMemCurMB: memCur / 1048576,
				HostCPU:    float64(b-hb) / float64(max64(tt-ht, 1)) * 100,
				SelfCPU:    float64(sc-ps0) / 100 / dt * 100,
				WgRxKB:     float64(rx-rx0) / 1024 / dt,
				WgTxKB:     float64(tx-tx0) / 1024 / dt,
				ListenOvf:  lo - lo0,
				Health:     map[string]float64{},
			}
			pu, pt, hb, ht, ps0, rx0, tx0, lo0 = u, t, b, tt, sc, rx, tx, lo
			ok, rc, sk, er := cntOK.Load(), cntRecv.Load(), cntSkipped.Load(), cntErrFinal.Load()
			s.SentOK, s.Recv, s.Skipped, s.ErrFinal = ok-ok0, rc-rc0, sk-sk0, er-er0
			ok0, rc0, sk0, er0 = ok, rc, sk, er
			var wg sync.WaitGroup
			var hmu sync.Mutex
			for _, p := range ps {
				wg.Add(1)
				go func(p probe) {
					defer wg.Done()
					v := p.fn()
					hmu.Lock()
					s.Health[p.name] = v
					hmu.Unlock()
				}(p)
			}
			wg.Wait()
			sp, sn := sendWin.p99()
			ep, en := e2eWin.p99()
			s.SendP99, s.E2eP99 = sp, ep
			loading := now.After(loadStart)
			if !loading {
				for k, v := range s.Health {
					if v >= 0 {
						base[k] = append(base[k], v)
					}
				}
			} else {
				if m.baseline == nil {
					m.mu.Lock()
					m.baseline = map[string]float64{}
					for k, v := range base {
						m.baseline[k] = median(v)
					}
					m.mu.Unlock()
				}
				for k, v := range s.Health {
					if k == "router" {
						continue // é o próprio roteador: só registra (a parada vem de p99/erro)
					}
					bl := m.baseline[k]
					lim := bl * C.healthX
					if lim < bl+C.healthAbsMs {
						lim = bl + C.healthAbsMs
					}
					if v < 0 {
						bad[k]++
						if bad[k] >= 3 {
							trip("health_fail:" + k)
						}
					} else {
						bad[k] = 0
					}
					if v > lim {
						hot[k]++
						if hot[k] >= 3 {
							trip(fmt.Sprintf("health_slow:%s %.1fms (base %.1f)", k, v, bl))
						}
					} else {
						hot[k] = 0
					}
				}
				if memMax > 0 && mem > C.memFrac*memMax {
					trip(fmt.Sprintf("router_mem anon %.0fMB > %.0f%% de %.0fMB", mem/1048576, C.memFrac*100, memMax/1048576))
				}
				if s.HostCPU > C.hostCPU {
					hot["hostcpu"]++
					if hot["hostcpu"] >= 3 {
						trip(fmt.Sprintf("host_cpu %.0f%%", s.HostCPU))
					}
				} else {
					hot["hostcpu"] = 0
				}
				if sn >= 200 && sp > float64(C.p99max.Milliseconds()) {
					trip(fmt.Sprintf("send_p99 %.0fms", sp))
				}
				if en >= 200 && ep > float64(C.p99max.Milliseconds()) {
					trip(fmt.Sprintf("e2e_p99 %.0fms", ep))
				}
				if tot := s.SentOK + s.ErrFinal; s.ErrFinal >= 5 && float64(s.ErrFinal)/float64(tot) > C.errFrac {
					trip(fmt.Sprintf("erro %d/%d", s.ErrFinal, tot))
				}
			}
			m.mu.Lock()
			m.samples = append(m.samples, s)
			m.mu.Unlock()
			writeState(m, s)
			if _, err := os.Stat(filepath.Join(C.out, "stop")); err == nil {
				trip("stop_externo")
			}
		}
	}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func writeJSON(path string, v any) {
	b, _ := json.Marshal(v)
	tmp := path + ".tmp"
	os.WriteFile(tmp, b, 0644)
	os.Rename(tmp, path)
}

func writeState(m *monitor, s sample) {
	tr, _ := tripReason.Load().(string)
	writeJSON(filepath.Join(C.out, "state.json"), map[string]any{
		"me": C.me, "step": C.step, "ok": cntOK.Load(), "recv": cntRecv.Load(), "err": cntErrFinal.Load(),
		"skip": cntSkipped.Load(), "trip": tr, "last": s,
	})
}

// ---------------- principal ----------------

func parseFlags(args []string) {
	fs := flag.NewFlagSet("step", flag.ExitOnError)
	regions := fs.String("regions", "", "regiões participantes (vírgula)")
	ban := fs.String("ban", "", "pares sem rota, ex.: sg:br2")
	homesF := fs.String("homes", "", "só estas regiões são casa (vírgula); vazio = todas")
	dstsF := fs.String("dsts", "", "só estas regiões têm aparelho destino (vírgula); vazio = todas")
	at := fs.Int64("at", 0, "início da carga (unix s)")
	fs.StringVar(&C.run, "run", "", "id da rodada")
	fs.IntVar(&C.step, "step", 1, "passo")
	fs.StringVar(&C.me, "me", "", "região deste nó")
	fs.StringVar(&C.out, "out", "", "diretório de saída")
	fs.Float64Var(&C.rate, "rate", 100, "msgs/s deste nó")
	fs.DurationVar(&C.dur, "dur", 60*time.Second, "duração do envio")
	fs.DurationVar(&C.drain, "drain", 30*time.Second, "espera máx. de entrega depois do envio")
	fs.IntVar(&C.convs, "convs", 1000, "conversas por origem")
	fs.IntVar(&C.devs, "devs", 1, "aparelhos por (destino, origem)")
	fs.DurationVar(&C.poll, "poll", 150*time.Millisecond, "intervalo do fetch vazio")
	fs.IntVar(&C.bytes, "bytes", 200, "tamanho do corpo")
	fs.StringVar(&C.ctl, "ctl", "http://127.0.0.1:4790", "controle do roteador")
	fs.DurationVar(&C.p99max, "p99max", 2*time.Second, "limite p99 (send e e2e)")
	fs.Float64Var(&C.memFrac, "memfrac", 0.8, "limite RAM do roteador / MemoryMax")
	fs.Float64Var(&C.hostCPU, "hostcpu", 85, "limite CPU do host (%)")
	fs.Float64Var(&C.healthX, "healthx", 3, "limite health = max(base*X, base+abs)")
	fs.Float64Var(&C.healthAbsMs, "healthabs", 50, "folga absoluta do health (ms)")
	fs.Float64Var(&C.errFrac, "errfrac", 0.01, "limite fração de erro por segundo")
	fs.BoolVar(&C.noTrip, "notrip", false, "não parar sozinho")
	fs.Parse(args)
	C.regions = strings.Split(*regions, ",")
	C.ban = map[string]bool{}
	for _, b := range strings.Split(*ban, ",") {
		if b != "" {
			C.ban[b] = true
		}
	}
	C.homes = map[string]bool{}
	for _, h := range strings.Split(*homesF, ",") {
		if h != "" {
			C.homes[h] = true
		}
	}
	C.dstsOK = map[string]bool{}
	for _, h := range strings.Split(*dstsF, ",") {
		if h != "" {
			C.dstsOK[h] = true
		}
	}
	C.at = time.Unix(*at, 0)
	if *at == 0 {
		C.at = time.Now().Add(6 * time.Second)
	}
}

func assignHomes(plan []conv) error {
	sem := make(chan struct{}, 16)
	var wg sync.WaitGroup
	var fails atomic.Int64
	for _, cv := range plan {
		wg.Add(1)
		sem <- struct{}{}
		go func(cv conv) {
			defer wg.Done()
			defer func() { <-sem }()
			code, _, err := postJSON("/assign", map[string]any{"cid": cv.cid, "region": cv.home})
			if err != nil || code != 200 {
				fails.Add(1)
			}
		}(cv)
	}
	wg.Wait()
	if fails.Load() > 0 {
		return fmt.Errorf("assign falhou em %d conversas", fails.Load())
	}
	return nil
}

// 1 envio por conversa antes da medição (ensure + cache de pid; 1ª msg custa 2×RTT).
// Corpo marcado com passo 0: o receptor conta como "late" e não entra nas métricas.
func warm(plan []conv) (int64, time.Duration) {
	t := time.Now()
	sem := make(chan struct{}, 64)
	var wg sync.WaitGroup
	var fails atomic.Int64
	pad := make([]byte, C.bytes)
	for _, cv := range plan {
		wg.Add(1)
		sem <- struct{}{}
		go func(cv conv) {
			defer wg.Done()
			defer func() { <-sem }()
			body := []byte(fmt.Sprintf("L1|%s|0|%s|%d|0|%d|", C.run, cv.origin, cv.idx, time.Now().UnixNano()))
			body = append(body, pad[:max(0, C.bytes-len(body))]...)
			code, _, err := postJSON("/send", map[string]any{
				"cid": cv.cid, "from": "load-" + cv.origin, "device": "ldsrc:" + C.run + ":" + cv.origin,
				"cmi": fmt.Sprintf("W%s-%s-%d", C.run, cv.origin, cv.idx), "body_b64": base64.StdEncoding.EncodeToString(body),
				"devices": [][]string{{cv.dev, cv.dst}},
			})
			if err != nil || code != 200 {
				fails.Add(1)
			}
		}(cv)
	}
	wg.Wait()
	return fails.Load(), time.Since(t)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("uso: rtload step|probe|plan ...")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "probe":
		C.ctl = "http://127.0.0.1:4790"
		for _, p := range probes() {
			fmt.Printf("%s %.2f ms\n", p.name, p.fn())
		}
		return
	case "httpbench":
		// rtload httpbench <path> <n> <conc>: custo de CPU do roteador por requisição (desconta o ocioso)
		C.ctl = "http://127.0.0.1:4790"
		path := os.Args[2]
		n, _ := strconv.Atoi(os.Args[3])
		cc, _ := strconv.Atoi(os.Args[4])
		u0, _ := cgCPU()
		time.Sleep(3 * time.Second)
		u1, _ := cgCPU()
		idle := float64(u1-u0) / 3e6
		t0 := time.Now()
		var wg sync.WaitGroup
		var errs atomic.Int64
		ch := make(chan struct{}, n)
		for i := 0; i < n; i++ {
			ch <- struct{}{}
		}
		close(ch)
		for w := 0; w < cc; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range ch {
					resp, err := hc.Get(C.ctl + path)
					if err != nil {
						errs.Add(1)
						continue
					}
					io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
				}
			}()
		}
		wg.Wait()
		wall := time.Since(t0).Seconds()
		u2, _ := cgCPU()
		cpu := float64(u2-u1)/1e6 - idle*wall
		fmt.Printf("%s n=%d conc=%d wall=%.2fs (%.0f req/s) cpu_rt=%.0f us/req idle=%.1f%% errs=%d\n", path, n, cc, wall, float64(n)/wall, cpu/float64(n)*1e6, idle*100, errs.Load())
		return
	case "clean":
		// rtload clean -run R -me X -regions ... [-devs N]: fetch + ack de tudo que sobrou nas inboxes sintéticas desta região
		parseFlags(os.Args[2:])
		total := 0
		for _, d := range myDevices() {
			for {
				resp, err := hc.Get(C.ctl + "/fetch?device=" + url.QueryEscape(d))
				if err != nil {
					break
				}
				b, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				var r struct {
					Messages []struct {
						Cid string `json:"cid"`
						Seq int64  `json:"seq"`
					} `json:"messages"`
				}
				json.Unmarshal(b, &r)
				if len(r.Messages) == 0 {
					break
				}
				up := map[string]int64{}
				for _, m := range r.Messages {
					if m.Seq > up[m.Cid] {
						up[m.Cid] = m.Seq
					}
				}
				for cid, u := range up {
					postJSON("/ack", map[string]any{"device": d, "cid": cid, "upto": u})
				}
				total += len(r.Messages)
				time.Sleep(200 * time.Millisecond)
			}
		}
		fmt.Printf("%s run=%s limpou %d\n", C.me, C.run, total)
		return
	case "planlist":
		parseFlags(os.Args[2:])
		for _, cv := range planFor(C.me) {
			fmt.Println(cv.cid, cv.home, cv.dst, cv.dev)
		}
		return
	case "plan":
		parseFlags(os.Args[2:])
		cnt := map[string]int{}
		for _, o := range C.regions {
			for _, cv := range planFor(o) {
				cnt["home:"+cv.home]++
				cnt["dst:"+cv.dst]++
			}
		}
		json.NewEncoder(os.Stdout).Encode(cnt)
		return
	case "step":
		parseFlags(os.Args[2:])
	default:
		os.Exit(2)
	}
	os.MkdirAll(C.out, 0755)
	os.Remove(filepath.Join(C.out, "stop"))
	plan := planFor(C.me)
	log := func(f string, a ...any) {
		fmt.Fprintf(os.Stderr, "%s "+f+"\n", append([]any{time.Now().UTC().Format("15:04:05")}, a...)...)
	}
	// casas: só no 1º passo da rodada (as conversas são as mesmas nos passos seguintes)
	if C.step == 1 || os.Getenv("RTLOAD_ASSIGN") == "1" {
		t := time.Now()
		if err := assignHomes(plan); err != nil {
			log("ERRO %v", err)
			writeJSON(filepath.Join(C.out, "summary.json"), map[string]any{"me": C.me, "fatal": err.Error()})
			os.Exit(1)
		}
		log("assign de %d conversas em %v", len(plan), time.Since(t))
		time.Sleep(3 * time.Second) // a casa precisa receber o merge do assign antes do ensure
	}
	if C.step == 1 || os.Getenv("RTLOAD_WARM") == "1" {
		f, d := warm(plan)
		log("aquecimento: %d conversas em %v, %d falhas", len(plan), d, f)
	}
	mon := &monitor{t0: C.at}
	monDone := make(chan struct{})
	go mon.loop(monDone, C.at)
	// receptor começa já (pega o que chegar), remetente em C.at
	var lastRecv atomic.Int64
	sendUntil := C.at.Add(C.dur)
	var sendDone atomic.Bool
	var quietSince atomic.Int64
	origEnd := C.at.Add(C.dur)
	stopPath := filepath.Join(C.out, "stop")
	recvStop := func() bool {
		if !sendDone.Load() {
			return false
		}
		now := time.Now()
		if now.After(origEnd.Add(C.drain)) {
			return true
		}
		// os OUTROS nós continuam enviando até o fim do passo ou até a parada global (arquivo stop)
		globalEnd := origEnd
		if fi, err := os.Stat(stopPath); err == nil && fi.ModTime().Before(globalEnd) {
			globalEnd = fi.ModTime()
		}
		if now.Before(globalEnd.Add(3 * time.Second)) {
			return false
		}
		// 5 s sem nada novo depois do fim do envio (de todos os nós: o envio acaba igual em todos)
		lr := time.Unix(0, lastRecv.Load())
		qs := time.Unix(0, quietSince.Load())
		return now.Sub(lr) > 5*time.Second && now.Sub(qs) > 5*time.Second
	}
	var rwg sync.WaitGroup
	runReceiver(recvStop, &rwg, &lastRecv)
	time.Sleep(time.Until(C.at))
	log("início: %d conversas, %.0f msg/s, %v", len(plan), C.rate, C.dur)
	var swg sync.WaitGroup
	runSender(plan, sendUntil, &swg)
	// espera fim do envio (tempo ou parada) e conversas sem envio em voo
	for time.Now().Before(sendUntil) && !stopFlag.Load() {
		time.Sleep(100 * time.Millisecond)
	}
	swg.Wait()
	sendEnd := time.Now()
	quietSince.Store(time.Now().UnixNano())
	sendDone.Store(true)
	log("envio terminou: ok=%d err=%d skip=%d", cntOK.Load(), cntErrFinal.Load(), cntSkipped.Load())
	rwg.Wait()
	close(monDone)
	elapsed := sendEnd.Sub(C.at).Seconds()
	tr, _ := tripReason.Load().(string)
	ek := map[string]int64{}
	errKinds.Range(func(k, v any) bool { ek[k.(string)] = v.(*atomic.Int64).Load(); return true })
	byO := map[string]any{}
	e2eByOrigin.Range(func(k, v any) bool { byO[k.(string)] = v.(*hist).snapshot(); return true })
	// recebidos por conversa: lista de k da ETAPA atual
	recvK := map[string][]int64{}
	rmu.Lock()
	for cid, st := range rconvs {
		for _, k := range st.seen {
			recvK[cid] = append(recvK[cid], k)
		}
	}
	rmu.Unlock()
	mon.mu.Lock()
	sum := map[string]any{
		"me": C.me, "run": C.run, "step": C.step, "rate": C.rate, "convs": len(plan),
		"at": C.at.Unix(), "send_secs": elapsed, "trip": tr,
		"offered": cntOffered.Load(), "ok": cntOK.Load(), "err_final": cntErrFinal.Load(), "retries": cntRetry.Load(),
		"skipped": cntSkipped.Load(), "err_kinds": ek,
		"recv": cntRecv.Load(), "refetch": cntRefetch.Load(), "dup": cntDup.Load(), "ooo": cntOOO.Load(),
		"korder": cntKOrder.Load(), "seq_conflict": cntSeqConflict.Load(), "late": cntLate.Load(), "foreign": cntForeign.Load(),
		"fetches": cntFetches.Load(), "fetch_err": cntFetchErr.Load(), "acks": cntAcks.Load(), "ack_err": cntAckErr.Load(),
		"send_hist": sendH.snapshot(), "e2e_hist": e2eH.snapshot(), "e2e_by_origin": byO,
		"sent_k": sStats.okByCid, "sent_seq": sStats.seqByCid, "recv_k": recvK,
		"baseline_health_ms": mon.baseline, "samples": mon.samples,
	}
	mon.mu.Unlock()
	writeJSON(filepath.Join(C.out, "summary.json"), sum)
	log("fim: recv=%d dup=%d ooo=%d trip=%q", cntRecv.Load(), cntDup.Load(), cntOOO.Load(), tr)
}
