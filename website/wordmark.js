<script>
/* Animated SANDLOADER wordmark: pixel letterforms built from sand-coloured
   brick and darker machine segments, assembled by blocks falling into place. */
(function () {
  var FONT = {
    S:['01111','10000','10000','01110','00001','00001','11110'],
    A:['01110','10001','10001','11111','10001','10001','10001'],
    N:['10001','11001','11001','10101','10011','10011','10001'],
    D:['11110','10001','10001','10001','10001','10001','11110'],
    L:['10000','10000','10000','10000','10000','10000','11111'],
    O:['01110','10001','10001','10001','10001','10001','01110'],
    E:['11111','10000','10000','11110','10000','10000','11111'],
    R:['11110','10001','10001','11110','10100','10010','10001']
  };
  var WORD = 'SANDLOADER', H = 7, GAP = 1;
  var M_SAND = 1, M_MACH = 2, M_TRIM = 3;

  function buildTarget(withDetail) {
    var out = [], cur = 0;
    for (var n = 0; n < WORD.length; n++) {
      var g = FONT[WORD[n]], w = g[0].length;
      for (var r = 0; r < H; r++)
        for (var col = 0; col < w; col++)
          if (g[r][col] === '1') out.push({ x: cur + col, y: r, mat: M_SAND });
      cur += w + GAP;
    }
    var width = cur - GAP;

    if (withDetail) {
      var rowsMap = {};
      out.forEach(function (b) { (rowsMap[b.y] = rowsMap[b.y] || []).push(b); });
      Object.keys(rowsMap).forEach(function (rk) {
        var row = rowsMap[rk].sort(function (a, b) { return a.x - b.x; });
        var i = 0;
        while (i < row.length) {
          var s = i;
          while (i + 1 < row.length && row[i + 1].x === row[i].x + 1) i++;
          if (i - s + 1 >= 3 && Math.random() < .5)
            for (var k = s; k <= i; k++) row[k].mat = M_MACH;
          i++;
        }
      });
      var tops = {};
      out.forEach(function (b) { if (tops[b.x] === undefined || b.y < tops[b.x]) tops[b.x] = b.y; });
      Object.keys(tops).forEach(function (x) {
        if (Math.random() < .06) out.push({ x: +x, y: tops[x] - 1, mat: M_TRIM });
      });
    }
    return { blocks: out, width: width };
  }

  function shade(hex, amt) {
    var h = String(hex).trim().replace('#', '');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    if (isNaN(r)) return hex;
    function f(v){ return Math.max(0, Math.min(255, Math.round(amt<0 ? v*(1+amt) : v+(255-v)*amt))); }
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }

  function makeRenderer(canvas, opts) {
    var ctx = canvas.getContext('2d');
    var t = buildTarget(opts.detail);
    var blocks = t.blocks, wordW = t.width;
    var px = 4, offX = 0, offY = 0;
    var COL = {};

    function readTheme() {
      var cs = getComputedStyle(document.documentElement);
      function g(n, d) { var v = (cs.getPropertyValue(n) || '').trim(); return v || d; }
      COL.sand = g('--sand', '#E0AC55');
      COL.hi = shade(COL.sand, .26);
      COL.lo = shade(COL.sand, -.26);
      COL.mach = g('--ground-3', '#231F1B');
      COL.machHi = shade(COL.mach, .5);
      COL.trim = g('--verd', '#7BAF8C');
    }
    readTheme();

    function layout() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return false;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      var rows = H + (opts.detail ? 1 : 0);
      px = Math.max(1, Math.floor(Math.min(w / wordW, h / rows)));
      offX = Math.round((w - wordW * px) / 2);
      offY = Math.round((h - H * px) / 2);
      if (opts.detail) offY += Math.round(px * .5);   // room for the trim caps
      return true;
    }

    function drawBlock(b, sx, sy) {
      var s = px, body, hi, lo;
      if (b.mat === M_MACH) { body = COL.mach; hi = COL.machHi; lo = COL.mach; }
      else if (b.mat === M_TRIM) { body = COL.trim; hi = shade(COL.trim,.3); lo = shade(COL.trim,-.3); }
      else { body = COL.sand; hi = COL.hi; lo = COL.lo; }
      ctx.fillStyle = body;
      ctx.fillRect(sx, sy, s, s);
      if (s >= 5) {
        var e = Math.max(1, Math.round(s * .17));
        ctx.fillStyle = hi;
        ctx.fillRect(sx, sy, s, e); ctx.fillRect(sx, sy, e, s);
        ctx.fillStyle = lo;
        ctx.fillRect(sx, sy + s - e, s, e); ctx.fillRect(sx + s - e, sy, e, s);
        if (b.mat === M_MACH && s >= 8) {
          ctx.fillStyle = COL.machHi;
          var d = Math.max(1, Math.round(s * .2));
          ctx.fillRect(sx + Math.round((s-d)/2), sy + Math.round((s-d)/2), d, d);
        }
      }
    }

    function paintStatic() {
      if (!layout()) return;
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      blocks.forEach(function (b) {
        drawBlock(b, offX + b.x * px, offY + b.y * px);
      });
    }

    return { layout: layout, drawBlock: drawBlock, paintStatic: paintStatic,
             blocks: blocks, readTheme: readTheme,
             get px(){return px}, get offX(){return offX}, get offY(){return offY} };
  }

  function mq(q) {
    try { if (window.matchMedia) return window.matchMedia(q); } catch (_) {}
    return { matches: false, addEventListener: function () {}, addListener: function () {} };
  }
  function onMQ(q, fn) {
    var m = mq(q);
    if (m.addEventListener) m.addEventListener('change', fn);
    else if (m.addListener) m.addListener(fn);
  }
  var reduce = mq('(prefers-reduced-motion: reduce)');

  /* ---- header brandmark: always static, tiny ---- */
  var brand = document.getElementById('brandmark');
  if (brand) {
    var bm = makeRenderer(brand, { detail: false });
    brand.style.width = '';
    bm.paintStatic();
    window.addEventListener('themechange', function () { bm.readTheme(); bm.paintStatic(); });
    onMQ('(prefers-color-scheme: dark)', function () { bm.readTheme(); bm.paintStatic(); });
  }

  /* ---- hero wordmark: animated assembly ---- */
  var hero = document.getElementById('wordmark');
  if (!hero) return;
  var R = makeRenderer(hero, { detail: true });
  var state = [], t0 = 0, running = false, done = false, visible = true;

  function reset() {
    state = R.blocks.map(function (b) {
      return { b: b, y: -(3 + Math.random() * 22), v: 0,
               delay: b.x * 1.5 + Math.random() * 8, set: false };
    });
    t0 = performance.now();
    done = false;
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!visible) return;
    var w = hero.clientWidth, h = hero.clientHeight;
    hero.getContext('2d').clearRect(0, 0, w, h);
    var el = (now - t0) / 16.67, settled = 0, px = R.px;
    for (var i = 0; i < state.length; i++) {
      var s = state[i];
      if (!s.set) {
        if (el > s.delay) {
          s.v += 0.05 * px;
          s.y += s.v / px;
          if (s.y >= s.b.y) {
            if (s.v > 1.1 * px) { s.v = -s.v * 0.2; s.y = s.b.y - Math.abs(s.v) / px; }
            else { s.y = s.b.y; s.set = true; s.v = 0; }
          }
        }
      } else settled++;
      R.drawBlock(s.b, R.offX + s.b.x * px, Math.round(R.offY + s.y * px));
    }
    if (settled === state.length) { running = false; done = true; }
  }

  function startAnim() {
    if (!R.layout()) return;
    reset();
    running = true;
    requestAnimationFrame(frame);
  }

  if (reduce.matches) R.paintStatic();
  else startAnim();

  hero.style.cursor = 'pointer';
  hero.addEventListener('click', function () {
    if (reduce.matches || running) return;
    startAnim();
  });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (running) { R.layout(); }
      else R.paintStatic();
    }, 150);
  });
  function repaint() { R.readTheme(); if (!running) R.paintStatic(); }
  window.addEventListener('themechange', repaint);
  onMQ('(prefers-color-scheme: dark)', repaint);

  if (window.IntersectionObserver) {
    new IntersectionObserver(function (es) { visible = es[0].isIntersecting; },
      { threshold: 0 }).observe(hero);
  }
})();
</script>
