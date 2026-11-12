'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildIndex, elementAt } = require('../src/core/index');
const { xpathFor } = require('../src/core/xpathgen');
const { evaluate } = require('../src/core/evaluate');
const { sampleFiles, SAMPLES } = require('./helpers');

const real = process.env.REAL_DIR ? fs.readdirSync(process.env.REAL_DIR).map(f => path.join(process.env.REAL_DIR, f)).filter(f => fs.statSync(f).isFile()) : [];
const files = [...sampleFiles(), ...real].filter(f => !/xxe|laughs/.test(f));

const stateOf = text => ({ text, index: buildIndex(text), dom: null, ord: null });
const run = (st, expr, opts) => evaluate(st, expr, opts);

for (const file of files) {
  test(`copied XPath selects exactly that element (3 styles): ${path.basename(file)}`, () => {
    const st = stateOf(fs.readFileSync(file, 'utf8'));
    const ix = st.index;
    assert.strictEqual(ix.error, null);
    const step = Math.max(1, Math.floor(ix.count / 1500));
    let checked = 0;
    for (let i = 0; i < ix.count; i += step) {
      for (const style of ['indexed', 'predicates', 'portable']) {
        const p = xpathFor(ix, i, style);
        const r = run(st, p);
        assert.ok(r.ok, `${p}: ${r.error}`);
        assert.strictEqual(r.total, 1, `${style} ${p} matched ${r.total}`);
        assert.strictEqual(r.items[0].ord, i, `${style} ${p} matched another element`);
        checked++;
      }
    }
    assert.ok(checked >= 3);
  });
}

test('SOAP with prefixes: evaluate and copy', () => {
  const st = stateOf(fs.readFileSync(path.join(SAMPLES, 'soap-envelope.xml'), 'utf8'));
  const r = run(st, '//soap:Body/m:GetStockPrice[2]/m:StockName');
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].value, 'MSFT');
  const n = run(st, 'count(//m:StockName)');
  assert.strictEqual(n.type, 'number'); assert.strictEqual(n.value, '2');
  const bad = run(st, '//x:Body');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /Prefix "x" is not declared.*soap, m, wsse/);
  const attr = run(st, '//wsse:Security/@soap:mustUnderstand');
  assert.strictEqual(attr.items[0].kind, 'attribute'); assert.strictEqual(attr.items[0].value, '1');
  const cd = run(st, 'string(//m:Note)');
  assert.strictEqual(cd.value, 'Prices < 100 are rounded & cached');
});

test('Android: prefixed attributes in predicates and copied paths', () => {
  const text = fs.readFileSync(path.join(SAMPLES, 'AndroidManifest.xml'), 'utf8');
  const st = stateOf(text);
  const r = run(st, "//activity[@android:name='.EditorActivity']/@android:windowSoftInputMode");
  assert.strictEqual(r.total, 1); assert.strictEqual(r.items[0].value, 'adjustResize');
  const off = text.indexOf('.SettingsActivity');
  const i = elementAt(st.index, off);
  assert.strictEqual(xpathFor(st.index, i, 'indexed'), '/manifest/application/activity[3]');
  assert.strictEqual(xpathFor(st.index, i, 'predicates'), "/manifest/application/activity[@android:name='.SettingsActivity']");
  assert.strictEqual(xpathFor(st.index, i, 'indexed', 'android:exported'), '/manifest/application/activity[3]/@android:exported');
  const back = run(st, xpathFor(st.index, i, 'portable', 'android:exported'));
  assert.strictEqual(back.items[0].value, 'false');
});

test('default namespace (pom.xml): plain names work; strict mode is XPath 1.0', () => {
  const st = stateOf(fs.readFileSync(path.join(SAMPLES, 'pom.xml'), 'utf8'));
  const r = run(st, "//dependency[scope='test']/artifactId");
  assert.strictEqual(r.total, 1); assert.strictEqual(r.items[0].value, 'junit-jupiter');
  assert.strictEqual(run(st, '//dependency', { strictNamespaces: true }).total, 0);
  assert.strictEqual(run(st, "count(/*[local-name()='project']/*[local-name()='dependencies']/*)", { strictNamespaces: true }).value, '3');
  const i = elementAt(st.index, st.text.indexOf('postgresql</artifactId>'));
  assert.strictEqual(xpathFor(st.index, i), '/project/dependencies/dependency[2]/artifactId');
});

test('same prefix bound to two URIs: copied path still exact', () => {
  const text = '<r><a:x xmlns:a="urn:1"/><g xmlns:a="urn:2"><a:x/><a:x/></g></r>';
  const st = stateOf(text);
  for (let i = 0; i < st.index.count; i++) {
    const p = xpathFor(st.index, i, 'indexed');
    const r = run(st, p);
    assert.strictEqual(r.total, 1, p); assert.strictEqual(r.items[0].ord, i, p);
  }
  assert.match(xpathFor(st.index, 3), /namespace-uri\(\)='urn:2'/);
});

test('syntax errors and scalar results', () => {
  const st = stateOf('<a><b n="2"/><b n="3"/></a>');
  assert.match(run(st, '//b[').error, /syntax/i);
  assert.strictEqual(run(st, 'sum(//b/@n)').value, '5');
  assert.strictEqual(run(st, 'boolean(//c)').value, 'false');
  assert.strictEqual(run(st, 'string(//b[2]/@n)').value, '3');
});

test('billion laughs: nothing expands, XPath answers fast with a note', () => {
  const text = fs.readFileSync(path.join(SAMPLES, 'hostile', 'billion-laughs.xml'), 'utf8');
  const st = stateOf(text);
  assert.ok(st.index.doctype.entities.maxExpansion >= 3e9, String(st.index.doctype.entities.maxExpansion));
  const t0 = Date.now();
  const r = run(st, 'string(//lol)');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(r.ok, r.error);
  assert.ok(r.value.length < 100, 'entity was expanded: ' + r.value.length);
  assert.ok(r.notes.some(n => /not expanded/.test(n)));
  assert.strictEqual(run(st, 'string(//safe)').value, 'plain text');
});

test('external entities (file:///etc/passwd, http) are never read', () => {
  const text = fs.readFileSync(path.join(SAMPLES, 'hostile', 'xxe-passwd.xml'), 'utf8');
  const st = stateOf(text);
  const opened = [];
  const origOpen = fs.openSync, origRead = fs.readFileSync;
  fs.openSync = function (p, ...a) { opened.push(String(p)); return origOpen.call(fs, p, ...a); };
  fs.readFileSync = function (p, ...a) { opened.push(String(p)); return origRead.call(fs, p, ...a); };
  const http = require('http');
  const origReq = http.request;
  let net = 0;
  http.request = function () { net++; throw new Error('no network'); };
  try {
    const r = run(st, 'string(//customer)');
    assert.ok(r.ok, r.error);
    assert.ok(!/root:/.test(r.value));
    assert.ok(!opened.some(p => p.includes('passwd')));
    assert.strictEqual(net, 0);
    assert.deepStrictEqual(st.index.doctype.entities.external.sort(), ['remote', 'secret']);
  } finally { fs.openSync = origOpen; fs.readFileSync = origRead; http.request = origReq; }
});
