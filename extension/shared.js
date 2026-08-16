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
