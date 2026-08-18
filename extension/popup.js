(async function () {
  const serverUrl = await getServerUrl();

  const statusDot = document.getElementById('status-dot');
  const saveFavicon = document.getElementById('save-favicon');
  const saveTitle = document.getElementById('save-title');
  const saveUrl = document.getElementById('save-url');
  const saveBtn = document.getElementById('save-btn');
  const saveStatus = document.getElementById('save-status');
  const searchInput = document.getElementById('search-input');
  const results = document.getElementById('results');
  const emptyState = document.getElementById('empty-state');
  const offlineState = document.getElementById('offline-state');
  const openAppLink = document.getElementById('open-app-link');
  const settingsLink = document.getElementById('settings-link');
  const openSettingsLink = document.getElementById('open-settings-link');
  const popupAuth = document.getElementById('popup-auth');
  const popupMain = document.getElementById('popup-main');
  const logoutLink = document.getElementById('popup-logout-link');

  openAppLink.href = serverUrl;
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  openSettingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  function faviconUrl(pageUrl) {
    try {
      const host = new URL(pageUrl).hostname;
      return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
    } catch {
      return '';
    }
  }

  // ---------- auth-aware API calls ----------
  // Wraps authFetch (which adds the stored Bearer token, a no-op for
  // self-hosted servers that never issue one) and reacts to 401 by
  // dropping back to the sign-in form — same shape as the web app's
  // apiFetch, so a session that expires mid-use degrades the same way.
  async function apiCall(path, options) {
    const res = await authFetch(serverUrl, path, options);
    if (res.status === 401) {
      await clearAuthToken(serverUrl);
      showAuthForm();
      throw new Error('Sign in required');
    }
    return res;
  }

  function showAuthForm() {
    popupAuth.classList.remove('hidden');
    popupMain.classList.add('hidden');
    logoutLink.classList.add('hidden');
  }

  function showMain() {
    popupAuth.classList.add('hidden');
    popupMain.classList.remove('hidden');
  }

  // ---------- multi-tenant sign-in form (only shown when required) ----------
  let authMode = 'login';
  const authTitle = document.getElementById('popup-auth-title');
  const authForm = document.getElementById('popup-auth-form');
  const authEmail = document.getElementById('popup-auth-email');
  const authPassword = document.getElementById('popup-auth-password');
  const authSubmit = document.getElementById('popup-auth-submit');
  const authError = document.getElementById('popup-auth-error');
  const authSwitchText = document.getElementById('popup-auth-switch-text');
  const authSwitchLink = document.getElementById('popup-auth-switch-link');

  function setAuthMode(mode) {
    authMode = mode;
    authError.classList.add('hidden');
    authTitle.textContent = mode === 'login' ? 'Sign in' : 'Create your account';
    authSubmit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    authSwitchText.textContent = mode === 'login' ? "Don't have an account?" : 'Already have an account?';
    authSwitchLink.textContent = mode === 'login' ? 'Create one' : 'Sign in';
  }
  authSwitchLink.addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode(authMode === 'login' ? 'signup' : 'login');
  });

  const googleBtn = document.getElementById('popup-google-btn');
  const googleDivider = document.getElementById('popup-auth-divider');
  googleBtn.addEventListener('click', async () => {
    authError.classList.add('hidden');
    googleBtn.disabled = true;
    try {
      await signInWithGoogle(serverUrl);
      showMain();
      logoutLink.classList.remove('hidden');
      await init();
    } catch (err) {
      authError.textContent = err.message;
      authError.classList.remove('hidden');
    } finally {
      googleBtn.disabled = false;
    }
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.classList.add('hidden');
    authSubmit.disabled = true;
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/signup';
      const res = await fetch(`${serverUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail.value.trim(), password: authPassword.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');

      await setAuthToken(serverUrl, data.token);
      showMain();
      logoutLink.classList.remove('hidden');
      await init();
    } catch (err) {
      authError.textContent = err.message;
      authError.classList.remove('hidden');
    } finally {
      authSubmit.disabled = false;
    }
  });

  logoutLink.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await apiCall('/api/auth/logout', { method: 'POST' });
    } catch {
      // already redirected to the auth form by apiCall
    }
    await clearAuthToken(serverUrl);
    setAuthMode('login');
    showAuthForm();
  });

  // ---------- connection status ----------
  function setOnline(isOnline) {
    statusDot.className = 'status-dot ' + (isOnline ? 'ok' : 'error');
    statusDot.title = isOnline ? `Connected to ${serverUrl}` : `Can't reach ${serverUrl}`;
    offlineState.classList.toggle('hidden', isOnline);
    searchInput.disabled = !isOnline;
    saveBtn.disabled = !isOnline;
  }
  statusDot.addEventListener('click', () => chrome.runtime.openOptionsPage());

  async function checkConnection() {
    try {
      const res = await apiCall('/api/stats');
      setOnline(res.ok);
    } catch {
      setOnline(false);
    }
  }

  // ---------- save current tab ----------
  let currentTab = null;
  async function loadCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
      saveTitle.textContent = 'This page can’t be saved';
      saveUrl.textContent = tab?.url || '';
      saveBtn.disabled = true;
      return;
    }
    saveFavicon.src = faviconUrl(tab.url);
    saveTitle.textContent = tab.title || tab.url;
    saveUrl.textContent = tab.url;
  }

  saveBtn.addEventListener('click', async () => {
    if (!currentTab) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    saveStatus.classList.remove('hidden', 'ok', 'error');
    saveStatus.textContent = 'Fetching & embedding…';

    try {
      const res = await apiCall('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: currentTab.url, title: currentTab.title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      if (data.outcome === 'already-saved') {
        saveStatus.textContent = 'Already in Bookmark Brain.';
      } else if (data.outcome === 'partial') {
        saveStatus.textContent = 'Saved — page content was unreachable, indexed by title only.';
      } else {
        saveStatus.textContent = 'Saved and embedded ✓';
      }
      saveStatus.classList.add('ok');
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#5eead4' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
    } catch (err) {
      saveStatus.textContent = err.message || "Couldn't save that page.";
      saveStatus.classList.add('error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  // ---------- search ----------
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      results.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 200);
  });

  async function runSearch(q) {
    emptyState.classList.add('hidden');
    try {
      const res = await apiCall(`/api/search?q=${encodeURIComponent(q)}`);
      const { results: items } = await res.json();
      renderResults(items);
    } catch {
      results.innerHTML = `<li class="empty-state">Search failed — is the server reachable?</li>`;
    }
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderResults(items) {
    if (!items.length) {
      results.innerHTML = `<li class="empty-state">No matches.</li>`;
      return;
    }
    results.innerHTML = items
      .slice(0, 12)
      .map((r) => {
        const tag = r.contentAvailable === false ? `<span class="result-tag">Title only</span>` : '';
        return `
        <li>
          <a class="result-item" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">
            <img class="favicon" src="${escapeHtml(faviconUrl(r.url))}" onerror="this.style.visibility='hidden'" />
            <div class="result-body">
              <div class="result-title">${escapeHtml(r.title || r.url)}</div>
              <div class="result-url">${escapeHtml(r.url)}</div>
            </div>
            ${tag}
          </a>
        </li>`;
      })
      .join('');
  }

  // ---------- boot ----------
  async function init() {
    await checkConnection();
    await loadCurrentTab();
  }

  const meta = await getServerMeta(serverUrl);
  if (meta.requiresAuth) {
    if (meta.googleAuthConfigured) {
      googleBtn.classList.remove('hidden');
      googleDivider.classList.remove('hidden');
    }
    const token = await getAuthToken(serverUrl);
    if (!token) {
      setAuthMode('login');
      showAuthForm();
    } else {
      showMain();
      logoutLink.classList.remove('hidden');
      await init();
    }
  } else {
    // Self-hosted (or unreachable — checkConnection will surface that via
    // the red status dot, same as before this feature existed).
    showMain();
    await init();
  }
})();
