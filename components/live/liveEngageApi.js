/**
 * liveEngageApi — chamadas REST do engajamento da live (Q&A, presentes, top
 * fãs, seguir). Fica separado de services/api.js para não colidir com outras
 * levas que mexem lá; reaproveita apiCall (auth/bearer/retry) e os wrappers
 * existentes de follow/presentes.
 */
import {
  apiCall, followUser, unfollowUser, getPublicProfile,
  liveTopGifters, liveGiftCatalog, liveGiftSend, walletBalance,
} from '../../services/api';

// Q&A (backend staged: chat_live_qa_* em chat.php).
export const qaList = (sessionId) => apiCall('chat_live_qa_list', { session_id: sessionId }, 'POST');
export const qaAsk = (sessionId, text) => apiCall('chat_live_qa_ask', { session_id: sessionId, text: String(text || '').slice(0, 200) }, 'POST');
export const qaUpvote = (sessionId, questionId) => apiCall('chat_live_qa_upvote', { session_id: sessionId, question_id: questionId }, 'POST');
export const qaHighlight = (sessionId, questionId) => apiCall('chat_live_qa_highlight', { session_id: sessionId, question_id: questionId || 0 }, 'POST');
export const qaDismiss = (sessionId, questionId) => apiCall('chat_live_qa_dismiss', { session_id: sessionId, question_id: questionId }, 'POST');

// Presentes (pagos em diamantes — só com LIVE_GIFTS_ENABLED).
export const giftCatalog = () => liveGiftCatalog();
export const giftSend = (sessionId, sku) => liveGiftSend(sessionId, sku);
export const balance = () => walletBalance();
export const topGifters = (sessionId) => liveTopGifters(sessionId, 50);

// Seguir o host.
export async function isFollowing(email) {
  const r = await getPublicProfile(email);
  const d = r?.data ?? r;
  if (!d || typeof d !== 'object') return null;
  if (typeof d.is_following === 'boolean') return d.is_following;
  if (d.profile && typeof d.profile.is_following === 'boolean') return d.profile.is_following;
  return null;
}
export const follow = (email) => followUser(email);
export const unfollow = (email) => unfollowUser(email);
