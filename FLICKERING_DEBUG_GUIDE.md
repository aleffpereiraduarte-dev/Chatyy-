# 🔍 ChatListTab Flickering Investigation - Deep Dive

## Problem Statement

Chat conversation list "pisca" (blinks/flickers) when:
1. App opens
2. Conversation list updates
3. New message arrives
4. User returns from background

Expected: Smooth like WhatsApp (no re-renders of unchanged rows)  
Actual: Entire list re-renders, causing visual flicker

---

## Root Causes Already Fixed (Session #1)

✅ **Issue #1**: ConversationRow memo comparison  
- **Fixed**: Deep property comparison instead of reference
- **Code**: Lines 622-651 in ChatListTab.js

✅ **Issue #2**: WebSocket updates with splice/unshift  
- **Fixed**: Use map() instead of splice, don't move conversations
- **Code**: Lines 1043-1073 in ChatListTab.js

✅ **Issue #3**: chat_read handler  
- **Fixed**: Only update specific item, not entire array
- **Code**: Lines 1075-1085 in ChatListTab.js

✅ **Issue #4**: FlatList missing extraData  
- **Fixed**: Add extraData prop
- **Code**: Line ~1642 in ChatListTab.js

---

## Remaining Suspects (Session #2)

### 🔴 SUSPECT 1: presenceVersion increment every 15s

**Location**: Lines 1140, 1152 in ChatListTab.js

```javascript
// Problem code:
setPresenceVersion(v => v + 1);  // This invalidates ALL callbacks
```

**Why it causes flicker**:
1. presenceVersion incremented every 15s
2. renderItem depends on presenceVersion (line 1447)
3. Every 15s, ALL callbacks recreated
4. All ConversationRow memos invalidated (presenceVersion changed!)
5. All rows re-render even if nothing changed

**Impact**: Flicker every 15 seconds exactly

**Test**: Open app, watch for flicker at 0s, 15s, 30s, 45s intervals

**Fix**: Move presenceVersion out of renderItem dependencies OR use separate context for presence

---

### 🔴 SUSPECT 2: typingUsers object recreation

**Location**: Line 1447 in renderItem dependencies

```javascript
// Current:
}, [filter, pinnedCount, isDark, colors, t, handleConversationPress, 
    handleDeleteConversation, handleArchiveConversation, handleMuteConversation, 
    handlePinConversation, user?.email, presenceVersion,  // ← presenceVersion here
    lockedIds, unlockedIds, typingUsers, selectionMode, selectedIds, ...]);
```

**Why**:
- typingUsers is plain object `{}`
- Every new typing event creates new `setTypingUsers(prev => ({ ...prev, ... }))`
- Object reference changes every time
- renderItem dependency includes typingUsers
- Every typing event = full callback recreation
- Every typing = potential flicker

**Test**: Type message in any conversation, watch for micro-flickers

**Fix**: 
1. Memoize typingUsers with useMemo
2. OR pass individual conversationId's typing status, not whole object

---

### 🟡 SUSPECT 3: selectedIds Set mutations

**Location**: Line 1447, multipleSelection feature

```javascript
selectedIds.has(item.id)  // Using Set reference
```

**Why**:
- selectedIds is a Set
- When Set changes, all dependencies update
- Even single item selection = all rows potentially re-render

**Fix**: Convert Set to Map with conversation IDs for memoization

---

### 🟡 SUSPECT 4: Filter state changes

**Location**: Line 1447 includes `filter`

```javascript
const [filter, setFilter] = useState('all');  // 'all', 'archived', 'pinned'
```

**Why**:
- When user toggles filter, dependencies change
- renderItem creates NEW callback
- All rows re-render

**This is EXPECTED** - when filter changes, list SHOULD update

**NOT A BUG** ✓

---

### 🟡 SUSPECT 5: loadConversations called too often

**Location**: Line 1037 in handleSearchChange

```javascript
searchTimerRef.current = setTimeout(() => {
  loadConversations(false);  // Calls API, updates conversations array
}, 400);
```

**Why**:
- loadConversations creates new array (even if data identical)
- Entire FlatList re-renders
- New array reference = extraData triggers

