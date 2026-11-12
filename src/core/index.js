'use strict';
// Compact element index for the tree, the outline and "Copy XPath": one row per element, in document order,
// in typed arrays so it crosses from the worker thread cheaply. A file that is not well formed gets the index of
// the part before the error and the error itself.
const { scan, XmlError, lineCol, firstNonWs } = require('./scan');

// Attributes used for "[@id='...']" steps and tree labels, best first.
const KEY_ATTRS = ['id', 'xml:id', 'name', 'key', 'android:id', 'android:name', 'x:Name', 'x:Key', 'Name', 'Id', 'ID', 'Include', 'ref', 'code', 'title', 'type'];
const KEY_RANK = new Map(KEY_ATTRS.map((a, i) => [a, i]));

function grow(a, n) { const b = new a.constructor(n); b.set(a); return b; }

function buildIndex(text, onProgress) {
  let cap = 1024, count = 0;
  let start = new Int32Array(cap), openEnd = new Int32Array(cap), end = new Int32Array(cap);
  let parent = new Int32Array(cap), firstChild = new Int32Array(cap), nextSibling = new Int32Array(cap);
  let childCount = new Int32Array(cap), nameId = new Int32Array(cap), nsId = new Int32Array(cap), attrCount = new Int32Array(cap);
  const names = [], nameMap = new Map();
  const uris = [''], uriMap = new Map([['', 0]]);
  const keyName = [], keyValue = [], preview = [];
  const lastChild = [];
  const prefixes = {};       // first binding of each prefix in the file (used to resolve prefixes in XPath)
  const conflicts = new Set(); // prefixes bound to two different URIs
  const unbound = [];        // [offset, prefix] for elements or attributes whose prefix is not declared
  let defaultNs = null;
  const stack = [];
  const scopes = [{ xml: 'http://www.w3.org/XML/1998/namespace', '': '' }];
  const roots = [];
  let doctype = null;

  const id = (map, list, v) => { let k = map.get(v); if (k === undefined) { k = list.length; list.push(v); map.set(v, k); } return k; };
  const ensure = () => {
    if (count < cap) return;
    cap *= 2;
    start = grow(start, cap); openEnd = grow(openEnd, cap); end = grow(end, cap); parent = grow(parent, cap);
    firstChild = grow(firstChild, cap); nextSibling = grow(nextSibling, cap); childCount = grow(childCount, cap);
    nameId = grow(nameId, cap); nsId = grow(nsId, cap); attrCount = grow(attrCount, cap);
  };

  let error = null;
  try {
    scan(text, {
      start(name, s, e, attrs, empty) {
        ensure();
        const i = count++;
        const p = stack.length ? stack[stack.length - 1] : -1;
        start[i] = s; openEnd[i] = e; end[i] = empty ? e : -1; parent[i] = p;
        firstChild[i] = -1; nextSibling[i] = -1; childCount[i] = 0; attrCount[i] = attrs.length / 4;
        nameId[i] = id(nameMap, names, name);
        keyName.push(''); keyValue.push(''); preview.push('');
        lastChild.push(-1);
        if (p >= 0) {
          if (lastChild[p] < 0) firstChild[p] = i; else nextSibling[lastChild[p]] = i;
          lastChild[p] = i; childCount[p]++;
        } else roots.push(i);
        // namespace scope
        let scope = scopes[scopes.length - 1];
        let best = 99;
        for (let k = 0; k < attrs.length; k += 4) {
          const an = text.slice(attrs[k], attrs[k + 1]);
          const av = text.slice(attrs[k + 2] + 1, attrs[k + 3] - 1);
          if (an === 'xmlns' || an.startsWith('xmlns:')) {
            if (scope === scopes[scopes.length - 1]) scope = Object.create(scope);
            const pre = an === 'xmlns' ? '' : an.slice(6);
            scope[pre] = av;
            if (pre) {
              if (!(pre in prefixes)) prefixes[pre] = av;
              else if (prefixes[pre] !== av) conflicts.add(pre);
            } else if (defaultNs === null && av) defaultNs = av;
            continue;
          }
          const r = KEY_RANK.get(an);
          if (r !== undefined && r < best && av.length <= 200) { best = r; keyName[i] = an; keyValue[i] = av; }
        }
        const c = name.indexOf(':');
        const pre = c > 0 ? name.slice(0, c) : '';
        const uri = scope[pre];
        if (uri === undefined) { unbound.push([s, pre]); nsId[i] = 0; }
        else nsId[i] = id(uriMap, uris, uri);
        for (let k = 0; k < attrs.length; k += 4) {
          const an = text.slice(attrs[k], attrs[k + 1]);
          const ac = an.indexOf(':');
          if (ac > 0 && !an.startsWith('xmlns:')) {
            const ap = an.slice(0, ac);
            if (scope[ap] === undefined) unbound.push([attrs[k], ap]);
          }
        }
        if (!empty) { stack.push(i); scopes.push(scope); }
      },
      end(name, s, e) {
        const i = stack.pop();
        scopes.pop();
        end[i] = e;
      },
      text(s, e) {
        if (!stack.length) return;
        const i = stack[stack.length - 1];
        if (preview[i]) return;
        const k = firstNonWs(text, s, Math.min(e, s + 4096));
        if (k >= 0) preview[i] = text.slice(k, Math.min(e, k + 80)).replace(/\s+/g, ' ').trim();
      },
      cdata(s, e) {
        if (!stack.length) return;
        const i = stack[stack.length - 1];
        if (!preview[i]) preview[i] = text.slice(s + 9, Math.min(e - 3, s + 89)).replace(/\s+/g, ' ').trim();
      },
      doctype(s, e, info) { doctype = { start: s, end: e, subsetStart: info.subsetStart, subsetEnd: info.subsetEnd, external: info.external, entities: summarize(info.entities) }; },
      progress: onProgress ? off => onProgress(off / text.length) : undefined,
    });
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
    error = { message: e.message, offset: e.offset, ...lineCol(text, e.offset) };
    for (const i of stack) end[i] = text.length; // unclosed elements reach to the end of the file
  }
  const cut = a => a.slice(0, count);
  return {
    count, start: cut(start), openEnd: cut(openEnd), end: cut(end), parent: cut(parent), firstChild: cut(firstChild),
    nextSibling: cut(nextSibling), childCount: cut(childCount), nameId: cut(nameId), nsId: cut(nsId), attrCount: cut(attrCount),
    names, uris, keyName, keyValue, preview, roots, prefixes, conflicts: [...conflicts], unbound: unbound.slice(0, 50), defaultNs,
    doctype, error, length: text.length,
  };
}

function summarize(ent) {
  return { count: ent.count, external: ent.external.slice(0, 20), parameter: ent.parameter, maxExpansion: ent.maxExpansion, biggest: ent.biggest };
}

/** Deepest element whose range holds `offset` (-1 when none). */
function elementAt(ix, offset) {
  let lo = 0, hi = ix.count - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ix.start[mid] <= offset) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  let i = best;
  while (i >= 0 && offset >= ix.end[i]) i = ix.parent[i];
  return i;
}

function children(ix, i) {
  const out = [];
  for (let c = i < 0 ? -1 : ix.firstChild[i]; c >= 0; c = ix.nextSibling[c]) out.push(c);
  return i < 0 ? ix.roots.slice() : out;
}

function localName(ix, i) { const n = ix.names[ix.nameId[i]]; const c = n.indexOf(':'); return c > 0 ? n.slice(c + 1) : n; }
function prefixOf(ix, i) { const n = ix.names[ix.nameId[i]]; const c = n.indexOf(':'); return c > 0 ? n.slice(0, c) : ''; }

module.exports = { buildIndex, elementAt, children, localName, prefixOf, KEY_ATTRS };
