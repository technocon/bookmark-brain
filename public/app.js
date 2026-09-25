(function () {
  // ---------- theme picker (System / Light / Dark) ----------
  // theme.js already applied the saved choice before first paint; this just
  // reflects it on every picker and handles clicks.
  function syncThemePickers() {
    const mode = window.BBTheme ? window.BBTheme.get() : 'system';
    document.querySelectorAll('[data-theme-mode]').forEach((b) => b.classList.toggle('active', b.dataset.themeMode === mode));
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-mode]');
    if (!btn || !window.BBTheme) return;
    window.BBTheme.set(btn.dataset.themeMode);
    syncThemePickers();
  });
  syncThemePickers();

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

    const previewsCard = document.getElementById('previews-card');
    previewsCard.classList.toggle('hidden', !(s.missingImages > 0));
    document.getElementById('previews-missing').textContent = `${s.missingImages} of ${s.indexed}`;

    document.getElementById('duplicates-card').classList.toggle('hidden', s.indexed === 0);

    const duplicatesPill = document.getElementById('stat-duplicates');
    if (s.duplicateGroups > 0) {
      duplicatesPill.textContent = `${s.duplicateGroups} possible dup${s.duplicateGroups === 1 ? '' : 's'}`;
      duplicatesPill.classList.remove('hidden');
    } else {
      duplicatesPill.classList.add('hidden');
    }

    // Counts moved, so the sidebar's lists (and their badges) did too.
    loadClusters().catch(() => {});
  }
  document.getElementById('stat-fallback').addEventListener('click', openFallbackDrawer);
  document.getElementById('stat-failed').addEventListener('click', openFailedDrawer);
  document.getElementById('stat-duplicates').addEventListener('click', openDuplicatesDrawer);
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

  // ---------- possible duplicates ----------
  async function openDuplicatesDrawer() {
    drawerTitle.textContent = 'Possible duplicates';
    drawerList.innerHTML = '';
    clearDrawerActions();
    document.getElementById('drawer-actions').classList.remove('hidden');
    document.getElementById('drawer-actions').innerHTML =
      `<p class="drawer-note">Grouped by likely match. Nothing's pre-selected to delete except the extras in each group — review before deleting, this can't be undone.</p>`;
    overlay.classList.remove('hidden');
    currentDrawerRefetch = openDuplicatesDrawer;
    const res = await fetch('/api/duplicates');
    const { groups } = await res.json();
    renderDuplicatesList(groups);
  }

  function renderDuplicatesList(groups) {
    if (!groups.length) {
      drawerList.innerHTML = `<li class="empty-state"><p class="muted">No duplicates found.</p></li>`;
      refreshSelectionBarFor(drawerList);
      return;
    }
    drawerList.innerHTML = groups
      .map((g) => {
        const label =
          g.reason === 'url-variant'
            ? 'Same page, different link'
            : `Looks like the same content — ${Math.round(g.similarity * 100)}% match`;
        const items = g.bookmarks
          .map(
            (b, i) => `
          <li>
            <input type="checkbox" class="select-checkbox" data-select-id="${b.id}" aria-label="Select bookmark" ${i > 0 ? 'checked' : ''} />
            <a class="result-item" href="${escapeAttr(b.url)}" target="_blank" rel="noopener noreferrer">
              <img class="favicon" src="${escapeAttr(faviconUrl(b.favicon, b.url))}" onerror="this.style.visibility='hidden'" />
              <div class="result-body">
                <div class="result-title">${escapeHtml(b.title || b.url)}</div>
                <div class="result-url">${escapeHtml(displayUrl(b.url))}</div>
              </div>
            </a>
          </li>`
          )
          .join('');
        return `<li class="dup-group"><p class="dup-group-label">${escapeHtml(label)}</p><ul class="result-list dup-group-list">${items}</ul></li>`;
      })
      .join('');
    refreshSelectionBarFor(drawerList);
  }

  // ---------- library: sidebar lists, recent saves, search ----------
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const clusterList = document.getElementById('cluster-list');
  const clustersEmpty = document.getElementById('clusters-empty');
  const viewTitle = document.getElementById('view-title');
  const viewCount = document.getElementById('view-count');
  const viewIcon = document.getElementById('view-icon');

  // Each list gets a stable colour and an initial, so the sidebar is
  // scannable at a glance (there are no user-chosen icons to store).
  const LIST_COLORS = ['#f59e0b', '#6366f1', '#64748b', '#10b981', '#ec4899', '#0ea5e9', '#8b5cf6', '#ef4444'];
  function listIconStyle(id) {
    return `background:${LIST_COLORS[Math.abs(Number(id) || 0) % LIST_COLORS.length]}`;
  }
  function listInitial(label) {
    const m = String(label || '').match(/[A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : '•';
  }

  // Card grid vs. compact rows -- remembered per browser.
  let viewMode = 'grid';
  try {
    if (localStorage.getItem('bookmarkbrain_view_mode') === 'list') viewMode = 'list';
  } catch {}
  function applyViewMode() {
    searchResults.classList.toggle('list-mode', viewMode === 'list');
    document.getElementById('view-mode-grid').classList.toggle('active', viewMode === 'grid');
    document.getElementById('view-mode-list').classList.toggle('active', viewMode === 'list');
  }
  const panels = {
    library: document.getElementById('panel-library'),
    import: document.getElementById('panel-import'),
  };
  let searchTimer = null;
  let viewToken = 0; // guards against a slow response overwriting a newer view
  let currentView = { type: 'recent' };
  let lastListView = { type: 'recent' }; // where clearing the search box returns to

  enableDeleteHandling(searchResults);
  setupSelectionBar({
    container: searchResults,
    bar: document.getElementById('search-select-bar'),
    selectAllCheckbox: document.getElementById('search-select-all'),
    countEl: document.getElementById('search-select-count'),
    deleteBtn: document.getElementById('search-delete-selected'),
    refetch: () => loadCurrentList(),
  });

  function setActiveNav() {
    document.querySelectorAll('#sidebar .side-item').forEach((el) => {
      const active =
        (currentView.type === 'recent' && el.dataset.view === 'recent') ||
        (currentView.type === 'import' && el.dataset.view === 'import') ||
        (currentView.type === 'cluster' && el.dataset.clusterId === String(currentView.id));
      el.classList.toggle('active', active);
    });
  }

  async function showView(view) {
    currentView = view;
    if (view.type === 'recent' || view.type === 'cluster') lastListView = view;
    document.body.classList.remove('sidebar-open');
    if (view.type !== 'search') addUrlStatus.className = 'add-url-status hidden';
    const isImport = view.type === 'import';
    panels.library.classList.toggle('active', !isImport);
    panels.import.classList.toggle('active', isImport);
    setActiveNav();
    if (isImport) return;
    if (view.type !== 'search') searchInput.value = '';
    await loadCurrentList();
  }

  async function loadCurrentList() {
    const token = ++viewToken;
    const view = currentView;
    let items;
    let title;
    let countLabel;
    let emptyMessage;
    if (view.type === 'search') {
      const res = await fetch(`/api/search?q=${encodeURIComponent(view.q)}`);
      items = (await res.json()).results;
      title = `Results for “${view.q}”`;
      countLabel = (n) => `${n} match${n === 1 ? '' : 'es'}`;
      emptyMessage = 'No matches yet — try a different phrase.';
    } else if (view.type === 'cluster') {
      const res = await fetch(`/api/clusters/${view.id}/bookmarks`);
      items = (await res.json()).bookmarks;
      title = view.label;
      countLabel = (n) => `${n} bookmark${n === 1 ? '' : 's'}`;
      emptyMessage = 'This list is empty.';
    } else {
      const res = await fetch('/api/bookmarks/recent');
      items = (await res.json()).bookmarks;
      title = 'Recently saved';
      countLabel = (n) => `latest ${n}`;
      emptyMessage = 'Nothing saved yet — paste a link above, or import your bookmarks.';
    }
    if (token !== viewToken) return;
    viewTitle.textContent = title;
    viewCount.textContent = items.length ? countLabel(items.length) : '';
    if (view.type === 'cluster') {
      viewIcon.textContent = listInitial(view.label);
      viewIcon.setAttribute('style', listIconStyle(view.id));
      viewIcon.classList.remove('hidden');
    } else {
      viewIcon.classList.add('hidden');
    }
    renderCards(searchResults, items, { emptyMessage });
  }

  // Re-render whatever list is showing (after a save or import) without
  // yanking the user out of the Import panel.
  function refreshView() {
    if (currentView.type !== 'import') loadCurrentList().catch(() => {});
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      showView(lastListView).catch(() => {});
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 220);
  });

  function runSearch(q) {
    return showView({ type: 'search', q });
  }

  document.getElementById('sidebar').addEventListener('click', (e) => {
    const item = e.target.closest('.side-item');
    if (!item) return;
    if (item.dataset.view === 'import') showView({ type: 'import' });
    else if (item.dataset.view === 'recent') showView({ type: 'recent' });
    else if (item.dataset.clusterId) {
      showView({
        type: 'cluster',
        id: item.dataset.clusterId,
        label: item.querySelector('.side-item-label').textContent,
      });
    }
  });
  function setViewMode(mode) {
    viewMode = mode;
    try {
      localStorage.setItem('bookmarkbrain_view_mode', mode);
    } catch {}
    applyViewMode();
  }
  document.getElementById('view-mode-grid').addEventListener('click', () => setViewMode('grid'));
  document.getElementById('view-mode-list').addEventListener('click', () => setViewMode('list'));
  applyViewMode();

  document.getElementById('sidebar-toggle').addEventListener('click', () => document.body.classList.add('sidebar-open'));
  document.getElementById('sidebar-close').addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  document.getElementById('sidebar-backdrop').addEventListener('click', () => document.body.classList.remove('sidebar-open'));

  function renderCards(container, items, { emptyMessage = 'Nothing here yet.' } = {}) {
    if (!items.length) {
      container.innerHTML = `<li class="grid-empty"><p>${escapeHtml(emptyMessage)}</p></li>`;
      refreshSelectionBarFor(container);
      return;
    }
    container.innerHTML = items
      .map((r) => {
        const isFallback = r.contentAvailable === false;
        const favicon = escapeAttr(faviconUrl(r.favicon, r.url));
        const image = r.image
          ? `<img class="card-thumb-img" src="${escapeAttr(r.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.card-thumb').classList.add('no-image');this.remove()" />`
          : '';
        const tag = isFallback
          ? `<span class="result-tag" title="${escapeAttr('Page unreachable: ' + (r.fetchError || 'unknown error'))}">Title only</span>`
          : '';
        const score = r.score !== undefined ? `<span class="result-score${isFallback ? ' result-score-fallback' : ''}">${Math.round(r.score * 100)}%</span>` : '';
        return `
        <li class="card">
          <a class="card-link" href="${escapeAttr(r.url)}" target="_blank" rel="noopener noreferrer">
            <div class="card-thumb${r.image ? '' : ' no-image'}">
              ${image}
              <img class="card-thumb-favicon" src="${favicon}" alt="" onerror="this.style.visibility='hidden'" />
            </div>
            <div class="card-body">
              <div class="card-title">${escapeHtml(r.title || r.url)}</div>
              ${r.description ? `<div class="card-desc">${escapeHtml(r.description)}</div>` : ''}
              <div class="card-meta">
                <img class="favicon" src="${favicon}" alt="" onerror="this.style.visibility='hidden'" />
                <span class="card-host">${escapeHtml(displayUrl(r.url))}</span>
                ${tag}${score}
              </div>
            </div>
          </a>
          ${selectCheckboxHtml(r.id)}
          ${deleteButtonHtml(r.id, r.title || r.url)}
        </li>`;
      })
      .join('');
    refreshSelectionBarFor(container);
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

  // ---------- paste a link to save it ----------
  const addUrlForm = document.getElementById('add-url-form');
  const addUrlInput = document.getElementById('add-url-input');
  const addUrlBtn = document.getElementById('add-url-btn');
  const addUrlStatus = document.getElementById('add-url-status');

  function setAddStatus(html, kind) {
    addUrlStatus.innerHTML = html;
    addUrlStatus.className = `add-url-status${kind ? ' ' + kind : ''}`;
  }

  // Pulls every link out of pasted text: whitespace-separated, scheme
  // optional ("example.com/a" becomes https://example.com/a), de-duplicated.
  function extractUrls(text) {
    const seen = new Set();
    const urls = [];
    for (const raw of text.split(/\s+/)) {
      let token = raw.replace(/^[<"']+/, '').replace(/[>"'.,;]+$/, '');
      if (!token) continue;
      if (!/^https?:\/\//i.test(token)) {
        if (!/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}([/?#]\S*)?$/i.test(token)) continue;
        token = 'https://' + token;
      }
      try {
        new URL(token);
      } catch {
        continue;
      }
      if (!seen.has(token)) {
        seen.add(token);
        urls.push(token);
      }
    }
    return urls;
  }

  async function saveOneLink(url) {
    const res = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save that link.');
    const title = escapeHtml(data.bookmark.title || url);
    const link = `<a href="${escapeAttr(data.bookmark.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`;
    if (data.outcome === 'already-saved') {
      setAddStatus(`Already in your collection: ${link}`, 'ok');
    } else if (data.outcome === 'partial') {
      setAddStatus(`Saved ${link} — the page couldn't be read, so it's searchable by title only.`, 'ok');
    } else if (data.outcome === 'failed') {
      setAddStatus(`Saved ${link}, but it couldn't be indexed yet — see the “failed” count above to retry.`, 'error');
    } else {
      setAddStatus(`Saved ${link}`, 'ok');
    }
  }

  async function saveManyLinks(urls) {
    const res = await fetch('/api/import-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmarks: urls.map((url) => ({ url })) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save those links.');
    await new Promise((resolve, reject) => {
      pollJob(data.jobId, {
        onTick: (job) => setAddStatus(`Saving ${job.done + job.partial + job.failed} of ${job.total} links…`),
        onDone: (job) => {
          const saved = job.done + job.partial;
          setAddStatus(
            `Saved ${saved} of ${job.total} links${job.failed ? ` (${job.failed} couldn't be indexed)` : ''}.`,
            job.failed ? 'error' : 'ok'
          );
          resolve();
        },
        onError: (message) => reject(new Error(message)),
      });
    });
  }

  async function submitAddUrl() {
    const urls = extractUrls(addUrlInput.value);
    if (urls.length === 0) {
      setAddStatus("That doesn't look like a link — paste a full URL, like https://example.com/article.", 'error');
      return;
    }
    addUrlBtn.disabled = true;
    addUrlInput.disabled = true;
    setAddStatus(urls.length === 1 ? 'Saving…' : `Saving ${urls.length} links…`);
    try {
      if (urls.length === 1) await saveOneLink(urls[0]);
      else await saveManyLinks(urls);
      addUrlInput.value = '';
      loadStats();
      refreshView();
    } catch (err) {
      setAddStatus(escapeHtml(err.message), 'error');
    } finally {
      addUrlBtn.disabled = false;
      addUrlInput.disabled = false;
      addUrlInput.focus();
    }
  }

  addUrlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAddUrl();
  });
  // Pasting a link saves it straight away -- no separate click needed.
  addUrlInput.addEventListener('paste', () => {
    setTimeout(() => {
      if (extractUrls(addUrlInput.value).length > 0) submitAddUrl();
    }, 0);
  });

  // ---------- clusters (the sidebar's lists) ----------
  async function loadClusters() {
    const res = await fetch('/api/clusters');
    const { clusters } = await res.json();
    clustersEmpty.classList.toggle('hidden', clusters.length > 0);
    clusterList.innerHTML = clusters
      .map(
        (c) => `
        <button class="side-item cluster-item" data-cluster-id="${c.id}">
          <span class="list-icon" style="${listIconStyle(c.id)}" aria-hidden="true">${escapeHtml(listInitial(c.label))}</span>
          <span class="side-item-label">${escapeHtml(c.label)}</span>
          <span class="side-badge">${c.size}</span>
        </button>`
      )
      .join('');
    // A list can vanish (its last bookmark was deleted); don't leave the
    // main area pointing at it.
    if (currentView.type === 'cluster' && !clusters.some((c) => String(c.id) === String(currentView.id))) {
      showView({ type: 'recent' }).catch(() => {});
      return;
    }
    setActiveNav();
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

  document.getElementById('view-clusters-btn').addEventListener('click', () => showView({ type: 'recent' }));

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

  // ---------- duplicate scan ----------
  const duplicatesScanBtn = document.getElementById('duplicates-scan-btn');
  const duplicatesProgress = document.getElementById('duplicates-progress');
  const duplicatesProgressFill = document.getElementById('duplicates-progress-fill');
  const duplicatesProgressStage = document.getElementById('duplicates-progress-stage');
  const duplicatesResult = document.getElementById('duplicates-result');

  duplicatesScanBtn.addEventListener('click', async () => {
    duplicatesResult.classList.add('hidden');
    duplicatesScanBtn.disabled = true;
    duplicatesProgress.classList.remove('hidden');
    duplicatesProgressFill.style.width = '20%';
    duplicatesProgressStage.textContent = 'Scanning…';

    try {
      const res = await fetch('/api/duplicates/scan', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');

      pollJob(data.jobId, {
        onTick: (job) => {
          duplicatesProgressFill.style.width = job.status === 'done' ? '100%' : '60%';
          duplicatesProgressStage.textContent = job.stage || 'Working…';
        },
        onDone: (job) => {
          duplicatesProgress.classList.add('hidden');
          duplicatesScanBtn.disabled = false;
          duplicatesResult.textContent =
            job.total > 0
              ? `Found ${job.total} possible duplicate group${job.total === 1 ? '' : 's'} — check the "possible dups" pill above to review.`
              : 'No duplicates found.';
          duplicatesResult.classList.remove('error');
          duplicatesResult.classList.remove('hidden');
          loadStats();
        },
        onError: (msg) => {
          duplicatesProgress.classList.add('hidden');
          duplicatesScanBtn.disabled = false;
          duplicatesResult.textContent = msg;
          duplicatesResult.classList.add('error');
          duplicatesResult.classList.remove('hidden');
        },
      });
    } catch (err) {
      duplicatesProgress.classList.add('hidden');
      duplicatesScanBtn.disabled = false;
      duplicatesResult.textContent = err.message;
      duplicatesResult.classList.add('error');
      duplicatesResult.classList.remove('hidden');
    }
  });

  // ---------- add preview images to bookmarks saved before thumbnails ----------
  const previewsBtn = document.getElementById('previews-btn');
  const previewsProgress = document.getElementById('previews-progress');
  const previewsProgressFill = document.getElementById('previews-progress-fill');
  const previewsProgressStage = document.getElementById('previews-progress-stage');
  const previewsResult = document.getElementById('previews-result');

  function finishPreviews(text, isError) {
    previewsProgress.classList.add('hidden');
    previewsBtn.disabled = false;
    previewsResult.textContent = text;
    previewsResult.classList.toggle('error', !!isError);
    previewsResult.classList.remove('hidden');
  }

  previewsBtn.addEventListener('click', async () => {
    previewsResult.classList.add('hidden');
    previewsBtn.disabled = true;
    previewsProgress.classList.remove('hidden');
    previewsProgressFill.style.width = '4%';
    previewsProgressStage.textContent = 'Starting…';
    try {
      const res = await fetch('/api/thumbnails/backfill', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start that.');
      pollJob(data.jobId, {
        onTick: (job) => {
          const handled = (job.done || 0) + (job.failed || 0);
          const pct = job.total ? Math.min(99, Math.round((handled / job.total) * 100)) : 8;
          previewsProgressFill.style.width = `${job.status === 'done' ? 100 : pct}%`;
          previewsProgressStage.textContent = job.stage || 'Working…';
        },
        onDone: (job) => {
          const bits = [`${job.done} preview image${job.done === 1 ? '' : 's'} added`];
          if (job.failed) bits.push(`${job.failed} page${job.failed === 1 ? '' : 's'} couldn't be reached (they'll be retried next time)`);
          finishPreviews(`Done — ${bits.join(', ')}.`, false);
          loadStats();
          refreshView();
        },
        onError: (msg) => finishPreviews(msg, true),
      });
    } catch (err) {
      finishPreviews(err.message, true);
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

  loadStats().then(() => showView({ type: 'recent' }));
})();
