import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, StyleSheet, Platform, ActivityIndicator, Alert, TouchableOpacity, AppState } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import * as api from '../../services/api';
import MeetControls from '../../components/MeetControls';
import MeetChatPanel from '../../components/MeetChatPanel';
import MeetParticipantsPanel from '../../components/MeetParticipantsPanel';
import MeetReactionsOverlay from '../../components/MeetReactionsOverlay';
import MeetPollPanel from '../../components/MeetPollPanel';
import MeetNotesPanel from '../../components/MeetNotesPanel';
import MeetCaptionsOverlay from '../../components/MeetCaptionsOverlay';
import MeetBreakoutPanel from '../../components/MeetBreakoutPanel';
import MeetMoreMenu from '../../components/MeetMoreMenu';
import MeetVirtualBgPicker from '../../components/MeetVirtualBgPicker';
import { IconFlashlight, IconLock, IconUnlock, IconHome, IconImage, IconBarChart, IconEdit, IconMessageSquare, IconPaperclip, IconInfo } from '../../components/Icons';

let WebView = null;
if (Platform.OS !== 'web') {
  try { WebView = require('react-native-webview').default; } catch {}
}

const MEET_BASE = 'https://mail.onemundo.com.br/meet/room.html';

export default function MeetScreen() {
  const { id: roomId, video } = useLocalSearchParams();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lobbyWaiting, setLobbyWaiting] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoMuted, setVideoMuted] = useState(video === 'off');
  const [screenSharing, setScreenSharing] = useState(false);
  const [participantCount, setParticipantCount] = useState(1);
  const [chatMessages, setChatMessages] = useState([]);
  const [showChat, setShowChat] = useState(false);
  const showChatRef = useRef(false);
  const [unreadChat, setUnreadChat] = useState(0);
  const [ended, setEnded] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [recording, setRecording] = useState(false);
  const [roomLocked, setRoomLocked] = useState(false);

  // Participants & lobby
  const [showParticipants, setShowParticipants] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [lobbyPeers, setLobbyPeers] = useState([]);

  // Reactions
  const [reactions, setReactions] = useState([]);
  const reactionIdRef = useRef(0);

  // Hand raised
  const [handRaised, setHandRaised] = useState(false);

  // Polls
  const [showPolls, setShowPolls] = useState(false);
  const [polls, setPolls] = useState([]);

  // Notes
  const [showNotes, setShowNotes] = useState(false);
  const [meetingNotes, setMeetingNotes] = useState('');

  // Captions
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captions, setCaptions] = useState([]);
  const captionIdRef = useRef(0);

  // Breakout rooms
  const [showBreakout, setShowBreakout] = useState(false);
  const [breakoutRooms, setBreakoutRooms] = useState([]);

  // More menu
  const [showMore, setShowMore] = useState(false);

  // Virtual background
  const [showVirtualBg, setShowVirtualBg] = useState(false);
  const [virtualBgEffect, setVirtualBgEffect] = useState(null);

  // File sharing & spotlight
  const [sharedFiles, setSharedFiles] = useState([]);
  const [spotlightPeerId, setSpotlightPeerId] = useState(null);

  const notesTimerRef = useRef(null);
  const pendingTimersRef = useRef([]);
  const webViewRef = useRef(null);
  const iframeRef = useRef(null);

  // Join meeting via API
  const attemptJoin = async (password) => {
    try {
      const params = { room_id: roomId };
      if (password) params.password = password;
      const r = await api.apiCall('meet_join', params, 'POST');
      if (r.success) {
        setNeedsPassword(false);
        if (r.data?.status === 'lobby') {
          setLobbyWaiting(true);
          setLoading(false);
        } else {
          setIsHost(r.data?.is_host || false);
          setMeetingTitle(r.data?.meeting?.title || '');
          setParticipants(r.data?.participants || []);
          setLoading(false);
        }
      } else if (r.data?.requires_password) {
        setNeedsPassword(true);
        setLoading(false);
      } else {
        setError(r.message || t('meetScreen.joinFailed'));
        setLoading(false);
      }
    } catch (e) {
      setError(t('meetScreen.connectionError'));
      setLoading(false);
    }
  };

  useEffect(() => {
    if (roomId) attemptJoin();
  }, [roomId]);

  // Reconnect when app returns from background
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && roomId && !ended && !error) {
        // Re-join to refresh connection state
        attemptJoin();
      }
    });
    return () => sub.remove();
  }, [roomId, ended, error]);

  // Leave meeting + cleanup timers on unmount
  useEffect(() => {
    return () => {
      api.meetLeave(roomId).catch(() => {});
      pendingTimersRef.current.forEach(id => clearTimeout(id));
      pendingTimersRef.current = [];
      if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    };
  }, [roomId]);

  const displayName = user?.name || user?.email || t('meetScreen.guest');
  const meetUrl = `${MEET_BASE}?id=${encodeURIComponent(roomId)}&token=${encodeURIComponent(api.getAuthToken() || '')}&name=${encodeURIComponent(displayName)}&webview=${Platform.OS !== 'web' ? '1' : '0'}&video=${video === 'off' ? '0' : '1'}`;

  // Inject JS into WebView/iframe
  const injectJS = useCallback((code) => {
    if (Platform.OS === 'web') {
      try {
        const action = code.replace('window.meetController.', '').replace(/\(.*\)$/, '');
        const argsMatch = code.match(/\((.+)\)$/);
        const msg = { action };
        if (argsMatch) msg.args = argsMatch[1];
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), 'https://mail.onemundo.com.br');
      } catch {}
    } else if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`${code}; true;`);
    }
  }, []);

  // Handle messages from WebView/iframe
  const handleMessage = useCallback((event) => {
    let msg;
    try {
      if (Platform.OS === 'web') {
        msg = typeof event.data === 'object' ? event.data : JSON.parse(event.data);
      } else {
        msg = JSON.parse(event.nativeEvent.data);
      }
    } catch { return; }

    switch (msg.type) {
      case 'joined':
        setParticipantCount(msg.participantCount || 1);
        break;
      case 'peer_joined':
        setParticipantCount(prev => msg.participantCount || prev + 1);
        setParticipants(prev => [...prev.filter(p => p.peerId !== msg.peerId), {
          peerId: msg.peerId, displayName: msg.displayName, email: msg.email,
          audioMuted: false, videoMuted: false, handRaised: false,
        }]);
        break;
      case 'peer_left':
        setParticipantCount(prev => msg.participantCount || Math.max(1, prev - 1));
        setParticipants(prev => prev.filter(p => p.peerId !== msg.peerId));
        break;
      case 'audio_muted':
        setAudioMuted(msg.muted);
        break;
      case 'video_muted':
        setVideoMuted(msg.muted);
        break;
      case 'screen_share_started':
        setScreenSharing(true);
        break;
      case 'screen_share_stopped':
        setScreenSharing(false);
        break;
      case 'chat_message': {
        const chatMsg = { displayName: msg.displayName, message: msg.message, timestamp: msg.timestamp };
        setChatMessages(prev => [...prev, chatMsg]);
        if (!showChatRef.current) setUnreadChat(prev => prev + 1);
        break;
      }
      case 'left':
        setEnded(true);
        pendingTimersRef.current.push(setTimeout(() => router.back(), 1500));
        break;
      case 'error':
        setError(msg.message);
        break;

      // ─── New handlers ───
      case 'hand_raised':
        setParticipants(prev => prev.map(p =>
          p.peerId === msg.peerId ? { ...p, handRaised: true } : p
        ));
        break;
      case 'hand_lowered':
        setParticipants(prev => prev.map(p =>
          p.peerId === msg.peerId ? { ...p, handRaised: false } : p
        ));
        break;
      case 'reaction': {
        const id = ++reactionIdRef.current;
        const r = { id, emoji: msg.emoji, displayName: msg.displayName, timestamp: Date.now() };
        setReactions(prev => [...prev.slice(-9), r]);
        pendingTimersRef.current.push(setTimeout(() => setReactions(prev => prev.filter(x => x.id !== id)), 3500));
        break;
      }
      case 'lobby_pending':
        setLobbyPeers(prev => [...prev.filter(p => p.peerId !== msg.peerId),
          { peerId: msg.peerId, displayName: msg.displayName, email: msg.email }]);
        break;
      case 'lobby_admitted':
        setLobbyWaiting(false);
        setLoading(false);
        break;
      case 'lobby_denied':
        setError(t('meetScreen.lobbyDenied'));
        setLobbyWaiting(false);
        break;
      case 'mute_update':
        setParticipants(prev => prev.map(p =>
          p.peerId === msg.peerId ? { ...p, audioMuted: msg.audio, videoMuted: msg.video } : p
        ));
        break;
      case 'recording_started':
        setRecording(true);
        break;
      case 'recording_stopped':
        setRecording(false);
        break;
      case 'room_locked':
        setRoomLocked(true);
        break;
      case 'room_unlocked':
        setRoomLocked(false);
        break;
      case 'meeting_ended':
        setEnded(true);
        pendingTimersRef.current.push(setTimeout(() => router.back(), 2000));
        break;
      case 'kicked':
        setEnded(true);
        setError(t('meetScreen.kicked'));
        pendingTimersRef.current.push(setTimeout(() => router.back(), 2000));
        break;

      // ─── Polls ───
      case 'poll_created':
        setPolls(prev => [...prev, { id: msg.pollId, question: msg.question, options: msg.options.map(t => ({ text: t, votes: 0 })), active: true, myVote: null }]);
        break;
      case 'poll_vote':
        setPolls(prev => prev.map(p => p.id === msg.pollId ? { ...p, options: p.options.map((o, i) => i === msg.optionIndex ? { ...o, votes: (o.votes || 0) + 1 } : o) } : p));
        break;

      // ─── Notes ───
      case 'notes_updated':
        setMeetingNotes(msg.text || '');
        break;

      // ─── Captions ───
      case 'caption': {
        const capId = ++captionIdRef.current;
        const cap = { id: capId, speaker: msg.displayName || t('meetScreen.unknownSpeaker'), text: msg.text };
        setCaptions(prev => [...prev.slice(-9), cap]);
        pendingTimersRef.current.push(setTimeout(() => setCaptions(prev => prev.filter(c => c.id !== capId)), 5000));
        break;
      }

      // ─── File sharing ───
      case 'file_shared': {
        const file = { name: msg.fileName, url: msg.fileUrl, sender: msg.displayName, timestamp: Date.now() };
        setSharedFiles(prev => [...prev, file]);
        setChatMessages(prev => [...prev, { displayName: msg.displayName, message: t('meetScreen.fileShared', { name: msg.fileName }), timestamp: Date.now() }]);
        break;
      }

      // ─── Virtual Background ───
      case 'bg_effect_changed':
        if (msg.effect === 'none') setVirtualBgEffect(null);
        else if (msg.effect === 'blur') setVirtualBgEffect('blur');
        else if (msg.effect === 'blur-light') setVirtualBgEffect('blur-light');
        else if (msg.effect === 'gradient') setVirtualBgEffect('gradient:' + (msg.name || ''));
        else if (msg.effect === 'image') setVirtualBgEffect(msg.url || 'image');
        break;

      // ─── Spotlight ───
      case 'spotlight':
        setSpotlightPeerId(msg.peerId || null);
        break;

      // ─── Breakout rooms ───
      case 'breakout_created':
        setBreakoutRooms(msg.rooms || []);
        break;
      case 'breakout_ended':
        setBreakoutRooms([]);
        break;
    }
  }, []);

  // Web: listen for iframe messages
  useEffect(() => {
    if (Platform.OS === 'web') {
      window.addEventListener('message', handleMessage);
      return () => window.removeEventListener('message', handleMessage);
    }
  }, [handleMessage]);

  const handleEndCall = useCallback(() => {
    const doLeave = () => {
      injectJS('window.meetController.leaveRoom()');
      api.meetLeave(roomId).catch(() => {});
      setEnded(true);
      setTimeout(() => router.back(), 500);
    };
    if (Platform.OS === 'web') {
      if (!window.confirm(t('meetScreen.leaveConfirm'))) return;
      doLeave();
    } else {
      Alert.alert(
        t('meetScreen.leave'),
        t('meetScreen.leaveConfirm'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('meetScreen.leave'), style: 'destructive', onPress: doLeave },
        ]
      );
    }
  }, [roomId, injectJS]);

  const handleToggleChat = useCallback(() => {
    setShowChat(prev => {
      const next = !prev;
      showChatRef.current = next;
      if (next) { setShowParticipants(false); setShowPolls(false); setShowNotes(false); setShowBreakout(false); setShowVirtualBg(false); }
      return next;
    });
    setUnreadChat(0);
  }, []);

  const handleToggleParticipants = useCallback(() => {
    const wasOpen = showParticipants;
    setShowParticipants(prev => !prev);
    if (!wasOpen) { setShowChat(false); setShowPolls(false); setShowNotes(false); setShowBreakout(false); setShowVirtualBg(false); }
  }, [showParticipants]);

  const handleSendChat = useCallback((text) => {
    injectJS(`window.meetController.sendChat(${JSON.stringify(text)})`);
    setChatMessages(prev => [...prev, { displayName: displayName + ' (You)', message: text, timestamp: Date.now() }]);
  }, [injectJS, displayName]);

  const handleRaiseHand = useCallback(() => {
    setHandRaised(prev => {
      injectJS(prev ? 'window.meetController.lowerHand()' : 'window.meetController.raiseHand()');
      return !prev;
    });
  }, [injectJS]);

  const handleReaction = useCallback((emoji) => {
    injectJS(`window.meetController.sendReaction('${emoji}')`);
    const id = ++reactionIdRef.current;
    setReactions(prev => [...prev.slice(-9), { id, emoji, displayName: 'You', timestamp: Date.now() }]);
    setTimeout(() => setReactions(prev => prev.filter(x => x.id !== id)), 3500);
  }, [injectJS]);

  const handleToggleRecording = useCallback(() => {
    if (recording) {
      api.meetStopRecording(roomId).catch(() => {});
      injectJS('window.meetController.stopRecording && window.meetController.stopRecording()');
    } else {
      api.meetStartRecording(roomId).catch(() => {});
      injectJS('window.meetController.startRecording && window.meetController.startRecording()');
    }
    setRecording(prev => !prev);
  }, [recording, roomId, injectJS]);

  const handleToggleLock = useCallback(() => {
    if (roomLocked) {
      api.meetUnlock(roomId).catch(() => {});
      injectJS('window.meetController.unlockRoom()');
    } else {
      api.meetLock(roomId).catch(() => {});
      injectJS('window.meetController.lockRoom()');
    }
    setRoomLocked(prev => !prev);
  }, [roomLocked, roomId, injectJS]);

  // Participant panel callbacks
  const handleAdmit = useCallback((peerId) => {
    injectJS(`window.meetController.admitFromLobby('${peerId}')`);
    setLobbyPeers(prev => prev.filter(p => p.peerId !== peerId));
  }, [injectJS]);

  const handleDeny = useCallback((peerId) => {
    injectJS(`window.meetController.denyFromLobby('${peerId}')`);
    setLobbyPeers(prev => prev.filter(p => p.peerId !== peerId));
  }, [injectJS]);

  const handleKick = useCallback((peerId) => {
    injectJS(`window.meetController.kickParticipant('${peerId}')`);
    setParticipants(prev => prev.filter(p => p.peerId !== peerId));
  }, [injectJS]);

  const handleMutePeer = useCallback((peerId) => {
    injectJS(`window.meetController.muteParticipant('${peerId}')`);
  }, [injectJS]);

  const handlePromote = useCallback((peerId) => {
    const peer = participants.find(p => p.peerId === peerId);
    if (peer?.email) api.meetPromote(roomId, peer.email).catch(() => {});
  }, [participants, roomId]);

  // ─── Polls ───
  const handleCreatePoll = useCallback((question, options) => {
    injectJS(`window.meetController.sendData && window.meetController.sendData(${JSON.stringify({ type: 'poll_created', pollId: 'poll_' + Date.now(), question, options })})`);
    const pollId = 'poll_' + Date.now();
    setPolls(prev => [...prev, { id: pollId, question, options: options.map(t => ({ text: t, votes: 0 })), active: true, myVote: null }]);
  }, [injectJS]);

  const handleVotePoll = useCallback((pollId, optionIndex) => {
    injectJS(`window.meetController.sendData && window.meetController.sendData(${JSON.stringify({ type: 'poll_vote', pollId, optionIndex })})`);
    setPolls(prev => prev.map(p => p.id === pollId ? { ...p, myVote: optionIndex, options: p.options.map((o, i) => i === optionIndex ? { ...o, votes: (o.votes || 0) + 1 } : o) } : p));
  }, [injectJS]);

  // ─── Notes ───
  const handleUpdateNotes = useCallback((text) => {
    setMeetingNotes(text);
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      injectJS(`window.meetController.sendData && window.meetController.sendData(${JSON.stringify({ type: 'notes_updated', text })})`);
    }, 2000);
  }, [injectJS]);

  // ─── Captions ───
  const handleToggleCaptions = useCallback(() => {
    setCaptionsEnabled(prev => {
      const next = !prev;
      injectJS(next
        ? 'window.meetController.startCaptions && window.meetController.startCaptions()'
        : 'window.meetController.stopCaptions && window.meetController.stopCaptions()');
      return next;
    });
  }, [injectJS]);

  // ─── File sharing ───
  const handleShareFile = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const form = new FormData();
          form.append('file', file);
          form.append('room_id', roomId);
          const r = await api.apiCall('meet_upload_file', form, 'POST');
          if (r.success) {
            injectJS(`window.meetController.sendData && window.meetController.sendData(${JSON.stringify({ type: 'file_shared', fileName: file.name, fileUrl: r.data?.url })})`);
          }
        };
        input.click();
      }
    } catch {}
  }, [roomId, injectJS]);

  // ─── Spotlight ───
  const handleSpotlight = useCallback((peerId) => {
    injectJS(`window.meetController.spotlightPeer && window.meetController.spotlightPeer('${peerId}')`);
    setSpotlightPeerId(peerId);
  }, [injectJS]);

  // ─── Breakout rooms ───
  const handleCreateBreakout = useCallback((rooms, timerSec) => {
    const payload = JSON.stringify({ type: 'breakout_created', rooms, timerSec });
    injectJS(`window.meetController.sendData && window.meetController.sendData(${payload})`);
    setBreakoutRooms(rooms);
  }, [injectJS]);

  const handleEndBreakout = useCallback(() => {
    injectJS('window.meetController.sendData && window.meetController.sendData({ type: "breakout_ended" })');
    setBreakoutRooms([]);
  }, [injectJS]);

  // ─── Toggle helpers for panels ───
  const closeAllPanels = useCallback(() => {
    setShowChat(false);
    setShowParticipants(false);
    setShowPolls(false);
    setShowNotes(false);
    setShowBreakout(false);
    setShowMore(false);
    setShowVirtualBg(false);
  }, []);

  const handleTogglePolls = useCallback(() => {
    setShowPolls(prev => {
      if (!prev) { setShowChat(false); setShowParticipants(false); setShowNotes(false); setShowBreakout(false); setShowMore(false); setShowVirtualBg(false); }
      return !prev;
    });
  }, []);

  const handleToggleNotes = useCallback(() => {
    setShowNotes(prev => {
      if (!prev) { setShowChat(false); setShowParticipants(false); setShowPolls(false); setShowBreakout(false); setShowMore(false); setShowVirtualBg(false); }
      return !prev;
    });
  }, []);

  const handleToggleBreakout = useCallback(() => {
    setShowBreakout(prev => {
      if (!prev) { setShowChat(false); setShowParticipants(false); setShowPolls(false); setShowNotes(false); setShowMore(false); setShowVirtualBg(false); }
      return !prev;
    });
  }, []);

  const handleToggleMore = useCallback(() => {
    setShowMore(prev => !prev);
  }, []);

  // ─── Virtual Background ───
  const handleToggleVirtualBg = useCallback(() => {
    setShowVirtualBg(prev => {
      if (!prev) { setShowChat(false); setShowParticipants(false); setShowPolls(false); setShowNotes(false); setShowBreakout(false); setShowMore(false); }
      return !prev;
    });
  }, []);

  const handleSelectVirtualBg = useCallback((type, value) => {
    if (type === 'none') {
      injectJS('window.meetController.setVirtualBackground("none")');
      setVirtualBgEffect(null);
    } else if (type === 'blur') {
      injectJS('window.meetController.setVirtualBackground("blur")');
      setVirtualBgEffect('blur');
    } else if (type === 'blur-light') {
      injectJS('window.meetController.setVirtualBackground("blur-light")');
      setVirtualBgEffect('blur-light');
    } else if (type === 'gradient') {
      injectJS(`window.meetController.setVirtualBackground("gradient", ${JSON.stringify(value)})`);
      setVirtualBgEffect('gradient:' + value);
    } else if (type === 'image') {
      injectJS(`window.meetController.setVirtualBackground("image", ${JSON.stringify(value)})`);
      setVirtualBgEffect(value);
    }
  }, [injectJS]);

  // ─── More menu options ───
  const moreMenuOptions = [
    // Collaboration
    { section: t('meetScreen.collaboration'), label: t('meetScreen.polls'), icon: IconBarChart, onPress: handleTogglePolls },
    { section: t('meetScreen.collaboration'), label: t('meetScreen.meetingNotes'), icon: IconEdit, onPress: handleToggleNotes },
    { section: t('meetScreen.collaboration'), label: t('meetScreen.shareFile'), icon: IconPaperclip, onPress: handleShareFile },
    // Media
    { section: t('meetScreen.media'), label: virtualBgEffect ? t('meetScreen.changeBackground') : t('meetScreen.virtualBackground'), icon: IconImage, onPress: handleToggleVirtualBg },
    { section: t('meetScreen.media'), label: captionsEnabled ? t('meetScreen.disableCaptions') : t('meetScreen.enableCaptions'), icon: IconMessageSquare, onPress: handleToggleCaptions },
    // Host Controls
    ...(isHost ? [
      { section: t('meetScreen.controls'), label: spotlightPeerId ? t('meetScreen.removeSpotlight') : t('meetScreen.spotlightSpeaker'), icon: IconFlashlight, onPress: () => handleSpotlight(spotlightPeerId ? null : '') },
      { section: t('meetScreen.controls'), label: recording ? t('meetScreen.stopRecording') : t('meetScreen.startRecording'), icon: null, onPress: handleToggleRecording },
      { section: t('meetScreen.controls'), label: roomLocked ? t('meetScreen.unlockRoom') : t('meetScreen.lockRoom'), icon: roomLocked ? IconUnlock : IconLock, onPress: handleToggleLock },
      { section: t('meetScreen.controls'), label: t('meetScreen.breakoutRooms'), icon: IconHome, onPress: handleToggleBreakout },
    ] : []),
    // Info
    { section: t('meetScreen.info'), label: t('meetScreen.meetingInfo'), icon: IconInfo, onPress: () => {
      const info = `${t('meetScreen.room')}: ${roomId}\n${t('meetScreen.participantsLabel')}: ${participantCount}`;
      if (Platform.OS === 'web') window.alert(info);
      else Alert.alert(t('meetScreen.meetingInfo'), info);
    }},
  ];

  // ─── Password prompt ───
  if (needsPassword) {
    return (
      <View style={s.centered}>
        <Text style={s.lobbyText}>{t('meetScreen.passwordRequired')}</Text>
        <TextInput
          style={s.passwordInput}
          value={passwordInput}
          onChangeText={setPasswordInput}
          placeholder={t('meetScreen.passwordPlaceholder')}
          placeholderTextColor="#64748b"
          secureTextEntry
          autoFocus
          onSubmitEditing={() => { setLoading(true); attemptJoin(passwordInput); }}
        />
        <TouchableOpacity
          onPress={() => { setLoading(true); attemptJoin(passwordInput); }}
          style={[s.lobbyBackBtn, { backgroundColor: '#3b82f6' }]}
        >
          <Text style={[s.lobbyBackText, { color: '#fff' }]}>{t('meetScreen.enter')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={s.lobbyBackBtn}>
          <Text style={s.lobbyBackText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Loading ───
  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={s.statusText}>{t('meetScreen.connecting')}</Text>
      </View>
    );
  }

  // ─── Lobby waiting ───
  if (lobbyWaiting) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={s.lobbyText}>{t('meetScreen.lobbyWaiting')}</Text>
        <TouchableOpacity onPress={() => router.back()} style={s.lobbyBackBtn}>
          <Text style={s.lobbyBackText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Error ───
  if (error && !ended) {
    return (
      <View style={s.centered}>
        <Text style={s.errorText}>{error}</Text>
        <Text style={s.statusText} onPress={() => router.back()}>{t('meetScreen.goBack')}</Text>
      </View>
    );
  }

  // ─── Ended ───
  if (ended) {
    return (
      <View style={s.centered}>
        <Text style={s.endedText}>{t('meetScreen.ended')}</Text>
      </View>
    );
  }

  // ─── Recording banner ───
  const RecordingBanner = recording ? (
    <View style={s.recordingBanner}>
      <View style={s.recordingDot} />
      <Text style={s.recordingText}>REC</Text>
    </View>
  ) : null;

  // ─── Meeting title bar ───
  const TitleBar = meetingTitle ? (
    <View style={s.titleBar}>
      <Text style={s.titleText} numberOfLines={1}>{meetingTitle}</Text>
      {roomLocked && <IconLock size={14} color="#e2e8f0" style={{ marginLeft: 8 }} />}
    </View>
  ) : null;

  // Shared panels
  const panels = (
    <>
      <MeetReactionsOverlay reactions={reactions} />
      <MeetCaptionsOverlay enabled={captionsEnabled} captions={captions} />
      <MeetControls
        audioMuted={audioMuted}
        videoMuted={videoMuted}
        screenSharing={screenSharing}
        handRaised={handRaised}
        isHost={isHost}
        recording={recording}
        onToggleAudio={() => injectJS('window.meetController.toggleAudio()')}
        onToggleVideo={() => injectJS('window.meetController.toggleVideo()')}
        onScreenShare={() => injectJS('window.meetController.startScreenShare()')}
        onEndCall={handleEndCall}
        onToggleChat={handleToggleChat}
        onToggleParticipants={handleToggleParticipants}
        onRaiseHand={handleRaiseHand}
        onReaction={handleReaction}
        onToggleRecording={handleToggleRecording}
        onToggleLock={handleToggleLock}
        onTogglePolls={handleTogglePolls}
        onToggleNotes={handleToggleNotes}
        onToggleCaptions={handleToggleCaptions}
        onToggleBreakout={handleToggleBreakout}
        onToggleMore={handleToggleMore}
        onToggleVirtualBg={handleToggleVirtualBg}
        virtualBgActive={!!virtualBgEffect}
        captionsEnabled={captionsEnabled}
        participantCount={participantCount}
        unreadChat={unreadChat}
        lobbyCount={lobbyPeers.length}
      />
      <MeetChatPanel
        visible={showChat}
        messages={chatMessages}
        onSend={handleSendChat}
        onClose={() => { setShowChat(false); showChatRef.current = false; setUnreadChat(0); }}
      />
      <MeetParticipantsPanel
        visible={showParticipants}
        onClose={() => setShowParticipants(false)}
        participants={participants}
        lobbyPeers={lobbyPeers}
        isHost={isHost}
        onAdmit={handleAdmit}
        onDeny={handleDeny}
        onKick={handleKick}
        onMute={handleMutePeer}
        onPromote={handlePromote}
      />
      <MeetPollPanel
        visible={showPolls}
        onClose={() => setShowPolls(false)}
        polls={polls}
        onCreatePoll={handleCreatePoll}
        onVote={handleVotePoll}
        isHost={isHost}
      />
      <MeetNotesPanel
        visible={showNotes}
        onClose={() => setShowNotes(false)}
        notes={meetingNotes}
        onUpdateNotes={handleUpdateNotes}
      />
      <MeetBreakoutPanel
        visible={showBreakout}
        onClose={() => setShowBreakout(false)}
        isHost={isHost}
        breakoutRooms={breakoutRooms}
        onCreateBreakout={handleCreateBreakout}
        onEndBreakout={handleEndBreakout}
      />
      <MeetMoreMenu
        visible={showMore}
        onClose={() => setShowMore(false)}
        isHost={isHost}
        options={moreMenuOptions}
      />
      <MeetVirtualBgPicker
        visible={showVirtualBg}
        onClose={() => setShowVirtualBg(false)}
        onSelect={handleSelectVirtualBg}
        currentEffect={virtualBgEffect}
      />
    </>
  );

  // ─── Web: iframe ───
  if (Platform.OS === 'web') {
    return (
      <View style={s.container}>
        {TitleBar}
        {RecordingBanner}
        <iframe
          ref={iframeRef}
          src={meetUrl}
          style={{ width: '100%', flex: 1, border: 'none', background: '#111827' }}
          allow="camera; microphone; display-capture; autoplay"
        />
        {panels}
      </View>
    );
  }

  // ─── Mobile: WebView ───
  if (!WebView) {
    return (
      <View style={s.centered}>
        <Text style={s.errorText}>WebView not available</Text>
      </View>
    );
  }

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      {TitleBar}
      {RecordingBanner}
      <WebView
        ref={webViewRef}
        source={{ uri: meetUrl }}
        onMessage={handleMessage}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        mediaCapturePermissionGrantType="grant"
        javaScriptEnabled={true}
        domStorageEnabled={true}
        originWhitelist={['*']}
        style={{ flex: 1, backgroundColor: '#111827' }}
      />
      {panels}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  centered: {
    flex: 1, backgroundColor: '#111827',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  statusText: { color: '#94a3b8', fontSize: 16, marginTop: 16 },
  errorText: { color: '#f87171', fontSize: 18, fontWeight: '600', textAlign: 'center' },
  endedText: { color: '#fff', fontSize: 20, fontWeight: '600' },
  lobbyText: { color: '#e2e8f0', fontSize: 18, fontWeight: '500', marginTop: 20, textAlign: 'center' },
  lobbyBackBtn: { marginTop: 24, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 8, backgroundColor: '#374151' },
  lobbyBackText: { color: '#94a3b8', fontSize: 16 },
  passwordInput: {
    width: 260, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: 16,
    marginTop: 16, textAlign: 'center',
  },
  titleBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#1f2937',
  },
  titleText: { color: '#e2e8f0', fontSize: 14, fontWeight: '600', flex: 1, textAlign: 'center' },
  recordingBanner: {
    position: 'absolute', top: 60, left: 16, zIndex: 100,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(220, 38, 38, 0.9)', borderRadius: 6,
    paddingVertical: 4, paddingHorizontal: 10,
  },
  recordingDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#fff', marginRight: 6,
  },
  recordingText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
});
