'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildIndex, elementAt, children } = require('../src/core/index');
const { SAMPLES } = require('./helpers');

test('index: parents, children, names, keys and previews', () => {
  const text = '<r xmlns="urn:r"><a id="1">hello  world</a><b name="x"><c/></b><a id="2"/></r>';
  const ix = buildIndex(text);
  assert.strictEqual(ix.count, 5);
  assert.deepStrictEqual(children(ix, 0), [1, 2, 4]);
  assert.deepStrictEqual(children(ix, -1), [0]);
  assert.strictEqual(ix.names[ix.nameId[3]], 'c');
  assert.strictEqual(ix.parent[3], 2);
  assert.strictEqual(ix.keyName[1], 'id'); assert.strictEqual(ix.keyValue[1], '1');
  assert.strictEqual(ix.preview[1], 'hello world');
  assert.strictEqual(ix.uris[ix.nsId[3]], 'urn:r');
  assert.strictEqual(ix.defaultNs, 'urn:r');
  assert.strictEqual(elementAt(ix, text.indexOf('hello')), 1);
  assert.strictEqual(elementAt(ix, text.indexOf('<c/>') + 1), 3);
  assert.strictEqual(elementAt(ix, text.indexOf('<c/>') + 4), 2);
  assert.strictEqual(elementAt(ix, 0), 0);
  assert.strictEqual(elementAt(ix, text.length), -1);
});

test('index of a broken file keeps the part before the error', () => {
  const text = fs.readFileSync(path.join(SAMPLES, 'hostile', 'unclosed-tags.xml'), 'utf8');
  const ix = buildIndex(text);
  assert.ok(ix.error);
  assert.match(ix.error.message, /Expected <\/book>|not closed/);
  assert.strictEqual(ix.error.line, 8);
  assert.ok(ix.count >= 4);
});

test('undeclared prefixes are reported', () => {
  const ix = buildIndex('<r><x:a/><b y:attr="1"/></r>');
  assert.deepStrictEqual(ix.unbound.map(u => u[1]), ['x', 'y']);
});

test('entity bombs are measured without expanding', () => {
  const ix = buildIndex(fs.readFileSync(path.join(SAMPLES, 'hostile', 'billion-laughs.xml'), 'utf8'));
  assert.strictEqual(ix.doctype.entities.count, 10);
  assert.strictEqual(ix.doctype.entities.biggest, 'lol9');
  assert.ok(ix.doctype.entities.maxExpansion >= 3e9);
  const cyc = buildIndex('<!DOCTYPE r [<!ENTITY a "&b;"><!ENTITY b "&a;">]><r>&a;</r>');
  assert.ok(cyc.doctype.entities.maxExpansion >= 1e15);
});
