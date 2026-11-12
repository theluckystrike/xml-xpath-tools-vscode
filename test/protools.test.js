'use strict';
// Zovo Pro tools (src/protools.js) with the real worker (src/worker.js) and a small fake of the VS Code API:
// XPath on a folder (CSV / JSON / Markdown), Format a folder (report and apply), Compare ignoring formatting, and the
// gate in src/pro.js (3 free tries, a try only after a result, the Pro panel after that). No network, no VS Code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkerClient } = require('../src/client');
const { createProTools, toCsv, csvCell, decodeBytes } = require('../src/protools');
const { canonical } = require('../src/core/canon');
const { createPro, TRIAL_KEY } = require('../src/pro');

const SAMPLES = path.join(__dirname, '..', 'samples');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xml-pro-'));
const client = new WorkerClient(path.join(__dirname, '..', 'src', 'worker.js'));
test.after(() => { client.terminate(); fs.rmSync(tmp, { recursive: true, force: true }); });

function fakeVscode() {
  const ui = { picks: [], inputs: [], dialogs: [], log: { picks: [], info: [], warn: [], opened: [], diffs: [], status: [] } };
  const Uri = {
    file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p }),
    joinPath: (u, ...p) => Uri.file(path.join(u.fsPath, ...p)),
    parse: (s) => ({ scheme: s.split(':')[0], path: s, fsPath: s, toString: () => s }),
  };
  const docs = new Map();
  const mkDoc = (fsPath) => {
    if (docs.has(fsPath)) return docs.get(fsPath);
    const d = { uri: Uri.file(fsPath), fileName: fsPath, version: 1, text: fs.readFileSync(fsPath, 'utf8'),
      getText() { return this.text; }, positionAt: (o) => o, async save() { fs.writeFileSync(fsPath, this.text); return true; } };
    docs.set(fsPath, d);
    return d;
  };
  class WorkspaceEdit { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ uri, range, text }); } }
  class EventEmitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { this.l.forEach((f) => f(v)); } dispose() {} }
  const vscode = {
    Uri, EventEmitter, WorkspaceEdit,
    Range: class { constructor(a, b) { this.start = a; this.end = b; } },
    FileType: { File: 1, Directory: 2 },
    ProgressLocation: { Notification: 15 },
    workspace: {
      textDocuments: [],
      workspaceFolders: [],
      fs: {
        readDirectory: async (u) => fs.readdirSync(u.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? 2 : 1]),
        readFile: async (u) => new Uint8Array(fs.readFileSync(u.fsPath)),
      },
      openTextDocument: async (a) => {
        if (a && a.fsPath) return mkDoc(a.fsPath);
        const d = { uri: Uri.parse('untitled:' + ui.log.opened.length), language: a.language, getText: () => a.content };
        ui.log.opened.push(a);
        return d;
      },
      applyEdit: async (we) => { for (const op of we.ops) { const d = mkDoc(op.uri.fsPath); d.text = d.text.slice(0, op.range.start) + op.text + d.text.slice(op.range.end); d.version++; } return true; },
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
    },
    window: {
      activeTextEditor: undefined,
      showOpenDialog: async () => ui.dialogs.shift(),
      showInputBox: async () => ui.inputs.shift(),
      showQuickPick: async (items, o) => { ui.log.picks.push({ items: items.map((i) => i.label), title: o && o.title }); const want = ui.picks.shift(); return want === undefined ? undefined : items.find((i) => i.label.startsWith(want)); },
      withProgress: async (o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
      showTextDocument: async () => ({}),
      showInformationMessage: async (m) => { ui.log.info.push(m); },
      showWarningMessage: async (m) => { ui.log.warn.push(m); },
      setStatusBarMessage: (m) => { ui.log.status.push(m); return { dispose() {} }; },
    },
    commands: { executeCommand: async (id, ...a) => { if (id === 'vscode.diff') ui.log.diffs.push(a); } },
  };
  return { vscode, ui };
}

function setup({ licensed = false } = {}) {
  const { vscode, ui } = fakeVscode();
  const store = new Map();
  const context = { subscriptions: [], globalState: { get: (k) => store.get(k), update: async (k, v) => { store.set(k, v); } } };
  const panels = [];
  const license = { isPro: () => licensed, ready: Promise.resolve(), requirePro: async (title, detail) => { panels.push({ title, detail }); return false; }, onDidChange() {} };
  const pro = createPro({ vscode, context, license });
  const tools = createProTools({
    vscode, pro,
    request: (msg) => client.request(msg),
    formatOptions: (text) => ({ indent: '  ', eol: text.includes('\r\n') ? '\r\n' : '\n', attributes: 'keep', keepBlankLines: true }),
    maxChars: () => 60 * 1048576,
    xpathOptions: () => ({ strictNamespaces: false, maxResults: 5000 }),
  });
  const tries = () => store.get(TRIAL_KEY) || {};
  return { vscode, ui, tools, pro, tries, panels, store };
}

