(function () {
  const tabs = document.querySelectorAll('.tab');
  const panels = {
    search: document.getElementById('panel-search'),
    clusters: document.getElementById('panel-clusters'),
    import: document.getElementById('panel-import'),
  };

  function showTab(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    Object.entries(panels).forEach(([key, el]) => el.classList.toggle('active', key === name));
    if (name === 'clusters') loadClusters();
  }

  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  function faviconUrl(favicon, pageUrl) {
    if (favicon) return favicon;
    try {
      const host = new URL(pageUrl).hostname;
      return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
    } catch {
      return '';
    }
  }

  function deleteButtonHtml(id, title) {
    return `<button class="delete-btn" data-delete-id="${id}" data-delete-title="${escapeAttr(title)}" title="Delete bookmark" aria-label="Delete bookmark">🗑</button>`;
  }

  function selectCheckboxHtml(id) {
    return `<input type="checkbox" class="select-checkbox" data-select-id="${id}" aria-label="Select bookmark" />`;
  }

  // Event delegation so a single listener survives re-renders (innerHTML
  // swaps on the container don't remove a listener bound to the container
  // itself) instead of re-binding per item on every render.
  function enableDeleteHandling(container) {
    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-delete-id]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const id = btn.dataset.deleteId;
      const title = btn.dataset.deleteTitle || 'this bookmark';
      if (!confirm(`Delete "${title}"? This can't be undone.`)) return;

      btn.disabled = true;
      try {
        const res = await fetch(`/api/bookmarks/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        btn.closest('li')?.remove();
        refreshSelectionBarFor(container);
        loadStats();
      } catch {
        btn.disabled = false;
        alert("Couldn't delete that bookmark — try again.");
      }
    });
  }

  // ---------- multi-select bulk delete ----------
  // One selection bar serves the search results list, and one serves the
  // drawer (reused across cluster/failed/fallback views) — both driven by
  // the same logic, keyed off whichever container currently holds the
  // checkboxes. `refetch` re-runs whatever populated that container, so a
  // bulk delete leaves the view in a correct, freshly-rendered state
  // (right empty-state message, right counts) instead of hand-editing DOM.
  const selectionBars = new Map(); // container element -> { refresh }
  // Whichever open*Drawer function last populated the drawer — the shared
  // drawer selection bar calls this after a bulk delete to reload whatever
  // view is actually open (cluster bookmarks, failed imports, or fallback
  // matches), rather than needing to know which one it is.
  let currentDrawerRefetch = null;

  function setupSelectionBar({ container, bar, selectAllCheckbox, countEl, deleteBtn, refetch }) {
    function refresh() {
      const checkboxes = [...container.querySelectorAll('.select-checkbox')];
      const checked = checkboxes.filter((cb) => cb.checked);
      bar.classList.toggle('hidden', checkboxes.length === 0);
      countEl.textContent = checked.length > 0 ? `${checked.length} selected` : '';
      deleteBtn.disabled = checked.length === 0;
      selectAllCheckbox.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
      selectAllCheckbox.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
    }

    container.addEventListener('change', (e) => {
      if (e.target.classList.contains('select-checkbox')) refresh();
    });

    selectAllCheckbox.addEventListener('change', () => {
      container.querySelectorAll('.select-checkbox').forEach((cb) => {
        cb.checked = selectAllCheckbox.checked;
      });
      refresh();
    });

    deleteBtn.addEventListener('click', async () => {
      const ids = [...container.querySelectorAll('.select-checkbox:checked')].map((cb) => cb.dataset.selectId);
      if (ids.length === 0) return;
      if (!confirm(`Delete ${ids.length} bookmark${ids.length === 1 ? '' : 's'}? This can't be undone.`)) return;

      deleteBtn.disabled = true;
      try {
        const res = await fetch('/api/bookmarks/bulk-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) throw new Error('Delete failed');
        await refetch();
        loadStats();
      } catch {
        deleteBtn.disabled = false;
        alert("Couldn't delete the selected bookmarks — try again.");
      }
    });

    selectionBars.set(container, { refresh });
    return { refresh };
  }

  function refreshSelectionBarFor(container) {
    selectionBars.get(container)?.refresh();
  }

  // ---------- stats ----------
  async function loadStats() {
    const res = await fetch('/api/stats');
    const s = await res.json();
    document.getElementById('stat-total').textContent = `${s.indexed} bookmark${s.indexed === 1 ? '' : 's'}`;
    const modeLabels = { openai: 'OpenAI embeddings', gemini: 'Gemini embeddings', local: 'Local embeddings (offline)' };
    document.getElementById('stat-mode').textContent = modeLabels[s.embeddingMode] || 'Local embeddings (offline)';

    const fallbackPill = document.getElementById('stat-fallback');
    if (s.fallback > 0) {
      fallbackPill.textContent = `${s.fallback} title-only`;
      fallbackPill.classList.remove('hidden');
    } else {
      fallbackPill.classList.add('hidden');
    }

    const failedPill = document.getElementById('stat-failed');
    if (s.failed > 0) {
      failedPill.textContent = `${s.failed} failed`;
      failedPill.classList.remove('hidden');
    } else {
      failedPill.classList.add('hidden');
    }

    const reembedCard = document.getElementById('reembed-card');
    if (s.embeddingMode !== 'local' && s.indexed > 0) {
      document.getElementById('reembed-provider-name').textContent = modeLabels[s.embeddingMode];
      reembedCard.classList.remove('hidden');
    } else {
      reembedCard.classList.add('hidden');
    }
  }
  document.getElementById('stat-fallback').addEventListener('click', openFallbackDrawer);
  document.getElementById('stat-failed').addEventListener('click', openFailedDrawer);
  document.getElementById('view-failed-btn').addEventListener('click', openFailedDrawer);

  function clearDrawerActions() {
    const actions = document.getElementById('drawer-actions');
    actions.classList.add('hidden');
    actions.innerHTML = '';
  }

  // ---------- failed imports (truly excluded — nothing could be embedded) ----------
  async function openFailedDrawer() {
    drawerTitle.textContent = 'Failed imports';
    drawerList.innerHTML = '';
    clearDrawerActions();
    overlay.classList.remove('hidden');
    currentDrawerRefetch = openFailedDrawer;
    const res = await fetch('/api/bookmarks/failed');
    const { bookmarks } = await res.json();
    renderFailedList(bookmarks);
  }

  function renderFailedList(items) {
    const actions = document.getElementById('drawer-actions');
    if (items.length > 0) {
      actions.classList.remove('hidden');
      actions.innerHTML = `
        <button id="recover-btn" class="btn">Recover ${items.length} as title-only →</button>
        <p class="drawer-note">Re-fetching won't help — these pages are gone, blocked, or require login. This embeds each one from its saved title + folder instead, so it becomes searchable again.</p>`;
      document.getElementById('recover-btn').addEventListener('click', runBackfill);
    } else {
      clearDrawerActions();
    }

    if (!items.length) {
      drawerList.innerHTML = `<li class="empty-state"><p class="muted">Nothing failed — every bookmark is searchable.</p></li>`;
      refreshSelectionBarFor(drawerList);
      return;
    }
    drawerList.innerHTML = items
      .map(
        (b) => `
        <li>
          ${selectCheckboxHtml(b.id)}
          <a class="result-item" href="${escapeAttr(b.url)}" target="_blank" rel="noopener noreferrer">
            <img class="favicon" src="${escapeAttr(faviconUrl(null, b.url))}" onerror="this.style.visibility='hidden'" />
            <div class="result-body">
              <div class="result-title">${escapeHtml(b.title || b.url)}</div>
              <div class="result-url">${escapeHtml(displayUrl(b.url))}</div>
              <div class="result-error">⚠ ${escapeHtml(b.fetch_error || 'Unknown error')}</div>
            </div>
          </a>
          ${deleteButtonHtml(b.id, b.title || b.url)}
        </li>`
      )
      .join('');
    refreshSelectionBarFor(drawerList);
  }

  function runBackfill() {
    const actions = document.getElementById('drawer-actions');
    actions.innerHTML = `
      <div class="import-progress">
        <div class="progress-bar"><div class="progress-fill" id="backfill-fill"></div></div>
        <p class="progress-stage" id="backfill-stage">Starting…</p>
      </div>`;
    const fillEl = document.getElementById('backfill-fill');
    const stageEl = document.getElementById('backfill-stage');

    fetch('/api/backfill', { method: 'POST' })
      .then((res) => res.json())
      .then(({ jobId }) => {
        pollJob(jobId, {
          onTick: (job) => {
            const pct = job.total ? Math.min(99, Math.round((job.partial + job.failed) / job.total * 100)) : 8;
            fillEl.style.width = `${job.status === 'done' ? 100 : pct}%`;
            stageEl.textContent = job.stage || 'Working…';
          },
          onDone: async (job) => {
            stageEl.textContent = `Recovered ${job.partial} of ${job.total} as title-only.`;
            loadStats();
            const res = await fetch('/api/bookmarks/failed');
            const { bookmarks } = await res.json();
            renderFailedList(bookmarks);
          },
          onError: (msg) => {
            stageEl.textContent = `Error: ${msg}`;
          },
        });
      });
  }

  // ---------- fallback (title-only) bookmarks — searchable, but degraded ----------
  async function openFallbackDrawer() {
    drawerTitle.textContent = 'Title-only matches';
    drawerList.innerHTML = '';
    clearDrawerActions();
    document.getElementById('drawer-actions').classList.remove('hidden');
    document.getElementById('drawer-actions').innerHTML =
      `<p class="drawer-note">These pages couldn't be fetched (blocked, dead, or behind a login), so they're searchable by title and folder only — not full content.</p>`;
    overlay.classList.remove('hidden');
    currentDrawerRefetch = openFallbackDrawer;
    const res = await fetch('/api/bookmarks/fallback');
    const { bookmarks } = await res.json();
    renderResults(
      drawerList,
      bookmarks.map((b) => ({ ...b, contentAvailable: false, fetchError: b.fetch_error }))
    );
  }

  // ---------- search ----------
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const searchEmpty = document.getElementById('search-empty');
  let searchTimer = null;
  enableDeleteHandling(searchResults);
  setupSelectionBar({
    container: searchResults,
    bar: document.getElementById('search-select-bar'),
    selectAllCheckbox: document.getElementById('search-select-all'),
    countEl: document.getElementById('search-select-count'),
    deleteBtn: document.getElementById('search-delete-selected'),
    refetch: () => runSearch(searchInput.value.trim()),
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      searchResults.innerHTML = '';
      searchEmpty.style.display = '';
      refreshSelectionBarFor(searchResults);
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 220);
  });

  async function runSearch(q) {
    searchEmpty.style.display = 'none';
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const { results } = await res.json();
    renderResults(searchResults, results);
  }

  function renderResults(container, items) {
    if (!items.length) {
      container.innerHTML = `<li class="empty-state"><p class="muted">No matches yet — try a different phrase.</p></li>`;
      refreshSelectionBarFor(container);
      return;
    }
    container.innerHTML = items
      .map((r) => {
        const isFallback = r.contentAvailable === false;
        const scoreClass = isFallback ? 'result-score result-score-fallback' : 'result-score';
        const tag = isFallback
          ? `<span class="result-tag" title="${escapeAttr('Page unreachable: ' + (r.fetchError || 'unknown error'))}">Title only</span>`
          : '';
        return `
        <li>
          ${selectCheckboxHtml(r.id)}
          <a class="result-item" href="${escapeAttr(r.url)}" target="_blank" rel="noopener noreferrer">
            <img class="favicon" src="${escapeAttr(faviconUrl(r.favicon, r.url))}" onerror="this.style.visibility='hidden'" />
            <div class="result-body">
              <div class="result-title-row">
                <div class="result-title">${escapeHtml(r.title || r.url)}</div>
                ${tag}
              </div>
              ${r.description ? `<div class="result-desc">${escapeHtml(r.description)}</div>` : ''}
              <div class="result-url">${escapeHtml(displayUrl(r.url))}</div>
            </div>
            ${r.score !== undefined ? `<span class="${scoreClass}">${Math.round(r.score * 100)}%</span>` : ''}
          </a>
          ${deleteButtonHtml(r.id, r.title || r.url)}
        </li>`;
      })
      .join('');
    refreshSelectionBarFor(container);
  }

  // ---------- clusters ----------
  const clusterGrid = document.getElementById('cluster-grid');
  const clustersEmpty = document.getElementById('clusters-empty');

  async function loadClusters() {
    const res = await fetch('/api/clusters');
    const { clusters } = await res.json();
    if (!clusters.length) {
      clustersEmpty.style.display = '';
      clusterGrid.innerHTML = '';
      return;
    }
    clustersEmpty.style.display = 'none';
    clusterGrid.innerHTML = clusters
      .map(
        (c) => `
        <button class="cluster-card" data-cluster-id="${c.id}">
          <div class="cluster-label">${escapeHtml(c.label)}</div>
          <div class="cluster-count">${c.size} bookmark${c.size === 1 ? '' : 's'}</div>
          <div class="cluster-samples">
            ${c.samples
              .map((s) => `<img class="favicon" src="${escapeAttr(faviconUrl(s.favicon, s.url))}" onerror="this.style.visibility='hidden'" />`)
              .join('')}
          </div>
        </button>`
      )
      .join('');

    clusterGrid.querySelectorAll('.cluster-card').forEach((btn) => {
      btn.addEventListener('click', () => openClusterDrawer(btn.dataset.clusterId, btn.querySelector('.cluster-label').textContent));
    });
  }

  const overlay = document.getElementById('overlay');
  const drawerTitle = document.getElementById('drawer-title');
  const drawerList = document.getElementById('drawer-list');
  enableDeleteHandling(drawerList);
  setupSelectionBar({
    container: drawerList,
    bar: document.getElementById('drawer-select-bar'),
    selectAllCheckbox: document.getElementById('drawer-select-all'),
    countEl: document.getElementById('drawer-select-count'),
    deleteBtn: document.getElementById('drawer-delete-selected'),
    refetch: () => currentDrawerRefetch && currentDrawerRefetch(),
  });

  async function openClusterDrawer(id, label) {
    drawerTitle.textContent = label;
    drawerList.innerHTML = '';
    clearDrawerActions();
    overlay.classList.remove('hidden');
    currentDrawerRefetch = () => openClusterDrawer(id, label);
    const res = await fetch(`/api/clusters/${id}/bookmarks`);
    const { bookmarks } = await res.json();
    renderResults(drawerList, bookmarks);
  }

  document.getElementById('drawer-close').addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  // ---------- import ----------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const importProgress = document.getElementById('import-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressStage = document.getElementById('progress-stage');
  const importError = document.getElementById('import-error');
  const importDone = document.getElementById('import-done');
  const doneSummary = document.getElementById('done-summary');

  ['dragover', 'dragenter'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  });

  async function uploadFile(file) {
    importError.classList.add('hidden');
    importDone.classList.add('hidden');
    importProgress.classList.remove('hidden');
    progressFill.style.width = '4%';
    progressStage.textContent = 'Uploading…';

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/import', { method: 'POST', body: formData });
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
          importDone.classList.remove('hidden');
          const bits = [`${job.done} imported`];
          if (job.partial) bits.push(`${job.partial} title-only (page unreachable)`);
          if (job.failed) bits.push(`${job.failed} couldn't be indexed at all`);
          doneSummary.textContent = `${bits.join(', ')}.`;
          document.getElementById('view-failed-btn').classList.toggle('hidden', !job.failed);
          loadStats();
        },
        onError: showImportError,
      });
    } catch (err) {
      showImportError(err.message);
    }
  }

  // Generic job poller shared by the import pipeline and the failed-imports
  // recovery ("backfill") flow — both just tick a stage/progress readout
  // and resolve into done/error.
  function pollJob(jobId, { onTick, onDone, onError } = {}) {
    const timer = setInterval(async () => {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();

      if (job.status === 'error') {
        clearInterval(timer);
        if (onError) onError(job.error || 'Something went wrong.');
        return;
      }

      if (onTick) onTick(job);

      if (job.status === 'done') {
        clearInterval(timer);
        if (onDone) onDone(job);
      }
    }, 700);
  }

  function showImportError(message) {
    importProgress.classList.add('hidden');
    importError.textContent = message;
    importError.classList.remove('hidden');
  }

  document.getElementById('view-clusters-btn').addEventListener('click', () => showTab('clusters'));

  // ---------- re-embed existing bookmarks with the active provider ----------
  const reembedBtn = document.getElementById('reembed-btn');
  const reembedProgress = document.getElementById('reembed-progress');
  const reembedProgressFill = document.getElementById('reembed-progress-fill');
  const reembedProgressStage = document.getElementById('reembed-progress-stage');
  const reembedResult = document.getElementById('reembed-result');

  reembedBtn.addEventListener('click', async () => {
    if (!confirm('Re-embed every bookmark with the active provider? This makes one API call per bookmark.')) return;

    reembedResult.classList.add('hidden');
    reembedBtn.disabled = true;
    reembedProgress.classList.remove('hidden');
    reembedProgressFill.style.width = '4%';
    reembedProgressStage.textContent = 'Starting…';

    try {
      const res = await fetch('/api/reembed', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Re-embed failed');

      pollJob(data.jobId, {
        onTick: (job) => {
          const pct = job.total
            ? Math.min(99, Math.round(((job.done || 0) + (job.partial || 0)) / job.total * 100))
            : 8;
          reembedProgressFill.style.width = `${job.status === 'done' ? 100 : pct}%`;
          reembedProgressStage.textContent = job.stage || 'Working…';
        },
        onDone: (job) => {
          reembedProgress.classList.add('hidden');
          reembedBtn.disabled = false;
          const bits = [`${job.done} re-embedded`];
          if (job.partial) bits.push(`${job.partial} fell back to local (provider hiccup)`);
          reembedResult.textContent = `Done — ${bits.join(', ')}.`;
          reembedResult.classList.remove('error');
          reembedResult.classList.remove('hidden');
          loadStats();
        },
        onError: (msg) => {
          reembedProgress.classList.add('hidden');
          reembedBtn.disabled = false;
          reembedResult.textContent = msg;
          reembedResult.classList.add('error');
          reembedResult.classList.remove('hidden');
        },
      });
    } catch (err) {
      reembedProgress.classList.add('hidden');
      reembedBtn.disabled = false;
      reembedResult.textContent = err.message;
      reembedResult.classList.add('error');
      reembedResult.classList.remove('hidden');
    }
  });

  // ---------- utils ----------
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(str) {
    return escapeHtml(str);
  }
  function displayUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname + u.pathname.replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  loadStats();
})();
