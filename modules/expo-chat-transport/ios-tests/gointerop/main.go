// Servidor de interop chatyy/1 sobre TCP com flynn/noise (a mesma lib do leaf).
// LEIA: go run . → imprime "host:porta chave_pub_b64"; noutro terminal:
//   swift run Interop host:porta chave_pub_b64   (em ../)
// Espera: READY bound=bearer / TEXT echo:... 150032 / CLOSE 4001 go_ws.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"

	"github.com/flynn/noise"
)

func readHS(r io.Reader) []byte {
	var h [2]byte
	io.ReadFull(r, h[:])
	b := make([]byte, binary.BigEndian.Uint16(h[:]))
	io.ReadFull(r, b)
	return b
}
func rec(cs *noise.CipherState, pt []byte) []byte {
	ct, _ := cs.Encrypt(nil, nil, pt)
	return append([]byte{byte(len(ct) >> 8), byte(len(ct))}, ct...)
}
func frame(t byte, body []byte) []byte {
	var b []byte
	n := uint64(len(body))
	switch {
	case n < 64:
		b = []byte{byte(n)}
	case n < 16384:
		b = []byte{byte(n>>8) | 0x40, byte(n)}
	default:
		b = []byte{byte(n>>24) | 0x80, byte(n >> 16), byte(n >> 8), byte(n)}
	}
	b = append(b, t)
	return append(b, body...)
}

func main() {
	suite := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashBLAKE2s)
	kp, _ := suite.GenerateKeypair(nil)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	fmt.Println(ln.Addr().String(), base64.StdEncoding.EncodeToString(kp.Public))
	os.Stdout.Sync()
	c, _ := ln.Accept()
	br := bufio.NewReader(c)
	var pre [4]byte
	io.ReadFull(br, pre[:])
	if string(pre[:3]) != "CY\x01" || pre[3] != 'I' {
		fmt.Fprintln(os.Stderr, "bad preamble")
		os.Exit(1)
	}
	pro := append([]byte("chatyy/1\x00mex\x00t1\x00"), 't', 'I')
	hs, _ := noise.NewHandshakeState(noise.Config{CipherSuite: suite, Pattern: noise.HandshakeIK, Initiator: false, Prologue: pro, StaticKeypair: kp})
	pl, _, _, err := hs.ReadMessage(nil, readHS(br))
	if err != nil {
		fmt.Fprintln(os.Stderr, "msg1:", err)
		os.Exit(1)
	}
	var hello map[string]any
	json.Unmarshal(pl, &hello)
	fmt.Fprintln(os.Stderr, "hello:", hello["v"], hello["dev"], hello["ua"], len(hello["n"].(string)), "peer", base64.StdEncoding.EncodeToString(hs.PeerStatic()))
	acc, _ := json.Marshal(map[string]any{"v": 1, "ok": true, "region": "mex", "kid": "t1", "srv_ts": 1, "bound": "bearer", "early_n": 0})
	m2, cs1, cs2, _ := hs.WriteMessage(nil, acc)
	c.Write(append([]byte{byte(len(m2) >> 8), byte(len(m2))}, m2...))
	// cs1 = cliente→servidor (recv aqui), cs2 = servidor→cliente
	c.Write(rec(cs2, frame(0x09, []byte("hb"))))
	// lê 1 registro do cliente: deve ser pong "hb" e depois um texto; ecoa o texto
	r := bufio.NewReader(br)
	got := []byte{}
	for len(got) < 1 || true {
		ct := readHS(r)
		pt, err := cs1.Decrypt(nil, nil, ct)
		if err != nil {
			fmt.Fprintln(os.Stderr, "rec:", err)
			os.Exit(1)
		}
		got = append(got, pt...)
		// pong(4 bytes: 02 0a 'h' 'b') + texto
		if len(got) > 6 && got[0] == 2 && got[1] == 0x0a {
			rest := got[4:]
			if len(rest) >= 2 {
				n := int(rest[0] & 0x3f)
				off := 1
				if rest[0]>>6 == 1 {
					n = int(rest[0]&0x3f)<<8 | int(rest[1])
					off = 2
				}
				if len(rest) >= off+1+n {
					body := rest[off+1 : off+1+n]
					fmt.Fprintln(os.Stderr, "client text:", string(body))
					big := make([]byte, 150000)
					for i := range big {
						big[i] = 'y'
					}
					w := frame(0x01, append(append([]byte("echo:"), body...), big...))
					for off := 0; off < len(w); off += 65519 {
						e := off + 65519
						if e > len(w) {
							e = len(w)
						}
						c.Write(rec(cs2, w[off:e]))
					}
					cb := append([]byte{0x0f, 0xa1}, []byte("go_ws")...)
					c.Write(rec(cs2, frame(0x08, cb)))
					break
				}
			}
		}
	}
	c.Close()
}
