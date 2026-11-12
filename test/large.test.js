'use strict';
// Big files: written to ~/xml-tools-work/big-test (not the temp folder) and deleted at the end.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Worker } = require('worker_threads');
const dir = path.join(os.homedir(), 'xml-tools-work', 'big-test');
const skip = !!process.env.SKIP_LARGE;

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function ask(worker, msg) {
  return new Promise((resolve, reject) => {
    const id = Math.random();
    const on = m => { if (m.id !== id || m.progress !== undefined && m.ok === undefined) return; worker.off('message', on); resolve(m); };
    worker.on('message', on);
    worker.once('error', reject);
    worker.postMessage({ ...msg, id });
  });
}

test('49 MB file: format, index and XPath run in the worker; the main thread stays free', { skip }, async () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-samples.js'), dir, '49']);
  const file = path.join(dir, 'big-catalog.xml');
  const text = fs.readFileSync(file, 'utf8');
  const w = new Worker(path.join(__dirname, '..', 'dist', 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
  // a timer on the main thread must keep firing while the worker formats
  let ticks = 0, maxGap = 0, last = Date.now();
  const iv = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 20);
  try {
    let t0 = Date.now();
    const f = await ask(w, { op: 'format', text, options: { indent: '    ' } });
    const fmtMs = Date.now() - t0;
    assert.ok(f.ok, JSON.stringify(f.error));
    t0 = Date.now();
    const ix = await ask(w, { op: 'index', key: 'big#1', text });
    const ixMs = Date.now() - t0;
    assert.ok(ix.ok && ix.index.count > 500000, String(ix.index && ix.index.count));
    t0 = Date.now();
    const ev = await ask(w, { op: 'eval', key: 'big#1', expr: "count(//product[stock='0'])" });
    const evMs = Date.now() - t0;
    assert.ok(ev.ok, ev.error);
    t0 = Date.now();
    const ev2 = await ask(w, { op: 'eval', key: 'big#1', expr: "//product[@id='P250000']/p:price" });
    const ev2Ms = Date.now() - t0;
    assert.strictEqual(ev2.total, 1);
    console.log(`# 49 MB: format ${fmtMs} ms, index ${ixMs} ms (${ix.index.count} elements), first XPath ${evMs} ms, second ${ev2Ms} ms, main-thread max timer gap ${maxGap} ms over ${ticks} ticks`);
    assert.ok(maxGap < 1000, 'main thread blocked for ' + maxGap + ' ms');
    assert.ok(fmtMs < 60000);
  } finally { clearInterval(iv); await w.terminate(); }
});

test('format on disk: 5 MB single line, written next to the file', { skip }, async () => {
  const file = path.join(dir, 'one-line-5mb.xml');
  if (!fs.existsSync(file)) execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-samples.js'), dir, '1']);
  const out = path.join(dir, 'one-line-5mb.formatted.xml');
  const w = new Worker(path.join(__dirname, '..', 'dist', 'worker.js'));
  try {
    const r = await ask(w, { op: 'formatFile', path: file, out, options: {} });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(fs.statSync(out).size > fs.statSync(file).size);
    assert.ok(fs.readFileSync(out, 'utf8').split('\n').length > 100000);
  } finally { await w.terminate(); }
});
