package main

// A minimal WebSocket client (RFC 6455), standard library only, enough to
// speak to a browser's DevTools endpoint: the HTTP upgrade, masked client
// frames, unmasked server frames, text messages split across fragments,
// ping and pong, and the closing handshake. Platform-neutral, so it builds
// and tests on any OS (websocket_test.go).

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"net/url"
	"strings"
	"sync"
	"time"
)

// The frame opcodes this client knows.
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// websocketGUID is the fixed string the server appends to the client's key
// before hashing it into Sec-WebSocket-Accept.
const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// maxMessageBytes bounds one message, whole: a DevTools reply is far
// smaller, and a broken stream must not grow without end.
const maxMessageBytes = 64 << 20

// closeWait bounds Close's attempt to send its close frame.
const closeWait = 2 * time.Second

// errClosed says the connection was closed, by either side.
var errClosed = errors.New("websocket: connection closed")

// wsConn is one client connection. ReadMessage belongs to one reader at a
// time; WriteText and Close may be called from any goroutine.
type wsConn struct {
	conn net.Conn
	in   *bufio.Reader

	writeMu sync.Mutex
	// closeSent is set once a close frame has gone out (under writeMu).
	closeSent bool
}

// acceptKey is the Sec-WebSocket-Accept a server must answer key with.
func acceptKey(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))

	return base64.StdEncoding.EncodeToString(sum[:])
}

// dialWebSocket opens a ws:// URL: a TCP connection and the HTTP upgrade.
// It sends no Origin header, which DevTools accepts from any local client.
func dialWebSocket(ctx context.Context, rawURL string) (*wsConn, error) {
	target, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}

	if target.Scheme != "ws" || target.Host == "" {
		return nil, fmt.Errorf("websocket: %q is not a ws:// URL", rawURL)
	}

	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", target.Host)
	if err != nil {
		return nil, err
	}

	// The handshake obeys ctx too; the connection then has no deadline.
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	ws, err := handshake(conn, target)
	if err != nil {
		_ = conn.Close()

		return nil, err
	}

	_ = conn.SetDeadline(time.Time{})

	return ws, nil
}

// handshake sends the upgrade request over conn and checks the answer.
func handshake(conn net.Conn, target *url.URL) (*wsConn, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}

	key := base64.StdEncoding.EncodeToString(nonce)

	request := "GET " + target.RequestURI() + " HTTP/1.1\r\n" +
		"Host: " + target.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		return nil, err
	}

	// Read with net/textproto rather than net/http, which would add over
	// a megabyte to the exe.
	in := bufio.NewReader(conn)
	answer := textproto.NewReader(in)

	status, err := answer.ReadLine()
	if err != nil {
		return nil, fmt.Errorf("websocket: reading the upgrade answer: %w", err)
	}

	if proto, code, _ := strings.Cut(status, " "); !strings.HasPrefix(proto, "HTTP/1.") ||
		(code != "101" && !strings.HasPrefix(code, "101 ")) {
		return nil, fmt.Errorf("websocket: the server answered %q, not 101", status)
	}

	header, err := answer.ReadMIMEHeader()
	if err != nil {
		return nil, fmt.Errorf("websocket: reading the upgrade answer: %w", err)
	}

	if !strings.EqualFold(header.Get("Upgrade"), "websocket") ||
		!headerHasToken(header.Get("Connection"), "upgrade") {
		return nil, errors.New("websocket: the server did not upgrade the connection")
	}

	if header.Get("Sec-WebSocket-Accept") != acceptKey(key) {
		return nil, errors.New("websocket: the server's Sec-WebSocket-Accept does not match the key")
	}

	return &wsConn{conn: conn, in: in}, nil
}

// headerHasToken reports whether a comma-separated header value holds
// token, ignoring case.
func headerHasToken(value, token string) bool {
	for part := range strings.SplitSeq(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}

	return false
}

// WriteText sends p as one text message.
func (c *wsConn) WriteText(p []byte) error {
	return c.writeFrame(opText, p)
}