function project(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.copyFileSync(path.join(SAMPLES, 'pom.xml'), path.join(root, 'pom.xml'));
  fs.copyFileSync(path.join(SAMPLES, 'AndroidManifest.xml'), path.join(root, 'sub', 'AndroidManifest.xml'));
  fs.writeFileSync(path.join(root, 'sub', 'messy.xml'), '<root><a   x="1"><b>t</b></a><a x="2"/></root>');
  fs.writeFileSync(path.join(root, 'broken.xml'), '<root><a></root>');
  fs.writeFileSync(path.join(root, 'Info.plist'), Buffer.concat([Buffer.from('bplist00'), Buffer.alloc(20)]));
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.xml'), '<skip/>');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not xml');
  return root;
}

test('canonical: formatting, attribute order, quotes, empty tags and CDATA are ignored; values are not', () => {
  const a = '<?xml version="1.0"?>\n<r b="2" a="1"><x/><y>t &amp; u</y><p>Hi <b>you</b></p><!-- c --></r>';
  const b = "<r a='1'\n   b=\"2\">\n  <x></x>\n  <y><![CDATA[t & u]]></y>\n  <p>Hi <b>you</b></p>\n  <!-- c -->\n</r>\n";
  assert.equal(canonical(a).text, canonical(b).text);
  assert.notEqual(canonical(a).text, canonical(a.replace('a="1"', 'a="9"')).text);
  assert.notEqual(canonical(a).text, canonical(a.replace('<p>Hi ', '<p>Hello ')).text);
  const bad = canonical('<r><a></r>');
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /Expected <\/a>/);
  // an entity bomb is not expanded
  const bomb = canonical(fs.readFileSync(path.join(SAMPLES, 'hostile', 'billion-laughs.xml'), 'utf8'));
  assert.equal(bomb.ok, true);
  assert.ok(bomb.text.length < 10000);
});

test('CSV: quoted fields and no spreadsheet formulas', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(toCsv([]).split('\r\n')[0], 'file,line,kind,name,value');
  assert.equal(decodeBytes(Buffer.from('bplist00abc')), null);
  assert.equal(decodeBytes(Buffer.from('﻿<a/>')), '<a/>');
});

test('XPath on a folder: every XML file (namespaces per file), CSV rows with file and line, one try', async () => {
  const root = project('xp');
  const s = setup();
  s.ui.inputs.push('//dependency/artifactId');
  s.ui.picks.push('Open as CSV');
  const r = await s.tools.xpathFolder(s.vscode.Uri.file(root));
  assert.ok(r);
  const csv = s.ui.log.opened.at(-1).content;
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'file,line,kind,name,value');
  assert.ok(lines.length > 2, csv);
  assert.ok(lines.slice(1).every((l) => l.startsWith('pom.xml,')), csv);
  assert.match(csv, /pom\.xml,\d+,element,artifactId,/);
  const byFile = Object.fromEntries(r.files.map((f) => [f.rel, f.status]));
  assert.equal(byFile['broken.xml'], 'error');
  assert.equal(byFile['Info.plist'], 'skipped');
  assert.equal(byFile['sub/messy.xml'], 'ok');
  assert.ok(!('node_modules/skip.xml' in byFile));
  assert.equal(s.tries().xpathFolder, 1);
  assert.match(s.ui.log.picks.at(-1).title, /results? in 1 of 5 files/);
});

