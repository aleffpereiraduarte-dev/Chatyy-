package message

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// Message types (0x00-0xFF)
const (
	// Auth
	TypeAuth     byte = 0x01
	TypeAuthOk   byte = 0x02
	TypeAuthFail byte = 0x03

	// Keepalive
	TypePing byte = 0x10
	TypePong byte = 0x11

	// Chat messages
	TypeChatSend            byte = 0x20
	TypeChatMessage         byte = 0x21
	TypeChatAck             byte = 0x22
	TypeChatRead            byte = 0x23
	TypeChatReadBroadcast   byte = 0x24
	TypeChatReact           byte = 0x25
	TypeChatReactBroadcast  byte = 0x26
	TypeChatDelete          byte = 0x27
	TypeChatDeleteBroadcast byte = 0x28
	TypeChatEdit            byte = 0x29
	TypeChatEditBroadcast   byte = 0x2A
	TypeChatDelivered       byte = 0x2B

	// Subscriptions
	TypeSubscribe    byte = 0x30
	TypeUnsubscribe  byte = 0x31
	TypeSubscribeAck byte = 0x32

	// Presence & Typing
	TypeStartedTyping    byte = 0x40
	TypeStoppedTyping    byte = 0x41
	TypeUserTyping       byte = 0x42
	TypeUserOnline       byte = 0x43
	TypeUserOffline      byte = 0x44
	TypeStartedRecording byte = 0x45
	TypeStoppedRecording byte = 0x46
	TypeUserRecording    byte = 0x47

	// Errors & Control
	TypeError      byte = 0xF0
	TypeDisconnect byte = 0xF1
)

const (
	MaxPayloadSize = (1 << 16) - 1 // 65535 bytes
)

type Message struct {
	Type    byte
	Payload map[string]interface{}
}

// Encoder writes messages to a connection in binary format
type Encoder struct {
	w *bufio.Writer
}

func NewEncoder(conn io.Writer) *Encoder {
	return &Encoder{
		w: bufio.NewWriterSize(conn, 32*1024), // 32KB write buffer (was default ~4KB)
	}
}

// Encode writes a message and flushes immediately (legacy single-message path)
func (e *Encoder) Encode(msg *Message) error {
	if err := e.EncodeBatch(msg); err != nil {
		return err
	}
	return e.Flush()
}

// EncodeBatch writes a message to the buffer WITHOUT flushing.
// Call Flush() after encoding all messages in the batch.
// This reduces TCP packets: N messages = 1 syscall instead of N syscalls.
func (e *Encoder) EncodeBatch(msg *Message) error {
	payload, err := json.Marshal(msg.Payload)
	if err != nil {
		return fmt.Errorf("json marshal failed: %w", err)
	}

	if len(payload) > MaxPayloadSize {
		return fmt.Errorf("payload too large: %d > %d", len(payload), MaxPayloadSize)
	}

	if err := e.w.WriteByte(msg.Type); err != nil {
		return fmt.Errorf("write type failed: %w", err)
	}

	lenBuf := make([]byte, 2)
	binary.BigEndian.PutUint16(lenBuf, uint16(len(payload)))
	if _, err := e.w.Write(lenBuf); err != nil {
		return fmt.Errorf("write length failed: %w", err)
	}

	if _, err := e.w.Write(payload); err != nil {
		return fmt.Errorf("write payload failed: %w", err)
	}

	return nil
}

// Flush flushes the buffered writer to the underlying connection
func (e *Encoder) Flush() error {
	return e.w.Flush()
}

// Decoder reads messages from a connection in binary format
type Decoder struct {
	r *bufio.Reader
}

func NewDecoder(conn io.Reader) *Decoder {
	return &Decoder{
		r: bufio.NewReaderSize(conn, 32*1024), // 32KB read buffer
	}
}

// Decode reads one message from the connection
func (d *Decoder) Decode() (*Message, error) {
	msgType, err := d.r.ReadByte()
	if err != nil {
		if err == io.EOF {
			return nil, fmt.Errorf("connection closed")
		}
		return nil, fmt.Errorf("read type failed: %w", err)
	}

	lenBuf := make([]byte, 2)
	if _, err := io.ReadFull(d.r, lenBuf); err != nil {
		return nil, fmt.Errorf("read length failed: %w", err)
	}
	length := binary.BigEndian.Uint16(lenBuf)

	if length > MaxPayloadSize {
		return nil, fmt.Errorf("payload too large: %d > %d", length, MaxPayloadSize)
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(d.r, payload); err != nil {
		return nil, fmt.Errorf("read payload failed: %w", err)
	}

	var data map[string]interface{}
	if err := json.Unmarshal(payload, &data); err != nil {
		return nil, fmt.Errorf("json unmarshal failed: %w", err)
	}

	return &Message{
		Type:    msgType,
		Payload: data,
	}, nil
}
