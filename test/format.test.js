'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { format, minify } = require('../src/core/format');
const { parse, canon, sampleFiles } = require('./helpers');

// Extra real-world files (not in the repo): REAL_DIR=~/xml-tools-work/gate/real npm test
const real = process.env.REAL_DIR ? fs.readdirSync(process.env.REAL_DIR).map(f => path.join(process.env.REAL_DIR, f)).filter(f => fs.statSync(f).isFile()) : [];
const files = [...sampleFiles(), ...real].filter(f => !/xxe|laughs/.test(f));

for (const file of files) {
  test(`format keeps the tree and is stable: ${path.basename(file)}`, () => {
    const src = fs.readFileSync(file, 'utf8');
    const before = canon(parse(src));
    for (const opts of [{}, { indent: '\t' }, { attributes: 'onePerLine' }, { attributes: 'oneLine', keepBlankLines: false }]) {
      const r = format(src, opts);
      assert.ok(r.ok, JSON.stringify(r.error));
      assert.strictEqual(canon(parse(r.text)), before, 'tree changed with ' + JSON.stringify(opts));
      const again = format(r.text, opts);
      assert.ok(again.ok);
      assert.strictEqual(again.text, r.text, 'second format changed the text with ' + JSON.stringify(opts));
    }
    const m = minify(src);
    assert.ok(m.ok);
    assert.strictEqual(canon(parse(m.text)), before, 'minify changed the tree');
    assert.ok(m.text.length <= src.length);
    const back = format(m.text);
    assert.strictEqual(canon(parse(back.text)), before, 'format after minify changed the tree');
  });
}

test('significant whitespace in an element is kept (<t> </t>)', () => {
  const r = format('<r><t> </t><u>  a  b  </u></r>');
  assert.strictEqual(r.text, '<r>\n  <t> </t>\n  <u>  a  b  </u>\n</r>');
});

test('xml:space="preserve" content is kept byte for byte, children included', () => {
  const src = '<doc><w:t xmlns:w="urn:w" xml:space="preserve">       </w:t><pre xml:space="preserve">\n  <b>x</b>\n    <i/>\n</pre></doc>';
  const r = format(src);
  assert.ok(r.text.includes('<w:t xmlns:w="urn:w" xml:space="preserve">       </w:t>'));
  assert.ok(r.text.includes('<pre xml:space="preserve">\n  <b>x</b>\n    <i/>\n</pre>'));
});

test('no spaces are added before CDATA, also after several runs', () => {
  const src = '<units>\n  <trans-unit id="m">\n    <source>Mobile <![CDATA[(<768px)]]></source>\n  </trans-unit>\n</units>\n';
  let t = src;
  for (let k = 0; k < 4; k++) t = format(t).text;
  assert.ok(t.includes('<source>Mobile <![CDATA[(<768px)]]></source>'));
  assert.strictEqual(t, src);
});

test('comment indentation does not grow on each format', () => {
  const src = '<?xml version="1.0" encoding="utf-8"?>\n<element>\n    text\n    <!-- comment -->\n</element>\n';
  const a = format(src, { indent: '    ' }).text;
  const b = format(a, { indent: '    ' }).text;
  const c = format(b, { indent: '    ' }).text;
  assert.strictEqual(a, src, 'mixed content is kept as is');
  assert.strictEqual(c, a);
  const src2 = '<a>\n<b/>\n        <!-- note -->\n<c/>\n</a>';
  const x = format(src2).text;
  assert.strictEqual(x, '<a>\n  <b/>\n  <!-- note -->\n  <c/>\n</a>');
  assert.strictEqual(format(x).text, x);
});

test('a file that is not well formed is not changed and the error has a line and column', () => {
  const src = '<catalog>\n  <book>\n    <title>First</title>\n  <book>\n  </book>\n</catalog>\n';
  const r = format(src);
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /<book> is not closed|Expected <\/book>/);
  assert.ok(r.error.line >= 2 && r.error.col >= 1);
  for (const bad of ['<a><b></a>', '<a>', '<a x="1" x="2"/>', '<a>&nope;</a>', '<a>1 < 2</a>', '<a/><b/>', 'text<a/>', '<a b=1/>']) {
    assert.strictEqual(format(bad).ok, false, bad);
  }
});

