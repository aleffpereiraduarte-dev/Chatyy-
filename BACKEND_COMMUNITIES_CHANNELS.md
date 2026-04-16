# Backend Changes — Communities + Channels

Target: `/var/www/mail/api/chat.php` on production server `69.62.103.131`.
All changes are additive (new tables + new `case` blocks). No existing tables altered.

---

## 1. Communities SQL

### `chat_communities`
Top-level container that groups multiple chat conversations under one brand.

```sql
CREATE TABLE IF NOT EXISTS chat_communities (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT        DEFAULT '',
  avatar_url  TEXT        DEFAULT '',
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_communities_created_by
  ON chat_communities (created_by);
```

### `chat_community_groups`
Maps communities to their member group conversations (many-to-many).

```sql
CREATE TABLE IF NOT EXISTS chat_community_groups (
  id              SERIAL PRIMARY KEY,
  community_id    INTEGER NOT NULL REFERENCES chat_communities(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_ccg_community_id
  ON chat_community_groups (community_id);
CREATE INDEX IF NOT EXISTS idx_ccg_conversation_id
  ON chat_community_groups (conversation_id);
```

### `chat_community_members`
Tracks who belongs to which community, with role (admin / member).

```sql
CREATE TABLE IF NOT EXISTS chat_community_members (
  id           SERIAL PRIMARY KEY,
  community_id INTEGER NOT NULL REFERENCES chat_communities(id) ON DELETE CASCADE,
  email        TEXT    NOT NULL,
  role         TEXT    NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, email)
);

CREATE INDEX IF NOT EXISTS idx_ccm_community_id
  ON chat_community_members (community_id);
CREATE INDEX IF NOT EXISTS idx_ccm_email
  ON chat_community_members (email);
```

> **Note**: The community creator is inserted as `role = 'admin'` by `community_create`. All tables above are already auto-created in `chat.php`'s `migrateSchema()` call (lines 491-492), so a cold server will provision them on first request.

---

## 2. Channels SQL

Channels reuse the existing `chat_conversations` table with `type = 'channel'`.
No new tables are required. The relevant extra tables that already exist:

```sql
-- Already present in chat.php migrateSchema():
-- channel_posts (id, channel_id, author_email, content, type, file_url, created_at, view_count, is_pinned)
-- channel_post_reactions (id, post_id, user_email, emoji, created_at)
-- channel_post_comments (id, post_id, author_email, content, parent_comment_id, created_at)
```

### New action: `channel_delete_post`

Add this case to the `chat.php` action switch. Only the channel admin may delete.

```php
case 'channel_delete_post': {
    requireAuth();
    $postId = (int)($input['post_id'] ?? 0);
    if (!$postId) jsonResponse(false, null, 'post_id required', 400);

    // Fetch post + verify admin
    $stmt = $db->prepare(
        "SELECT cp.channel_id, c.created_by
         FROM channel_posts cp
         JOIN chat_conversations c ON c.id = cp.channel_id
         WHERE cp.id = :pid"
    );
    $stmt->execute([':pid' => $postId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) jsonResponse(false, null, 'Post not found', 404);

    // Allow post author OR channel creator to delete
    $isAdmin = strtolower($row['created_by']) === strtolower($user['email']);
    if (!$isAdmin) {
        // Also allow if user is a conversation admin (conversation_members.role = 'admin')
        $adminChk = $db->prepare(
            "SELECT 1 FROM conversation_members
             WHERE conversation_id = :cid AND email = :email AND role = 'admin'"
        );
        $adminChk->execute([':cid' => $row['channel_id'], ':email' => $user['email']]);
        $isAdmin = (bool)$adminChk->fetchColumn();
    }
    if (!$isAdmin) jsonResponse(false, null, 'Only channel admins can delete posts', 403);

    $db->prepare("DELETE FROM channel_post_reactions WHERE post_id = :pid")->execute([':pid' => $postId]);
    $db->prepare("DELETE FROM channel_post_comments WHERE post_id = :pid")->execute([':pid' => $postId]);
    $db->prepare("DELETE FROM channel_posts WHERE id = :pid")->execute([':pid' => $postId]);
    jsonResponse(true, null, 'Post deleted');
}
```

---

## 3. Community backend actions (already implemented)

The following actions are live in `chat.php` (lines 14074–14320 approx.):

| Action | Description |
|---|---|
| `community_create` | Create community, creator becomes admin |
| `community_list` | List communities the user belongs to (with group/member counts) |
| `community_info` | Full detail: description, groups list, member role |
| `community_add_group` | Admin-only: link a conversation to the community |
| `community_remove_group` | Admin-only: unlink a conversation |
| `community_members` | List members with roles |
| `community_announcement` | Admin: post a message to ALL linked group conversations |
| `community_join` | Join a community (inserts member row) |
| `community_leave` | Leave (with admin succession logic) |

---

## 4. Channel backend actions (already implemented)

| Action | Description |
|---|---|
| `chat_create_channel` | Creates `chat_conversations` row with `type='channel'` |
| `chat_discover_channels` | Browse/search public channels with optional category filter |
| `chat_join_channel` | Follow a channel (inserts `conversation_members` row) |
| `chat_leave_channel` | Unfollow |
| `chat_channel_info` | Returns channel metadata + `is_member`, `is_admin`, `subscriber_count` |
| `channel_feed` | Paginated posts with reactions + `my_reaction` per post |
| `channel_post` | Admin-only: publish a new text/image/video post |
| `channel_react` | Toggle an emoji reaction on a post |
| `channel_post_comment_add` | Add a comment to a post |
| `channel_post_comments` | Fetch comments for a post |
| `channel_delete_post` | **New** (see section 2 above) — admin deletes a post |
| `channel_my_channels` | Returns channels the user follows + latest post preview |

---

## 5. API functions (frontend — `services/api.js`)

All community and channel calls are in `services/api.js`:

```js
// Communities
communityCreate(name, description, icon)
communityList()
communityInfo(communityId)
communityAddGroup(communityId, conversationId)
communityRemoveGroup(communityId, conversationId)
communityMembers(communityId)
communityAnnouncement(communityId, content)
communityJoin(communityId)
communityLeave(communityId)

// Channels
channelCreate(name, description, category, isPublic)
channelMyChannels()
channelDiscover(category, search, limit, offset)
channelFollow(channelId)
channelUnfollow(channelId)
channelFeed(channelId, limit, offset)
channelPost(channelId, content, type, fileUrl)
channelReact(postId, emoji)
channelDeletePost(postId)   // newly added
channelInfo(channelId)
channelPostCommentAdd(opts)
channelPostComments(postId)
```
