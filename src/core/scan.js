'use strict';
// Single-pass XML scanner. It reports tokens by offset and stops at the first well-formedness error.
// It never expands an entity, never reads a DTD and never opens a file or a URL: DOCTYPE text is only measured.

const NAME_START = 'A-Za-z_:\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\uD800-\\uDBFF';
const NAME_CHAR = NAME_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040\\uDC00-\\uDFFF';
const NAME_RE = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'y');
const REF_RE = new RegExp(`&(?:#[0-9]+|#x[0-9a-fA-F]+|([${NAME_START}][${NAME_CHAR}]*));`, 'y');
const PREDEFINED = new Set(['lt', 'gt', 'amp', 'apos', 'quot']);

class XmlError extends Error {
  constructor(message, offset) { super(message); this.offset = offset; }
}

/** 1-based line and column of an offset (only used for messages). */
function lineCol(text, offset) {
  let line = 1, last = -1, i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1 && i < offset) { line++; last = i; }
  return { line, col: offset - last };
}

function isWs(c) { return c === 32 || c === 10 || c === 9 || c === 13; }
function firstNonWs(text, s, e) { for (let i = s; i < e; i++) if (!isWs(text.charCodeAt(i))) return i; return -1; }
function skipWs(text, p, n) { while (p < n && isWs(text.charCodeAt(p))) p++; return p; }
/** indexOf limited to [s, e): a plain indexOf would run to the end of a big file on every miss. */
function findIn(text, sub, s, e) { if (e - s < sub.length) return -1; const k = text.slice(s, e).indexOf(sub); return k < 0 ? -1 : s + k; }

/**
 * Reads the DOCTYPE starting at `lt` ("<!DOCTYPE"). Returns { end, subsetStart, subsetEnd, external }.
 * Quotes, comments and processing instructions inside the internal subset are skipped, so a '>' in them is safe.
 */
function readDoctype(text, lt) {
  const n = text.length;
  let p = lt + 9, depth = 0, subsetStart = -1, subsetEnd = -1;
  while (p < n) {
    const c = text[p];
    if (c === '"' || c === "'") {
      const q = text.indexOf(c, p + 1);
      if (q < 0) throw new XmlError('Unclosed quote in DOCTYPE', p);
      p = q + 1; continue;
    }
    if (depth > 0 && c === '<' && text.startsWith('<!--', p)) {
      const q = text.indexOf('-->', p + 4);
      if (q < 0) throw new XmlError('Unclosed comment in DOCTYPE', p);
      p = q + 3; continue;
    }
    if (depth > 0 && c === '<' && text[p + 1] === '?') {
      const q = text.indexOf('?>', p + 2);
      if (q < 0) throw new XmlError('Unclosed processing instruction in DOCTYPE', p);
      p = q + 2; continue;
    }
    if (c === '[') { if (depth === 0) subsetStart = p + 1; depth++; }
    else if (c === ']') { depth--; if (depth === 0) subsetEnd = p; if (depth < 0) throw new XmlError('Unexpected "]" in DOCTYPE', p); }
    else if (c === '>' && depth === 0) {
      const head = text.slice(lt, subsetStart > 0 ? subsetStart : p);
      return { end: p + 1, subsetStart, subsetEnd, external: /\b(SYSTEM|PUBLIC)\b/.test(head) };
    }
    p++;
  }
  throw new XmlError('Unclosed DOCTYPE', lt);
}

