'use strict';
// The three Zovo Pro tools of XML Formatter & XPath Tools (gate in src/pro.js: 3 free tries each on this computer,
// a try counts only after a result):
// - xpathFolder: run one XPath on every XML file in a folder. Results open as CSV, JSON or a Markdown report
//   (file, line, kind, name, value), ready for a spreadsheet, a script or a review.
// - formatFolder: check every XML file in a folder with the same safe formatter as Format Document (whitespace
//   between tags only), then format them all or open a Markdown report of what would change (for review or CI).
// - compare: compare two XML files ignoring formatting and attribute order (src/core/canon.js): only real changes show
//   in VS Code's diff editor, or a note says the two files are the same XML.
// All work runs in a worker (dist/worker.js). No network. Files are read through vscode.workspace.fs.
const path = require('path');

const EXTENSIONS = ['.xml', '.xsd', '.xsl', '.xslt', '.svg', '.xaml', '.csproj', '.vbproj', '.fsproj', '.props', '.targets',
  '.nuspec', '.resx', '.kml', '.gpx', '.rss', '.atom', '.wsdl', '.dbk', '.xlf', '.xliff', '.plist', '.config', '.pom'];
const EXT_RE = /\.(xml|xsd|xsl|xslt|svg|xaml|csproj|vbproj|fsproj|props|targets|nuspec|resx|kml|gpx|rss|atom|wsdl|dbk|xlf|xliff|plist|config|pom)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.venv', 'venv', 'vendor']);
const MAX_FILES = 5000;
const SCHEME = 'zovo-xml-compare';

/** CSV field (RFC 4180): quoted when it holds a comma, quote or line break. Cells that start with = + - @ get a ' so a
 *  spreadsheet does not run them as formulas. */
function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const head = ['file', 'line', 'kind', 'name', 'value'];
  return [head.join(','), ...rows.map((r) => [r.file, r.line || '', r.kind, r.name, r.value].map(csvCell).join(','))].join('\r\n') + '\r\n';
}

function toJson(expr, files, rows) {
  return JSON.stringify({ xpath: expr, files: files.map((f) => ({ file: f.rel, status: f.status, matches: f.matches || 0, value: f.value, error: f.error })), results: rows }, null, 2) + '\n';
}

const mdCell = (s) => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function toMarkdown(expr, folderName, files, rows, max = 2000) {
  const ok = files.filter((f) => f.status === 'ok');
  const hit = ok.filter((f) => f.matches || f.value !== undefined);
  const lines = [`# XPath results in ${folderName}`, '', `\`${expr.replace(/`/g, "'")}\` on ${files.length} XML file${files.length === 1 ? '' : 's'}: ${rows.length} node${rows.length === 1 ? '' : 's'} in ${hit.length} file${hit.length === 1 ? '' : 's'}.`, ''];
  lines.push('| File | Result |', '| --- | --- |');
  for (const f of files) lines.push(`| ${mdCell(f.rel)} | ${f.status === 'ok' ? (f.value !== undefined ? mdCell(f.value) : `${f.matches} match${f.matches === 1 ? '' : 'es'}`) : mdCell(f.error || f.status)} |`);
  if (rows.length) {
    lines.push('', '## Nodes', '', '| File | Line | Kind | Name | Value |', '| --- | --- | --- | --- | --- |');
    for (const r of rows.slice(0, max)) lines.push(`| ${mdCell(r.file)} | ${r.line || ''} | ${r.kind} | ${mdCell(r.name)} | ${mdCell(r.value)} |`);
    if (rows.length > max) lines.push('', `The first ${max} of ${rows.length} nodes are listed. Export CSV or JSON for all of them.`);
  }
  return lines.join('\n') + '\n';
}

/** Lines of b that are not in the same place in a (a rough count for the report). */
function changedLines(a, b) {
  const la = a.split(/\r?\n/); const lb = b.split(/\r?\n/);
  let s = 0;
  while (s < la.length && s < lb.length && la[s] === lb[s]) s++;
  let ea = la.length; let eb = lb.length;
  while (ea > s && eb > s && la[ea - 1] === lb[eb - 1]) { ea--; eb--; }
  return Math.max(ea - s, eb - s);
}

/** Text of a file as VS Code would show it, or null for binary files (binary plist, NUL bytes). */
function decodeBytes(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 6 && b.subarray(0, 6).toString('latin1') === 'bplist') return null;
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.subarray(0, Math.min(b.length, 8000)).includes(0)) return null;
  return new TextDecoder('utf-8').decode(b.subarray(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? 3 : 0));
}

