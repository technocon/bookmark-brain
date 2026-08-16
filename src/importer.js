const cheerio = require('cheerio');

/**
 * Parses a Netscape-format bookmarks export (the HTML file every major
 * browser produces from Bookmarks Manager -> Export). Folder nesting is
 * flattened into a single "folder path" string per bookmark, e.g.
 * "Dev / Frontend / CSS".
 */
function parseBookmarksHtml(html) {
  const $ = cheerio.load(html, { xmlMode: false });
  const results = [];
  const seen = new Set();

  function walk(node, folderPath) {
    $(node)
      .children()
      .each((_, el) => {
        const tag = el.tagName?.toLowerCase();
        if (tag === 'dt') {
          const $dt = $(el);
          const $h3 = $dt.children('h3').first();
          const $a = $dt.children('a').first();

          if ($h3.length) {
            const folderName = $h3.text().trim();
            const nextPath = folderPath ? `${folderPath} / ${folderName}` : folderName;
            const $dl = $dt.children('dl').first();
            if ($dl.length) walk($dl.get(0), nextPath);
          } else if ($a.length) {
            const url = ($a.attr('href') || '').trim();
            const title = $a.text().trim() || url;
            const addDate = $a.attr('add_date');
            const icon = $a.attr('icon');
            if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
              seen.add(url);
              results.push({
                url,
                title,
                folder: folderPath,
                addedAt: addDate ? Number(addDate) : null,
                favicon: icon || null,
              });
            }
          }
        } else if (tag === 'dl') {
          walk(el, folderPath);
        }
      });
  }

  const root = $('dl').first();
  if (root.length) {
    walk(root.get(0), '');
  } else {
    // Fallback: some exports are just a flat list of <a> tags.
    $('a').each((_, el) => {
      const $a = $(el);
      const url = ($a.attr('href') || '').trim();
      const title = $a.text().trim() || url;
      if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        results.push({ url, title, folder: '', addedAt: null, favicon: null });
      }
    });
  }

  return results;
}

module.exports = { parseBookmarksHtml };
