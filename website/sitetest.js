/* Real DOM test of the published page: routing, search, TOC, copy, theme. */
const fs = require('fs');
/* Requires jsdom, which is intentionally NOT a project dependency - SandLoader
   itself ships with none. Install it on demand:  npm i --no-save jsdom  */
let JSDOM
try {
  ({ JSDOM } = require('jsdom'))
} catch (e) {
  console.log('SKIP  jsdom is not installed - run `npm i --no-save jsdom` to run these checks')
  process.exit(0)
}

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const page = '<!doctype html><html><head></head><body>' + html + '</body></html>';

let fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  - ' + extra : ''));
  if (!cond) fail++;
}

const dom = new JSDOM(page, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.test/',
});
const { window } = dom;
const doc = window.document;

// canvas getContext is not implemented in bare jsdom; stub it so the wordmark runs.
window.HTMLCanvasElement.prototype.getContext = function () {
  return { setTransform(){}, clearRect(){}, fillRect(){}, save(){}, restore(){},
           scale(){}, drawImage(){}, putImageData(){},
           createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
           set fillStyle(v){}, get fillStyle(){return '#000'},
           set imageSmoothingEnabled(v){}, get imageSmoothingEnabled(){return false} };
};

setTimeout(() => {
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => Array.from(doc.querySelectorAll(s));

  // ---- structure
  ok('all five views exist',
     ['home','docs','mods','reference','faq'].every(v => doc.getElementById('view-' + v)));
  ok('header nav has 5 links', $$('.hnav a[data-view]').length === 5,
     $$('.hnav a[data-view]').length + '');

  // ---- default route shows overview only
  const shown = () => $$('.view').filter(v => v.classList.contains('on')).map(v => v.id);
  ok('default route shows overview', shown().join() === 'view-home', shown().join());

  // ---- navigate to docs
  window.location.hash = '#/docs';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  ok('navigating to #/docs swaps view', shown().join() === 'view-docs', shown().join());
  ok('active nav item marked',
     $('.hnav a[data-view="docs"]').getAttribute('aria-current') === 'page');
  ok('document title updates', /Documentation/i.test(doc.title), doc.title);

  // ---- deep link with fragment
  window.location.hash = '#/reference#limits';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  ok('deep link opens reference', shown().join() === 'view-reference', shown().join());
  ok('deep-link target exists', !!doc.getElementById('limits'));
  const sideActive = $$('#view-reference .side a.active').map(a => a.textContent);
  ok('sidebar marks deep-linked section', sideActive.length > 0, sideActive.join());

  // ---- unknown route falls back
  window.location.hash = '#/nonsense';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  ok('unknown route falls back to overview', shown().join() === 'view-home', shown().join());

  // ---- TOC built per view
  window.location.hash = '#/docs';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  const tocLinks = $$('#toc-docs a');
  ok('docs TOC is built', tocLinks.length >= 6, tocLinks.length + ' entries');
  ok('TOC links point into docs view',
     tocLinks.every(a => a.getAttribute('href').startsWith('#/docs#')));

  // ---- heading anchors
  ok('headings get anchor links', $$('#view-docs .doc h2 .anchor').length >= 6,
     $$('#view-docs .doc h2 .anchor').length + '');

  // ---- copy buttons
  const copies = $$('.copy');
  ok('copy buttons added to code blocks', copies.length >= 8, copies.length + ' buttons');
  ok('every codewrap has exactly one copy button',
     $$('.codewrap').every(w => w.querySelectorAll('.copy').length === 1));

  // ---- search
  const input = doc.getElementById('searchInput');
  let r0 = [];
  const search0 = (q) => { input.value = q;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return $$('#searchResults a'); };
  doc.getElementById('openSearch').dispatchEvent(new window.MouseEvent('click', {bubbles:true}));
  ok('search dialog opens', doc.getElementById('searchDlg').classList.contains('on'));

  function search(q) {
    input.value = q;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return $$('#searchResults a');
  }
  let r = search('workshop');
  ok('search finds "workshop"', r.length > 0, r.length + ' hits: ' + (r[0] && r[0].querySelector('.st').textContent));
  r = search('permissions');
  ok('search finds "permissions"', r.length > 0, (r[0] && r[0].querySelector('.st').textContent) || '');
  r = search('banned');
  ok('search reaches FAQ answers', r.length > 0, (r[0] && r[0].querySelector('.st').textContent) || '');
  r = search('zzzznotathing');
  ok('search handles no matches', r.length === 0 && /No matches/.test(doc.getElementById('searchResults').textContent));
  r = search('achievements');
  ok('search result links are routable',
     r.length > 0 && r[0].getAttribute('href').startsWith('#/'),
     r[0] && r[0].getAttribute('href'));

  // ---- making-mods view + compatibility section
  window.location.hash = '#/mods#compatible';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  ok('mods view opens', shown().join() === 'view-mods', shown().join());
  ok('compatibility section exists', !!doc.getElementById('compatible'));
  ok('compatibility heading is the asked-for title',
     /How to make my mod compatible/i.test(doc.getElementById('compatible').textContent),
     doc.getElementById('compatible').textContent.replace('#','').trim());
  ok('mods TOC is built', $$('#toc-mods a').length >= 8, $$('#toc-mods a').length + ' entries');
  ok('compatibility cites the verified alias count', /91/.test(doc.getElementById('view-mods').textContent));
  ok('do/dont pairs present', $$('#view-mods .dodont').length >= 3,
     $$('#view-mods .dodont').length + ' pairs');
  ok('compatibility matrix present', $$('#view-mods .mrow').length >= 5,
     $$('#view-mods .mrow').length + ' rows');
  r0 = search0('compatible');
  ok('search finds the compatibility section', r0.length > 0,
     (r0[0] && r0[0].querySelector('.st').textContent) || '');

  // ---- theme toggle
  const before = doc.documentElement.getAttribute('data-theme');
  doc.getElementById('themeBtn').dispatchEvent(new window.MouseEvent('click', {bubbles:true}));
  const after = doc.documentElement.getAttribute('data-theme');
  ok('theme toggle sets data-theme', after === 'dark' || after === 'light', before + ' -> ' + after);
  doc.getElementById('themeBtn').dispatchEvent(new window.MouseEvent('click', {bubbles:true}));
  ok('theme toggle flips back', doc.documentElement.getAttribute('data-theme') !== after);

  // ---- links integrity
  const ids = new Set($$('[id]').map(e => e.id));
  const broken = $$('a[href^="#/"]')
    .map(a => a.getAttribute('href').split('#')[2])
    .filter(f => f && !ids.has(f));
  ok('no broken in-page fragments', broken.length === 0, broken.join(', '));

  const views = new Set(['', 'docs', 'mods', 'reference', 'faq']);
  const badRoutes = $$('a[href^="#/"]')
    .map(a => (/^#\/([a-z]*)/.exec(a.getAttribute('href')) || [])[1])
    .filter(v => v !== undefined && !views.has(v));
  ok('no unknown routes linked', badRoutes.length === 0, badRoutes.join(', '));

  // ---- header: exactly one wordmark, no duplicate text
  const brand = $('.brand');
  ok('header has one brand link', $$('.brand').length === 1);
  ok('brand contains a canvas mark', !!brand.querySelector('canvas'));
  ok('brand has no duplicate text label',
     brand.textContent.replace(/\s/g, '') === '',
     JSON.stringify(brand.textContent.trim()));
  ok('brand is still labelled for screen readers',
     /sandloader/i.test(brand.getAttribute('aria-label') || '') ||
     /sandloader/i.test((brand.querySelector('canvas').getAttribute('aria-label')) || ''));
  const headerText = $('.hdr').textContent.toLowerCase();
  ok('header text mentions SandLoader at most once',
     (headerText.match(/sandloader/g) || []).length <= 1,
     JSON.stringify($('.hdr').textContent.trim().slice(0,60)));

  // ---- scrollbar hygiene
  const cssText = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok('sticky columns hide their gutter', /\.side::-webkit-scrollbar/.test(cssText) &&
     /\.toc::-webkit-scrollbar/.test(cssText));
  ok('page cannot scroll sideways', /html,body\{max-width:100%;overflow-x:hidden\}/.test(cssText));
  ok('tables no longer force a min-width at desktop',
     /table\{min-width:0\}/.test(cssText));
  ok('scrollbars are thinned and themed', /scrollbar-width:thin/.test(cssText));

  // ---- vanilla-branch-only constraint
  const homeTxt = doc.getElementById('view-home').textContent;
  ok('overview states vanilla branch only', /vanilla branch only/i.test(homeTxt));
  ok('overview names the modded branch as unsupported',
     /modded branch/i.test(homeTxt) && /not supported/i.test(homeTxt));

  window.location.hash = '#/docs#branch';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  ok('docs has a Which branch section', !!doc.getElementById('branch'));
  const branchTxt = doc.getElementById('view-docs').textContent;
  ok('branch section names the public branch', /public/.test(branchTxt));
  ok('branch section explains the API generation split',
     /sandkit v1/i.test(branchTxt) && /legacy/i.test(branchTxt));
  ok('branch section tells you how to switch back', /betas/i.test(branchTxt));
  ok('requirements table has a Branch row',
     /<td><strong>Branch<\/strong><\/td>/.test(doc.getElementById('view-docs').innerHTML));

  const modsTxt = doc.getElementById('view-mods').textContent;
  ok('modding guide leads with the branch constraint',
     /vanilla branch/i.test(modsTxt));
  ok('compatibility section has a rule 0 for the branch',
     /0\.\s*Target the vanilla branch/i.test(modsTxt));
  ok('matrix flags the modded branch', /vanilla only/i.test(modsTxt));

  const faqTxt = doc.getElementById('view-faq').textContent;
  ok('FAQ answers the experimental branch question',
     /experimental\s*\/?\s*modded branch/i.test(faqTxt));

  r0 = search0('branch');
  ok('search finds the branch guidance', r0.length > 0,
     (r0[0] && r0[0].querySelector('.st').textContent) || '');

  // ---- content sanity
  const text = doc.body.textContent;
  ok('states 130/130 self-test', /130\s*\/\s*130/.test(text));
  ok('states 0.5.5 game version', /0\.5\.5/.test(text));
  ok('no lorem/TODO text in copy', !/lorem ipsum|TODO|FIXME/i.test(text));

  console.log('\n' + (fail === 0 ? 'all site checks passed' : fail + ' FAILED'));
  process.exit(fail ? 1 : 0);
}, 120);
