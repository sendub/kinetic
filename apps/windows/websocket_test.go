package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

// wsServer is an httptest server that upgrades by hand (no WebSocket
// library on either side) and hands each upgraded connection to the test.
type wsServer struct {
	*httptest.Server
	conns    chan *serverConn
	requests chan *http.Request
}

// serverConn is the server's end of one upgraded connection.
type serverConn struct {
	t    *testing.T
	conn net.Conn
	in   *bufio.Reader
}

// newWSServer answers each upgrade with accept(key) as its
// Sec-WebSocket-Accept, or with status when it is not 101.
func newWSServer(t *testing.T, status int, accept func(string) string) *wsServer {
	t.Helper()

	s := &wsServer{conns: make(chan *serverConn, 4), requests: make(chan *http.Request, 4)}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests <- r
		if status != http.StatusSwitchingProtocols {
			w.WriteHeader(status)

			return
		}

		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)

			return
		}

		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + accept(r.Header.Get("Sec-WebSocket-Key")) + "\r\n\r\n")
		_ = rw.Flush()
		s.conns <- &serverConn{t: t, conn: conn, in: rw.Reader}
	}))
	t.Cleanup(s.Close)

	return s
}

func (s *wsServer) wsURL(path string) string {
	return "ws" + strings.TrimPrefix(s.URL, "http") + path
}

// dial connects a client and returns both ends.
func (s *wsServer) dial(t *testing.T) (*wsConn, *serverConn) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client, err := dialWebSocket(ctx, s.wsURL("/devtools/browser/abc"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	t.Cleanup(func() { _ = client.conn.Close() })

	select {
	case server := <-s.conns:
		_ = server.conn.SetDeadline(time.Now().Add(10 * time.Second))
		t.Cleanup(func() { _ = server.conn.Close() })

		return client, server
	case <-time.After(5 * time.Second):
		t.Fatal("the server never saw the upgrade")

		return nil, nil
	}
}

// clientFrame is a frame as the server read it off the wire.
type clientFrame struct {
	fin      bool
	opcode   byte
	masked   bool
	sizeForm int // 7, 16 or 64: which length encoding the client used
	wire     []byte
	payload  []byte
}

func (s *serverConn) readFrame() clientFrame {
	s.t.Helper()

	var head [2]byte
	s.must(io.ReadFull(s.in, head[:]))

	f := clientFrame{fin: head[0]&0x80 != 0, opcode: head[0] & 0x0F, masked: head[1]&0x80 != 0, sizeForm: 7}
	size := uint64(head[1] & 0x7F)

	switch size {
	case 126:
		var ext [2]byte
		s.must(io.ReadFull(s.in, ext[:]))
		size, f.sizeForm = uint64(binary.BigEndian.Uint16(ext[:])), 16
	case 127:
		var ext [8]byte
		s.must(io.ReadFull(s.in, ext[:]))
		size, f.sizeForm = binary.BigEndian.Uint64(ext[:]), 64
	}

	var mask [4]byte
	if f.masked {
		s.must(io.ReadFull(s.in, mask[:]))
	}

	f.wire = make([]byte, size)
	s.must(io.ReadFull(s.in, f.wire))

	f.payload = make([]byte, size)
	for i, b := range f.wire {
		f.payload[i] = b ^ mask[i%4]
	}

	return f
}

// writeFrame sends a server frame, unmasked unless masked is set.
func (s *serverConn) writeFrame(fin bool, opcode byte, payload []byte, masked bool) {
	s.t.Helper()

	first := opcode
	if fin {
		first |= 0x80
	}

	out := []byte{first, 0}

	switch n := len(payload); {
	case n < 126:
		out[1] = byte(n)
	case n <= 0xFFFF:
		out[1] = 126
		out = binary.BigEndian.AppendUint16(out, uint16(n))
	default:
		out[1] = 127
		out = binary.BigEndian.AppendUint64(out, uint64(n))
	}

	if masked {
		out[1] |= 0x80
		out = append(out, 1, 2, 3, 4)

		for i, b := range payload {
			out = append(out, b^byte(i%4+1))
		}
	} else {
		out = append(out, payload...)
	}

	s.must(s.conn.Write(out))
}

// must stops the calling goroutine (the test's or a writer's) on err.
func (s *serverConn) must(_ int, err error) {
	s.t.Helper()

	if err != nil {
		s.t.Errorf("server: %v", err)
		runtime.Goexit()
	}
}

// pattern is n bytes that are not all alike.
func pattern(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte('a' + i%26)
	}

	return out
}

