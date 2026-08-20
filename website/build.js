'use strict'
/**
 * Assemble the website into a single self-contained `index.html`.
 *
 * The site is authored as four files - stylesheet, markup, and two scripts -
 * and shipped as one, because GitHub Pages serves it directly and a single
 * file has no load-order or relative-path problem to get wrong.
 *
 * The two scripts are stored as plain `.js` with no `<script>` wrapper, so the
 * repository's CI can run `node --check` over every JavaScript file in the
 * tree. The wrapper is added here instead.
 *
 * Run it with `node website/build.js`; `--check` verifies the committed
 * index.html is current without writing, which is what CI uses.
 */

const fs = require('fs')
const path = require('path')

const DIR = __dirname
const OUT = path.join(DIR, 'index.html')

/** Order matters: styles, then markup, then the scripts that read that markup. */
const PARTS = ['shell.css', 'body.html', 'wordmark.js', 'app.js']

/** Split so this file never contains a literal closing script tag. */
const OPEN_TAG = '<script>'
const CLOSE_TAG = '</scr' + 'ipt>'

const HEAD = `<title>SandLoader</title>
<meta name="description" content="A mod loader for Sandustry's vanilla branch, with an in-game console and mod manager that never modifies your game files.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter+Tight:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap">

<style>
`

function read(name) {
  const p = path.join(DIR, name)
  if (!fs.existsSync(p)) {
    console.error(`missing source file: website/${name}`)
    process.exit(1)
  }
  return fs.readFileSync(p, 'utf8')
}

/** One script source, wrapped in the tags the page needs. */
function script(name) {
  const body = read(name).replace(/\n+$/, '')
  return OPEN_TAG + '\n' + body + '\n' + CLOSE_TAG + '\n'
}

function assemble() {
  return HEAD +
    read('shell.css') + '\n</style>\n\n' +
    read('body.html') + '\n' +
    script('wordmark.js') +
    script('app.js')
}

const html = assemble()
const check = process.argv.includes('--check')

if (check) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (current !== html) {
    console.error('index.html is out of date - run `node website/build.js`')
    process.exit(1)
  }
  console.log(`index.html is up to date (${(html.length / 1024).toFixed(0)} KB)`)
} else {
  fs.writeFileSync(OUT, html)
  console.log(`built website/index.html from ${PARTS.length} sources` +
    ` (${(html.length / 1024).toFixed(0)} KB)`)
}
