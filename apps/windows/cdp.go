package main

// A minimal client for the Chrome DevTools Protocol over wsConn: commands
// with ids and their replies, events queued for the caller, and flattened
// sessions (a command for a page names its sessionId). Platform-neutral.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// devToolsPortFile is where Edge and Chrome, started with
// --remote-debugging-port=0, write the port they picked and the browser's
// WebSocket path: in the profile folder (--user-data-dir).
const devToolsPortFile = "DevToolsActivePort"

// devToolsURL reads a DevToolsActivePort file ("<port>\n/devtools/browser/
// <id>") into the browser's WebSocket URL. The browser listens on the
// loopback address only.
func devToolsURL(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	lines := strings.Fields(string(data))
	if len(lines) < 2 {
		return "", fmt.Errorf("%s is incomplete", path)
	}

	port, err := strconv.Atoi(lines[0])
	if err != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("%s names no port", path)
	}

	if !strings.HasPrefix(lines[1], "/devtools/browser/") {
		return "", fmt.Errorf("%s names no browser endpoint", path)
	}

	return "ws://127.0.0.1:" + strconv.Itoa(port) + lines[1], nil
}

// waitForDevTools waits for the browser started on profile to write its
// DevToolsActivePort and returns the URL in it. It gives up when ctx ends
// or when alive (if given) reports the browser gone.
func waitForDevTools(ctx context.Context, profile string, alive func() bool) (string, error) {
	path := filepath.Join(profile, devToolsPortFile)
	tick := time.NewTicker(100 * time.Millisecond)

	defer tick.Stop()

	for {
		if endpoint, err := devToolsURL(path); err == nil {
			return endpoint, nil
		}

		if alive != nil && !alive() {
			return "", errors.New("the browser exited before it opened its DevTools connection")
		}

		select {
		case <-ctx.Done():
			return "", fmt.Errorf("no DevTools connection: %w", ctx.Err())
		case <-tick.C:
		}
	}
}

// cdpError is an error a command's reply carries.
type cdpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data,omitempty"`
}

func (e *cdpError) Error() string {
	if e.Data != "" {
		return fmt.Sprintf("devtools: %s (%d): %s", e.Message, e.Code, e.Data)
	}

	return fmt.Sprintf("devtools: %s (%d)", e.Message, e.Code)
}

// cdpMessage is any message on the connection: a command going out, or a
// reply or event coming in.
type cdpMessage struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Params    any             `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *cdpError       `json:"error,omitempty"`
}

// incoming is a message as read, with its params left raw.
type incoming struct {
	ID        int64           `json:"id"`
	Method    string          `json:"method"`
	SessionID string          `json:"sessionId"`
	Params    json.RawMessage `json:"params"`
	Result    json.RawMessage `json:"result"`
	Error     *cdpError       `json:"error"`
}

// cdpEvent is one event, for the session that sent it ("" for the browser).
type cdpEvent struct {
	Method    string
	SessionID string
	Params    json.RawMessage
}

// cdpConn is a DevTools connection. One goroutine reads it: replies go to
// their callers, and events queue until the caller drains them, so a
// caller handling an event can send commands without a deadlock.
type cdpConn struct {
	ws *wsConn

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan incoming
	events  []cdpEvent
	err     error

	signal chan struct{} // gets a token when events are queued
	done   chan struct{} // closed when the connection ends
}

// dialCDP connects to a browser's DevTools WebSocket URL.
func dialCDP(ctx context.Context, endpoint string) (*cdpConn, error) {
	ws, err := dialWebSocket(ctx, endpoint)
	if err != nil {
		return nil, err
	}

	c := &cdpConn{
		ws:      ws,
		pending: map[int64]chan incoming{},
		signal:  make(chan struct{}, 1),
		done:    make(chan struct{}),
	}

	go c.read()

	return c, nil
}

func (c *cdpConn) read() {
	for {
		data, err := c.ws.ReadMessage()
		if err != nil {
			c.finish(err)

			return
		}

		var msg incoming
		if json.Unmarshal(data, &msg) != nil {
			continue
		}

		c.mu.Lock()

		if msg.ID != 0 {
			if reply, ok := c.pending[msg.ID]; ok {
				delete(c.pending, msg.ID)
				reply <- msg
			}
		} else if msg.Method != "" {
			c.events = append(c.events, cdpEvent{Method: msg.Method, SessionID: msg.SessionID, Params: msg.Params})

			select {
			case c.signal <- struct{}{}:
			default:
			}
		}

		c.mu.Unlock()
	}
}

// finish records why the connection ended and wakes every waiter.
func (c *cdpConn) finish(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.err != nil {
		return
	}

	c.err = err
	close(c.done)
}

// call sends method with params (nil for none) to session ("" for the
// browser) and decodes the reply's result into result (nil to drop it).
func (c *cdpConn) call(ctx context.Context, session, method string, params, result any) error {
	reply := make(chan incoming, 1)

	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()

		return c.err
	}

	c.nextID++
	id := c.nextID
	c.pending[id] = reply
	c.mu.Unlock()

	data, err := json.Marshal(cdpMessage{ID: id, Method: method, SessionID: session, Params: params})
	if err == nil {
		err = c.ws.WriteText(data)
	}

	if err != nil {
		c.forget(id)

		return err
	}

	select {
	case msg := <-reply:
		if msg.Error != nil {
			return msg.Error
		}

		if result == nil || len(msg.Result) == 0 {
			return nil
		}

		return json.Unmarshal(msg.Result, result)
	case <-c.done:
		c.forget(id)

		return c.Err()
	case <-ctx.Done():
		c.forget(id)

		return fmt.Errorf("devtools: %s: %w", method, ctx.Err())
	}
}

func (c *cdpConn) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// Events is signalled when events are waiting; drain them with takeEvents.
func (c *cdpConn) Events() <-chan struct{} { return c.signal }

// takeEvents returns the queued events, oldest first, and empties the queue.
func (c *cdpConn) takeEvents() []cdpEvent {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := c.events
	c.events = nil

	return out
}

// Done is closed when the connection ends; Err then says why.
func (c *cdpConn) Done() <-chan struct{} { return c.done }

// Err is why the connection ended, or nil while it is open.
func (c *cdpConn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.err
}

// Close ends the connection.
func (c *cdpConn) Close() error {
	err := c.ws.Close()
	c.finish(errClosed)

	return err
}
