(async function () {
  const urlInput = document.getElementById('server-url');
  const saveUrlBtn = document.getElementById('save-url-btn');
  const connectionStatus = document.getElementById('connection-status');
  const importBtn = document.getElementById('import-btn');
  const importProgress = document.getElementById('import-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressStage = document.getElementById('progress-stage');
  const importResult = document.getElementById('import-result');
  const openAppLink = document.getElementById('open-app-link');

  const accountCard = document.getElementById('account-card');
  const accountSignedOut = document.getElementById('account-signed-out');
  const accountSignedIn = document.getElementById('account-signed-in');
  const accountEmailInput = document.getElementById('account-email');
  const accountPasswordInput = document.getElementById('account-password');
  const accountLoginBtn = document.getElementById('account-login-btn');
  const accountSignupBtn = document.getElementById('account-signup-btn');
  const accountAuthStatus = document.getElementById('account-auth-status');
  const accountSignedInEmail = document.getElementById('account-signed-in-email');
  const accountSignedInStatus = document.getElementById('account-signed-in-status');
  const accountManageBtn = document.getElementById('account-manage-btn');
  const accountSubscribeBtn = document.getElementById('account-subscribe-btn');
  const accountLogoutBtn = document.getElementById('account-logout-btn');

  let serverUrl = await getServerUrl();
  urlInput.value = serverUrl;
  openAppLink.href = serverUrl;

  // ---------- connection + account status ----------
  async function checkConnection(url) {
    connectionStatus.className = 'status';
    connectionStatus.textContent = 'Checking…';

    const meta = await getServerMeta(url);
    if (meta.mode === 'unreachable') {
      connectionStatus.className = 'status error';
      connectionStatus.textContent = `Can't reach ${url}.`;
      accountCard.classList.add('hidden');
      return false;
    }

    if (!meta.requiresAuth) {
      // Self-hosted, single-tenant — no accounts at all, exactly the
      // original behavior before multi-tenant support existed.
      accountCard.classList.add('hidden');
      try {
        const res = await fetch(`${url}/api/stats`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const stats = await res.json();
        connectionStatus.className = 'status ok';
        connectionStatus.textContent = `Connected — ${stats.indexed} bookmarks indexed, ${stats.clusters} clusters.`;
        return true;
      } catch (err) {
        connectionStatus.className = 'status error';
        connectionStatus.textContent = `Can't reach ${url} — ${err.message}`;
        return false;
      }
    }

    // Multi-tenant server — show the account card and figure out whether
    // we're already signed in.
    accountCard.classList.remove('hidden');
    connectionStatus.className = 'status ok';
    connectionStatus.textContent = `Connected to ${url}.`;
    await refreshAccountUI();
    return true;
  }

  async function refreshAccountUI() {
    const token = await getAuthToken(serverUrl);
    if (!token) {
      accountSignedOut.classList.remove('hidden');
      accountSignedIn.classList.add('hidden');
      return;
    }

    try {
      const res = await authFetch(serverUrl, '/api/auth/me');
      if (!res.ok) throw new Error('not signed in');
      const { user } = await res.json();

      accountSignedOut.classList.add('hidden');
      accountSignedIn.classList.remove('hidden');
      accountSignedInEmail.textContent = user.email;

      if (user.subscriptionStatus === 'active') {
        accountSignedInStatus.textContent = 'Subscription active.';
        accountManageBtn.classList.remove('hidden');
        accountSubscribeBtn.classList.add('hidden');
      } else if (user.trialActive) {
        const daysLeft = Math.max(0, Math.ceil((new Date(user.trialEndsAt) - Date.now()) / (24 * 60 * 60 * 1000)));
        accountSignedInStatus.textContent = `Free trial — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left.`;
        accountManageBtn.classList.add('hidden');
        accountSubscribeBtn.classList.remove('hidden');
      } else {
        accountSignedInStatus.textContent = 'Trial ended — subscribe to keep using Bookmark Brain.';
        accountManageBtn.classList.add('hidden');
        accountSubscribeBtn.classList.remove('hidden');
      }

      // Now that we're authenticated, the stats line can show real numbers.
      const statsRes = await authFetch(serverUrl, '/api/stats');
      if (statsRes.ok) {
        const stats = await statsRes.json();
        connectionStatus.textContent = `Connected — ${stats.indexed} bookmarks indexed, ${stats.clusters} clusters.`;
      }
    } catch {
      await clearAuthToken(serverUrl);
      accountSignedOut.classList.remove('hidden');
      accountSignedIn.classList.add('hidden');
    }
  }

  async function submitAuth(endpoint) {
    accountAuthStatus.classList.add('hidden');
    accountLoginBtn.disabled = true;
    accountSignupBtn.disabled = true;
    try {
      const res = await fetch(`${serverUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: accountEmailInput.value.trim(), password: accountPasswordInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      await setAuthToken(serverUrl, data.token);
      accountPasswordInput.value = '';
      await refreshAccountUI();
    } catch (err) {
      accountAuthStatus.className = 'status error';
      accountAuthStatus.textContent = err.message;
      accountAuthStatus.classList.remove('hidden');
    } finally {
      accountLoginBtn.disabled = false;
      accountSignupBtn.disabled = false;
    }
  }
  accountLoginBtn.addEventListener('click', () => submitAuth('/api/auth/login'));
  accountSignupBtn.addEventListener('click', () => submitAuth('/api/auth/signup'));

  accountLogoutBtn.addEventListener('click', async () => {
    try {
      await authFetch(serverUrl, '/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore — clearing local state regardless
    }
    await clearAuthToken(serverUrl);
    await refreshAccountUI();
  });

  async function openBillingUrl(path) {
    try {
      const res = await authFetch(serverUrl, path, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      chrome.tabs.create({ url: data.url });
    } catch (err) {
      alert(err.message);
    }
  }
  accountSubscribeBtn.addEventListener('click', () => openBillingUrl('/api/billing/checkout'));
  accountManageBtn.addEventListener('click', () => openBillingUrl('/api/billing/portal'));

  // ---------- server URL ----------
  saveUrlBtn.addEventListener('click', async () => {
    const raw = urlInput.value.trim();
    if (!/^https?:\/\/.+/i.test(raw)) {
      connectionStatus.className = 'status error';
      connectionStatus.textContent = 'Enter a full URL, including http:// or https://.';
      return;
    }
    const url = raw.replace(/\/+$/, '');

    saveUrlBtn.disabled = true;
    const granted = await ensureHostPermission(url);
    if (!granted) {
      connectionStatus.className = 'status error';
      connectionStatus.textContent = 'Permission to reach that address was denied.';
      saveUrlBtn.disabled = false;
      return;
    }

    await setServerUrl(url);
    serverUrl = url;
    openAppLink.href = url;
    await checkConnection(url);
    saveUrlBtn.disabled = false;
  });

  // ---------- bulk import from Chrome's own bookmarks ----------
  function flattenBookmarks(nodes, folderPath = '') {
    let out = [];
    for (const node of nodes) {
      if (node.url) {
        if (/^https?:\/\//i.test(node.url)) {
          out.push({
            url: node.url,
            title: node.title || node.url,
            folder: folderPath,
            addedAt: node.dateAdded ? Math.floor(node.dateAdded / 1000) : null,
          });
        }
      } else if (node.children) {
        const nextPath = node.title ? (folderPath ? `${folderPath} / ${node.title}` : node.title) : folderPath;
        out = out.concat(flattenBookmarks(node.children, nextPath));
      }
    }
    return out;
  }

  function pollJob(jobId, { onTick, onDone, onError }) {
    const timer = setInterval(async () => {
      try {
        const res = await authFetch(serverUrl, `/api/jobs/${jobId}`);
        const job = await res.json();
        if (job.status === 'error') {
          clearInterval(timer);
          onError(job.error || 'Something went wrong.');
          return;
        }
        onTick(job);
        if (job.status === 'done') {
          clearInterval(timer);
          onDone(job);
        }
      } catch (err) {
        clearInterval(timer);
        onError(err.message);
      }
    }, 700);
  }

  importBtn.addEventListener('click', async () => {
    importResult.classList.add('hidden');
    importBtn.disabled = true;

    const tree = await chrome.bookmarks.getTree();
    const bookmarks = flattenBookmarks(tree);

    if (bookmarks.length === 0) {
      importBtn.disabled = false;
      importResult.className = 'status error';
      importResult.textContent = 'No bookmarks found in Chrome.';
      importResult.classList.remove('hidden');
      return;
    }

    importProgress.classList.remove('hidden');
    progressFill.style.width = '4%';
    progressStage.textContent = `Sending ${bookmarks.length} bookmarks…`;

    try {
      const res = await authFetch(serverUrl, '/api/import-json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookmarks }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Sign in above first.');
        if (res.status === 402) throw new Error(data.error || 'Subscription required.');
        throw new Error(data.error || 'Import failed');
      }

      pollJob(data.jobId, {
        onTick: (job) => {
          const pct = job.total
            ? Math.min(99, Math.round(((job.done || 0) + (job.partial || 0) + (job.failed || 0)) / job.total * 100))
            : 8;
          progressFill.style.width = `${job.status === 'done' ? 100 : pct}%`;
          progressStage.textContent = job.stage || 'Working…';
        },
        onDone: (job) => {
          importProgress.classList.add('hidden');
          importBtn.disabled = false;
          const bits = [`${job.done} imported`];
          if (job.partial) bits.push(`${job.partial} title-only (page unreachable)`);
          if (job.failed) bits.push(`${job.failed} couldn't be indexed`);
          importResult.className = 'status ok';
          importResult.textContent = `Done — ${bits.join(', ')}.`;
          importResult.classList.remove('hidden');
        },
        onError: (msg) => {
          importProgress.classList.add('hidden');
          importBtn.disabled = false;
          importResult.className = 'status error';
          importResult.textContent = msg;
          importResult.classList.remove('hidden');
        },
      });
    } catch (err) {
      importProgress.classList.add('hidden');
      importBtn.disabled = false;
      importResult.className = 'status error';
      importResult.textContent = err.message;
      importResult.classList.remove('hidden');
    }
  });

  await checkConnection(serverUrl);
})();