test('XPath on a folder: JSON and Markdown, prefixes from each file, number results', async () => {
  const root = project('xp2');
  const s = setup();
  s.ui.inputs.push('//activity/@android:name');
  s.ui.picks.push('Open as JSON');
  await s.tools.xpathFolder(s.vscode.Uri.file(root));
  const j = JSON.parse(s.ui.log.opened.at(-1).content);
  assert.equal(j.xpath, '//activity/@android:name');
  assert.ok(j.results.length >= 1 && j.results.every((x) => x.file === 'sub/AndroidManifest.xml' && x.kind === 'attribute'), JSON.stringify(j.results));
  s.ui.inputs.push('count(//*)');
  s.ui.picks.push('Open a Markdown');
  await s.tools.xpathFolder(s.vscode.Uri.file(root));
  assert.match(s.ui.log.opened.at(-1).content, /^# XPath results in xp2/);
  assert.match(s.ui.log.opened.at(-1).content, /\| sub\/messy\.xml \| 4 \|/);
  assert.equal(s.tries().xpathFolder, 2);
});

test('XPath on a folder: a syntax error, Escape, or a folder with no XML uses no try', async () => {
  const root = project('xp3');
  const s = setup();
  s.ui.inputs.push('//a[');
  await s.tools.xpathFolder(s.vscode.Uri.file(root));
  assert.match(s.ui.log.warn.at(-1), /XPath syntax error.*No free try was used/);
  s.ui.inputs.push('//*');
  s.ui.picks.push(undefined); // Escape at the output pick
  await s.tools.xpathFolder(s.vscode.Uri.file(root));
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
  s.ui.inputs.push('//*');
  await s.tools.xpathFolder(s.vscode.Uri.file(empty));
  assert.match(s.ui.log.info.at(-1), /No XML files.*No free try was used/);
  assert.equal(s.tries().xpathFolder, undefined);
});

test('Format a folder: the report changes nothing; Format writes the files; a broken file is left alone', async () => {
  const root = project('fmt');
  const s = setup();
  const messy = path.join(root, 'sub', 'messy.xml');
  const before = fs.readFileSync(messy, 'utf8');
  s.ui.picks.push('Show the report only');
  await s.tools.formatFolder(s.vscode.Uri.file(root));
  assert.equal(fs.readFileSync(messy, 'utf8'), before);
  const report = s.ui.log.opened.at(-1).content;
  assert.match(report, /\| sub\/messy\.xml \| changes \|/);
  assert.match(report, /\| broken\.xml \| not formatted \| Expected/);
  assert.match(report, /\| Info\.plist \| skipped \| binary file \|/);
  assert.equal(s.tries().formatFolder, 1);
  s.ui.picks.push('Format');
  const rows = await s.tools.formatFolder(s.vscode.Uri.file(root));
  assert.ok(rows.some((r) => r.status === 'formatted'));
  assert.equal(fs.readFileSync(messy, 'utf8'), '<root>\n  <a x="1">\n    <b>t</b>\n  </a>\n  <a x="2"/>\n</root>');
  assert.equal(fs.readFileSync(path.join(root, 'broken.xml'), 'utf8'), '<root><a></root>');
  assert.equal(s.tries().formatFolder, 2);
});

test('Compare ignoring formatting: same XML -> a note; different -> the diff; not well formed -> no try', async () => {
  const s = setup();
  const a = path.join(tmp, 'a.xml'); const b = path.join(tmp, 'b.xml'); const c = path.join(tmp, 'c.xml'); const d = path.join(tmp, 'd.xml');
  fs.writeFileSync(a, '<r b="2" a="1"><x/><y>v</y></r>');
  fs.writeFileSync(b, '<r a="1" b="2">\n  <x></x>\n  <y>v</y>\n</r>\n');
  fs.writeFileSync(c, '<r a="1" b="2"><x/><y>w</y></r>');
  fs.writeFileSync(d, '<r><x></r>');
  const U = s.vscode.Uri.file;
  assert.deepEqual(await s.tools.compare(U(a), U(b)), { same: true });
  assert.match(s.ui.log.info.at(-1), /same XML/);
  assert.deepEqual(await s.tools.compare(U(a), U(c)), { same: false });
  const [ua, ub] = s.ui.log.diffs.at(-1);
  assert.match(s.tools._contents.get(ua.toString()), /<y>v<\/y>/);
  assert.match(s.tools._contents.get(ub.toString()), /<y>w<\/y>/);
  assert.equal(s.tries().compare, 2);
  await s.tools.compare(U(a), U(d));
  assert.match(s.ui.log.warn.at(-1), /d\.xml is not well formed.*No free try was used/);
  assert.equal(s.tries().compare, 2);
  // second file picked in a dialog
  s.ui.dialogs.push([U(b)]);
  await s.tools.compare(U(a));
  assert.equal(s.tries().compare, 3);
});

test('gate: after 3 tries the Pro panel opens and the tool does not run; Pro owned runs with no count', async () => {
  const s = setup();
  const a = path.join(tmp, 'g1.xml'); fs.writeFileSync(a, '<r/>');
  const U = s.vscode.Uri.file;
  for (let i = 0; i < 3; i++) await s.tools.compare(U(a), U(a));
  assert.equal(s.tries().compare, 3);
  assert.equal(s.pro.left('compare'), 0);
  const r = await s.tools.compare(U(a), U(a));
  assert.equal(r, undefined);
  assert.equal(s.panels.length, 1);
  assert.equal(s.panels[0].title, 'Compare XML ignoring formatting');
  assert.equal(s.tries().compare, 3);
  // other tools keep their own 3 tries
  assert.equal(s.pro.left('xpathFolder'), 3);
  const owned = setup({ licensed: true });
  for (let i = 0; i < 5; i++) assert.deepEqual(await owned.tools.compare(U(a), U(a)), { same: true });
  assert.equal(owned.tries().compare, undefined);
  assert.equal(owned.panels.length, 0);
});
