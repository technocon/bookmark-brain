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
  const res = await fetch(`${serverUrl}/api/bookmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function flashBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#5eead4' : '#f36a6a' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
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
  } catch {
    flashBadge(false);
  }
});
