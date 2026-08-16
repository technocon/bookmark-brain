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