/**
 * deps: { vscode, pro, request(msg) -> Promise<worker reply>, formatOptions() -> options for core/format,
 *         maxChars() -> largest file in characters, xpathOptions() -> { strictNamespaces, maxResults } }
 */
function createProTools(deps) {
  const { vscode, pro, request, formatOptions, maxChars, xpathOptions } = deps;
  const contents = new Map(); // compare views: uri string -> text
  const provider = { provideTextDocumentContent: (uri) => contents.get(uri.toString()) || '' };

  async function listXml(folder) {
    const out = [];
    const queue = [folder];
    while (queue.length && out.length < MAX_FILES) {
      const dir = queue.shift();
      let entries;
      try { entries = await vscode.workspace.fs.readDirectory(dir); } catch { continue; }
      entries.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
      for (const [name, type] of entries) {
        const u = vscode.Uri.joinPath(dir, name);
        if (type & vscode.FileType.Directory) { if (!SKIP_DIRS.has(name) && !name.startsWith('.')) queue.push(u); }
        else if (EXT_RE.test(name)) out.push(u);
        if (out.length >= MAX_FILES) break;
      }
    }
    return out;
  }

  const rel = (folder, uri) => path.relative(folder.fsPath, uri.fsPath).split(path.sep).join('/') || path.basename(uri.fsPath);

  async function readText(uri) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return { text: open.getText(), doc: open };
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { text: decodeBytes(bytes) };
  }

  async function pickFolder(arg, title) {
    if (arg && arg.fsPath) return arg;
    const ws = vscode.workspace.workspaceFolders || [];
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title, openLabel: 'Use this folder', defaultUri: ws[0] ? ws[0].uri : undefined });
    return picked && picked[0];
  }

  // ---------------------------------------------------------------- XPath on a folder
  async function xpathFolder(arg, exprArg) {
    if (!(await pro.allowed('xpathFolder'))) return;
    const folder = await pickFolder(arg, 'Folder of XML files to search with XPath');
    if (!folder) return;
    let expr = typeof exprArg === 'string' ? exprArg : undefined;
    if (expr === undefined) {
      expr = await vscode.window.showInputBox({ title: `XPath on every XML file in ${path.basename(folder.fsPath)}`, value: deps.lastExpr ? deps.lastExpr() : '//*[@id]', prompt: 'XPath 1.0. Each file uses its own namespace prefixes; names without a prefix also match a default namespace.', ignoreFocusOut: true });
    }
    if (!expr || !expr.trim()) return;
    expr = expr.trim();
    const uris = await listXml(folder);
    if (!uris.length) { vscode.window.showInformationMessage(`No XML files in ${path.basename(folder.fsPath)}. No free try was used.`); return; }
    const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `XPath on ${uris.length} XML file${uris.length === 1 ? '' : 's'}`, cancellable: true }, async (progress, token) => {
      const files = []; const rows = [];
      for (let i = 0; i < uris.length; i++) {
        if (token.isCancellationRequested) return null;
        const r0 = rel(folder, uris[i]);
        progress.report({ message: `${i + 1} of ${uris.length}: ${r0}`, increment: 100 / uris.length });
        const f = { rel: r0 };
        try {
          const { text } = await readText(uris[i]);
          if (text === null) { f.status = 'skipped'; f.error = 'binary file'; files.push(f); continue; }
          if (text.length > maxChars()) { f.status = 'skipped'; f.error = 'larger than the xmlXpathTools.maxFileMB limit'; files.push(f); continue; }
          const r = await request({ op: 'xpathText', text, expr, options: xpathOptions() });
          if (!r.ok) {
            f.status = 'error'; f.error = r.error || 'failed';
            if (/^XPath (syntax )?error/.test(f.error)) return { syntax: f.error };
          } else if (r.type === 'nodes') {
            f.status = 'ok'; f.matches = r.total;
            for (const it of r.items) rows.push({ file: r0, line: it.at ? it.at.line : 0, kind: it.kind, name: it.name, value: it.value });
          } else { f.status = 'ok'; f.value = r.value; f.matches = 0; rows.push({ file: r0, line: 0, kind: r.type, name: '', value: r.value }); }
        } catch (e) { f.status = 'error'; f.error = String((e && e.message) || e); }
        files.push(f);
      }
      return { files, rows };
    });
    if (!res) return;
    if (res.syntax) { vscode.window.showWarningMessage(`${res.syntax}. No free try was used.`); return; }
    const { files, rows } = res;
    const okFiles = files.filter((f) => f.status === 'ok').length;
    if (!okFiles) { vscode.window.showWarningMessage(`None of the ${files.length} XML files could be read (${files[0].error}). No free try was used.`); return; }
    const hitFiles = files.filter((f) => f.status === 'ok' && (f.matches || f.value !== undefined)).length;
    const title = `${rows.length} result${rows.length === 1 ? '' : 's'} in ${hitFiles} of ${files.length} files for ${expr}`;
    const pick = await vscode.window.showQuickPick([
      { label: 'Open as CSV', description: 'file, line, kind, name, value: for a spreadsheet', fmt: 'csv' },
      { label: 'Open as JSON', description: 'every file and every node, for a script', fmt: 'json' },
      { label: 'Open a Markdown report', description: 'a table per file and per node, for a review', fmt: 'md' },
    ], { title, placeHolder: 'How do you want the results?' });
    if (!pick) return;
    const name = path.basename(folder.fsPath);
    const content = pick.fmt === 'csv' ? toCsv(rows) : pick.fmt === 'json' ? toJson(expr, files, rows) : toMarkdown(expr, name, files, rows);
    const doc = await vscode.workspace.openTextDocument({ language: pick.fmt === 'csv' ? 'plaintext' : pick.fmt === 'json' ? 'json' : 'markdown', content });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('xpathFolder');
    return { files, rows };
  }

  // ---------------------------------------------------------------- Format a folder
  async function formatFolder(arg) {
    if (!(await pro.allowed('formatFolder'))) return;
    const folder = await pickFolder(arg, 'Folder of XML files to format');
    if (!folder) return;
    const uris = await listXml(folder);
    if (!uris.length) { vscode.window.showInformationMessage(`No XML files in ${path.basename(folder.fsPath)}. No free try was used.`); return; }
    const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${uris.length} XML file${uris.length === 1 ? '' : 's'}`, cancellable: true }, async (progress, token) => {
      const out = [];
      for (let i = 0; i < uris.length; i++) {
        if (token.isCancellationRequested) return null;
        const row = { uri: uris[i], rel: rel(folder, uris[i]) };
        progress.report({ message: `${i + 1} of ${uris.length}: ${row.rel}`, increment: 100 / uris.length });
        try {
          const { text, doc } = await readText(uris[i]);
          if (text === null) { row.status = 'skipped'; row.why = 'binary file'; out.push(row); continue; }
          if (text.length > maxChars()) { row.status = 'skipped'; row.why = 'larger than the xmlXpathTools.maxFileMB limit'; out.push(row); continue; }
          const o = formatOptions(text);
          const r = await request({ op: 'format', text, options: o });
          if (!r.ok) { row.status = 'not formatted'; row.why = r.error && r.error.message ? `${r.error.message} (line ${r.error.line})` : String(r.error || 'failed'); out.push(row); continue; }
          row.before = text; row.after = r.text; row.doc = doc; row.version = doc ? doc.version : undefined;
          row.status = r.changed && r.text !== text ? 'changes' : 'formatted already';
          row.lines = row.status === 'changes' ? changedLines(text, r.text) : 0;
        } catch (e) { row.status = 'not formatted'; row.why = String((e && e.message) || e); }
        out.push(row);
      }
      return out;
    });
    if (!rows) return;
    const changes = rows.filter((r) => r.status === 'changes');
    const failed = rows.filter((r) => r.status === 'not formatted' || r.status === 'skipped');
    const summary = `${changes.length} of ${rows.length} XML file${rows.length === 1 ? '' : 's'} would change${failed.length ? `, ${failed.length} cannot be formatted` : ''}.`;
    const items = [];
    if (changes.length) items.push({ label: `Format ${changes.length} file${changes.length === 1 ? '' : 's'}`, description: 'whitespace between tags only; text, CDATA and comments stay as they are', act: 'apply' });
    items.push({ label: 'Show the report only', description: 'a Markdown list of every file, nothing is changed', act: 'report' });
    const pick = await vscode.window.showQuickPick(items, { title: summary, placeHolder: 'Pick what to do' });
    if (!pick) return;
    if (pick.act === 'apply') {
      let done = 0; const stale = [];
      for (const r of changes) {
        const doc = r.doc || await vscode.workspace.openTextDocument(r.uri);
        if ((r.doc && doc.version !== r.version) || doc.getText() !== r.before) { stale.push(r.rel); r.status = 'changed while checking, not formatted'; continue; }
        const we = new vscode.WorkspaceEdit();
        we.replace(r.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(r.before.length)), r.after);
        if (await vscode.workspace.applyEdit(we)) { await doc.save(); done++; r.status = 'formatted'; }
      }
      await showFormatReport(folder, rows);
      if (done) await pro.produced('formatFolder');
      vscode.window.setStatusBarMessage(`Formatted ${done} XML file${done === 1 ? '' : 's'}${stale.length ? `; ${stale.length} changed while checking and were left as they are` : ''}. Undo works in each file.`, 10000);
      return rows;
    }
    await showFormatReport(folder, rows);
    await pro.produced('formatFolder');
    return rows;
  }

  async function showFormatReport(folder, rows) {
    const lines = [`# XML formatting report for ${path.basename(folder.fsPath)}`, '', `${rows.length} file${rows.length === 1 ? '' : 's'} checked on ${new Date().toISOString().slice(0, 10)} with the same formatter as Format Document (whitespace between tags only).`, '', '| File | Result | Detail |', '| --- | --- | --- |'];
    for (const r of rows) lines.push(`| ${mdCell(r.rel)} | ${r.status} | ${mdCell(r.why || (r.lines ? `${r.lines} line${r.lines === 1 ? '' : 's'} change` : ''))} |`);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') + '\n' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  // ---------------------------------------------------------------- Compare ignoring formatting
  async function compare(arg, second) {
    if (!(await pro.allowed('compare'))) return;
    const ed = vscode.window.activeTextEditor;
    let left = arg && arg.fsPath ? arg : (ed && EXT_RE.test(ed.document.fileName) ? ed.document.uri : null);
    if (!left) {
      const p = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'First XML file', openLabel: 'Compare this file', filters: { XML: EXTENSIONS.map((e) => e.slice(1)), 'All files': ['*'] } });
      left = p && p[0];
    }
    if (!left) return;
    let right = second && second.fsPath ? second : null;
    if (!right) {
      const p2 = await vscode.window.showOpenDialog({ canSelectMany: false, title: `Compare ${path.basename(left.fsPath)} with`, openLabel: 'Compare', defaultUri: vscode.Uri.joinPath(left, '..'), filters: { XML: EXTENSIONS.map((e) => e.slice(1)), 'All files': ['*'] } });
      right = p2 && p2[0];
    }
    if (!right) return;
    const [ta, tb] = await Promise.all([readText(left), readText(right)]);
    for (const [t, u] of [[ta, left], [tb, right]]) {
      if (t.text === null) { vscode.window.showWarningMessage(`${path.basename(u.fsPath)} is not a text XML file. No free try was used.`); return; }
      if (t.text.length > maxChars()) { vscode.window.showWarningMessage(`${path.basename(u.fsPath)} is larger than the xmlXpathTools.maxFileMB limit. No free try was used.`); return; }
    }
    const o = { indent: '  ' };
    const [a, b] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading both XML files' }, () => Promise.all([request({ op: 'canon', text: ta.text, options: o }), request({ op: 'canon', text: tb.text, options: o })]));
    for (const [r, u] of [[a, left], [b, right]]) {
      if (!r.ok) { vscode.window.showWarningMessage(`${path.basename(u.fsPath)} is not well formed: ${r.error && r.error.message ? r.error.message : r.error}${r.error && r.error.line ? ` (line ${r.error.line})` : ''}. No free try was used.`); return; }
    }
    await pro.produced('compare');
    if (a.text === b.text) {
      vscode.window.showInformationMessage(`${path.basename(left.fsPath)} and ${path.basename(right.fsPath)} are the same XML: they differ only in formatting, attribute order, quotes or empty-tag style.`);
      return { same: true };
    }
    const stamp = Date.now();
    const ua = vscode.Uri.parse(`${SCHEME}:/${stamp}/a/${encodeURIComponent(path.basename(left.fsPath))}`);
    const ub = vscode.Uri.parse(`${SCHEME}:/${stamp}/b/${encodeURIComponent(path.basename(right.fsPath))}`);
    contents.set(ua.toString(), a.text);
    contents.set(ub.toString(), b.text);
    await vscode.commands.executeCommand('vscode.diff', ua, ub, `${path.basename(left.fsPath)} ↔ ${path.basename(right.fsPath)} (formatting and attribute order ignored)`);
    return { same: false };
  }

  function register(context) {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));
  }

  return { xpathFolder, formatFolder, compare, register, listXml, _contents: contents };
}

module.exports = { createProTools, toCsv, toJson, toMarkdown, csvCell, changedLines, decodeBytes, EXTENSIONS, EXT_RE, SCHEME };
