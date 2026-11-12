'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { WorkerClient, oneShot } = require('./client');
const { format } = require('./core/format');
const { elementAt, children } = require('./core/index');
const { xpathFor } = require('./core/xpathgen');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');
const { createPro } = require('./pro');
const { createProTools } = require('./protools');
const { createReach, runAs } = require('./reach');
const reachConfig = require('./reach-config');

const EXT_ID = 'zovo.zovo-xml-xpath-tools';
const S = 'xmlXpathTools';
const SELECTOR = [{ language: 'xml' }, { language: 'xsl' }, { language: 'svg' }, { language: 'xaml' }, { language: 'xhtml' }];
const XML_LANGS = new Set(SELECTOR.map(s => s.language));
const IN_PROCESS_LIMIT = 512 * 1024; // smaller texts format in the extension host (a few ms)
const CHUNK = 500; // tree rows per group for elements with many children
let rating = { success() {}, failure() {} };
let workerPath = '';
const sampleDocs = new Set();

const cfg = () => vscode.workspace.getConfiguration(S);
const mb = n => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';
const isXmlDoc = d => !!d && (XML_LANGS.has(d.languageId) || /\.(xml|xsd|xsl|xslt|svg|xaml|csproj|vbproj|fsproj|props|targets|nuspec|resx|kml|gpx|rss|atom|wsdl|dbk|xlf|xliff|plist|config|pom)$/i.test(d.uri.path));
const limitChars = () => Math.max(1, cfg().get('maxFileMB', 60)) * 1048576;
const ratingSuccess = doc => rating.success(sampleDocs.has(doc.uri.toString()) ? { sample: true } : doc.uri);

// ---------------------------------------------------------------- index store
class IndexStore {
  constructor(client) { this.client = client; this.map = new Map(); this.emitter = new vscode.EventEmitter(); this.onDidUpdate = this.emitter.event; }
  key(doc) { return doc.uri.toString() + '#' + doc.version; }
  peek(doc) { const e = this.map.get(doc.uri.toString()); return e && e.version === doc.version ? e.index : null; }
  /** Index of the document at its current version (from the worker). Resolves null when the file is over the limit. */
  get(doc) {
    const k = doc.uri.toString();
    const e = this.map.get(k);
    if (e && e.version === doc.version) return e.promise;
    const text = doc.getText();
    if (text.length > limitChars()) {
      const entry = { version: doc.version, index: null, tooBig: text.length, promise: Promise.resolve(null) };
      this.map.set(k, entry);
      return entry.promise;
    }
    const entry = { version: doc.version, index: null };
    entry.promise = this.client.request({ op: 'index', key: this.key(doc), text }).then(r => {
      if (!r.ok) { if (r.internal) rating.failure(); return null; }
      entry.index = r.index;
      this.emitter.fire(doc);
      return r.index;
    });
    this.map.set(k, entry);
    return entry.promise;
  }
  tooBig(doc) { const e = this.map.get(doc.uri.toString()); return e && e.version === doc.version ? e.tooBig || 0 : 0; }
  forget(doc) { this.map.delete(doc.uri.toString()); }
}

// ---------------------------------------------------------------- formatting
function formatOptions(doc, fo, extra = {}) {
  const c = cfg();
  return {
    indent: fo && fo.insertSpaces === false ? '\t' : ' '.repeat(fo && fo.tabSize ? Number(fo.tabSize) : 2),
    eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    attributes: c.get('format.attributes', 'keep'),
    keepBlankLines: c.get('format.keepBlankLines', true),
    removeComments: c.get('minify.removeComments', false),
    ...extra,
  };
}

/** Formats text in process (small) or in a worker with a progress note (big). Resolves the worker reply. */
async function runFormat(doc, text, options, token, label) {
  if (text.length <= IN_PROCESS_LIMIT) return format(text, options);
  const title = `${label} ${path.posix.basename(doc.uri.path)} (${mb(text.length)})`;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, ptoken) => {
    let done = 0;
    const src = new vscode.CancellationTokenSource();
    const subs = [ptoken.onCancellationRequested(() => src.cancel())];
    if (token) subs.push(token.onCancellationRequested(() => src.cancel()));
    try {
      return await oneShot(workerPath, { op: 'format', text, options }, {
        token: src.token,
        onProgress: f => { const pct = Math.round(f * 100); if (pct > done) { progress.report({ increment: pct - done, message: pct + '%' }); done = pct; } },
      });
    } finally { subs.forEach(s => s.dispose()); src.dispose(); }
  });
}

function showFormatError(doc, r, what) {
  if (r.cancelled) return;
  if (r.internal) { rating.failure(); vscode.window.showErrorMessage(`${what} stopped: ${r.error}`); return; }
  const e = r.error || {};
  const msg = `Not ${what === 'Minify' ? 'minified' : 'formatted'}: ${e.message || r.error}. The file is unchanged.`;
  vscode.window.showWarningMessage(msg, 'Go to error').then(pick => {
    if (pick && typeof e.offset === 'number') {
      const pos = doc.positionAt(e.offset);
      vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
    }
  });
}

