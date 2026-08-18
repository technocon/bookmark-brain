// Shared across popup.js, options.js, and background.js (via importScripts
// in the service worker, or a <script> tag in the two HTML pages).
const DEFAULT_SERVER_URL = 'http://localhost:3300';

function getServerUrl() {
  return chrome.storage.local.get('serverUrl').then((r) => r.serverUrl || DEFAULT_SERVER_URL);
}

function setServerUrl(url) {
  return chrome.storage.local.set({ serverUrl: url.replace(/\/+$/, '') });
}

function originOf(url) {
  try {
    return new URL(url).origin + '/*';
  } catch {
    return null;
  }
}

// The manifest only statically grants localhost/127.0.0.1 — anything else
// (a LAN IP, a future hosted domain) needs a runtime permission grant,
// which Chrome only allows from a user-gesture context (e.g. inside a
// button's click handler). Call this from there.
async function ensureHostPermission(serverUrl) {
  const pattern = originOf(serverUrl);
  if (!pattern) return false;
  const already = await chrome.permissions.contains({ origins: [pattern] });
  if (already) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

// ---------- multi-tenant auth ----------
// A self-hosted server has no /api/meta route at all and needs no auth.
// A hosted multi-tenant server has one and requires a Bearer token.
// Tokens are stored per-server so switching between a self-hosted and a
// hosted instance (or between two hosted instances) doesn't mix sessions.

async function getServerMeta(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/api/meta`);
    if (!res.ok) return { mode: 'single', requiresAuth: false };
    return await res.json();
  } catch {
    return { mode: 'unreachable', requiresAuth: false };
  }
}

async function getAuthToken(serverUrl) {
  const { authTokens } = await chrome.storage.local.get('authTokens');
  return (authTokens || {})[serverUrl] || null;
}

async function setAuthToken(serverUrl, token) {
  const { authTokens } = await chrome.storage.local.get('authTokens');
  const next = { ...(authTokens || {}), [serverUrl]: token };
  await chrome.storage.local.set({ authTokens: next });
}

async function clearAuthToken(serverUrl) {
  const { authTokens } = await chrome.storage.local.get('authTokens');
  const next = { ...(authTokens || {}) };
  delete next[serverUrl];
  await chrome.storage.local.set({ authTokens: next });
}

/**
 * fetch() wrapper that adds the stored Bearer token for this server (if
 * any) — a no-op for self-hosted servers, which never issue tokens in the
 * first place since login/signup only exist on multi-tenant servers.
 */
async function authFetch(serverUrl, path, options = {}) {
  const token = await getAuthToken(serverUrl);
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${serverUrl}${path}`, { ...options, headers });
}

// chrome.identity.getAuthToken() is callback-based on every Chrome version
// (a Promise-returning overload only landed recently), so it's wrapped here
// rather than called directly from popup.js/options.js.
function chromeGetAuthToken(details) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken(details, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

/**
 * Full Google sign-in: gets an access token from the account the browser
 * profile is signed into (prompting for consent/account choice the first
 * time, via manifest.json's oauth2.client_id), sends it to the server for
 * verification, and stores the resulting Bookmark Brain session token —
 * same shape/storage as email+password login. Requires manifest.json's
 * oauth2.client_id to be a real Chrome Extension OAuth client (the default
 * placeholder there will make this throw a clear Chrome-side error).
 */
async function signInWithGoogle(serverUrl) {
  let accessToken;
  try {
    accessToken = await chromeGetAuthToken({ interactive: true });
  } catch (err) {
    throw new Error(`Google sign-in failed: ${err.message}`);
  }
  if (!accessToken) throw new Error('Google sign-in was canceled.');

  const res = await fetch(`${serverUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Drop the cached token so a retry (e.g. after the user fixes server
    // config) fetches a fresh one instead of repeating the same failure.
    chrome.identity.removeCachedAuthToken({ token: accessToken }, () => {});
    throw new Error(data.error || 'Google sign-in failed.');
  }

  await setAuthToken(serverUrl, data.token);
  return data;
}
