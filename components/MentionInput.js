import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Platform } from 'react-native';
import AvatarCircle from './AvatarCircle';

/**
 * MentionAutocomplete - Shows a dropdown list of group members when typing "@"
 *
 * Props:
 *   inputText: string - current text in the input
 *   members: array - group members [{email, role, ...}]
 *   currentEmail: string - current user's email
 *   visible: boolean - whether the popup should be shown
 *   onSelect: (member) => void - callback when a member is selected
 *   colors: object - theme colors
 *   t: function - i18n translation function
 */
export function MentionAutocomplete({ inputText, members, currentEmail, visible, onSelect, colors, t }) {
  if (!visible || !members || members.length === 0) return null;

  // Find the current @query from the input text
  const mentionMatch = inputText.match(/@([\w.\-]*)$/);
  if (!mentionMatch) return null;

  const query = mentionMatch[1].toLowerCase();

  // Filter members based on query (exclude self)
  const filtered = members.filter(m => {
    if (m.email === currentEmail) return false;
    const name = m.email.split('@')[0].toLowerCase();
    const email = m.email.toLowerCase();
    return name.includes(query) || email.includes(query);
  });

  if (filtered.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <FlatList
        data={filtered.slice(0, 5)}
        keyExtractor={(item) => item.email}
        keyboardShouldPersistTaps="always"
        renderItem={({ item }) => {
          const displayName = item.email.split('@')[0];
          return (
            <TouchableOpacity
              style={[styles.item, { borderBottomColor: colors.border }]}
              onPress={() => onSelect(item)}
              activeOpacity={0.7}
            >
              <AvatarCircle name={displayName} email={item.email} size={32} />
              <View style={styles.itemText}>
                <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
                <Text style={[styles.email, { color: colors.textTertiary }]} numberOfLines={1}>{item.email}</Text>
              </View>
              {item.role === 'admin' && (
                <View style={styles.adminBadge}>
                  <Text style={styles.adminText}>Admin</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

/**
 * Parse @mention query state from input text.
 * Returns true if the cursor is currently in a @mention context.
 */
export function isMentioning(text) {
  if (!text) return false;
  // Check if the last word starts with @ and isn't a complete email mention
  return /@[\w.\-]*$/.test(text);
}

/**
 * Replace the current @query with the selected member's name.
 * Returns { newText, mentionedEmail }
 */
export function insertMention(text, memberEmail) {
  const name = memberEmail.split('@')[0];
  // Replace the @query at the end with @Name
  const newText = text.replace(/@[\w.\-]*$/, `@${name} `);
  return { newText, mentionedEmail: memberEmail };
}

/**
 * Check if current user is mentioned in a message.
 */
export function isUserMentioned(message, currentEmail) {
  if (!message || !currentEmail) return false;
  // Check mentions array from server
  if (Array.isArray(message.mentions) && message.mentions.includes(currentEmail)) return true;
  // Fallback: check content for @username or @email
  if (message.content) {
    const username = currentEmail.split('@')[0];
    const mentionRegex = new RegExp(`@(${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${currentEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i');
    return mentionRegex.test(message.content);
  }
  return false;
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    maxHeight: 200,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.1, shadowRadius: 4 },
      android: { elevation: 4 },
      web: { boxShadow: '0 -2px 8px rgba(0,0,0,0.1)' },
    }),
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  itemText: {
    flex: 1,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
  },
  email: {
    fontSize: 12,
    marginTop: 1,
  },
  adminBadge: {
    backgroundColor: '#7C3AED20',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  adminText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#7C3AED',
  },
});

export default MentionAutocomplete;
