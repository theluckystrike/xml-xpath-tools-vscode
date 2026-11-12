'use strict';
// XPath 1.0 evaluation with @xmldom/xmldom and xpath (both MIT, pure JavaScript).
// Safety: the DOCTYPE internal subset is blanked before parsing (same length, line breaks kept), so no entity is
// declared, expanded or fetched. xmldom never loads external resources. References to declared entities stay as
// the text "&name;".
const { DOMParser, Node } = require('@xmldom/xmldom');
const xpath = require('xpath');

// Speed: the xpath library dedupes node sets with a linear scan and orders nodes by walking the DOM, which is
// quadratic on wide files (1,000 siblings: 300 ms per query). Node sets get a Set for dedupe, and every node gets
// its document-order number once per parse (elementOrdinals), so ordering two nodes is one comparison.
(function speedUp() {
  const P = xpath.XNodeSet && xpath.XNodeSet.prototype;
  if (!P || P.__zovoFast) return;
  P.__zovoFast = true;
  P.add = function (n) {
    let seen = this.__seen;
    if (!seen || this.__seenLen !== this.nodes.length) { seen = new Set(this.nodes); this.__seen = seen; }
    if (seen.has(n)) return;
    seen.add(n);
    this.tree = null;
    this.nodes.push(n);
    this.size += 1;
    this.__seenLen = this.nodes.length;
  };
  const NP = Node && Node.prototype;
  const orig = NP && NP.compareDocumentPosition;
  if (orig) {
    NP.compareDocumentPosition = function (other) {
      const a = this.__o, b = other ? other.__o : undefined;
      if (a !== undefined && b !== undefined) return a === b ? 0 : a < b ? 0x04 : 0x02;
      return orig.call(this, other);
    };
  }
})();

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Replaces the internal subset of the DOCTYPE with spaces (line breaks kept, so positions do not move). */
function blankSubset(text, doctype) {
  if (!doctype || doctype.subsetStart < 0 || doctype.subsetEnd <= doctype.subsetStart) return text;
  const s = doctype.subsetStart, e = doctype.subsetEnd;
  return text.slice(0, s) + text.slice(s, e).replace(/[^\r\n]/g, ' ') + text.slice(e);
}

function parseDom(text, doctypeInfo) {
  const errors = [];
  const src = blankSubset(text, doctypeInfo);
  const parser = new DOMParser({
    locator: true,
    onError: (level, msg) => {
      if (level === 'fatalError') throw new Error(String(msg));
      if (errors.length < 20) errors.push(String(msg).split('\n')[0]);
    },
  });
  const dom = parser.parseFromString(src, 'text/xml');
  return { dom, errors };
}

