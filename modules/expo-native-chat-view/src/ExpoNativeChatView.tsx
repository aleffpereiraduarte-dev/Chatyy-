import { requireNativeView } from 'expo';
import * as React from 'react';
import { ViewProps, NativeSyntheticEvent } from 'react-native';

export type ChatMessageTapEvent = {
  messageId: number;
  messageType?: string;
};

export type ChatScrollEvent = {
  contentOffset: number;
  atTop: boolean;
  atBottom: boolean;
};

export interface NativeChatViewProps extends ViewProps {
  /** Conversation id — used as fallback to read from native SQLite cache */
  conversationId: number;
  /** Current user's email — used to detect "own" messages for bubble alignment */
  myEmail: string;
  /** Messages array from JS — PRIMARY data source. Bypasses SQLite cache. */
  messages?: Record<string, any>[];
  /** True for group chats — enables sender name above each non-own bubble */
  isGroupChat?: boolean;
  /** Array of message ids that are currently selected (multi-select mode) */
  selectedIds?: number[];
  /** Bubble color for own messages (hex string e.g. "#EDE9FE") */
  ownBubbleColor?: string;
  /** Bubble color for other messages */
  otherBubbleColor?: string;
  /** Background color of the list */
  backgroundColor?: string;
  /** Text color */
  textColor?: string;
  /** Tap on a message bubble */
  onMessageTap?: (event: NativeSyntheticEvent<ChatMessageTapEvent>) => void;
  /** Long-press on a message bubble */
  onMessageLongPress?: (event: NativeSyntheticEvent<ChatMessageTapEvent>) => void;
  /** User scrolled to top — fetch older messages */
  onReachTop?: () => void;
  /** User scrolled — useful for floating "scroll to bottom" button */
  onScroll?: (event: NativeSyntheticEvent<ChatScrollEvent>) => void;
  /** User pull-to-refreshed. Call endRefreshing() when JS finishes its fetch. */
  onRefresh?: () => void;
  /** Swipe-to-reply gesture released past the threshold */
  onSwipeReply?: (event: NativeSyntheticEvent<{ messageId: number; messageType?: string }>) => void;
  /** Native UIContextMenu action selected (reply/forward/copy/star/info/delete/react) */
  onContextAction?: (event: NativeSyntheticEvent<{ action: string; messageId: number; emoji?: string }>) => void;
  /** User voted on a poll — emitted by PollCell */
  onPollVote?: (event: NativeSyntheticEvent<{ messageId: number; optionIndex: number }>) => void;
  /** User RSVPed to a meetup — emitted by MeetupCell */
  onMeetupRsvp?: (event: NativeSyntheticEvent<{ messageId: number; status: 'going' | 'maybe' | 'not_going' | 'none' }>) => void;
  /** User tapped a location map — emitted by LocationCell */
  onLocationTap?: (event: NativeSyntheticEvent<{ messageId: number; latitude: number; longitude: number; label: string }>) => void;
  /** Native view finished loading rows from cache (debug + sync hook) */
  onLoaded?: (event: NativeSyntheticEvent<{ count: number; sample?: any[] }>) => void;
}

const NativeView: React.ComponentType<NativeChatViewProps> =
  requireNativeView('ExpoNativeChatView');

export default NativeView;
