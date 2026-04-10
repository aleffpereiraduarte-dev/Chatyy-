#!/usr/bin/env python3
"""Patch clientWriter in main.go to use batched writes via NextWriter"""
import re

with open('/opt/chatyy-ws-go/main.go', 'r') as f:
    content = f.read()

old_writer = '''func (h *Hub) clientWriter(c *Client) {
	defer func() {
		if r := recover(); r != nil {
			buf := make([]byte, 4096)
			n := runtime.Stack(buf, false)
			log.Printf("[WS] PANIC in clientWriter for %s: %v\\n%s", c.id, r, buf[:n])
			h.disconnect(c.id)
		}
	}()

	ticker := time.NewTicker(PingPeriod)
	defer ticker.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			c.ws.SetWriteDeadline(time.Now().Add(WriteWait))
			if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					log.Printf("[WS] Writer: write error for %s: %v", c.id, err)
				}
				return
			}
		case <-ticker.C:
			c.ws.SetWriteDeadline(time.Now().Add(WriteWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}'''

new_writer = '''func (h *Hub) clientWriter(c *Client) {
	defer func() {
		if r := recover(); r != nil {
			buf := make([]byte, 4096)
			n := runtime.Stack(buf, false)
			log.Printf("[WS] PANIC in clientWriter for %s: %v\\n%s", c.id, r, buf[:n])
			h.disconnect(c.id)
		}
	}()

	ticker := time.NewTicker(PingPeriod)
	defer ticker.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			c.ws.SetWriteDeadline(time.Now().Add(WriteWait))
			// Use NextWriter for batching: write first message, then drain channel
			w, err := c.ws.NextWriter(websocket.TextMessage)
			if err != nil {
				if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					log.Printf("[WS] Writer: nextwriter error for %s: %v", c.id, err)
				}
				return
			}
			w.Write(msg)
			w.Close()

			// Drain all pending messages (batch: reduces TCP round-trips)
			n := len(c.send)
			for i := 0; i < n; i++ {
				nextMsg, ok := <-c.send
				if !ok {
					return
				}
				w2, err := c.ws.NextWriter(websocket.TextMessage)
				if err != nil {
					return
				}
				w2.Write(nextMsg)
				w2.Close()
			}
		case <-ticker.C:
			c.ws.SetWriteDeadline(time.Now().Add(WriteWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}'''

if old_writer in content:
    content = content.replace(old_writer, new_writer)
    with open('/opt/chatyy-ws-go/main.go', 'w') as f:
        f.write(content)
    print("SUCCESS: clientWriter patched with batched writes")
else:
    print("WARN: Could not find exact old_writer pattern")
