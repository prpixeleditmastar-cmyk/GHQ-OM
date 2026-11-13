// Builds dist/ (the APK's web files) and dist-update/ (published to GitHub Pages for automatic app updates).
//  dist/app.html      = the real app page (offline icons bundled)
//  dist/index.html    = tiny loader: runs a newer downloaded version if there is one, else app.html
//  dist-update/       = version.json + bundle.json (app page with its own JS/CSS inlined)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'www'), out = path.join(root, 'dist'), upd = path.join(root, 'dist-update');
const fa = path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free');
const BUILD = process.env.BUILD_ID || new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const UPDATE_URL = process.env.UPDATE_URL || '';

fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(upd, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

fs.mkdirSync(path.join(out, 'vendor', 'fa', 'css'), { recursive: true });
fs.copyFileSync(path.join(fa, 'css', 'all.min.css'), path.join(out, 'vendor', 'fa', 'css', 'all.min.css'));
fs.cpSync(path.join(fa, 'webfonts'), path.join(out, 'vendor', 'fa', 'webfonts'), { recursive: true });

let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const cdn = /https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/[\d.]+\/css\/all\.min\.css/;
if (!cdn.test(html)) throw new Error('Font Awesome CDN link not found');
html = html.replace(cdn, 'vendor/fa/css/all.min.css');
if (!html.includes('<script src="config.js"></script>')) throw new Error('config.js script tag not found');
html = html.replace('<script src="config.js"></script>', '<script src="build.js"></script>\n  <script src="config.js"></script>');
fs.writeFileSync(path.join(out, 'app.html'), html);
fs.writeFileSync(path.join(out, 'build.js'), 'window.GHQ_BUILD=' + JSON.stringify(BUILD) + ';window.GHQ_UPDATE_URL=' + JSON.stringify(UPDATE_URL) + ';\n');

fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>GHQ O&M</title>
<style>html,body{margin:0;background:#0b0f19}</style><script src="build.js"></script></head><body>
<script>
(function () {
  var b = null;
  try { var raw = localStorage.getItem('ghq_bundle'); b = raw && JSON.parse(raw); } catch (e) { b = null; }
  if (b && b.html && b.version > (window.GHQ_BUILD || '0')) {
    window.addEventListener('load', function () {
      window.__GHQ_CACHED = b.version;
      document.open(); document.write(b.html); document.close();
      setTimeout(function () {                       // safety net: a broken download never locks the app
        if (!window.__GHQ_BOOTED) { try { localStorage.removeItem('ghq_bundle'); } catch (e) {} location.replace('app.html'); }
      }, 9000);
    });
  } else { location.replace('app.html'); }
})();
</script></body></html>`);

// update bundle: app page with its own JS / CSS inlined (config.js, logo, icons stay in the APK)
function inl(s) { return s.replace(/<\/script/gi, '<\\/script'); }
let b = html;
b = b.replace('<link href="app-layer.css" rel="stylesheet">', () => '<style>' + fs.readFileSync(path.join(src, 'app-layer.css'), 'utf8') + '</style>');
['qrcode.js', 'jsqr.js', 'xlsx-lite.js', 'xlsx-read.js', 'app-layer.js'].forEach(f => {
  const tag = '<script src="' + f + '"></script>';
  if (!b.includes(tag)) throw new Error(f + ' tag not found');
  b = b.replace(tag, () => '<script>' + inl(fs.readFileSync(path.join(src, f), 'utf8')) + '</script>');
});
fs.mkdirSync(upd, { recursive: true });
fs.writeFileSync(path.join(upd, 'version.json'), JSON.stringify({ version: BUILD }));
fs.writeFileSync(path.join(upd, 'bundle.json'), JSON.stringify({ version: BUILD, html: b }));
fs.writeFileSync(path.join(upd, 'index.html'), '<!doctype html><meta charset="utf-8"><title>GHQ O&M updates</title><p>GHQ O&M app update feed. Version ' + BUILD + '</p>');
console.log('dist ready · build ' + BUILD + (UPDATE_URL ? ' · updates from ' + UPDATE_URL : ' · (no UPDATE_URL: auto-update off)'));
