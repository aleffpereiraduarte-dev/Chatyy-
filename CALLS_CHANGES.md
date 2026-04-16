# Screen Share: server.js Signaling Changes

This document describes the WebSocket signaling changes needed in
`/opt/onemundo-mail-ws/server.js` to properly propagate screen-share
state to remote peers.

## Why changes are needed

The current React Native layer (`app/meet/[id].js`) now calls
`navigator.mediaDevices.getDisplayMedia()` directly in the top-level
browser context and then injects the captured track into the iframe's
WebRTC peer connections. The iframe (`room.html`) already posts
`screen_share_started` / `screen_share_stopped` messages back to the
parent and calls `notifyHost()` to broadcast them over the WebSocket.

However, `server.js` currently treats these purely as pass-through data
messages. To give remote participants a first-class signal (so their UIs
can show a "Peer X is sharing their screen" badge), the server should
understand the message type and broadcast a typed event.

---

## Required changes

### 1. Add `screen_share_started` / `screen_share_stopped` to the relay logic

Currently `server.js` relays arbitrary `data` messages:

```js
// Existing (pseudocode)
case 'data':
  broadcastToRoom(roomId, { type: 'data', from: peerId, payload: msg.payload });
  break;
```

Add explicit handling so the message type is preserved and carried to
all peers in the room:

```js
case 'screen_share_started':
  broadcastToRoom(roomId, {
    type: 'screen_share_started',
    peerId: peerId,
    displayName: peer.displayName,
  }, /* excludeSelf= */ false);
  break;

case 'screen_share_stopped':
  broadcastToRoom(roomId, {
    type: 'screen_share_stopped',
    peerId: peerId,
    displayName: peer.displayName,
  }, /* excludeSelf= */ false);
  break;
```

### 2. Track per-peer screen-share state in the room presence map

Add a `screenSharing` boolean to the in-memory peer record so that
late joiners (lobby admits, reconnects) receive the current state:

```js
// When a peer joins, include screenSharing in the presence snapshot
// sent to all existing members.
peers[peerId] = {
  ...peers[peerId],
  screenSharing: false,
};

// On screen_share_started:
peers[peerId].screenSharing = true;

// On screen_share_stopped (and on disconnect):
peers[peerId].screenSharing = false;
```

When broadcasting `peer_joined` to existing room members, include the
new peer's `screenSharing` flag. When a new peer receives the current
participant list on join, each entry should include `screenSharing`.

### 3. Cleanup on disconnect

`server.js` already fires a `peer_left` event on WebSocket close. Ensure
the disconnect handler also broadcasts `screen_share_stopped` if the
disconnecting peer was actively sharing:

```js
ws.on('close', () => {
  const peer = peers[peerId];
  if (peer && peer.screenSharing) {
    broadcastToRoom(roomId, {
      type: 'screen_share_stopped',
      peerId: peerId,
      displayName: peer.displayName,
    });
  }
  // ... existing peer_left broadcast
});
```

### 4. `mute_update` extension (optional but recommended)

The existing `mute_update` message carries `{ audio, video }` per peer.
Extend it to carry `{ audio, video, screen }` so a single message can
convey the full A/V state. Receivers (both `room.html` and the React
Native `handleMessage` handler) should update the participant's
`screenSharing` flag from this field.

---

## Client-side (room.html) changes needed

The injected JS in `[id].js` calls `window.meetController.stopScreenShare()`
to revert the sender track to the camera. `room.html`'s `stopScreenShare`
implementation (lines ~1091-1121) restores the camera track and calls
`notifyHost({ type: 'screen_share_stopped' })`. No changes needed there —
the existing path already posts `screen_share_stopped` to the parent
which triggers `_stopScreenShareWeb()` cleanup.

---

## Summary of files to change

| File | Change |
|------|--------|
| `/opt/onemundo-mail-ws/server.js` | Handle `screen_share_started`/`stopped` explicitly, track per-peer state, broadcast on disconnect |
| `/var/www/mail/meet/room.html` | No changes required — existing `notifyHost` path is reused |
| `app/meet/[id].js` | **Done** — `handleMessage` already handles both events |