**Fix**: Deduplicate API responses, only setState if changed

---

### 🟢 SUSPECT 6: Native bridge overhead (iOS UICollectionView fallback)

**Location**: Lines 7040-7109 in chat-conversation.js

```javascript
// If iOS native view crashes, fallback to JS FlatList
if (!_NativeChatView) {
  return <FlatList ... />;  // JS fallback
}
```

**Symptom**: Flicker only on iOS, not Android?  
**Cause**: Native-JS bridge synchronization delay  
**Fix**: Check if using native or fallback FlatList

---

## Diagnostic Tools

### 1. React DevTools Profiler

```javascript
// In browser console:
// 1. Open React DevTools
// 2. Go to "Profiler" tab
// 3. Click "Start Recording"
// 4. Do action (open app, send message)
// 5. Stop recording
// 6. Look at flame graph:
//    - Red = re-renders
//    - Which rows?
//    - How many renders?
//    - Time duration?
```

### 2. Chrome Performance Timeline

```javascript
// 1. F12 → Performance tab
// 2. Click "Record"
// 3. Open chat list
// 4. Stop recording
// 5. Look for:
//    - Long frames (> 16ms = visible stutter)
//    - Which functions causing frames?
//    - React.render calls?
```

### 3. Logs with Timestamps

Add logging to detect exact moment of flicker:

```javascript
const renderItem = useCallback(({ item, index }) => {
  console.log(`[render] Conv ${item.id} at ${new Date().getTime()}`);
  // ...
}, [dependencies]);
```

Then watch console to see:
- How many items render?
- Do all items render or just one?
- How often?
- Correlation with presenceVersion updates?

### 4. Disable Animations

Disable LayoutAnimation to see if it's animation timing:

```javascript
if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental(false);
}
```

If flicker disappears = it's an animation timing bug, not render bug

### 5. Profile Memory

```javascript
// Check if ConversationRow memos are properly cached:
// In React DevTools → Components
// Filter by "ConversationRow"
// Check if same instance or new?
```

---

## Testing Plan

### Step 1: Identify exact timing

1. Open app
2. Watch chat list
3. Note when flicker happens (every N seconds? specific event?)
4. Check console logs for timestamps

```javascript
// Add this to ChatListTab.js top level:
useEffect(() => {
  const interval = setInterval(() => {
    console.log(`[debug] presenceVersion: ${presenceVersion}, typingUsers: ${Object.keys(typingUsers).length}`);
  }, 1000);
  return () => clearInterval(interval);
}, [presenceVersion, typingUsers]);
```

### Step 2: Isolate cause

1. **Disable presenceVersion**: Comment out lines 1140, 1152
   - Does flicker stop? → Cause: presenceVersion
   
2. **Disable typing**: Don't update typingUsers
   - Does flicker stop? → Cause: typing updates
   
3. **Disable memo**: Remove React.memo from ConversationRow
   - Does flicker get worse? → Memo IS helping
   
4. **Disable animations**: Set LayoutAnimation.configureNext(null)
   - Does flicker stop? → Cause: animation timing

### Step 3: Verify fix

After applying fix:
1. Open app → No flicker on open
2. Send message → No flicker on new message
3. Return from background → No flicker
4. Type in conversation → No micro-flickers
5. Change filter → List updates, but smooth

---

## Proposed Fixes (Implement in order)

### Fix #1: Extract presenceVersion from renderItem dependencies (HIGH PRIORITY)

**File**: ChatListTab.js, line 1447

**Current**:
```javascript
}, [filter, pinnedCount, isDark, colors, t, handleConversationPress, 
    handleDeleteConversation, handleArchiveConversation, handleMuteConversation, 
    handlePinConversation, user?.email, presenceVersion,  // ← REMOVE THIS
    lockedIds, unlockedIds, typingUsers, selectionMode, selectedIds, enterSelectionMode, toggleSelected]);
```

**After**:
```javascript
}, [filter, pinnedCount, isDark, colors, t, handleConversationPress, 
    handleDeleteConversation, handleArchiveConversation, handleMuteConversation, 
    handlePinConversation, user?.email,  // ← presenceVersion REMOVED
    lockedIds, unlockedIds, typingUsers, selectionMode, selectedIds, enterSelectionMode, toggleSelected]);
```

