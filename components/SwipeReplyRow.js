// [2026-10-07 native-polish] Web: swipe-to-reply stays on the PanResponder
// path inside app/chat-conversation.js (SwipeReplyWrap). The UI-thread
// version lives in SwipeReplyRow.native.js.
export const SWIPE_REPLY_UI_THREAD = false;
export default function SwipeReplyRow() { return null; }
