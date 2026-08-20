# Website

The SandLoader documentation site. One self-contained `index.html`, no build
tooling, no dependencies — the same rules the loader itself follows.

## Layout

| File | What it is |
|---|---|
| `index.html` | **Generated.** The shipped site. Do not edit by hand. |
| `shell.css` | Design tokens, layout, components. |
| `body.html` | All five views: Overview, Documentation, Making mods, Reference, FAQ. |
| `wordmark.js` | The animated pixel wordmark and the header brandmark. |
| `app.js` | Routing, search, scroll-spy, theme toggle, copy buttons. |
| `build.js` | Concatenates the four sources into `index.html`. |
| `sitetest.js` | Behaviour: routing, search, deep links, theme, header. |
| `layouttest.js` | Layout regressions and code-sample accuracy. |

## Build

```bash
node website/build.js            # regenerate index.html
node website/build.js --check    # verify it matches its sources (CI)
```

Edit the sources, never `index.html` — a rebuild overwrites it.

## Tests

They need [jsdom](https://github.com/jsdom/jsdom), which is deliberately *not* a
project dependency. Install it only when you want to run them:

```bash
npm i --no-save jsdom
node website/sitetest.js
node website/layouttest.js
```

Without jsdom both scripts print `SKIP` and exit 0, so they are safe to wire
into a pipeline that has not installed it.

`layouttest.js` guards two classes of bug that have already happened once:

- **Shattered lists.** A list item styled `display:grid` turns every inline
  `<strong>` and `<code>` into a grid item, so one sentence renders one word per
  line. List items must stay block-level with an absolutely-positioned marker.
- **Invented APIs.** Code samples must only use calls that exist in `src/`.
  `SMLN.patch()`, `SMLN.listElements()` and a `main.js` `actions` export were all
  fiction in an early draft; the test fails if any of them reappears.

## Publishing to GitHub Pages

Settings → Pages → *Deploy from a branch*, then either:

- serve `/docs` and copy `index.html` there, or
- keep `/website` and add a workflow that uploads it as the Pages artifact.

Nothing in the page loads from a relative path, so it works from any directory.
The only external requests are Google Fonts.
