/* Bundles the tool into one self-contained HTML file.

   The multi-file version under asset-reconciler/ is the source of truth; this
   produces dist/asset-reconciler.html, which needs no web server at all - it
   runs from a file share, a USB stick or a local Downloads folder. Only the
   map's background tiles still need internet access.

   Usage:  node scripts/build-single-file.js
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'asset-reconciler.html');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

/* Leaflet's stylesheet points at a handful of small PNGs; fold them in so the
   single file has no external references of its own. */
function inlineCssAssets(css, baseDir) {
  return css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (whole, ref) => {
    if (/^(data:|https?:|\/\/)/.test(ref)) return whole;
    const file = path.join(ROOT, baseDir, ref.split('?')[0]);
    if (!fs.existsSync(file)) return whole;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) return whole;
    return `url("data:${mime};base64,${fs.readFileSync(file).toString('base64')}")`;
  });
}

/* A literal </script> anywhere in the inlined JS would close the tag early. */
function safeScript(js) { return js.replace(/<\/script/gi, '<\\/script'); }

let html = read('index.html');

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (whole, href) => {
  if (/^https?:/.test(href)) return whole;
  const css = inlineCssAssets(read(href), path.dirname(href));
  return `<style>\n/* ${href} */\n${css}\n</style>`;
});

html = html.replace(/<script src="([^"]+)"[^>]*><\/script>/g, (whole, src) => {
  if (/^https?:/.test(src)) return whole;
  return `<script>\n/* ${src} */\n${safeScript(read(src))}\n</script>`;
});

// Note in the page itself which build this is.
html = html.replace('</title>', '</title>\n<!-- Single-file build. Source: asset-reconciler/ -->');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);

const kb = Math.round(fs.statSync(OUT).size / 1024);
const leftover = html.match(/(?:src|href)="(?!data:|#|https?:\/\/(?:tile|www)\.)[^"]*\.(js|css)"/g);
console.log(`Wrote dist/asset-reconciler.html (${kb} KB)`);
console.log(leftover ? `WARNING - unresolved local references: ${leftover}` : 'No unresolved local references.');
