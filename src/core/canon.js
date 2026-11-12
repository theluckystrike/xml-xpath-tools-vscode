'use strict';
// Canonical text of an XML document for "Compare two XML files ignoring formatting" (Zovo Pro).
// Two files that differ only in indentation, line breaks between tags, attribute order, quote style, empty-tag style
// (<a/> or <a></a>), CDATA versus escaped text, or the XML declaration give the same text here. Everything else
// (element and attribute names, values, text, comments, processing instructions, order of elements) stays visible.
// Safety: the DOCTYPE internal subset is blanked before parsing (evaluate.js parseDom): no entity is expanded or read.
const { parseDom } = require('./evaluate');
const { buildIndex } = require('./index');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

/**
 * canonical(text, { indent = '  ', ignoreComments = false }) -> { ok: true, text } | { ok: false, error: { message, line } }
 */
function canonical(text, options = {}) {
  const indent = options.indent === undefined ? '  ' : options.indent;
  let dom;
  try {
    const ix = buildIndex(text);
    if (ix.error) return { ok: false, error: { message: ix.error.message, line: ix.error.line } };
    dom = parseDom(text, ix.doctype ? { subsetStart: ix.doctype.subsetStart, subsetEnd: ix.doctype.subsetEnd } : null).dom;
  } catch (e) {
    return { ok: false, error: { message: String((e && e.message) || e).split('\n')[0] } };
  }
  const out = [];
  const walk = (n, depth, preserve) => {
    const pad = indent.repeat(depth);
    switch (n.nodeType) {
      case 1: {
        const attrs = [];
        for (let i = 0; i < n.attributes.length; i++) attrs.push([n.attributes[i].name, n.attributes[i].value]);
        // namespace declarations first, then the other attributes, each group sorted by name
        attrs.sort((a, b) => {
          const na = a[0] === 'xmlns' || a[0].startsWith('xmlns:'), nb = b[0] === 'xmlns' || b[0].startsWith('xmlns:');
          if (na !== nb) return na ? -1 : 1;
          return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
        });
        const sp = n.getAttribute('xml:space');
        const pres = sp === 'preserve' ? true : sp === 'default' ? false : preserve;
        const open = `<${n.nodeName}${attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}`;
        const kids = [];
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if (options.ignoreComments && c.nodeType === 8) continue;
          kids.push(c);
        }
        const isText = (c) => c.nodeType === 3 || c.nodeType === 4;
        const hasRealText = kids.some((c) => isText(c) && /\S/.test(c.data));
        const hasMarkup = kids.some((c) => !isText(c));
        if (!kids.length || (!hasMarkup && !hasRealText && !pres)) { out.push(`${pad}${open}/>`); break; }
        if (!hasMarkup) { // text only: on one line, text kept exactly (escaped the same way for CDATA and text)
          out.push(`${pad}${open}>${esc(kids.map((c) => c.data).join(''))}</${n.nodeName}>`);
          break;
        }
        if (hasRealText || pres) { // mixed content: whitespace is meaningful, keep the content on one line as written
          out.push(`${pad}${open}>${kids.map((c) => inline(c)).join('')}</${n.nodeName}>`);
          break;
        }
        out.push(`${pad}${open}>`);
        for (const c of kids) if (!isText(c)) walk(c, depth + 1, pres);
        out.push(`${pad}</${n.nodeName}>`);
        break;
      }
      case 7: out.push(`${pad}<?${n.target}${n.data ? ' ' + n.data : ''}?>`); break;
      case 8: out.push(`${pad}<!--${n.data}-->`); break;
      case 3: case 4: if (/\S/.test(n.data)) out.push(pad + esc(n.data)); break;
      default: break;
    }
  };
  const inline = (c) => {
    if (c.nodeType === 3 || c.nodeType === 4) return esc(c.data);
    const keep = [];
    const save = out.length;
    walk(c, 0, true);
    keep.push(...out.splice(save));
    return keep.join('');
  };
  for (let c = dom.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 10) continue; // DOCTYPE: compared by the elements it describes, not by its text
    if (options.ignoreComments && c.nodeType === 8) continue;
    if (c.nodeType === 7 && c.target === 'xml') continue;
    walk(c, 0, false);
  }
  return { ok: true, text: out.join('\n') + '\n' };
}

module.exports = { canonical };