class Formatter {
  async provideDocumentFormattingEdits(doc, fo, token) {
    const text = doc.getText();
    const r = await runFormat(doc, text, formatOptions(doc, fo), token, 'Formatting');
    if (!r.ok) { showFormatError(doc, r, 'Format'); return []; }
    ratingSuccess(doc);
    if (!r.changed) return [];
    return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), r.text)];
  }
  async provideDocumentRangeFormattingEdits(doc, range, fo, token) {
    const endsAtLineStart = range.end.character === 0 && range.end.line > range.start.line;
    const full = new vscode.Range(range.start.line, 0, range.end.line, endsAtLineStart ? 0 : doc.lineAt(range.end.line).text.length);
    const text = doc.getText(full);
    const base = /^[ \t]*/.exec(doc.lineAt(full.start.line).text)[0];
    const r = await runFormat(doc, text, formatOptions(doc, fo, { fragment: true, baseIndent: base }), token, 'Formatting');
    if (!r.ok) { showFormatError(doc, r, 'Format'); return []; }
    ratingSuccess(doc);
    return r.changed ? [vscode.TextEdit.replace(full, r.text)] : [];
  }
}

async function minifyCommand() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showInformationMessage('Open an XML file first.'); return; }
  const doc = ed.document;
  const sel = ed.selection;
  const range = sel.isEmpty ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)) : new vscode.Range(sel.start, sel.end);
  const text = doc.getText(range);
  const r = await runFormat(doc, text, formatOptions(doc, null, { minify: true, fragment: !sel.isEmpty }), null, 'Minifying');
  if (!r.ok) { showFormatError(doc, r, 'Minify'); return; }
  if (r.changed) await ed.edit(b => b.replace(range, r.text));
  ratingSuccess(doc);
  vscode.window.setStatusBarMessage(`XML minified: ${text.length.toLocaleString('en-US')} → ${r.text.length.toLocaleString('en-US')} characters`, 5000);
}

