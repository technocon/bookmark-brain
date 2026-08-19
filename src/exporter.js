function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Inverse of importer.js's parseBookmarksHtml: rebuilds a standard
 * Netscape Bookmark File (the format every browser both produces and
 * consumes, and the only format the Import tab accepts) from bookmarks
 * carrying a flattened "A / B / C" folder path, re-nesting that path back
 * into <H3> folder markup. Matches the exact
 * <DT><H3>...</H3>\n<DL><p>...</DL><p> shape real browser exports use,
 * which parseBookmarksHtml is written against — so a file this produces
 * round-trips correctly through this app's own importer, and through any
 * other Bookmark Brain server's (self-hosted or cloud share the same
 * parser).
 */
function buildBookmarksHtml(bookmarks) {
  const root = { links: [], children: new Map() };
  for (const b of bookmarks) {
    const segments = (b.folder || '').split(' / ').map((s) => s.trim()).filter(Boolean);
    let node = root;
    for (const seg of segments) {
      if (!node.children.has(seg)) node.children.set(seg, { links: [], children: new Map() });
      node = node.children.get(seg);
    }
    node.links.push(b);
  }

  function render(node, indent) {
    const pad = '    '.repeat(indent);
    let out = '';
    for (const b of node.links) {
      const addDate = Number.isFinite(b.addedAt) ? ` ADD_DATE="${b.addedAt}"` : '';
      out += `${pad}<DT><A HREF="${escapeHtml(b.url)}"${addDate}>${escapeHtml(b.title)}</A>\n`;
    }
    for (const [name, child] of node.children) {
      out += `${pad}<DT><H3>${escapeHtml(name)}</H3>\n`;
      out += `${pad}<DL><p>\n`;
      out += render(child, indent + 1);
      out += `${pad}</DL><p>\n`;
    }
    return out;
  }

  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${render(root, 1)}</DL><p>
`;
}

module.exports = { buildBookmarksHtml };