/** Entity declarations in an internal subset: names, external ones, and the size each would expand to. */
function inspectEntities(text, s, e) {
  const out = { count: 0, external: [], names: new Set(), parameter: 0, maxExpansion: 0, biggest: '' };
  if (s < 0 || e <= s) return out;
  const sub = text.slice(s, e);
  const re = /<!ENTITY\s+(%\s+)?([^\s"'>]+)\s+(?:(SYSTEM|PUBLIC)\s+(?:"[^"]*"|'[^']*')(?:\s+(?:"[^"]*"|'[^']*'))?|"([^"]*)"|'([^']*)')/g;
  const values = new Map();
  let m;
  while ((m = re.exec(sub))) {
    out.count++;
    if (m[1]) { out.parameter++; continue; }
    const name = m[2];
    out.names.add(name);
    if (m[3]) { out.external.push(name); continue; }
    values.set(name, m[4] !== undefined ? m[4] : m[5]);
  }
  // Size each entity would expand to, with a cap. Only arithmetic: no string is ever built.
  const CAP = 1e15;
  const size = new Map();
  const visiting = new Set();
  const measure = name => {
    if (size.has(name)) return size.get(name);
    if (visiting.has(name)) return CAP; // a cycle never ends
    visiting.add(name);
    const v = values.get(name) || '';
    let total = 0, last = 0;
    const r = /&([^\s;&#]+);/g;
    let k;
    while ((k = r.exec(v))) {
      total += k.index - last;
      last = r.lastIndex;
      total += values.has(k[1]) ? measure(k[1]) : k[0].length;
      if (total > CAP) { total = CAP; break; }
    }
    total = Math.min(CAP, total + v.length - last);
    visiting.delete(name);
    size.set(name, total);
    return total;
  };
  for (const name of values.keys()) {
    const sz = measure(name);
    if (sz > out.maxExpansion) { out.maxExpansion = sz; out.biggest = name; }
  }
  return out;
}

/**
 * Scans `text` and calls the handler:
 *   text(s, e)                         character data (may be whitespace only)
 *   start(name, s, e, attrs, empty)    start tag or empty-element tag; attrs = flat [nameS, nameE, valueS, valueE, ...]
 *                                      where valueS is the opening quote and valueE is after the closing quote
 *   end(name, s, e)                    end tag
 *   comment(s, e), cdata(s, e), pi(s, e), doctype(s, e, info)
 *   progress(offset)                   about every 1 MB
 * options.fragment: allow several top-level elements and top-level text (format selection).
 * Throws XmlError({ offset }) at the first error.
 */
function scan(text, h, options = {}) {
  const fragment = !!options.fragment;
  const n = text.length;
  const stack = [];
  const stackAt = [];
  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let rootDone = false, rootSeen = false;
  let entityNames = null, anyEntity = fragment; // a selection may use entities declared above it
  let nextProgress = 1 << 20;

  const checkRefs = (s, e) => {
    let a = findIn(text, '&', s, e);
    while (a !== -1) {
      REF_RE.lastIndex = a;
      const m = REF_RE.exec(text);
      if (!m || REF_RE.lastIndex > e) throw new XmlError('"&" must start an entity or character reference; write &amp; for a plain "&"', a);
      const name = m[1];
      if (name && !PREDEFINED.has(name) && !anyEntity && !(entityNames && entityNames.has(name))) {
        throw new XmlError(`Entity &${name}; is not declared`, a);
      }
      a = findIn(text, '&', REF_RE.lastIndex, e);
    }
  };

  while (pos < n) {
    if (pos >= nextProgress) { if (h.progress) h.progress(pos); nextProgress = pos + (1 << 20); }
    const lt = text.indexOf('<', pos);
    const tEnd = lt < 0 ? n : lt;
    if (tEnd > pos) {
      if (stack.length === 0 && !fragment) {
        const k = firstNonWs(text, pos, tEnd);
        if (k >= 0) throw new XmlError(rootDone ? 'Text after the root element' : 'Text before the root element', k);
      }
      checkRefs(pos, tEnd);
      const gt = findIn(text, ']]>', pos, tEnd);
      if (gt !== -1) throw new XmlError('"]]>" is not allowed in text; write ]]&gt;', gt);
      if (h.text) h.text(pos, tEnd);
    }
    if (lt < 0) break;
    const c = text.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      if (text.startsWith('<!--', lt)) {
        const q = text.indexOf('-->', lt + 4);
        if (q < 0) throw new XmlError('Comment is not closed with -->', lt);
        if (h.comment) h.comment(lt, q + 3);
        pos = q + 3; continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        if (stack.length === 0 && !fragment) throw new XmlError('CDATA section outside the root element', lt);
        const q = text.indexOf(']]>', lt + 9);
        if (q < 0) throw new XmlError('CDATA section is not closed with ]]>', lt);
        if (h.cdata) h.cdata(lt, q + 3);
        pos = q + 3; continue;
      }
      if (text.startsWith('<!DOCTYPE', lt)) {
        if (rootSeen) throw new XmlError('DOCTYPE after the root element', lt);
        const info = readDoctype(text, lt);
        info.entities = inspectEntities(text, info.subsetStart, info.subsetEnd);
        entityNames = info.entities.names;
        // An external DTD may declare entities we never read: accept any named reference then.
        anyEntity = info.external || info.entities.parameter > 0;
        if (h.doctype) h.doctype(lt, info.end, info);
        pos = info.end; continue;
      }
      throw new XmlError('Unexpected "<!"', lt);
    }
    if (c === 63 /* ? */) {
      const q = text.indexOf('?>', lt + 2);
      if (q < 0) throw new XmlError('Processing instruction is not closed with ?>', lt);
      if (h.pi) h.pi(lt, q + 2);
      pos = q + 2; continue;
    }
    if (c === 47 /* / */) {
      NAME_RE.lastIndex = lt + 2;
      const m = NAME_RE.exec(text);
      if (!m) throw new XmlError('Invalid end tag', lt);
      const name = m[0];
      const p = skipWs(text, NAME_RE.lastIndex, n);
      if (text.charCodeAt(p) !== 62) throw new XmlError(`End tag </${name}> is not closed with ">"`, lt);
      if (!stack.length) throw new XmlError(`End tag </${name}> has no start tag`, lt);
      const top = stack[stack.length - 1];
      if (top !== name) {
        const lc = lineCol(text, stackAt[stackAt.length - 1]);
        throw new XmlError(`Expected </${top}> to close <${top}> from line ${lc.line}, found </${name}>`, lt);
      }
      stack.pop(); stackAt.pop();
      if (h.end) h.end(name, lt, p + 1);
      if (!stack.length) rootDone = true;
      pos = p + 1; continue;
    }
    // start tag
    NAME_RE.lastIndex = lt + 1;
    const m = NAME_RE.exec(text);
    if (!m) throw new XmlError('"<" must start a tag; write &lt; for a plain "<"', lt);
    const name = m[0];
    if (stack.length === 0 && rootDone && !fragment) throw new XmlError(`Second root element <${name}>; a document has one root`, lt);
    let p = NAME_RE.lastIndex;
    const attrs = [];
    let end = -1, empty = false;
    for (;;) {
      const w = skipWs(text, p, n);
      if (w >= n) throw new XmlError(`Tag <${name}> is not closed with ">"`, lt);
      const ch = text.charCodeAt(w);
      if (ch === 62) { end = w + 1; break; }
      if (ch === 47) {
        if (text.charCodeAt(w + 1) !== 62) throw new XmlError(`Expected "/>" in <${name}>`, w);
        end = w + 2; empty = true; break;
      }
      if (ch === 60) throw new XmlError(`Tag <${name}> is not closed with ">"`, lt);
      if (w === p) throw new XmlError(`Expected a space before the attribute in <${name}>`, w);
      NAME_RE.lastIndex = w;
      const a = NAME_RE.exec(text);
      if (!a) throw new XmlError(`Invalid attribute in <${name}>`, w);
      const ne = NAME_RE.lastIndex;
      let q = skipWs(text, ne, n);
      if (text.charCodeAt(q) !== 61) throw new XmlError(`Attribute ${a[0]} in <${name}> needs ="value"`, w);
      q = skipWs(text, q + 1, n);
      const quote = text[q];
      if (quote !== '"' && quote !== "'") throw new XmlError(`Value of ${a[0]} in <${name}> must be in quotes`, q);
      const qe = text.indexOf(quote, q + 1);
      if (qe < 0) throw new XmlError(`Value of ${a[0]} in <${name}> is not closed`, q);
      const bad = findIn(text, '<', q + 1, qe);
      if (bad !== -1) throw new XmlError(`"<" is not allowed in the value of ${a[0]}; write &lt;`, bad);
      checkRefs(q + 1, qe);
      for (let k = 0; k < attrs.length; k += 4) {
        if (attrs[k + 1] - attrs[k] === ne - w && text.startsWith(a[0], attrs[k])) throw new XmlError(`Attribute ${a[0]} appears twice in <${name}>`, w);
      }
      attrs.push(w, ne, q, qe + 1);
      p = qe + 1;
    }
    rootSeen = true;
    if (h.start) h.start(name, lt, end, attrs, empty);
    if (!empty) { stack.push(name); stackAt.push(lt); }
    else if (!stack.length) rootDone = true;
    pos = end;
  }
  if (stack.length) {
    throw new XmlError(`<${stack[stack.length - 1]}> is not closed`, stackAt[stackAt.length - 1]);
  }
  if (!rootSeen && !fragment) throw new XmlError('No root element', Math.min(pos, n));
  return true;
}

module.exports = { scan, XmlError, lineCol, firstNonWs, isWs, inspectEntities, readDoctype, NAME_RE };
