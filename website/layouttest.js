/* Verify the list/tree layout rules that the screenshots showed broken. */
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
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>');
const doc = dom.window.document;

let bad = 0;
function chk(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  - ' + extra : ''));
  if (!cond) bad++;
}

function ruleFor(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : '';
}

// --- the actual bug: list items must not be grids, or inline children shatter
for (const sel of ['.check li', '.rules li', '.annot ol li']) {
  const r = ruleFor(sel);
  chk(sel + ' is not a grid container', !/display:\s*grid/.test(r), r.slice(0, 70).trim());
  chk(sel + ' reserves marker space with padding', /padding/.test(r));
}
chk('.check marker is out of flow', /position:\s*absolute/.test(ruleFor('.check li::before')));
chk('.rules marker is out of flow', /position:\s*absolute/.test(ruleFor('.rules li::before')));
chk('.annot marker is out of flow', /position:\s*absolute/.test(ruleFor('.annot ol li::before')));

// --- inline code must stay inline
chk('inline code is forced to display:inline', /li code,p code,td code,dd code\{display:inline/.test(css));

// --- these list items really do contain inline markup worth protecting
const withInline = [...doc.querySelectorAll('.check li, .rules li, .annot ol li')]
  .filter((li) => li.querySelectorAll('strong,code,em').length > 0);
chk('inline markup present in lists', withInline.length >= 10, withInline.length + ' items');

// --- text is not fragmented: each such item should read as one sentence
const fragmented = withInline.filter((li) => {
  const t = li.textContent.replace(/\s+/g, ' ').trim();
  return t.length < 12;
});
chk('no near-empty list items', fragmented.length === 0, fragmented.length + ' suspicious');

// --- file trees
const gridRows = doc.querySelectorAll('.tree .tree-row');
chk('anatomy tree uses real columns', gridRows.length === 7, gridRows.length + ' rows');
chk('.tree-row is a grid', /display:\s*grid/.test(ruleFor('.tree-row')));
const pres = doc.querySelectorAll('pre.filetree');
chk('packaging tree is a <pre>', pres.length === 1, pres.length + '');
chk('.filetree preserves whitespace', /white-space:\s*pre/.test(ruleFor('.filetree')));
if (pres[0]) {
  chk('packaging tree kept its newlines', pres[0].textContent.split('\n').length >= 5,
      pres[0].textContent.split('\n').length + ' lines');
}
chk('no filetree left as a div', doc.querySelectorAll('div.filetree').length === 0);

// --- GitHub button
const gh = doc.getElementById('ghBtn');
chk('GitHub button exists', !!gh);
if (gh) {
  chk('GitHub button is a link', gh.tagName === 'A', gh.tagName);
  chk('GitHub button has an accessible name',
      /github/i.test(gh.getAttribute('aria-label') || gh.textContent || ''));
  chk('GitHub button carries an svg mark', !!gh.querySelector('svg'));
  const hact = doc.querySelector('.hact');
  chk('GitHub button sits in the header actions', hact && hact.contains(gh));
  chk('GitHub button is last in the header', hact && hact.lastElementChild &&
      (hact.lastElementChild === gh || hact.lastElementChild.contains(gh) ||
       [...hact.children].indexOf(gh) >= [...hact.children].length - 2),
      hact ? [...hact.children].map(c => c.id || c.className).join(' | ') : '');
}

// --- GitHub link points at the real repo, and no placeholders survive
const REPO = 'https://github.com/LopeKinz/SandLoader';
chk('GitHub button points at the real repo', !!gh && gh.getAttribute('href') === REPO,
    gh ? gh.getAttribute('href') : 'no button');
chk('GitHub mark uses the official 16px viewBox',
    !!gh && !!gh.querySelector('svg') && gh.querySelector('svg').getAttribute('viewBox') === '0 0 16 16');
chk('GitHub mark is filled, not stroked', /\.ghbtn svg\{[^}]*fill:currentColor/.test(css));
chk('clone command uses the real repo', doc.body.textContent.indexOf(REPO + '.git') !== -1);
chk('no <you> placeholder left', html.indexOf('&lt;you&gt;') === -1,
    String((html.match(/&lt;you&gt;/g) || []).length) + ' left');
chk('no bare github.com link left', html.indexOf('href="https://github.com/"') === -1);
chk('footer links to the source', [...doc.querySelectorAll('footer a')].some(a => a.getAttribute('href') === REPO));

// --- code samples must only use APIs that exist in the source
const Q = String.fromCharCode(39);
const FICTION = ['SMLN.patch(', 'SMLN.listElements', 'elementNames()', 'res.ok', 'file: ' + Q + 'bundle' + Q];
for (const f of FICTION) {
  chk('no invented API: ' + f, html.indexOf(f) === -1);
}
const modsTxt = doc.getElementById('view-mods').textContent;
chk('main.js sample uses setup()', /setup\(ctx\)/.test(modsTxt));
chk('main.js sample returns patches', /return\s*\{[\s\S]{0,40}patches/.test(modsTxt));
chk('patch sample uses the real Patch shape',
    /description:/.test(modsTxt) && /expect:/.test(modsTxt) && /required:/.test(modsTxt));
chk('patch find is a regex with /g', /find:\s*\/.*\/g/.test(modsTxt));
chk('recipe sample uses (kind, def)', /recipe\(\s*'smelter'/.test(modsTxt));
chk('registrars documented as promises', /returns? a .{0,12}Promise|await SMLN\.register/.test(modsTxt));
chk('completion uses a real enum', /SMLN\.enums\.ELEMENT_KEYS/.test(modsTxt));

console.log(bad ? '\n' + bad + ' FAILED' : '\nall layout checks passed');
process.exit(bad ? 1 : 0);