// writeFrame sends one final frame, masked with a fresh key as RFC 6455
// requires of every client frame.
func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if c.closeSent {
		return errClosed
	}

	if opcode == opClose {
		c.closeSent = true
	}

	header := []byte{0x80 | opcode, 0}

	switch n := len(payload); {
	case n < 126:
		header[1] = byte(n)
	case n <= 0xFFFF:
		header[1] = 126
		header = binary.BigEndian.AppendUint16(header, uint16(n))
	default:
		header[1] = 127
		header = binary.BigEndian.AppendUint64(header, uint64(n))
	}

	header[1] |= 0x80

	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return err
	}

	frame := make([]byte, 0, len(header)+4+len(payload))
	frame = append(frame, header...)
	frame = append(frame, mask...)

	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}

	_, err := c.conn.Write(frame)

	return err
}

// frame is one frame as read from the server.
type frame struct {
	fin     bool
	opcode  byte
	payload []byte
}

// readFrame reads one frame. Server frames are never masked.
func (c *wsConn) readFrame() (frame, error) {
	var head [2]byte
	if _, err := io.ReadFull(c.in, head[:]); err != nil {
		return frame{}, err
	}

	if head[0]&0x70 != 0 {
		return frame{}, errors.New("websocket: a frame uses reserved bits")
	}

	if head[1]&0x80 != 0 {
		return frame{}, errors.New("websocket: the server masked a frame")
	}

	f := frame{fin: head[0]&0x80 != 0, opcode: head[0] & 0x0F}
	size := uint64(head[1] & 0x7F)

	switch size {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.in, ext[:]); err != nil {
			return frame{}, err
		}

		size = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.in, ext[:]); err != nil {
			return frame{}, err
		}

		size = binary.BigEndian.Uint64(ext[:])
	}

	if f.opcode >= opClose && (size > 125 || !f.fin) {
		return frame{}, errors.New("websocket: a control frame is fragmented or too long")
	}

	if size > maxMessageBytes {
		return frame{}, fmt.Errorf("websocket: a %d-byte frame is too large", size)
	}

	f.payload = make([]byte, size)
	if _, err := io.ReadFull(c.in, f.payload); err != nil {
		return frame{}, err
	}

	return f, nil
}

// ReadMessage returns the next whole text or binary message's payload. It
// answers pings with pongs on the way (also between a message's fragments)
// and, when the server closes, answers its close frame and returns
// errClosed.
func (c *wsConn) ReadMessage() ([]byte, error) {
	var (
		message []byte
		started bool
	)

	for {
		f, err := c.readFrame()
		if err != nil {
			return nil, err
		}

		switch f.opcode {
		case opPing:
			if err := c.writeFrame(opPong, f.payload); err != nil && !errors.Is(err, errClosed) {
				return nil, err
			}

			continue
		case opPong:
			continue
		case opClose:
			// Echo the status code (the first two bytes), as RFC 6455 asks.
			code := f.payload
			if len(code) > 2 {
				code = code[:2]
			}

			_ = c.writeFrame(opClose, code)

			return nil, errClosed
		case opText, opBinary:
			if started {
				return nil, errors.New("websocket: a new message began inside a fragmented one")
			}

			started = true
		case opContinuation:
			if !started {
				return nil, errors.New("websocket: a continuation frame with no message")
			}
		default:
			return nil, fmt.Errorf("websocket: unknown opcode %#x", f.opcode)
		}

		if len(message)+len(f.payload) > maxMessageBytes {
			return nil, errors.New("websocket: a message is too large")
		}

		message = append(message, f.payload...)
		if f.fin {
			if message == nil {
				message = []byte{}
			}

			return message, nil
		}
	}
}

// Close sends a normal close frame (1000) unless one has gone out, then
// closes the connection without waiting for the server's answer: the
// client is done either way. Safe to call more than once, and alongside a
// blocked ReadMessage, which then returns an error.
func (c *wsConn) Close() error {
	c.writeMu.Lock()
	sent := c.closeSent
	c.writeMu.Unlock()

	if !sent {
		_ = c.conn.SetWriteDeadline(time.Now().Add(closeWait))
		_ = c.writeFrame(opClose, []byte{0x03, 0xE8})
	}

	return c.conn.Close()
}
