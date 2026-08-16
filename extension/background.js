importScripts('shared.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-page',
    title: 'Save page to Bookmark Brain',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'save-link',
    title: 'Save link to Bookmark Brain',
    contexts: ['link'],
  });
});

async function saveToServer({ url, title }) {
  const serverUrl = await getServerUrl();
  const res = await authFetch(serverUrl, '/api/bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // On a hosted multi-tenant server this commonly means "not signed
    // in" (401) or "trial ended" (402) — surface that distinctly rather
    // than a generic failure, since the fix (open the popup and sign
    // in, or subscribe) is different from an actual save error.
    if (res.status === 401) throw new Error('Sign in via the extension popup first.');
    if (res.status === 402) throw new Error(data.error || 'Subscription required.');
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function flashBadge(ok, message) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#5eead4' : '#f36a6a' });
  if (message) chrome.action.setTitle({ title: message });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: '' });
  }, 3500);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'save-page') {
      await saveToServer({ url: info.pageUrl || tab?.url, title: tab?.title });
    } else if (info.menuItemId === 'save-link') {
      await saveToServer({ url: info.linkUrl, title: info.selectionText || info.linkUrl });
    } else {
      return;
    }
    flashBadge(true);
  } catch (err) {
    flashBadge(false, err.message);
  }
});
