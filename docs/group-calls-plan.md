# Group Calls Plan

## Current State

- 1:1 calls work via WebRTC peer-to-peer (mesh with 2 peers)
- The `meet/` system already supports group video via rooms (WebRTC + signaling server at port 8443)
- Call signaling goes through the existing WebSocket server (`/opt/onemundo-mail-ws/server.js`)
- Group chat infrastructure exists with `conversation_members` table

## Architecture Decision: SFU vs Mesh

### Mesh (peer-to-peer)
- Each participant connects directly to every other participant
- N participants = N*(N-1)/2 connections
- Works well for 2-4 people
- No server infrastructure needed
- Degrades rapidly: at 4 people = 6 connections per device, at 8 people = 28 connections
- Not viable beyond ~4 participants

### SFU (Selective Forwarding Unit) - RECOMMENDED
- All participants send their stream to a central server
- Server forwards streams selectively to each participant
- N participants = N connections (one per participant)
- Scales to 32+ participants
- Requires server-side media routing

### Recommendation
Use a **hybrid approach**:
- 2-4 participants: mesh (no extra server load, already works)
- 5-32 participants: SFU via mediasoup or Livekit

## SFU Options

| Option | License | Language | Pros | Cons |
|--------|---------|----------|------|------|
| **mediasoup** | ISC (free) | Node.js + C++ | Battle-tested, Discord uses it, great docs | Must self-host, C++ worker needs compilation |
| **Livekit** | Apache 2.0 | Go | All-in-one (SFU + TURN + recording), great SDK | Heavier, needs dedicated server |
| **Janus** | GPL-3 | C | Very mature, plugin system | Complex config, C dependencies |
| **ion-sfu** | MIT | Go | Lightweight, pure Go | Smaller community, fewer features |

### Recommended: mediasoup
- Already using Node.js for the WS server, so the tech stack aligns
- Can run on the existing US Central server (69.62.103.131)
- Has official `mediasoup-client` npm package for the frontend
- Proven at scale (Discord, Edumeet, Whereby)

## Implementation Plan

### Phase 1: Infrastructure (1-2 days)
1. Install mediasoup on production server:
   ```bash
   cd /opt && mkdir mediasoup-sfu && cd mediasoup-sfu
   npm init -y && npm install mediasoup
   ```
2. Create SFU server (`/opt/mediasoup-sfu/server.js`):
   - Listen on port 8444 (separate from existing WS signaling on 8443)
   - Manage Router (one per room), Producer (one per participant track), Consumer (one per viewer of each track)
   - Expose REST/WS API for room creation, joining, producing, consuming
3. Nginx reverse proxy: `location /sfu/ { proxy_pass http://127.0.0.1:8444; }`
4. systemd service: `mediasoup-sfu.service`

### Phase 2: Backend API (1 day)
Add to `chat.php`:
- `group_call_create` - Creates a group call room, returns room ID
- `group_call_invite` - Sends push/WS notification to selected members
- `group_call_join` - Returns SFU transport parameters
- `group_call_leave` - Notifies others, updates participant count
- `group_call_end` - Host ends call for everyone

New table: `group_calls`
```sql
CREATE TABLE group_calls (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    creator_email TEXT NOT NULL,
    video INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    max_participants INTEGER DEFAULT 32,
    created_at TEXT DEFAULT (iso_now()),
    ended_at TEXT DEFAULT NULL
);
CREATE TABLE group_call_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_call_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    joined_at TEXT DEFAULT (iso_now()),
    left_at TEXT DEFAULT NULL,
    UNIQUE(group_call_id, user_email)
);
```

### Phase 3: Frontend (2-3 days)
1. Install `mediasoup-client`:
   ```bash
   npm install mediasoup-client
   ```
2. Create `services/sfuClient.js`:
   - Connect to SFU server
   - Create send/receive transports
   - Produce local audio/video
   - Consume remote participants' tracks
3. Modify `app/call.js`:
   - Detect group call (>2 participants) and switch to SFU mode
   - Grid layout for multiple video feeds (2x2 for 4, 3x3 for 9, scrollable beyond)
   - Active speaker detection (highlight loudest participant)
   - Participant list overlay showing who's in the call
4. Modify `components/IncomingCallListener.js`:
   - Handle group call invitations
   - Show "Group Call from [Group Name]" with participant avatars
5. Modify `chat-conversation.js`:
   - "Start Group Call" button in group chat header
   - Show "Ongoing call" banner when a group call is active

### Phase 4: Polish (1-2 days)
- Dominant speaker highlight (border glow on active speaker)
- Pin participant video (tap to enlarge)
- Mute individual participants (admin only)
- Bandwidth adaptation: reduce video quality as participant count grows
  - 2-4 people: 720p
  - 5-8 people: 480p
  - 9-16 people: 360p
  - 17-32 people: 240p or audio-only for non-speakers
- "Raise hand" button
- End-to-end encryption via insertable streams (Chrome 86+)

## Network Topology

```
                    mediasoup SFU
                   (69.62.103.131:8444)
                  /    |    |    \
                 /     |    |     \
           User A  User B  User C  User D
           (send)  (send)  (send)  (send)
           (recv)  (recv)  (recv)  (recv)
```

Each user sends 1 audio + 1 video stream to the SFU.
The SFU forwards N-1 audio + N-1 video streams to each user.
With simulcast, the SFU can pick the right quality per consumer.

## Estimated Timeline
- Total: 5-8 days of development
- Can reuse 60%+ of existing call.js WebRTC code
- meet/ room.html already proves the WebRTC infrastructure works for groups

## Risks
- mediasoup C++ worker compilation on production server (mitigated: prebuilt binaries available)
- TURN server load with many participants (mitigated: existing TURN setup, add bandwidth limits)
- Mobile battery drain with many video streams (mitigated: adaptive quality + audio-only fallback)
