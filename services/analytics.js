// Lightweight analytics tracking — pageviews, screen views, app opens
// GDPR-friendly: no cookies, just localStorage/sessionStorage IDs
import { Platform } from 'react-native';

const TRACK_URL = 'https://chatyy.com.br/api/analytics.php?action=track';

let _visitorId = null;
let _sessionId = null;

function getVisitorId() {
  if (_visitorId) return _visitorId;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      _visitorId = localStorage.getItem('_cty_vid');
      if (!_visitorId) {
        _visitorId = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('_cty_vid', _visitorId);
      }
    } else {
      _visitorId = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  } catch { _visitorId = 'v_' + Math.random().toString(36).slice(2); }
  return _visitorId;
}

function getSessionId() {
  if (_sessionId) return _sessionId;
  try {
    if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') {
      _sessionId = sessionStorage.getItem('_cty_sid');
      if (!_sessionId) {
        _sessionId = 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem('_cty_sid', _sessionId);
      }
    } else {
      _sessionId = 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  } catch { _sessionId = 's_' + Math.random().toString(36).slice(2); }
  return _sessionId;
}

function send(event, page, referrer) {
  const payload = JSON.stringify({
    event,
    page: page || (Platform.OS === 'web' && typeof location !== 'undefined' ? location.pathname : '/'),
    referrer: referrer || (Platform.OS === 'web' && typeof document !== 'undefined' ? document.referrer : ''),
    visitor_id: getVisitorId(),
    session_id: getSessionId(),
    platform: Platform.OS === 'web' ? 'web' : Platform.OS,
    screen: Platform.OS === 'web' && typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : '',
    language: Platform.OS === 'web' && typeof navigator !== 'undefined' ? (navigator.language || '') : '',
  });
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(TRACK_URL, new Blob([payload], { type: 'application/json' }));
    } else {
      fetch(TRACK_URL, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  } catch {}
}

export function trackPageview(page) { send('pageview', page); }
export function trackScreenView(screen) { send('screen_view', screen); }
export function trackAppOpen() { send('app_open', '/'); }
