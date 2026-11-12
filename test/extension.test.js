'use strict';
// Package checks: engines, name, no network code in the bundles.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('engines floor for Cursor and Windsurf', () => {
  assert.strictEqual(pkg.engines.vscode, '^1.90.0');
  assert.strictEqual(pkg.devDependencies['@types/vscode'], '~1.90.0');
});

test('display name has every word of the target phrases and is not a rival name', () => {
  const name = pkg.displayName.toLowerCase();
  for (const phrase of ['format xml', 'xml format', 'xml formatter', 'xml tools', 'xpath']) {
    for (const w of phrase.split(' ')) assert.ok(new RegExp(`\\b${w}\\b`).test(name), `${w} missing`);
  }
  for (const rival of ['XML Tools', 'XML Format', 'Pretty XML', 'XPath Tester', 'XML Formatter']) {
    assert.notStrictEqual(pkg.displayName.toLowerCase(), rival.toLowerCase());
    assert.ok(!pkg.displayName.startsWith(rival + ' '), 'starts with a rival name: ' + rival);
  }
});

test('the bundles contain no network code', () => {
  for (const f of ['extension.js', 'worker.js']) {
    const js = fs.readFileSync(path.join(root, 'dist', f), 'utf8');
    for (const bad of [/require\(["'](https?|net|tls|dgram|http2)["']\)/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/]) {
      assert.ok(!bad.test(js), `${f} has ${bad}`);
    }
  }
});

test('every command in menus is declared, every setting has a description', () => {
  const cmds = new Set(pkg.contributes.commands.map(c => c.command));
  for (const list of Object.values(pkg.contributes.menus)) for (const m of list) assert.ok(cmds.has(m.command), m.command);
  for (const [k, v] of Object.entries(pkg.contributes.configuration.properties)) assert.ok(v.description, k);
});
