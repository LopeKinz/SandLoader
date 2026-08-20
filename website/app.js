<script>
(function () {
  'use strict';

  /* ===================== theme ===================== */
  var root = document.documentElement;
  var themeBtn = document.getElementById('themeBtn');
  var icon = document.getElementById('themeIcon');
  var SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  var MOON = '<path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 105.9 15.6A8.6 8.6 0 0120 14.5z"/>';

  /* matchMedia is absent in some embedded/legacy webviews; degrade, never throw. */
  function mq(q) {
    try {
      if (window.matchMedia) return window.matchMedia(q);
    } catch (_) {}
    return { matches: false, addEventListener: function () {}, addListener: function () {} };
  }
  function onMQ(q, fn) {
    var m = mq(q);
    if (m.addEventListener) m.addEventListener('change', fn);
    else if (m.addListener) m.addListener(fn);
  }
  function prefersDark() { return mq('(prefers-color-scheme: dark)').matches; }
  function currentIsDark() {
    var t = root.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return prefersDark();
  }
  function syncIcon() {
    if (icon) icon.innerHTML = currentIsDark() ? MOON : SUN;
  }
  syncIcon();
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      root.setAttribute('data-theme', currentIsDark() ? 'light' : 'dark');
      syncIcon();
      window.dispatchEvent(new Event('themechange'));
    });
  }
  onMQ('(prefers-color-scheme: dark)', function () {
    if (!root.getAttribute('data-theme')) { syncIcon(); window.dispatchEvent(new Event('themechange')); }
  });

  /* ===================== router ===================== */
  var VIEWS = ['home', 'docs', 'mods', 'reference', 'faq'];
  var TITLES = { docs: 'Documentation', mods: 'Making mods', reference: 'Reference', faq: 'FAQ' };
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.hnav a[data-view]'));
  var menuBtn = document.getElementById('menuBtn');
  var hnav = document.getElementById('hnav');

  function parseHash() {
    var h = location.hash || '#/';
    var m = /^#\/([a-z]*)(?:#(.*))?$/.exec(h);
    if (!m) return { view: 'home', frag: '' };
    var v = m[1] || 'home';
    if (VIEWS.indexOf(v) === -1) v = 'home';
    return { view: v, frag: m[2] || '' };
  }

  function render(scroll) {
    var r = parseHash();
    VIEWS.forEach(function (v) {
      var el = document.getElementById('view-' + v);
      if (el) el.classList.toggle('on', v === r.view);
    });
    navLinks.forEach(function (a) {
      if (a.getAttribute('data-view') === r.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.title = r.view === 'home'
      ? 'SandLoader'
      : 'SandLoader — ' + (TITLES[r.view] || r.view);

    if (hnav) hnav.classList.remove('open');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');

    buildTOC(r.view);

    syncSideActive(r);

    if (scroll !== false) {
      var t = r.frag ? document.getElementById(r.frag) : null;
      try {
        if (t) t.scrollIntoView({ behavior: 'auto', block: 'start' });
        else window.scrollTo(0, 0);
      } catch (_) {
        if (t && t.offsetTop != null) window.scrollTo(0, t.offsetTop);
      }
    }
  }

  function syncSideActive(r) {
    var view = document.getElementById('view-' + r.view);
    if (!view) return;
    var links = view.querySelectorAll('.side a');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var frag = href.split('#')[2] || '';
      links[i].classList.toggle('active', !!r.frag && frag === r.frag);
    }
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[data-nav]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) !== '#') return;
    e.preventDefault();
    if (location.hash === href) { render(true); }
    else location.hash = href;
  });
  window.addEventListener('hashchange', function () { render(true); });

  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      var open = hnav.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ===================== headings: anchors + TOC ===================== */
  var HEADINGS = {};
  VIEWS.forEach(function (v) {
    var view = document.getElementById('view-' + v);
    if (!view) return;
    var hs = view.querySelectorAll('.doc h2[id], .doc h3[id]');
    HEADINGS[v] = Array.prototype.slice.call(hs);
    HEADINGS[v].forEach(function (h) {
      var a = document.createElement('a');
      a.className = 'anchor';
      a.href = '#/' + (v === 'home' ? '' : v) + '#' + h.id;
      a.textContent = '#';
      a.setAttribute('aria-label', 'Link to this section');
      a.setAttribute('data-nav', '');
      h.appendChild(a);
    });
  });

  function buildTOC(view) {
    var toc = document.getElementById('toc-' + view);
    if (!toc) return;
    if (toc.getAttribute('data-built') === '1') return;
    var hs = (HEADINGS[view] || []).filter(function (h) { return h.tagName === 'H2'; });
    hs.forEach(function (h) {
      var a = document.createElement('a');
      a.href = '#/' + view + '#' + h.id;
      a.setAttribute('data-nav', '');
      a.textContent = h.textContent.replace(/#$/, '').trim();
      a.setAttribute('data-target', h.id);
      toc.appendChild(a);
    });
    toc.setAttribute('data-built', '1');
  }

  /* scroll-spy across the visible view */
  var spyTick = null;
  function spy() {
    if (spyTick) return;
    spyTick = requestAnimationFrame(function () {
      spyTick = null;
      var r = parseHash();
      var hs = (HEADINGS[r.view] || []).filter(function (h) { return h.tagName === 'H2'; });
      if (!hs.length) return;
      var top = 90, best = hs[0].id;
      for (var i = 0; i < hs.length; i++) {
        if (hs[i].getBoundingClientRect().top <= top) best = hs[i].id;
      }
      var toc = document.getElementById('toc-' + r.view);
      if (toc) {
        var links = toc.querySelectorAll('a');
        for (var j = 0; j < links.length; j++)
          links[j].classList.toggle('active', links[j].getAttribute('data-target') === best);
      }
      var view = document.getElementById('view-' + r.view);
      if (view) {
        var sl = view.querySelectorAll('.side a');
        for (var k = 0; k < sl.length; k++) {
          var frag = (sl[k].getAttribute('href') || '').split('#')[2] || '';
          sl[k].classList.toggle('active', frag === best);
        }
      }
    });
  }
  window.addEventListener('scroll', spy, { passive: true });

  /* ===================== copy buttons ===================== */
  Array.prototype.forEach.call(document.querySelectorAll('.codewrap'), function (w) {
    var pre = w.querySelector('pre');
    if (!pre) return;
    var b = document.createElement('button');
    b.className = 'copy';
    b.type = 'button';
    b.textContent = 'Copy';
    b.addEventListener('click', function () {
      var text = pre.innerText;
      function done() {
        b.textContent = 'Copied';
        b.classList.add('done');
        setTimeout(function () { b.textContent = 'Copy'; b.classList.remove('done'); }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (_) {}
        document.body.removeChild(ta);
      }
    });
    w.appendChild(b);
  });

  /* ===================== search ===================== */
  var INDEX = [];
  VIEWS.forEach(function (v) {
    var view = document.getElementById('view-' + v);
    if (!view) return;
    var label = v === 'home' ? 'Overview' : (TITLES[v] || v);

    (HEADINGS[v] || []).forEach(function (h) {
      var body = '';
      var n = h.nextElementSibling;
      var hops = 0;
      while (n && hops < 6 && !/^H[123]$/.test(n.tagName)) {
        body += ' ' + (n.textContent || '');
        n = n.nextElementSibling; hops++;
      }
      INDEX.push({
        view: v, viewLabel: label, id: h.id,
        title: h.textContent.replace(/#$/, '').trim(),
        body: body.replace(/\s+/g, ' ').trim().slice(0, 260)
      });
    });

    Array.prototype.forEach.call(view.querySelectorAll('details'), function (d) {
      var s = d.querySelector('summary'), a = d.querySelector('.a');
      if (!s) return;
      INDEX.push({
        view: v, viewLabel: label, id: '',
        title: s.textContent.trim(),
        body: (a ? a.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 260)
      });
    });
  });

  var dlg = document.getElementById('searchDlg');
  var input = document.getElementById('searchInput');
  var results = document.getElementById('searchResults');
  var openBtn = document.getElementById('openSearch');
  var sel = 0, current = [];

  function openSearch() {
    dlg.classList.add('on');
    input.value = '';
    draw([]);
    setTimeout(function () { input.focus(); }, 10);
  }
  function closeSearch() { dlg.classList.remove('on'); }

  function score(item, q) {
    var t = item.title.toLowerCase(), b = item.body.toLowerCase();
    if (t === q) return 100;
    if (t.indexOf(q) === 0) return 80;
    if (t.indexOf(q) !== -1) return 60;
    if (b.indexOf(q) !== -1) return 30;
    // all terms present
    var parts = q.split(/\s+/).filter(Boolean);
    if (parts.length > 1 && parts.every(function (p) { return t.indexOf(p) !== -1 || b.indexOf(p) !== -1; })) return 20;
    return 0;
  }

  function draw(list) {
    current = list; sel = 0;
    if (!list.length) {
      results.innerHTML = '<div class="sempty">' +
        (input.value.trim() ? 'No matches.' : 'Search headings and answers across the site.') +
        '</div>';
      return;
    }
    results.innerHTML = '';
    list.forEach(function (it, i) {
      var a = document.createElement('a');
      a.href = '#/' + (it.view === 'home' ? '' : it.view) + (it.id ? '#' + it.id : '');
      a.setAttribute('data-nav', '');
      a.className = i === 0 ? 'sel' : '';
      a.innerHTML = '<div class="sv">' + esc(it.viewLabel) + '</div>' +
                    '<div class="st">' + esc(it.title) + '</div>' +
                    (it.body ? '<div class="sc">' + esc(it.body) + '</div>' : '');
      a.addEventListener('click', function () { closeSearch(); });
      results.appendChild(a);
    });
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }
  function markSel() {
    var items = results.querySelectorAll('a');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('sel', i === sel);
    if (items[sel]) items[sel].scrollIntoView({ block: 'nearest' });
  }

  if (input) {
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      if (!q) return draw([]);
      var hits = [];
      INDEX.forEach(function (it) {
        var s = score(it, q);
        if (s > 0) hits.push({ s: s, it: it });
      });
      hits.sort(function (a, b) { return b.s - a.s; });
      draw(hits.slice(0, 12).map(function (h) { return h.it; }));
    });
    input.addEventListener('keydown', function (e) {
      var items = results.querySelectorAll('a');
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); markSel(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); markSel(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (items[sel]) items[sel].click(); e.preventDefault(); }
      else if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
    });
  }
  if (openBtn) openBtn.addEventListener('click', openSearch);
  if (dlg) dlg.addEventListener('click', function (e) { if (e.target === dlg) closeSearch(); });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
    if (!typing && (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'k'))) {
      openSearch(); e.preventDefault();
    }
    if (e.key === 'Escape' && dlg.classList.contains('on')) closeSearch();
  });

  /* ===================== boot ===================== */
  render(true);
  spy();
})();
</script>
