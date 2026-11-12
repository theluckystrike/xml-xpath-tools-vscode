'use strict';
// Worker thread: all parsing, formatting and XPath work runs here, so the editor never waits on a big file.
// No network module is loaded. The only file access is formatFile, on the file the user picked.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const { format } = require('./core/format');
const { buildIndex } = require('./core/index');
const { evaluate } = require('./core/evaluate');
const { canonical } = require('./core/canon');

let state = null; // { key, text, index, dom, ord }

function stateFor(key, text, progress) {
  if (state && state.key === key) return state;
  if (text === undefined) throw new Error('NO_TEXT');
  const index = buildIndex(text, progress);
  state = { key, text, index, dom: null, ord: null };
  return state;
}

/** Reads a file in the encoding its BOM or XML declaration names. */
function decode(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), enc: 'utf16le', bom: true };
  if (buf[0] === 0xFE && buf[1] === 0xFF) throw new Error('UTF-16 big-endian files are not supported by this command. Open the file in the editor and use Format Document.');
  const head = buf.subarray(0, 200).toString('latin1');
  const m = /^(?:﻿|\xEF\xBB\xBF)?<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/.exec(head);
  const named = m ? m[1].toLowerCase() : 'utf-8';
  if (named === 'iso-8859-1' || named === 'latin1' || named === 'us-ascii' || named === 'ascii') return { text: buf.toString('latin1'), enc: 'latin1', bom: false };
  if (named !== 'utf-8' && named !== 'utf8') throw new Error(`The file says encoding="${m[1]}". This command reads UTF-8, UTF-16 and ISO-8859-1 files.`);
  return { text: buf.toString('utf8'), enc: 'utf8', bom: false };
}

function encode(text, enc, bom) {
  if (enc === 'utf16le') return Buffer.concat([bom ? Buffer.from([0xFF, 0xFE]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
  return Buffer.from(text, enc);
}

parentPort.on('message', m => {
  const reply = msg => parentPort.postMessage({ id: m.id, ...msg });
  let last = 0;
  const progress = f => {
    const now = Date.now();
    if (now - last > 250) { last = now; parentPort.postMessage({ id: m.id, progress: Math.min(0.99, f) }); }
  };
  try {
    switch (m.op) {
      case 'index': {
        const st = stateFor(m.key, m.text, m.progress ? progress : null);
        reply({ ok: true, index: st.index });
        break;
      }
      case 'eval': {
        const st = stateFor(m.key, m.text, null);
        reply({ ...evaluate(st, m.expr, m.options || {}), index: m.wantIndex ? st.index : undefined });
        break;
      }
      case 'format': {
        const t0 = Date.now();
        const r = format(m.text, m.options || {}, progress);
        reply({ ...r, ms: Date.now() - t0 });
        break;
      }
      case 'formatFile': {
        const t0 = Date.now();
        const buf = fs.readFileSync(m.path);
        const { text, enc, bom } = decode(buf);
        const opts = { ...(m.options || {}) };
        if (!opts.eol) opts.eol = text.includes('\r\n') ? '\r\n' : '\n';
        const r = format(text, opts, progress);
        if (!r.ok) { reply(r); break; }
        const out = encode(r.text, enc, bom);
        fs.writeFileSync(m.out, out);
        reply({ ok: true, changed: r.changed, bytesIn: buf.length, bytesOut: out.length, ms: Date.now() - t0, out: m.out });
        break;
      }
      case 'xpathText': { // Zovo Pro "XPath on a folder": one file at a time, nothing kept between files
        const index = buildIndex(m.text);
        if (index.error) { reply({ ok: false, error: `not well formed at line ${index.error.line}: ${index.error.message}` }); break; }
        const st = { key: null, text: m.text, index, dom: null, ord: null };
        reply(evaluate(st, m.expr, m.options || {}));
        break;
      }
      case 'canon': reply(canonical(m.text, m.options || {})); break;
      case 'drop': state = null; reply({ ok: true }); break;
      default: reply({ ok: false, error: 'unknown op ' + m.op });
    }
  } catch (e) {
    if (e && e.message === 'NO_TEXT') { reply({ ok: false, needText: true }); return; }
    reply({ ok: false, internal: true, error: String((e && e.message) || e).slice(0, 500) });
  }
});