/** For files VS Code does not pass to extensions (over 50 MB) or that are not open: format on disk in a worker. */
async function formatFileOnDisk(arg) {
  let uri = arg instanceof vscode.Uri ? arg : undefined;
  if (!uri) {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && tab.input && tab.input.uri instanceof vscode.Uri) uri = tab.input.uri;
  }
  if (!uri) {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { XML: ['xml', 'svg', 'xsd', 'xsl', 'xslt', 'kml', 'gpx', 'rss', 'xaml', 'csproj', 'config', 'plist'], 'All files': ['*'] }, openLabel: 'Format' });
    if (!pick || !pick.length) return;
    uri = pick[0];
  }
  if (uri.scheme !== 'file') { vscode.window.showWarningMessage('This command works on files on this computer. For other files, open them and use Format Document.'); return; }
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (open && open.isDirty) { vscode.window.showWarningMessage('Save the file first: this command formats the copy on disk.'); return; }
  const base = path.basename(uri.fsPath);
  const ext = path.extname(base);
  const outPath = path.join(path.dirname(uri.fsPath), base.slice(0, base.length - ext.length) + '.formatted' + (ext || '.xml'));
  const choice = await vscode.window.showQuickPick([
    { label: `Write ${path.basename(outPath)}`, description: 'keeps the original file', out: outPath },
    { label: `Replace ${base}`, description: 'overwrites the file on disk (no undo)', out: uri.fsPath, replace: true },
  ], { placeHolder: `Format ${base} on disk (${mb(fs.statSync(uri.fsPath).size)})` });
  if (!choice) return;
  if (choice.replace) {
    const ok = await vscode.window.showWarningMessage(`Replace ${base} with the formatted text? This cannot be undone.`, { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
  }
  const c = cfg();
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Formatting ${base}`, cancellable: true }, (progress, token) => {
    let done = 0;
    return oneShot(workerPath, {
      op: 'formatFile', path: uri.fsPath, out: choice.out,
      options: { indent: ' '.repeat(Number(vscode.workspace.getConfiguration('editor').get('tabSize', 2)) || 2), attributes: c.get('format.attributes', 'keep'), keepBlankLines: c.get('format.keepBlankLines', true) },
    }, { token, onProgress: f => { const pct = Math.round(f * 100); if (pct > done) { progress.report({ increment: pct - done, message: pct + '%' }); done = pct; } } });
  });
  if (!r.ok) {
    if (r.cancelled) return;
    if (r.internal) { rating.failure(); vscode.window.showErrorMessage(`Format stopped: ${r.error}`); return; }
    const e = r.error || {};
    vscode.window.showWarningMessage(`Not formatted: ${e.message || r.error}${e.line ? '' : ''}. The file is unchanged.`);
    return;
  }
  rating.success(uri);
  const msg = `Formatted ${base} in ${(r.ms / 1000).toFixed(1)} s: ${mb(r.bytesIn)} → ${mb(r.bytesOut)}.`;
  const act = await vscode.window.showInformationMessage(msg, choice.replace ? 'Reveal' : 'Open', 'Reveal in Explorer');
  if (act === 'Open') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(r.out));
  else if (act) vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(r.out));
}

// ---------------------------------------------------------------- tree view
class XmlTree {
  constructor(store) {
    this.store = store; this.doc = null; this.ix = null; this.groups = new Map(); this.kids = new Map();
    this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event;
  }
  setDoc(doc, ix) {
    // Rows are { i } objects, never bare numbers: VS Code treats a parent 0 (the root element) as "no parent", so
    // revealing an element under the root failed and left the tree empty. A new index means new element numbers: a new
    // generation gives every row a new id, so VS Code never maps an old row handle to a different element.
    this.doc = doc; this.ix = ix; this.groups.clear(); this.kids.clear(); this.nodes = new Map(); this.gen = (this.gen || 0) + 1; this.changedAt = Date.now();
    this.emitter.fire();
  }
  node(i) {
    if (!this.nodes) this.nodes = new Map();
    let n = this.nodes.get(i);
    if (!n) { n = { i }; this.nodes.set(i, n); }
    return n;
  }
  kidsOf(i) {
    let k = this.kids.get(i);
    if (!k) { k = children(this.ix, i); this.kids.set(i, k); }
    return k;
  }
  group(p, from) {
    const key = p + ':' + from;
    let g = this.groups.get(key);
    if (!g) {
      const n = this.kidsOf(p).length;
      g = { group: true, parent: p, from, to: Math.min(n, from + CHUNK) };
      this.groups.set(key, g);
    }
    return g;
  }
  getChildren(el) {
    if (!this.ix) return [];
    if (el && el.group) return this.kidsOf(el.parent).slice(el.from, el.to).map(i => this.node(i));
    const p = el === undefined ? -1 : el.i;
    const k = this.kidsOf(p);
    if (k.length <= CHUNK) return k.map(i => this.node(i));
    const out = [];
    for (let f = 0; f < k.length; f += CHUNK) out.push(this.group(p, f));
    return out;
  }
  getParent(el) {
    if (!this.ix) return undefined;
    if (el && el.group) return el.parent < 0 ? undefined : this.node(el.parent);
    const p = this.ix.parent[el.i];
    const sibs = this.kidsOf(p);
    if (sibs.length > CHUNK) { const pos = sibs.indexOf(el.i); return this.group(p, Math.floor(pos / CHUNK) * CHUNK); }
    return p < 0 ? undefined : this.node(p);
  }
  getTreeItem(row) {
    const ix = this.ix;
    if (row.group) {
      const it = new vscode.TreeItem(`[${row.from + 1} … ${row.to}]`, vscode.TreeItemCollapsibleState.Collapsed);
      it.id = `${this.gen}:g${row.parent}:${row.from}`;
      it.description = `${row.to - row.from} of ${this.kidsOf(row.parent).length} elements`;
      return it;
    }
    const el = row.i;
    const name = ix.names[ix.nameId[el]];
    const kids = ix.childCount[el];
    const it = new vscode.TreeItem(name, kids ? (ix.parent[el] < 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    it.id = `${this.gen}:${el}`;
    const bits = [];
    if (ix.keyName[el]) bits.push(`${ix.keyName[el]}="${ix.keyValue[el].length > 40 ? ix.keyValue[el].slice(0, 39) + '…' : ix.keyValue[el]}"`);
    if (ix.preview[el]) bits.push(ix.preview[el].length > 50 ? ix.preview[el].slice(0, 49) + '…' : ix.preview[el]);
    if (kids) bits.push(`${kids} child${kids === 1 ? '' : 'ren'}`);
    it.description = bits.join(' · ');
    const line = this.doc ? this.doc.positionAt(ix.start[el]).line + 1 : 0;
    it.tooltip = new vscode.MarkdownString(`\`${xpathFor(ix, el, 'indexed')}\`\n\nLine ${line}, ${ix.attrCount[el]} attribute${ix.attrCount[el] === 1 ? '' : 's'}`);
    it.iconPath = new vscode.ThemeIcon(kids ? 'symbol-namespace' : 'symbol-field');
    it.contextValue = 'xmlElement';
    it.command = { command: `${S}.revealElement`, title: 'Show in editor', arguments: [el] };
    return it;
  }
}

