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

  let serverUrl = await getServerUrl();
  urlInput.value = serverUrl;
  openAppLink.href = serverUrl;

  async function checkConnection(url) {
    connectionStatus.className = 'status';
    connectionStatus.textContent = 'Checking…';
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
        const res = await fetch(`${serverUrl}/api/jobs/${jobId}`);
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
      const res = await fetch(`${serverUrl}/api/import-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookmarks }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');

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
