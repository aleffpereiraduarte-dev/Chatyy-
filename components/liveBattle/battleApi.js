/**
 * battleApi — REST da Batalha PK (chat.php: chat_live_battle_*).
 * Separado de services/api.js (reaproveita apiCall: auth/bearer/retry).
 */
import { apiCall } from '../../services/api';

export const battleCandidates = (sessionId) =>
  apiCall('chat_live_battle_candidates', { session_id: sessionId }, 'POST');

export const battleInvite = (sessionId, targetSessionId) =>
  apiCall('chat_live_battle_invite', { session_id: sessionId, target_session_id: targetSessionId || '' }, 'POST');

export const battleInviteRandom = (sessionId) =>
  apiCall('chat_live_battle_invite', { session_id: sessionId, random: 1 }, 'POST');

export const battleRespond = (battleId, accept) =>
  apiCall('chat_live_battle_respond', { battle_id: battleId, accept: accept ? 1 : 0 }, 'POST');

export const battleEnd = (battleId, reason) =>
  apiCall('chat_live_battle_end', { battle_id: battleId, reason: reason === 'opponent_left' ? 'opponent_left' : 'host_ended' }, 'POST');

export const battleState = (sessionId, withToken) =>
  apiCall('chat_live_battle_state', { session_id: sessionId, with_token: withToken ? 1 : 0 }, 'POST');