/** Elements in document order, matching the order of the index built by index.js. */
function elementOrdinals(dom) {
  const ord = new Map();
  let n = 0, o = 0;
  dom.__o = o++;
  const stack = [];
  for (let c = dom.lastChild; c; c = c.previousSibling) stack.push(c);
  while (stack.length) {
    const node = stack.pop();
    node.__o = o++;
    if (node.nodeType !== 1) continue;
    ord.set(node, n++);
    const at = node.attributes;
    if (at) for (let i = 0; i < at.length; i++) at[i].__o = o++;
    for (let c = node.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return ord;
}

function preview(s, max = 160) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * state: { dom, ord, index } (reused between calls for the same text).
 * Returns { ok, type: 'nodes'|'number'|'string'|'boolean', items, total, value, ms, notes } or { ok: false, error }.
 */
function evaluate(state, expr, options = {}) {
  const t0 = Date.now();
  const ix = state.index;
  const notes = [];
  if (!state.dom) {
    try {
      const { dom, errors } = parseDom(state.text, ix && ix.doctype ? { subsetStart: ix.doctype.subsetStart, subsetEnd: ix.doctype.subsetEnd } : null);
      state.dom = dom; state.domErrors = errors;
    } catch (e) {
      return { ok: false, error: 'The file is not well formed, so XPath cannot run: ' + preview(e.message, 300) };
    }
    state.ord = elementOrdinals(state.dom);
  }
  if (ix && ix.doctype && ix.doctype.entities && ix.doctype.entities.count) {
    notes.push(`This file declares ${ix.doctype.entities.count} entit${ix.doctype.entities.count === 1 ? 'y' : 'ies'}. Entities are not expanded and nothing is read from disk or the network; references stay as text.`);
  }
  const namespaces = Object.assign({ xml: XML_NS }, ix ? ix.prefixes : {}, options.namespaces || {});
  if (ix && ix.conflicts && ix.conflicts.length) notes.push(`Prefix ${ix.conflicts.join(', ')} is bound to more than one namespace in this file; the first binding is used.`);
  let parsed;
  try { parsed = xpath.parse(String(expr)); }
  catch (e) { return { ok: false, error: 'XPath syntax error: ' + preview(e.message, 300) }; }
  let res;
  try {
    res = parsed.evaluate({ node: state.dom, namespaces, allowAnyNamespaceForNoPrefix: !options.strictNamespaces });
  } catch (e) {
    const m = /Cannot resolve QName (\S+)/.exec(e.message || '');
    if (m) {
      const known = Object.keys(namespaces).filter(p => p !== 'xml');
      return { ok: false, error: `Prefix "${m[1]}" is not declared in this file.` + (known.length ? ` Declared prefixes: ${known.join(', ')}.` : ' This file declares no prefixes; use names without a prefix.') };
    }
    if (e instanceof RangeError) return { ok: false, error: 'The XPath went too deep for this file: ' + preview(e.message, 200) };
    return { ok: false, error: 'XPath error: ' + preview(e.message, 300) };
  }
  const max = options.maxResults || 5000;
  const ms = () => Date.now() - t0;
  if (res instanceof xpath.XNodeSet || (res && typeof res.toArray === 'function' && typeof res.size === 'number')) {
    const nodes = res.toArray();
    const items = nodes.slice(0, max).map(n => describe(n, state));
    return { ok: true, type: 'nodes', items, total: nodes.length, ms: ms(), notes };
  }
  if (res instanceof xpath.XNumber) return { ok: true, type: 'number', value: String(res.numberValue()), ms: ms(), notes };
  if (res instanceof xpath.XBoolean) return { ok: true, type: 'boolean', value: String(res.booleanValue()), ms: ms(), notes };
  return { ok: true, type: 'string', value: res.stringValue(), ms: ms(), notes };
}

function describe(n, state) {
  const ord = state.ord;
  const ix = state.index;
  const loc = node => (node && node.lineNumber ? { line: node.lineNumber, col: node.columnNumber } : null);
  switch (n.nodeType) {
    case 1: {
      const i = ord.get(n);
      return { kind: 'element', name: n.nodeName, ord: i === undefined ? -1 : i, value: preview(n.textContent || ''), at: loc(n), childElements: ix && i !== undefined && i < ix.count ? ix.childCount[i] : 0 };
    }
    case 2: {
      const owner = n.ownerElement;
      const i = owner ? ord.get(owner) : undefined;
      return { kind: 'attribute', name: n.nodeName, ord: i === undefined ? -1 : i, value: preview(n.value, 300), at: loc(n) || loc(owner) };
    }
    case 3: case 4: {
      const p = n.parentNode;
      const i = p ? ord.get(p) : undefined;
      return { kind: n.nodeType === 4 ? 'cdata' : 'text', name: n.nodeType === 4 ? '#cdata' : '#text', ord: i === undefined ? -1 : i, value: preview(n.data, 300), at: loc(n) || loc(p) };
    }
    case 7: return { kind: 'pi', name: n.target, ord: n.parentNode ? (ord.get(n.parentNode) ?? -1) : -1, value: preview(n.data), at: loc(n) };
    case 8: return { kind: 'comment', name: '#comment', ord: n.parentNode ? (ord.get(n.parentNode) ?? -1) : -1, value: preview(n.data), at: loc(n) };
    case 9: return { kind: 'document', name: '/', ord: -1, value: '', at: { line: 1, col: 1 } };
    default: return { kind: 'node', name: n.nodeName, ord: -1, value: preview(n.nodeValue || ''), at: loc(n) };
  }
}

module.exports = { evaluate, parseDom, blankSubset, elementOrdinals };