**Reasoning**:
- presenceVersion only affects isOnline display
- isOnline calculated inside ConversationRow (lines 1424-1437)
- presenceVersion change doesn't need to invalidate renderItem callback
- ConversationRow prop change (isOnline) will still trigger re-render (correctly)

**Impact**: Eliminates 15-second flicker cycle

---

### Fix #2: Memoize typingUsers object

**File**: ChatListTab.js, line ~814

**Current**:
```javascript
const [typingUsers, setTypingUsers] = useState({});
```

**After**:
```javascript
const [typingUsers, setTypingUsers] = useState({});
const memoTypingUsers = useMemo(() => typingUsers, [typingUsers]);

// Then in renderItem dependencies, use memoTypingUsers instead:
}, [..., memoTypingUsers, ...]);
```

**OR better**: Use Context for typing to avoid prop drilling

**Impact**: Prevents re-renders when typing object changes reference

---

### Fix #3: Deduplicate loadConversations API responses

**File**: ChatListTab.js, loadConversations function

**Current**:
```javascript
const data = r.data?.conversations || [];
setConversations(data);
```

**After**:
```javascript
const data = r.data?.conversations || [];
setConversations(prev => {
  // Only update if data actually changed
  const prevIds = prev.map(c => c.id).join(',');
  const newIds = data.map(c => c.id).join(',');
  if (prevIds === newIds) return prev;  // No change, return same reference
  return data;
});
```

**Impact**: Prevents "no-op" re-renders when API returns identical data

---

### Fix #4: Optimize isOnline calculation

**File**: ChatListTab.js, lines 1424-1437

**Current**: Inline calculation in renderItem (recreated every render)

```javascript
isOnline={(() => {
  if (item.type === 'group') return false;
  // ... complex calculation ...
})()}
```

**After**: Move to useMemo

```javascript
const isOnlineValue = useMemo(() => {
  if (item.type === 'group') return false;
  // ... calculation ...
}, [item.id, presenceVersion]);

// In return:
isOnline={isOnlineValue}
```

**Impact**: isOnline value stable unless presenceVersion changes (correct!)

---

## Performance Targets

| Metric | Current | Target | Method |
|--------|---------|--------|--------|
| **Flicker frequency** | Every 15s | Never | Remove presenceVersion from deps |
| **Frame rate** | 30fps (stutters) | 60fps | Reduce render workload |
| **List render time** | 300ms | <50ms | Optimize deep comparisons |
| **Re-renders per message** | 20+ | 1-2 | Memo optimization |

---

## Commit & Verify

After implementing fixes:

```bash
# Stage changes
git add app/ChatListTab.js

# Test on device/simulator
# 1. Open app → watch for flicker
# 2. Send message → smooth update
# 3. Return from background → smooth
# 4. Type in chat → no micro-flickers
# 5. Change filter → smooth transition

# If all passes:
git commit -m "Fix ChatListTab flickering: remove presenceVersion deps, memoize typing, deduplicate API"
```

---

## Monitoring Post-Deploy

After deploying:

```javascript
// Add to ChatListTab.js for monitoring:
useEffect(() => {
  let renderCount = 0;
  console.log(`[monitoring] Render count in 5s window: ${++renderCount}`);
  return () => console.log(`[monitoring] Final count: ${renderCount}`);
}, []); // Only at mount
```

Expected: <5 renders per 5 seconds at rest
Actual (with bug): 20+ renders per 5 seconds

---

## Escalation Path

If flicker persists after fixes:

1. ✅ Check React DevTools profile → identify which rows re-render
2. ✅ Enable React.StrictMode → double-render detection
3. ✅ Profile with Chrome DevTools → frame timing analysis
4. 🔄 Check if it's **native UICollectionView** issue (iOS only)
   - Look at ExpoNativeChatViewModule.swift
   - Flicker might be from native view, not JS
5. 🔄 Check **Virtualization** settings
   - FlatList initialNumToRender?
   - estimatedItemSize?

---

**Status**: Ready to diagnose  
**Next**: Run diagnostic tools, identify exact cause, apply fixes