func TestWebSocketHandshake(t *testing.T) {
	s := newWSServer(t, http.StatusSwitchingProtocols, acceptKey)
	s.dial(t)

	r := <-s.requests
	if r.Method != http.MethodGet || r.URL.Path != "/devtools/browser/abc" {
		t.Errorf("request %s %s, want GET /devtools/browser/abc", r.Method, r.URL.Path)
	}

	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!headerHasToken(r.Header.Get("Connection"), "Upgrade") ||
		r.Header.Get("Sec-WebSocket-Version") != "13" {
		t.Errorf("upgrade headers %v", r.Header)
	}

	if key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key")); err != nil || len(key) != 16 {
		t.Errorf("Sec-WebSocket-Key %q is not 16 bytes in base64", r.Header.Get("Sec-WebSocket-Key"))
	}

	// DevTools refuses a WebSocket from an origin it was not told to allow.
	if origin := r.Header.Get("Origin"); origin != "" {
		t.Errorf("sent Origin %q, want none", origin)
	}

	// The example from RFC 6455 section 1.3.
	if got := acceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Errorf("acceptKey = %q", got)
	}
}

func TestWebSocketHandshakeRefusals(t *testing.T) {
	cases := map[string]*wsServer{
		"a 403":           newWSServer(t, http.StatusForbidden, acceptKey),
		"a wrong accept":  newWSServer(t, http.StatusSwitchingProtocols, func(string) string { return "AAAA" }),
		"an accept of no": newWSServer(t, http.StatusSwitchingProtocols, func(string) string { return "" }),
	}
	for name, s := range cases {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if _, err := dialWebSocket(ctx, s.wsURL("/")); err == nil {
			t.Errorf("%s: dial succeeded, want an error", name)
		}

		cancel()
	}

	if _, err := dialWebSocket(context.Background(), "http://127.0.0.1:1/"); err == nil {
		t.Error("dial of an http:// URL succeeded")
	}
}

func TestWebSocketClientFramesAreMaskedWithEachLengthForm(t *testing.T) {
	s := newWSServer(t, http.StatusSwitchingProtocols, acceptKey)
	client, server := s.dial(t)

	for _, c := range []struct{ size, form int }{{0, 7}, {5, 7}, {125, 7}, {126, 16}, {65535, 16}, {65536, 64}, {300000, 64}} {
		payload := pattern(c.size)
		if err := client.WriteText(payload); err != nil {
			t.Fatalf("WriteText(%d bytes): %v", c.size, err)
		}

		f := server.readFrame()
		if !f.fin || f.opcode != opText || !f.masked || f.sizeForm != c.form {
			t.Errorf("%d bytes: fin %v opcode %d masked %v length form %d, want a final masked text frame, form %d",
				c.size, f.fin, f.opcode, f.masked, f.sizeForm, c.form)
		}

		if !bytes.Equal(f.payload, payload) {
			t.Errorf("%d bytes: the unmasked payload differs", c.size)
		}

		if c.size >= 16 && bytes.Equal(f.wire, payload) {
			t.Errorf("%d bytes: sent in the clear", c.size)
		}
	}
}

