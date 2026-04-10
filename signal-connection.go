package server

import (
	"context"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"chatyy-signal/message"
)

// RateLimiter is a token bucket rate limiter per connection
type RateLimiter struct {
	tokens    float64
	maxTokens float64
	rate      float64 // tokens per second
	lastTime  time.Time
	mu        sync.Mutex
}

// NewRateLimiter creates a rate limiter: rate tokens/sec, burst max tokens
func NewRateLimiter(rate, burst float64) *RateLimiter {
	return &RateLimiter{
		tokens:    burst,
		maxTokens: burst,
		rate:      rate,
		lastTime:  time.Now(),
	}
}

// Allow checks if the action is within the rate limit (token bucket algorithm)
func (r *RateLimiter) Allow() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(r.lastTime).Seconds()
	r.lastTime = now

	r.tokens = min(r.maxTokens, r.tokens+elapsed*r.rate)

	if r.tokens < 1 {
		return false
	}
	r.tokens--
	return true
}

// ClientConn represents a connected client
type ClientConn struct {
	email         string
	token         string
	deviceID      string
	userID        int64
	conn          net.Conn
	encoder       *message.Encoder
	decoder       *message.Decoder
	msgChan       chan *message.Message
	closeChan     chan struct{}
	closeOnce     sync.Once
	subscriptions map[int64]bool
	subMutex      sync.RWMutex
	lastActivity  time.Time
	pingTimer     *time.Timer
	authenticated bool
	rateLimiter   *RateLimiter
}

// NewClientConn creates a new client connection wrapper
func NewClientConn(conn net.Conn) *ClientConn {
	// TCP_NODELAY: disable Nagle for low-latency messaging (WhatsApp/Telegram both do this)
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		tcpConn.SetNoDelay(true)
		tcpConn.SetKeepAlive(true)
		tcpConn.SetKeepAlivePeriod(30 * time.Second)
		tcpConn.SetReadBuffer(64 * 1024)
		tcpConn.SetWriteBuffer(64 * 1024)
	}

	return &ClientConn{
		conn:          conn,
		encoder:       message.NewEncoder(conn),
		decoder:       message.NewDecoder(conn),
		msgChan:       make(chan *message.Message, 256),
		closeChan:     make(chan struct{}),
		subscriptions: make(map[int64]bool),
		lastActivity:  time.Now(),
		rateLimiter:   NewRateLimiter(20, 50),
	}
}

// Send queues a message to be sent to the client (non-blocking, drops if full)
func (c *ClientConn) Send(msg *message.Message) error {
	select {
	case c.msgChan <- msg:
		return nil
	case <-c.closeChan:
		return fmt.Errorf("connection closed")
	default:
		log.Printf("[conn] Send buffer full for %s, dropping message type 0x%02X", c.email, msg.Type)
		return fmt.Errorf("send buffer full")
	}
}

func (c *ClientConn) Subscribe(conversationID int64) {
	c.subMutex.Lock()
	defer c.subMutex.Unlock()
	c.subscriptions[conversationID] = true
}

func (c *ClientConn) Unsubscribe(conversationID int64) {
	c.subMutex.Lock()
	defer c.subMutex.Unlock()
	delete(c.subscriptions, conversationID)
}

func (c *ClientConn) IsSubscribed(conversationID int64) bool {
	c.subMutex.RLock()
	defer c.subMutex.RUnlock()
	return c.subscriptions[conversationID]
}

func (c *ClientConn) GetSubscriptions() []int64 {
	c.subMutex.RLock()
	defer c.subMutex.RUnlock()
	result := make([]int64, 0, len(c.subscriptions))
	for convID := range c.subscriptions {
		result = append(result, convID)
	}
	return result
}

func (c *ClientConn) StartPingTimer() {
	if c.pingTimer != nil {
		c.pingTimer.Stop()
	}
	c.pingTimer = time.AfterFunc(25*time.Second, func() {
		c.Send(&message.Message{
			Type: message.TypePing,
			Payload: map[string]interface{}{
				"ts": time.Now().UnixMilli(),
			},
		})
		c.StartPingTimer()
	})
}

func (c *ClientConn) StopPingTimer() {
	if c.pingTimer != nil {
		c.pingTimer.Stop()
		c.pingTimer = nil
	}
}

// WriteLoop with BATCHED FLUSHING: drain all pending messages before flushing.
// Reduces syscalls and TCP packets. Same technique as WhatsApp/Telegram.
func (c *ClientConn) WriteLoop(ctx context.Context) {
	defer func() {
		c.StopPingTimer()
		c.conn.Close()
		c.closeOnce.Do(func() { close(c.closeChan) })
	}()

	for {
		select {
		case msg := <-c.msgChan:
			// Encode first message (buffered, no flush yet)
			if err := c.encoder.EncodeBatch(msg); err != nil {
				log.Printf("[write] Encode error for %s: %v", c.email, err)
				return
			}

			// Drain all remaining pending messages (non-blocking batch)
		drain:
			for {
				select {
				case nextMsg := <-c.msgChan:
					if err := c.encoder.EncodeBatch(nextMsg); err != nil {
						log.Printf("[write] Encode error for %s: %v", c.email, err)
						return
					}
				default:
					break drain
				}
			}

			// Single flush for all batched messages
			if err := c.encoder.Flush(); err != nil {
				log.Printf("[write] Flush error for %s: %v", c.email, err)
				return
			}

		case <-ctx.Done():
			return
		case <-c.closeChan:
			return
		}
	}
}

// ReadLoop handles incoming messages
func (c *ClientConn) ReadLoop(ctx context.Context, handler func(*ClientConn, *message.Message)) {
	defer c.closeOnce.Do(func() { close(c.closeChan) })

	readTimeout := 10 * time.Second
	authStartTime := time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if !c.authenticated && time.Since(authStartTime) > 10*time.Second {
			log.Printf("[read] AUTH timeout for %s", c.conn.RemoteAddr())
			c.Send(&message.Message{
				Type: message.TypeAuthFail,
				Payload: map[string]interface{}{
					"reason":  "timeout",
					"message": "AUTH required within 10 seconds",
				},
			})
			return
		}

		c.conn.SetReadDeadline(time.Now().Add(readTimeout))

		msg, err := c.decoder.Decode()
		if err != nil {
			if err.Error() != "connection closed" {
				log.Printf("[read] Decode error for %s: %v", c.email, err)
			}
			return
		}

		c.lastActivity = time.Now()

		if msg.Type == message.TypeAuth {
			readTimeout = 60 * time.Second
		}

		handler(c, msg)
	}
}

func (c *ClientConn) Close() error {
	c.StopPingTimer()
	return c.conn.Close()
}