// ---------------------------------------------------------------- XPath results view
class Results {
  constructor() { this.items = []; this.doc = null; this.ix = null; this.expr = ''; this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  set(doc, ix, expr, items) { this.doc = doc; this.ix = ix; this.expr = expr; this.items = items; this.emitter.fire(); }
  getChildren(el) { return el ? [] : this.items; }
  getTreeItem(r) {
    if (r.pro) {
      const it = new vscode.TreeItem(r.pro);
      it.description = r.description;
      it.iconPath = new vscode.ThemeIcon('folder-library');
      it.tooltip = 'Zovo Pro: runs this XPath on every XML file in a folder and opens the results as CSV, JSON or a Markdown report. Turn this line off with the setting xmlXpathTools.showProTools.';
      it.command = { command: `${S}.xpathFolderFromResults`, title: 'Run this XPath on a folder' };
      return it;
    }
    if (r.note) {
      const it = new vscode.TreeItem(r.note);
      it.iconPath = new vscode.ThemeIcon(r.icon || 'info');
      it.tooltip = r.note;
      return it;
    }
    const label = r.kind === 'attribute' ? '@' + r.name : r.kind === 'element' ? `<${r.name}>` : r.name;
    const it = new vscode.TreeItem(label);
    const line = r.line ? `line ${r.line}` : '';
    it.description = [r.value ? (r.kind === 'attribute' ? `="${r.value}"` : r.value) : '', line].filter(Boolean).join('  ·  ');
    it.tooltip = new vscode.MarkdownString().appendCodeblock(r.value || '', 'text');
    it.iconPath = new vscode.ThemeIcon({ element: 'symbol-namespace', attribute: 'symbol-property', text: 'symbol-text', cdata: 'symbol-text', comment: 'comment', pi: 'symbol-event' }[r.kind] || 'circle-small');
    it.contextValue = 'xpathResult';
    it.command = { command: `${S}.revealResult`, title: 'Show in editor', arguments: [r] };
    return it;
  }
}

// ---------------------------------------------------------------- helpers
/** Attribute name at an offset inside a start tag, or ''. */
function attributeAt(doc, ix, i, offset) {
  if (offset < ix.start[i] || offset >= ix.openEnd[i]) return '';
  const s = ix.start[i];
  const tagText = doc.getText(new vscode.Range(doc.positionAt(s), doc.positionAt(ix.openEnd[i])));
  const re = /([^\s=<>/"']+)\s*=\s*("[^"]*"|'[^']*')/g;
  let m;
  while ((m = re.exec(tagText))) {
    const a = s + m.index, b = a + m[0].length;
    if (offset >= a && offset <= b && !m[1].startsWith('xmlns')) return m[1];
  }
  return '';
}

function attributeRange(doc, ix, i, name) {
  const s = ix.start[i];
  const tagText = doc.getText(new vscode.Range(doc.positionAt(s), doc.positionAt(ix.openEnd[i])));
  const re = /([^\s=<>/"']+)\s*=\s*("[^"]*"|'[^']*')/g;
  let m;
  while ((m = re.exec(tagText))) if (m[1] === name) return new vscode.Range(doc.positionAt(s + m.index), doc.positionAt(s + m.index + m[0].length));
  return null;
}

function nameRange(doc, ix, i) {
  const s = ix.start[i];
  return new vscode.Range(doc.positionAt(s + 1), doc.positionAt(s + 1 + ix.names[ix.nameId[i]].length));
}

async function revealRange(doc, range) {
  const ed = await vscode.window.showTextDocument(doc, { selection: range, preserveFocus: false, preview: false, viewColumn: visibleColumn(doc) });
  ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function visibleColumn(doc) {
  const ed = vscode.window.visibleTextEditors.find(e => e.document === doc);
  return ed ? ed.viewColumn : undefined;
}

function shortPath(p, max = 60) { return p.length <= max ? p : '…' + p.slice(p.length - max + 1); }

// ---------------------------------------------------------------- activate
function activate(context) {
  workerPath = path.join(context.extensionPath, 'dist', 'worker.js');
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: S, name: 'XML Formatter & XPath Tools' });
  registerSupport({ vscode, context, prefix: S, selfId: EXT_ID });
  const client = new WorkerClient(workerPath);
  const store = new IndexStore(client);
  const tree = new XmlTree(store);
  const results = new Results();
  const diagnostics = vscode.languages.createDiagnosticCollection('xml-well-formed');
  const treeView = vscode.window.createTreeView(`${S}.tree`, { treeDataProvider: tree, showCollapseAll: true });
  const resultsView = vscode.window.createTreeView(`${S}.results`, { treeDataProvider: results });
  const status = vscode.window.createStatusBarItem(`${S}.xpath`, vscode.StatusBarAlignment.Right, 101);
  status.name = 'XPath at cursor';
  status.command = `${S}.copyXPathAs`;
  context.subscriptions.push({ dispose: () => client.terminate() }, diagnostics, treeView, resultsView, status);

  const fmt = new Formatter();
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, fmt),
    vscode.languages.registerDocumentRangeFormattingEditProvider(SELECTOR, fmt),
  );

  // ---- active document tracking
  let activeDoc = null;
  let timer = null;
  const refresh = async (doc, delay) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!doc || doc.isClosed) return;
      const ix = await store.get(doc);
      if (doc !== activeDoc && !vscode.window.visibleTextEditors.some(e => e.document === doc)) return;
      updateDiagnostics(doc, ix);
      if (doc === activeDoc) { showTree(doc, ix); updateStatus(); }
    }, delay);
  };
  const delayFor = doc => (doc.getText().length > 5 * 1048576 ? 1500 : 400);

  function showTree(doc, ix) {
    if (ix) {
      tree.setDoc(doc, ix);
      treeView.message = ix.error ? `Not well formed at line ${ix.error.line}, column ${ix.error.col}: ${ix.error.message}. The tree shows the part before the error.` : undefined;
      treeView.description = `${ix.count.toLocaleString('en-US')} elements`;
    } else {
      tree.setDoc(doc, null);
      const big = store.tooBig(doc);
      treeView.message = big ? `This file is ${mb(big)}. The tree, XPath and checks work up to ${cfg().get('maxFileMB', 60)} MB (setting ${S}.maxFileMB). Format Document still works.` : undefined;
      treeView.description = '';
    }
  }

  function updateDiagnostics(doc, ix) {
    if (!cfg().get('validate', true) || !ix) { diagnostics.delete(doc.uri); return; }
    const out = [];
    if (ix.error) {
      const p = doc.positionAt(ix.error.offset);
      const d = new vscode.Diagnostic(new vscode.Range(p, p.translate(0, 1)), ix.error.message, vscode.DiagnosticSeverity.Error);
      d.source = 'XML'; out.push(d);
    }
    for (const [off, pre] of ix.unbound || []) {
      const p = doc.positionAt(off);
      const d = new vscode.Diagnostic(new vscode.Range(p, p.translate(0, 1 + pre.length)), `Namespace prefix "${pre}" is not declared (add xmlns:${pre}="...")`, vscode.DiagnosticSeverity.Error);
      d.source = 'XML'; out.push(d);
    }
    const dt = ix.doctype;
    if (dt && dt.entities) {
      const r = new vscode.Range(doc.positionAt(dt.start), doc.positionAt(Math.min(dt.end, dt.start + 9)));
      if (dt.entities.maxExpansion > 100000) {
        const d = new vscode.Diagnostic(r, `Entity expansion attack: &${dt.entities.biggest}; would expand to about ${Number(dt.entities.maxExpansion).toExponential(1)} characters ("billion laughs"). This extension never expands entities.`, vscode.DiagnosticSeverity.Warning);
        d.source = 'XML'; out.push(d);
      }
      if (dt.entities.external && dt.entities.external.length) {
        const d = new vscode.Diagnostic(r, `External entit${dt.entities.external.length === 1 ? 'y' : 'ies'} ${dt.entities.external.map(n => '&' + n + ';').join(', ')} point outside this file. They are not read: nothing is loaded from disk or the network.`, vscode.DiagnosticSeverity.Warning);
        d.source = 'XML'; out.push(d);
      }
    }
    diagnostics.set(doc.uri, out);
  }

  function setActive(ed) {
    const doc = ed && isXmlDoc(ed.document) ? ed.document : null;
    vscode.commands.executeCommand('setContext', `${S}.xmlActive`, !!doc);
    if (!doc) {
      if (!ed) {
        // a big file that VS Code does not pass to extensions shows as a tab without a text editor
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const u = tab && tab.input && tab.input.uri;
        if (u instanceof vscode.Uri && /\.(xml|svg|kml|gpx|xsd|xaml|rss|csproj|config)$/i.test(u.path) && !vscode.window.activeTextEditor) {
          treeView.message = 'VS Code does not pass files over 50 MB to extensions. Use "Format Large XML File on Disk" (Explorer right-click menu) to format it.';
        }
      }
      status.hide();
      return;
    }
    if (doc === activeDoc) { updateStatus(); return; }
    activeDoc = doc;
    const ix = store.peek(doc);
    if (ix) { showTree(doc, ix); updateStatus(); } else { treeView.message = 'Reading the file…'; refresh(doc, 0); }
  }

  let statusTimer = null;
  function updateStatus() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document !== activeDoc || !cfg().get('statusBar.showXPath', true)) { status.hide(); return; }
      const ix = store.peek(ed.document);
      if (!ix || !ix.count) { status.hide(); return; }
      const off = ed.document.offsetAt(ed.selection.active);
      const i = elementAt(ix, off);
      if (i < 0) { status.hide(); return; }
      const p = xpathFor(ix, i, cfg().get('copyXPathStyle', 'indexed'), attributeAt(ed.document, ix, i, off));
      status.text = '$(symbol-namespace) ' + shortPath(p, 70);
      status.tooltip = `XPath at the cursor:\n${p}\n\nClick to copy it (3 styles).`;
      status.show();
      if (treeView.visible && cfg().get('tree.syncWithCursor', true) && tree.doc === ed.document && tree.ix === ix) {
        // right after a refresh VS Code may not have the new rows yet: reveal a moment later
        const wait = Math.max(0, 400 - (Date.now() - (tree.changedAt || 0)));
        const go = () => { if (tree.ix === ix && treeView.visible) treeView.reveal(tree.node(i), { select: true, focus: false, expand: false }).then(undefined, () => {}); };
        if (wait) setTimeout(go, wait); else go();
      }
    }, 120);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(setActive),
    vscode.window.tabGroups.onDidChangeTabs(() => { if (!vscode.window.activeTextEditor) setActive(undefined); }),
    vscode.window.onDidChangeTextEditorSelection(e => { if (e.textEditor.document === activeDoc) updateStatus(); }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!e.contentChanges.length) return;
      if (e.document === activeDoc || (isXmlDoc(e.document) && vscode.window.visibleTextEditors.some(v => v.document === e.document))) refresh(e.document, delayFor(e.document));
    }),
    vscode.workspace.onDidOpenTextDocument(doc => { if (isXmlDoc(doc) && ['file', 'untitled', 'vscode-remote'].includes(doc.uri.scheme) && doc !== activeDoc && cfg().get('validate', true)) setTimeout(() => store.get(doc).then(ix => updateDiagnostics(doc, ix)), 50); }),
    vscode.workspace.onDidCloseTextDocument(doc => { store.forget(doc); diagnostics.delete(doc.uri); sampleDocs.delete(doc.uri.toString()); if (doc === activeDoc) activeDoc = null; }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(S) && activeDoc) { store.forget(activeDoc); refresh(activeDoc, 0); } }),
    treeView.onDidChangeVisibility(() => { if (treeView.visible) updateStatus(); }),
  );

  // ---- commands
  const needDoc = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { vscode.window.showInformationMessage('Open an XML file first.'); return null; }
    return ed;
  };
  const freshIndex = async doc => {
    const ix = await store.get(doc);
    if (!ix) {
      const big = store.tooBig(doc);
      vscode.window.showWarningMessage(big ? `This file is ${mb(big)}; XPath works up to ${cfg().get('maxFileMB', 60)} MB (setting ${S}.maxFileMB).` : 'Could not read the file.');
    }
    return ix;
  };

  async function evaluateCommand(exprArg) {
    const ed = needDoc();
    if (!ed) return;
    const doc = ed.document;
    const history = context.workspaceState.get(`${S}.history`, []);
    let expr = typeof exprArg === 'string' ? exprArg : undefined;
    if (expr === undefined) {
      const ix0 = store.peek(doc);
      const pre = ix0 ? Object.keys(ix0.prefixes) : [];
      expr = await vscode.window.showInputBox({
        title: 'Evaluate XPath',
        value: history[0] || '//*',
        valueSelection: [0, (history[0] || '//*').length],
        prompt: 'XPath 1.0. Names without a prefix also match elements in a default namespace.' + (pre.length ? ` Prefixes in this file: ${pre.slice(0, 8).join(', ')}.` : ''),
        ignoreFocusOut: true,
      });
    }
    if (!expr || !expr.trim()) return;
    expr = expr.trim();
    context.workspaceState.update(`${S}.history`, [expr, ...history.filter(h => h !== expr)].slice(0, 20));
    const ix = await freshIndex(doc);
    if (!ix) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'XPath' }, () =>
      client.request({ op: 'eval', key: store.key(doc), text: doc.getText(), expr, options: { strictNamespaces: cfg().get('xpath.strictNamespaces', false), maxResults: cfg().get('xpath.maxResults', 5000) } }));
    let items;
    if (!r.ok) {
      if (r.internal) rating.failure();
      items = [{ note: r.error || 'XPath failed', icon: 'error' }];
      resultsView.message = `${expr}`;
    } else if (r.type === 'nodes') {
      items = r.items.map(it => ({ ...it, line: it.ord >= 0 && it.kind === 'element' ? doc.positionAt(ix.start[it.ord]).line + 1 : (it.at ? it.at.line : 0) }));
      resultsView.message = `${r.total.toLocaleString('en-US')} result${r.total === 1 ? '' : 's'} for ${expr} (${r.ms} ms)` + (r.total > r.items.length ? `. Showing the first ${r.items.length}.` : '');
      if (!r.total) items = [{ note: 'No nodes match.' + (ix.defaultNs && cfg().get('xpath.strictNamespaces', false) ? ' This file has a default namespace; turn off the strict namespaces setting or use a prefix.' : ''), icon: 'info' }];
      ratingSuccess(doc);
    } else {
      items = [{ note: `${r.type}: ${r.value}`, icon: 'symbol-numeric' }];
      resultsView.message = `${expr} (${r.ms} ms)`;
      ratingSuccess(doc);
    }
    for (const n of (r.notes || [])) items.push({ note: n, icon: 'shield' });
    if (r.ok && cfg().get('showProTools', true)) {
      const n = pro.left('xpathFolder');
      items.push({ pro: 'Run this XPath on every XML file in a folder', description: pro.licensed ? 'Zovo Pro' : `Zovo Pro · ${n === 3 ? '3 free tries' : n === 1 ? '1 try left' : n + ' tries left'}` });
    }
    results.set(doc, ix, expr, items);
    vscode.commands.executeCommand('setContext', `${S}.hasResults`, true);
    await vscode.commands.executeCommand(`${S}.results.focus`);
    return r;
  }

  async function revealResult(r) {
    const doc = results.doc;
    if (!doc || !r || r.note) return;
    if (doc.isClosed) { vscode.window.showInformationMessage('The file of these results is closed.'); return; }
    const ix = store.peek(doc) || results.ix;
    let range = null;
    if (r.ord >= 0 && ix && r.ord < ix.count) {
      if (r.kind === 'element') range = nameRange(doc, ix, r.ord);
      else if (r.kind === 'attribute') range = attributeRange(doc, ix, r.ord, r.name);
    }
    if (!range && r.at) { const p = new vscode.Position(Math.max(0, r.at.line - 1), Math.max(0, r.at.col - 1)); range = new vscode.Range(p, p); }
    if (!range && r.ord >= 0 && ix) range = nameRange(doc, ix, r.ord);
    if (range) await revealRange(doc, range);
  }

  async function copyXPath(style, quiet) {
    const ed = needDoc();
    if (!ed) return;
    const doc = ed.document;
    const ix = await freshIndex(doc);
    if (!ix) return;
    const off = doc.offsetAt(ed.selection.active);
    const i = elementAt(ix, off);
    if (i < 0) { vscode.window.showInformationMessage('Put the cursor inside an element.'); return; }
    const attr = attributeAt(doc, ix, i, off);
    const p = xpathFor(ix, i, style || cfg().get('copyXPathStyle', 'indexed'), attr);
    await vscode.env.clipboard.writeText(p);
    ratingSuccess(doc);
    if (!quiet) vscode.window.setStatusBarMessage(`$(check) Copied XPath: ${shortPath(p, 90)}`, 4000);
    return p;
  }

  async function copyXPathAs() {
    const ed = needDoc();
    if (!ed) return;
    const doc = ed.document;
    const ix = await freshIndex(doc);
    if (!ix) return;
    const off = doc.offsetAt(ed.selection.active);
    const i = elementAt(ix, off);
    if (i < 0) { vscode.window.showInformationMessage('Put the cursor inside an element.'); return; }
    const attr = attributeAt(doc, ix, i, off);
    const items = [
      { label: xpathFor(ix, i, 'indexed', attr), description: 'with positions', style: 'indexed' },
      { label: xpathFor(ix, i, 'predicates', attr), description: 'with id or name attributes', style: 'predicates' },
      { label: xpathFor(ix, i, 'portable', attr), description: 'portable: works without namespace setup', style: 'portable' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Copy which XPath?', matchOnDescription: true });
    if (!pick) return;
    await vscode.env.clipboard.writeText(pick.label);
    ratingSuccess(doc);
    vscode.window.setStatusBarMessage(`$(check) Copied XPath: ${shortPath(pick.label, 90)}`, 4000);
  }

  async function openSample() {
    const src = path.join(context.extensionPath, 'media', 'sample.xml');
    const doc = await vscode.workspace.openTextDocument({ language: 'xml', content: fs.readFileSync(src, 'utf8') });
    sampleDocs.add(doc.uri.toString());
    await vscode.window.showTextDocument(doc);
  }

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${S}.${id}`, fn));

  // ---- Zovo Pro (src/pro.js, src/protools.js): 3 tools, 3 free tries each. Nothing about Pro runs or shows on open.
  // REACH1: this listing has no webview, so no toolbar row. The tools sit in the Explorer right-click menu ("Zovo Pro:
  // <tool>": folders for the 2 folder tools, XML files for Compare) and as one line at the end of XPath Results after
  // an XPath ran ("Run this XPath on every XML file in a folder"). Explorer runs tag a card link <install id>_ctx,
  // the XPath Results line <install id>_toolbar. The setting xmlXpathTools.showProTools hides both.
  const pro = createPro({ vscode, context, prefix: S });
  let proClient = null;
  context.subscriptions.push({ dispose: () => { if (proClient) proClient.terminate(); } });
  const proTools = createProTools({
    vscode, pro,
    request: msg => { if (!proClient) proClient = new WorkerClient(workerPath); return proClient.request(msg); },
    formatOptions: text => ({ indent: ' '.repeat(Number(vscode.workspace.getConfiguration('editor').get('tabSize', 2)) || 2), eol: text.includes('\r\n') ? '\r\n' : '\n', attributes: cfg().get('format.attributes', 'keep'), keepBlankLines: cfg().get('format.keepBlankLines', true) }),
    maxChars: limitChars,
    xpathOptions: () => ({ strictNamespaces: cfg().get('xpath.strictNamespaces', false), maxResults: cfg().get('xpath.maxResults', 5000) }),
    lastExpr: () => (context.workspaceState.get(`${S}.history`, [])[0] || ''),
  });
  proTools.register(context);
  const reach = createReach({ vscode, context, ...reachConfig, licensed: () => pro.licensed, shown: () => cfg().get('showProTools', true) });
  reach.registerCtx();
  const proCmd = fn => async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(`XML Pro tool stopped: ${e && e.message ? e.message : String(e)}`); }
  };
  const isUri = u => !!(u && typeof u === 'object' && u.scheme && u.fsPath);
  reg('xpathFolder', reach.wrap(proCmd((arg, expr) => proTools.xpathFolder(isUri(arg) ? arg : undefined, typeof expr === 'string' ? expr : undefined))));
  reg('formatFolder', reach.wrap(proCmd(arg => proTools.formatFolder(isUri(arg) ? arg : undefined))));
  reg('compareIgnoringFormat', reach.wrap(proCmd((arg, all) => {
    const two = Array.isArray(all) && all.length === 2 && all.every(isUri) ? all : null;
    return two ? proTools.compare(two[0], two[1]) : proTools.compare(isUri(arg) ? arg : undefined);
  })));
  reg('xpathFolderFromResults', () => runAs('toolbar', proCmd(() => proTools.xpathFolder(undefined, results.expr || undefined))));
  pro.onDidChange(() => { if (results.items.some(r => r.pro)) { const n = pro.left('xpathFolder'); for (const r of results.items) if (r.pro) r.description = pro.licensed ? 'Zovo Pro' : `Zovo Pro · ${n === 3 ? '3 free tries' : n === 1 ? '1 try left' : n + ' tries left'}`; results.emitter.fire(); } });
  reg('minify', minifyCommand);
  reg('evaluate', evaluateCommand);
  reg('copyXPath', () => copyXPath());
  reg('copyXPathAs', copyXPathAs);
  reg('formatFileOnDisk', formatFileOnDisk);
  reg('openSample', openSample);
  reg('showTree', async () => { await vscode.commands.executeCommand(`${S}.tree.focus`); });
  const elIndex = a => (typeof a === 'number' ? a : a && typeof a.i === 'number' ? a.i : -1);
  reg('revealElement', async a => {
    const i = elIndex(a);
    if (!tree.doc || !tree.ix || i < 0) return;
    await revealRange(tree.doc, nameRange(tree.doc, tree.ix, i));
  });
  reg('copyElementXPath', async a => {
    const i = elIndex(a);
    if (!tree.ix || i < 0) return;
    const p = xpathFor(tree.ix, i, cfg().get('copyXPathStyle', 'indexed'));
    await vscode.env.clipboard.writeText(p);
    vscode.window.setStatusBarMessage(`$(check) Copied XPath: ${shortPath(p, 90)}`, 4000);
  });
  reg('revealResult', revealResult);
  reg('copyResultValue', async r => { if (r && !r.note) { await vscode.env.clipboard.writeText(r.value || ''); vscode.window.setStatusBarMessage('$(check) Copied value', 3000); } });
  reg('copyResultXPath', async r => {
    if (!r || r.note || r.ord < 0 || !results.ix) return;
    const p = xpathFor(results.ix, r.ord, cfg().get('copyXPathStyle', 'indexed'), r.kind === 'attribute' ? r.name : undefined);
    await vscode.env.clipboard.writeText(p);
    vscode.window.setStatusBarMessage(`$(check) Copied XPath: ${shortPath(p, 90)}`, 4000);
  });
  reg('copyAllResults', async () => {
    const lines = results.items.filter(r => !r.note).map(r => `${r.line || ''}\t${r.kind === 'attribute' ? '@' + r.name : r.name}\t${r.value || ''}`);
    await vscode.env.clipboard.writeText(lines.join('\n'));
    vscode.window.setStatusBarMessage(`$(check) Copied ${lines.length} results`, 3000);
  });
  reg('rerun', () => (results.expr ? evaluateCommand(results.expr) : evaluateCommand()));
  reg('getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${S}.start`, false));

  setActive(vscode.window.activeTextEditor);
  for (const ed of vscode.window.visibleTextEditors) if (isXmlDoc(ed.document) && ed.document !== activeDoc) store.get(ed.document).then(ix => updateDiagnostics(ed.document, ix));

  // test hook: lets the release check read state without a UI scrape. Returns plain data only.
  return {
    _state: () => ({ active: activeDoc ? activeDoc.uri.toString() : null, results: results.items.map(r => ({ ...r })), resultsMessage: resultsView.message, treeMessage: treeView.message, status: status.text }),
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
