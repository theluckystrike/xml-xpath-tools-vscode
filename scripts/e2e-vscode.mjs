// Release check in a real VS Code: installs the .vsix into an isolated profile, opens real XML files, runs
// Format Document, XPath, Copy XPath, the tree and the big-file paths with real key and mouse events, saves
// screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <workspaceDir> <shotDir> <outJson> [theme]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { canon, parse } = require('../test/helpers.js');

const [work0, port, vsix, ws0, shotDir, outJson, theme] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], files: {} };
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const settings = {
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom',
  'xmlXpathTools.askForRating': false, 'editor.defaultFormatter': 'zovo.zovo-xml-xpath-tools', 'files.autoSave': 'off',
  'editor.minimap.enabled': false, 'workbench.editor.enablePreview': false, 'explorer.autoReveal': false,
  'editor.detectIndentation': false, 'editor.tabSize': 4, 'editor.insertSpaces': true, 'files.simpleDialog.enable': true,
  ...(theme === 'light' ? { 'workbench.colorTheme': 'Default Light Modern' } : {}),
};
const vs = await launch(work, Number(port), ws, settings);
const shots = [];
const shot = async name => { const f = path.join(shotDir, `${theme === 'light' ? 'light-' : ''}${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name, JSON.stringify(v).slice(0, 300)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 400)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const pb = () => execSync('pbpaste', { encoding: 'utf8' });
const W = expr => vs.wbEval(expr);
const activeTab = () => W(`(document.querySelector('.editor-group-container.active .tab.active .label-name') || {}).textContent || ''`);
const cursor = async () => { const t = await W(`(document.querySelector('#status\\\\.editor\\\\.selection') || {}).textContent || ''`); const m = /Ln (\d+), Col (\d+)/.exec(t); return m ? { line: +m[1], col: +m[2] } : null; };
const notes = () => vs.notifications();
const clearNotes = () => vs.command('Notifications: Clear All Notifications').catch(() => {});
const paneRows = title => W(`(() => {
  const panes = [...document.querySelectorAll('.pane')];
  const p = panes.find(x => { const t = x.querySelector('.pane-header .title'); return t && t.textContent.trim().toLowerCase() === ${JSON.stringify(title.toLowerCase())}; });
  if (!p) return null;
  const msg = (p.querySelector('.pane-body .message') || p.querySelector('.tree-explorer-viewlet-tree-view-message') || {}).textContent || '';
  const rows = [...p.querySelectorAll('.pane-body .monaco-list-row')].map(r => ({ text: r.textContent.trim().replace(/\\s+/g, ' '), sel: r.classList.contains('selected'), aria: r.getAttribute('aria-label') || '' }));
  return JSON.stringify({ msg: msg.trim(), rows, expanded: p.classList.contains('expanded') });
})()`).then(v => (v ? JSON.parse(v) : null));
const statusXPath = () => W(`(() => { const it = [...document.querySelectorAll('.statusbar-item')].find(s => /symbol-namespace/.test(s.innerHTML) && /\\//.test(s.textContent)); return it ? it.textContent.trim() : ''; })()`);
const openFile = async (rel, waitTab = true) => {
  vs.open(path.join(ws, rel));
  if (waitTab) { const ok = await vs.waitFor(async () => (await activeTab()) === path.basename(rel), 30000, 150); if (!ok) throw new Error('tab did not open: ' + rel); }
  await sleep(700);
};
const goto = async (line, col) => { await vs.command('Go to Line/Column...'); await vs.type(`${line}:${col}`); await vs.key('Enter', 'Enter'); await sleep(400); };
const save = async () => { await vs.key('s', 'KeyS', 4, 83); await sleep(800); };
const formatDoc = async () => { await vs.command('Format Document'); };
const evaluate = async expr => {
  await vs.command('XML: Evaluate XPath…');
  await sleep(300);
  await vs.key('a', 'KeyA', 4, 65); // select all in the input box
  await vs.type(expr); await vs.key('Enter', 'Enter');
  const r = await vs.waitFor(async () => { const p = await paneRows('XPath Results'); return p && p.rows.length && (p.msg.includes(expr) || p.rows.some(x => /error|declared/i.test(x.text))) ? p : null; }, 20000, 200);
  if (!r) throw new Error('no XPath results for ' + expr);
  return r;
};

// The 10+ real files: name -> an XPath that must find something, and a node text to look for
const FILES = [
  ['real/commons-text-pom.xml', "//dependency[artifactId='commons-lang3']/version"],
  ['real/AndroidManifest.xml', '//activity/@android:name'],
  ['real/activity_main.xml', '//*[@android:id]'],
  ['real/flow.svg', '//text'],
  ['real/bing.rss', '//item/title'],
  ['real/MailArchiver.csproj', '//PackageReference/@Include'],
  ['real/cyclonedx.xsd', "//xs:complexType[@name='component']"],
  ['real/styled-placemarks.kml', '//Placemark/name'],
  ['real/messages.de.xlf', "//trans-unit[1]/target"],
  ['real/SharedResource.resx', "count(//data)"],
  ['real/vscode-Info.plist', "//key[.='CFBundleIdentifier']/following-sibling::string[1]"],
  ['samples/soap-envelope.xml', '//soap:Body/m:GetStockPrice[2]/m:StockName'],
  ['samples/chapter.dbk', '//programlisting'],
  ['samples/MainWindow.xaml', '//DataGridTextColumn/@Header'],
];

try {
  await sleep(3000);
  await step('extension installed and active on an XML file', async () => {
    if (R.install.code !== 0) throw new Error(R.install.out);
    await openFile('samples/pom.xml');
    const st = await vs.waitFor(statusXPath, 15000, 200);
    if (!st) throw new Error('no XPath in the status bar');
    return { install: R.install.out.trim().split('\n').pop(), status: st };
  });

  for (const [rel, expr] of FILES) {
    await step(`format + XPath: ${rel}`, async () => {
      const file = path.join(ws, rel);
      const before = fs.readFileSync(file, 'utf8');
      const canonBefore = canon(parse(before));
      await openFile(rel);
      await clearNotes();
      const t0 = Date.now();
      await formatDoc();
      await sleep(rel.includes('cyclonedx') ? 2500 : 900);
      await save();
      const after = fs.readFileSync(file, 'utf8');
      const fmtMs = Date.now() - t0;
      const same = canon(parse(after)) === canonBefore;
      const n = await notes();
      if (!same) throw new Error('tree changed after Format Document');
      if (n.some(x => /Not formatted|stopped|error/i.test(x))) throw new Error('notification: ' + n.join(' | '));
      // run it again: nothing may change
      await formatDoc(); await sleep(700); await save();
      const again = fs.readFileSync(file, 'utf8');
      const r = await evaluate(expr);
      const ok = r.rows.length > 0 && !r.rows.some(x => /No nodes match|error|not declared/i.test(x.text));
      if (!ok) throw new Error('XPath: ' + JSON.stringify(r).slice(0, 500));
      R.files[rel] = { bytesBefore: before.length, bytesAfter: after.length, changed: before !== after, stable: again === after, fmtMs, xpath: expr, results: r.msg, first: r.rows[0].text.slice(0, 120) };
      if (again !== after) throw new Error('second Format Document changed the file');
      return R.files[rel];
    });
  }

  await step('copied XPath at the cursor selects the same node (SOAP, namespaces)', async () => {
    await openFile('samples/soap-envelope.xml');
    const text = fs.readFileSync(path.join(ws, 'samples/soap-envelope.xml'), 'utf8');
    const lines = text.split('\n');
    const ln = lines.findIndex(l => l.includes('MSFT'));
    const col = lines[ln].indexOf('MSFT') + 2;
    await goto(ln + 1, col);
    await vs.command('XML: Copy XPath at Cursor');
    await sleep(500);
    const copied = pb().trim();
    const st = await statusXPath();
    const r = await evaluate(copied);
    await vs.command('View: Focus into Primary Side Bar').catch(() => {});
    if (!/^\/soap:Envelope\/soap:Body\/m:GetStockPrice\[2\]\/m:StockName$/.test(copied)) throw new Error('copied ' + copied);
    if (!/^1 result/.test(r.msg)) throw new Error(JSON.stringify(r));
    return { copied, status: st, results: r.msg, row: r.rows[0].text };
  });

  await step('click an XPath result jumps to its line', async () => {
    await openFile('samples/AndroidManifest.xml');
    const r = await evaluate('//activity');
    const rowsXY = JSON.parse(await W(`(() => { const p = [...document.querySelectorAll('.pane')].find(x => /xpath results/i.test((x.querySelector('.pane-header .title') || {}).textContent || '')); const rows = [...p.querySelectorAll('.monaco-list-row')]; return JSON.stringify(rows.map(r => { const b = r.getBoundingClientRect(); return { x: b.x + 40, y: b.y + b.height / 2, t: r.textContent }; })); })()`));
    await vs.click(rowsXY[2].x, rowsXY[2].y);
    await sleep(800);
    const c = await cursor();
    const lines = fs.readFileSync(path.join(ws, 'samples/AndroidManifest.xml'), 'utf8').split('\n');
    const want = lines.findIndex(l => l.includes('.SettingsActivity')) + 1;
    if (!c || c.line !== want) throw new Error(JSON.stringify({ c, want, rows: r.rows.map(x => x.text) }));
    await shot('xpath-results-android');
    return { results: r.msg, clicked: rowsXY[2].t.slice(0, 80), cursor: c };
  });

  await step('XML Tree shows the file and follows the cursor', async () => {
    await openFile('samples/pom.xml');
    await vs.command('XML: Show XML Tree');
    await sleep(1200);
    const lines = fs.readFileSync(path.join(ws, 'samples/pom.xml'), 'utf8').split('\n');
    const ln = lines.findIndex(l => l.includes('junit-jupiter')) + 1;
    await vs.command('View: Focus Active Editor Group').catch(() => {});
    await goto(ln, lines[ln - 1].indexOf('junit') + 2);
    await sleep(1000);
    const t = await paneRows('XML Tree');
    const sel = t && t.rows.find(r => r.sel);
    if (!t || !t.rows.length) throw new Error('tree empty ' + JSON.stringify(t));
    if (!sel || !/^artifactId/.test(sel.text)) throw new Error('selected row: ' + JSON.stringify(sel));
    return { rows: t.rows.length, selected: sel.text, first: t.rows[0].text };
  });

  await step('hostile: unclosed tags are reported with a line and the file is not changed', async () => {
    await openFile('hostile/unclosed-tags.xml');
    const before = fs.readFileSync(path.join(ws, 'hostile/unclosed-tags.xml'), 'utf8');
    await clearNotes();
    await formatDoc(); await sleep(1200);
    const n = await notes();
    const dirty = await W(`!!document.querySelector('.editor-group-container.active .tab.active.dirty')`);
    const t = await paneRows('XML Tree');
    if (!n.some(x => /Not formatted/.test(x)) || dirty) throw new Error(JSON.stringify({ n, dirty }));
    if (fs.readFileSync(path.join(ws, 'hostile/unclosed-tags.xml'), 'utf8') !== before) throw new Error('file changed');
    await shot('unclosed-tags');
    return { notification: n.find(x => /Not formatted/.test(x)), treeMessage: t && t.msg };
  });

  await step('hostile: billion laughs is not expanded; warning and fast XPath', async () => {
    await openFile('hostile/billion-laughs.xml');
    await sleep(800);
    const t0 = Date.now();
    const r = await evaluate('string(//lol)');
    const ms = Date.now() - t0;
    const hover = await W(`[...document.querySelectorAll('.squiggly-warning, .squiggly-error')].length`);
    const row = r.rows.map(x => x.text).join(' | ');
    if (!/string: &lol9;|string: $/.test(r.rows[0].text) && /lollollol/.test(row)) throw new Error('expanded: ' + row.slice(0, 200));
    if (!/not expanded/i.test(row)) throw new Error('no note: ' + row);
    await formatDoc(); await sleep(800); await save();
    const after = fs.readFileSync(path.join(ws, 'hostile/billion-laughs.xml'), 'utf8');
    if (!after.includes('<!ENTITY lol9')) throw new Error('DOCTYPE lost');
    await shot('billion-laughs');
    return { ms, rows: row.slice(0, 300), squiggles: hover };
  });

  await step('hostile: external entities (file:///etc/passwd, http) are not read', async () => {
    for (const rel of ['hostile/xxe-passwd.xml', 'real/kml-xxe-laughs.kml']) {
      await openFile(rel);
      const r = await evaluate(rel.endsWith('.kml') ? 'string(//name)' : 'string(//customer)');
      const row = r.rows.map(x => x.text).join(' | ');
      if (/root:|nobody:|daemon:/.test(row)) throw new Error('file content leaked: ' + row);
      R.files[rel] = { xpath: row.slice(0, 200) };
    }
    return R.files['hostile/xxe-passwd.xml'];
  });

  await step('hostile: 5 MB single line formats in a worker, editor stays responsive', async () => {
    await openFile('big/one-line-5mb.xml');
    await clearNotes();
    const t0 = Date.now();
    await formatDoc();
    let maxRtt = 0;
    const done = await vs.waitFor(async () => {
      const a = Date.now(); await W('1'); maxRtt = Math.max(maxRtt, Date.now() - a);
      return W(`!!document.querySelector('.editor-group-container.active .tab.active.dirty')`);
    }, 120000, 100);
    const ms = Date.now() - t0;
    if (!done) throw new Error('not formatted in 120 s');
    await save(); await sleep(1500);
    const lines = fs.readFileSync(path.join(ws, 'big/one-line-5mb.xml'), 'utf8').split('\n').length;
    return { ms, lines, maxRendererRttMs: maxRtt };
  });

  await step('large: 49 MB file opens, tree fills, XPath runs, Format Document finishes', async () => {
    const rel = 'big/big-catalog.xml';
    const bytes = fs.statSync(path.join(ws, rel)).size;
    let t0 = Date.now();
    await openFile(rel);
    const tree = await vs.waitFor(async () => { const t = await paneRows('XML Tree'); return t && t.rows.length > 1 ? t : null; }, 120000, 300);
    const treeMs = Date.now() - t0;
    if (!tree) throw new Error('tree did not fill');
    t0 = Date.now();
    const r = await evaluate("//product[@id='P250000']/name");
    const xpMs = Date.now() - t0;
    await clearNotes();
    t0 = Date.now();
    await formatDoc();
    let maxRtt = 0, probes = 0;
    const done = await vs.waitFor(async () => {
      const a = Date.now(); await W('1'); maxRtt = Math.max(maxRtt, Date.now() - a); probes++;
      return W(`!!document.querySelector('.editor-group-container.active .tab.active.dirty')`);
    }, 300000, 250);
    const fmtMs = Date.now() - t0;
    if (!done) throw new Error('Format Document did not finish in 300 s');
    await shot('big-catalog-formatted');
    return { bytes, treeMs, treeRows: tree.rows.length, treeDescription: tree.msg, xpath: r.msg, xpathMs: xpMs, formatMs: fmtMs, maxRendererRttMs: maxRtt, probes };
  });

  await step('Format Large XML File on Disk writes a formatted copy', async () => {
    const out = path.join(ws, 'big/one-line-5mb.formatted.xml');
    fs.rmSync(out, { force: true });
    await vs.command('View: Close All Editors').catch(() => {});
    await sleep(500);
    await vs.command('XML: Format Large XML File on Disk…');
    await sleep(800);
    // the simple file dialog: type the path
    await vs.key('a', 'KeyA', 4, 65);
    await vs.type(path.join(ws, 'big/one-line-5mb.xml'));
    await vs.key('Enter', 'Enter'); await sleep(1200);
    await vs.key('Enter', 'Enter'); // first choice: write a copy
    const ok = await vs.waitFor(() => fs.existsSync(out) && fs.statSync(out).size > 0 && notes().then(n => n.some(x => /Formatted/.test(x))), 120000, 300);
    if (!ok) throw new Error('no formatted copy; notes: ' + JSON.stringify(await notes()));
    const n = await notes();
    return { out: path.basename(out), bytes: fs.statSync(out).size, note: n.find(x => /Formatted/.test(x)) };
  });

  await step('README screenshot: pom.xml with tree, results and status bar', async () => {
    await vs.command('View: Close All Editors').catch(() => {});
    await openFile('real/commons-text-pom.xml');
    await vs.command('XML: Show XML Tree'); await sleep(800);
    const r = await evaluate("//dependency[scope='test']/artifactId");
    await vs.command('View: Focus Active Editor Group').catch(() => {});
    const lines = fs.readFileSync(path.join(ws, 'real/commons-text-pom.xml'), 'utf8').split('\n');
    const ln = lines.findIndex(l => l.includes('<artifactId>junit-jupiter')) + 1;
    if (ln > 0) await goto(ln, lines[ln - 1].indexOf('junit') + 3);
    await sleep(1200);
    const f = await shot('readme-pom-xpath');
    return { file: f, results: r.msg };
  });
} finally {
  R.console = vs.console.filter(c => !/Extension host|ExtensionService|update|Failed to fetch|net::ERR|marketplace|Unable to resolve|ENOTFOUND/i.test(c.text)).slice(0, 40);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  if (clipBefore !== null) { try { execSync('pbcopy', { input: clipBefore }); } catch {} }
  await vs.close();
  const pass = R.steps.filter(s => s.ok).length;
  console.log(`${pass}/${R.steps.length} steps passed; report ${outJson}`);
}
