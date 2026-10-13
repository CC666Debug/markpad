// Bundles src/ into ONE self-contained HTML file (dist/index.html) that every edition uses:
// open it in a browser, or the desktop and Android apps load it.
import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const targets = ['dist/index.html', 'android/app/src/main/assets/index.html'];

async function build(){
  const r = await esbuild.build({ entryPoints: ['src/app.js'], bundle: true, minify: !watch, format: 'iife', target: 'es2020', write: false, legalComments: 'none' });
  const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\/script');
  const html = fs.readFileSync('src/index.html', 'utf8').replace('<script>/*APP*/</script>', () => `<script>${js}</script>`);
  for (const t of targets){
    fs.mkdirSync(t.slice(0, t.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(t, html);
  }
  console.log(`built ${(html.length / 1024).toFixed(0)} KB → ${targets.join(', ')}`);
}
await build();
if (watch) fs.watch('src', { recursive: true }, () => build().catch(e => console.error(e.message)));