func TestWebSocketReadsFragmentsLargeFramesAndAnswersPings(t *testing.T) {
	s := newWSServer(t, http.StatusSwitchingProtocols, acceptKey)
	client, server := s.dial(t)

	big := pattern(70000)
	mid := pattern(300)

	go func() {
		server.writeFrame(true, opText, []byte(`{"id":1}`), false)
		// One message in three fragments, a ping between two of them.
		server.writeFrame(false, opText, []byte("frag-one "), false)
		server.writeFrame(true, opPing, []byte("are you there"), false)
		server.writeFrame(false, opContinuation, []byte("frag-two "), false)
		server.writeFrame(true, opContinuation, []byte("frag-three"), false)
		server.writeFrame(true, opText, mid, false)
		server.writeFrame(true, opBinary, big, false)
		// A large message in fragments.
		server.writeFrame(false, opText, big[:40000], false)
		server.writeFrame(true, opContinuation, big[40000:], false)
		server.writeFrame(true, opText, nil, false)
	}()

	want := [][]byte{[]byte(`{"id":1}`), []byte("frag-one frag-two frag-three"), mid, big, big, {}}
	for i, w := range want {
		got, err := client.ReadMessage()
		if err != nil {
			t.Fatalf("message %d: %v", i, err)
		}

		if !bytes.Equal(got, w) {
			t.Errorf("message %d: %d bytes %.40q, want %d bytes %.40q", i, len(got), got, len(w), w)
		}
	}

	pong := server.readFrame()
	if pong.opcode != opPong || !pong.masked || string(pong.payload) != "are you there" {
		t.Errorf("answer to the ping: opcode %d masked %v payload %q, want a masked pong echoing it",
			pong.opcode, pong.masked, pong.payload)
	}
}

func TestWebSocketServerClose(t *testing.T) {
	s := newWSServer(t, http.StatusSwitchingProtocols, acceptKey)
	client, server := s.dial(t)

	go server.writeFrame(true, opClose, []byte{0x03, 0xE9, 'b', 'y', 'e'}, false)

	if _, err := client.ReadMessage(); !errors.Is(err, errClosed) {
		t.Fatalf("ReadMessage after a close = %v, want errClosed", err)
	}

	echo := server.readFrame()
	if echo.opcode != opClose || !echo.masked || !bytes.Equal(echo.payload, []byte{0x03, 0xE9}) {
		t.Errorf("close answer: opcode %d masked %v payload %v, want a masked close with 1001",
			echo.opcode, echo.masked, echo.payload)
	}

	if err := client.WriteText([]byte("late")); !errors.Is(err, errClosed) {
		t.Errorf("WriteText after the close = %v, want errClosed", err)
	}
}

func TestWebSocketClientClose(t *testing.T) {
	s := newWSServer(t, http.StatusSwitchingProtocols, acceptKey)
	client, server := s.dial(t)

	read := make(chan error, 1)

	go func() {
		_, err := client.ReadMessage()
		read <- err
	}()

	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	f := server.readFrame()
	if f.opcode != opClose || !f.masked || !bytes.Equal(f.payload, []byte{0x03, 0xE8}) {
		t.Errorf("close frame: opcode %d masked %v payload %v, want a masked close with 1000", f.opcode, f.masked, f.payload)
	}

	select {
	case err := <-read:
		if err == nil {
			t.Error("a blocked ReadMessage returned no error after Close")
		}
	case <-time.After(5 * time.Second):
		t.Error("a blocked ReadMessage did not return after Close")
	}

	_ = client.Close() // twice is harmless
}

func TestWebSocketRefusesProtocolErrors(t *testing.T) {
	cases := map[string]func(*serverConn){
		"a masked server frame": func(s *serverConn) { s.writeFrame(true, opText, []byte("x"), true) },
		"a fragmented ping":     func(s *serverConn) { s.writeFrame(false, opPing, []byte("x"), false) },
		"a stray continuation":  func(s *serverConn) { s.writeFrame(true, opContinuation, []byte("x"), false) },
		"a message inside another": func(s *serverConn) {
			s.writeFrame(false, opText, []byte("x"), false)
			s.writeFrame(true, opText, []byte("y"), false)
		},
		"reserved bits":     func(s *serverConn) { s.must(s.conn.Write([]byte{0xC1, 0x01, 'x'})) },
		"an unknown opcode": func(s *serverConn) { s.writeFrame(true, 0x3, []byte("x"), false) },
	}
	for name, send := range cases {
		s := newWSServer(t, http.StatusSwitchingProtocols, acceptKey)
		client, server := s.dial(t)

		go send(server)

		if _, err := client.ReadMessage(); err == nil || errors.Is(err, errClosed) {
			t.Errorf("%s: ReadMessage = %v, want a protocol error", name, err)
		}
	}
}
