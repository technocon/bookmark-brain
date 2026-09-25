// Applies the saved theme (System / Light / Dark) before first paint, so a
// page never flashes the wrong palette. Loaded synchronously in <head> on
// every page. "System" means no data-theme attribute at all, which leaves the
// stylesheet's prefers-color-scheme media query in charge.
(function () {
  var KEY = 'bookmarkbrain_theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function apply(mode) {
    var root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var light = mode === 'light' || (mode === 'system' && mq && mq.matches);
      meta.setAttribute('content', light ? '#f4f4f2' : '#0f1115');
    }
  }

  apply(stored());

  window.BBTheme = {
    get: stored,
    set: function (mode) {
      try {
        if (mode === 'light' || mode === 'dark') localStorage.setItem(KEY, mode);
        else localStorage.removeItem(KEY);
      } catch (e) {}
      apply(mode);
    },
  };

  if (mq && mq.addEventListener) {
    mq.addEventListener('change', function () {
      if (stored() === 'system') apply('system');
    });
  }
})();