test('comments, PIs, DOCTYPE and entity references are copied, never expanded', () => {
  const src = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e "x&e2;"><!ENTITY e2 "y">]><?pi data?><r><!-- c --><a>&e;</a><b attr="&amp;&#65;"/></r>';
  const r = format(src);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.ok(r.text.includes('<!DOCTYPE r [<!ENTITY e "x&e2;"><!ENTITY e2 "y">]>'));
  assert.ok(r.text.includes('<a>&e;</a>'));
  assert.ok(r.text.includes('<b attr="&amp;&#65;"/>'));
  assert.ok(r.text.includes('<?pi data?>'));
});

test('attribute values and quotes are kept; layout options work', () => {
  const src = '<a><b one="1"   two=\'2\' three="x &quot;y&quot;"/></a>';
  assert.strictEqual(format(src).text, '<a>\n  <b one="1" two=\'2\' three="x &quot;y&quot;"/>\n</a>');
  assert.strictEqual(format(src, { attributes: 'onePerLine' }).text, '<a>\n  <b one="1"\n    two=\'2\'\n    three="x &quot;y&quot;"/>\n</a>');
  const android = '<LinearLayout\n  a:w="1"\n  a:h="2" xmlns:a="urn:a">\n<View a:id="v"/></LinearLayout>';
  const t = format(android, { indent: '    ' }).text;
  assert.strictEqual(t, '<LinearLayout\n    a:w="1"\n    a:h="2"\n    xmlns:a="urn:a">\n    <View a:id="v"/>\n</LinearLayout>');
  assert.strictEqual(format(t, { indent: '    ' }).text, t);
});

test('CRLF, tabs, BOM and a final newline are kept', () => {
  const src = '﻿<?xml version="1.0"?>\r\n<a><b>1</b><c/></a>\r\n';
  const r = format(src, { eol: '\r\n', indent: '\t' });
  assert.strictEqual(r.text, '﻿<?xml version="1.0"?>\r\n<a>\r\n\t<b>1</b>\r\n\t<c/>\r\n</a>\r\n');
});

test('blank lines: one kept where there were several, none after a start tag', () => {
  const r = format('<a>\n\n\n  <b/>\n\n\n\n  <c/>\n\n</a>');
  assert.strictEqual(r.text, '<a>\n  <b/>\n\n  <c/>\n</a>');
  assert.strictEqual(format('<a>\n<b/>\n\n<c/>\n</a>', { keepBlankLines: false }).text, '<a>\n  <b/>\n  <c/>\n</a>');
});

test('a selection (fragment) formats with the base indentation', () => {
  const r = format('<b><c/></b><d>x</d>\n', { fragment: true, baseIndent: '    ' });
  assert.ok(r.ok);
  assert.strictEqual(r.text, '    <b>\n      <c/>\n    </b>\n    <d>x</d>\n');
});

test('minify removes only whitespace between tags; comments optional', () => {
  const src = '<a>\n  <!-- c -->\n  <b> keep  this </b>\n  <c><![CDATA[ x ]]></c>\n</a>\n';
  assert.strictEqual(minify(src).text, '<a><!-- c --><b> keep  this </b><c><![CDATA[ x ]]></c></a>');
  assert.strictEqual(minify(src, { removeComments: true }).text, '<a><b> keep  this </b><c><![CDATA[ x ]]></c></a>');
});

test('a 13.5 MB single-line file formats in seconds, not minutes', () => {
  const parts = ['<root>'];
  let n = 0;
  while (n < 13.5e6) { const s = `<item id="${parts.length}"><name>Item ${parts.length}</name><v>${parts.length % 97}</v></item>`; parts.push(s); n += s.length; }
  parts.push('</root>');
  const src = parts.join('');
  const t0 = Date.now();
  const r = format(src);
  const ms = Date.now() - t0;
  assert.ok(r.ok);
  assert.ok(r.text.split('\n').length > 500000);
  assert.ok(ms < 20000, `took ${ms} ms`);
  console.log(`# 13.5 MB single line: ${ms} ms`);
});
