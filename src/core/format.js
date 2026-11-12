'use strict';
// XML formatter and minifier on top of scan.js.
//
// Safety rules (each one is a test in test/format.test.js):
// - Text is never changed. An element whose content holds text or CDATA (mixed content), an element with
//   xml:space="preserve", and an element that holds only text or only spaces on one line, are written exactly as
//   they are, children included.
// - Only whitespace between tags in elements that hold tags and no text is replaced by new lines and indentation.
// - Comments, CDATA, processing instructions and the DOCTYPE are copied byte for byte. Entities are not expanded.
// - Attribute values are copied byte for byte, quotes included. Only the spaces between attributes change.
// - The output formats to itself (a second run changes nothing).
// - A file that is not well formed is not changed: the result is { ok: false, error }.
const { scan, XmlError, lineCol, firstNonWs } = require('./scan');

const K_TEXT = 1, K_START = 2, K_END = 3, K_EMPTY = 4, K_COMMENT = 5, K_CDATA = 6, K_PI = 7, K_DOCTYPE = 8;
const F_MIXED = 1, F_MARKUP = 2, F_PRESERVE = 4;

function tokenize(text, options, onProgress) {
  const kind = [], start = [], end = [], match = [], flags = [], attrsOf = new Map();
  const stack = [];
  const markParent = f => { if (stack.length) flags[stack[stack.length - 1]] |= f; };
  const push = (k, s, e) => { kind.push(k); start.push(s); end.push(e); match.push(-1); flags.push(0); return kind.length - 1; };
  scan(text, {
    text(s, e) {
      push(K_TEXT, s, e);
      if (stack.length && firstNonWs(text, s, e) >= 0) markParent(F_MIXED);
    },
    start(name, s, e, attrs, empty) {
      markParent(F_MARKUP);
      const i = push(empty ? K_EMPTY : K_START, s, e);
      if (attrs.length) attrsOf.set(i, attrs);
      if (!empty) {
        for (let k = 0; k < attrs.length; k += 4) {
          if (attrs[k + 1] - attrs[k] === 9 && text.startsWith('xml:space', attrs[k])) {
            if (text.slice(attrs[k + 2] + 1, attrs[k + 3] - 1).trim() === 'preserve') flags[i] |= F_PRESERVE;
          }
        }
        stack.push(i);
      }
    },
    end(name, s, e) {
      const i = push(K_END, s, e);
      const o = stack.pop();
      match[o] = i; match[i] = o;
    },
    comment(s, e) { markParent(F_MARKUP); push(K_COMMENT, s, e); },
    cdata(s, e) { markParent(F_MIXED); push(K_CDATA, s, e); },
    pi(s, e) { markParent(F_MARKUP); push(K_PI, s, e); },
    doctype(s, e) { push(K_DOCTYPE, s, e); },
    progress: onProgress ? off => onProgress(off / text.length) : undefined,
  }, { fragment: !!options.fragment });
  return { kind, start, end, match, flags, attrsOf };
}

function countNl(text, s, e) {
  let c = 0;
  for (let i = s; i < e; i++) if (text.charCodeAt(i) === 10) c++;
  return c;
}
function hasNl(text, s, e) {
  for (let i = s; i < e; i++) { const c = text.charCodeAt(i); if (c === 10 || c === 13) return true; }
  return false;
}

/** Element with no tags inside: write it as is, unless it holds only whitespace with a line break. */
function keepAsIs(T, text, i) {
  const f = T.flags[i];
  if (f & (F_MIXED | F_PRESERVE)) return true;
  if (f & F_MARKUP) return false;
  const j = T.match[i];
  return !hasNl(text, T.end[i], T.start[j]);
}

function tagName(text, s) {
  let p = s + 1;
  while (p < text.length) { const c = text.charCodeAt(p); if (c === 32 || c === 10 || c === 9 || c === 13 || c === 62 || c === 47) break; p++; }
  return text.slice(s + 1, p);
}

/**
 * Formats XML text. options:
 *   indent: '  ' | '\t' ...      one level
 *   eol: '\n' | '\r\n'
 *   attributes: 'keep' | 'oneLine' | 'onePerLine'   keep = one line, or one attribute per line when the tag
 *                                                   already spans lines
 *   keepBlankLines: true         keep one empty line where the source had one or more
 *   fragment: false              format a selection (several elements, base indentation)
 *   baseIndent: ''               put before every line (fragment)
 *   minify: false                no new lines and no indentation
 *   removeComments: false        minify only: drop comments between tags
 * Returns { ok: true, text, changed } or { ok: false, error: { message, offset, line, col } }.
 */
function format(text, options = {}, onProgress) {
  const o = {
    indent: options.indent === undefined ? '  ' : options.indent,
    eol: options.eol || '\n',
    attributes: options.attributes || 'keep',
    keepBlankLines: options.keepBlankLines !== false,
    fragment: !!options.fragment,
    baseIndent: options.baseIndent || '',
    minify: !!options.minify,
    removeComments: !!options.removeComments,
  };
  if (o.minify) { o.indent = ''; o.eol = ''; o.keepBlankLines = false; o.baseIndent = ''; o.attributes = 'oneLine'; }
  let T;
  try {
    T = tokenize(text, o, onProgress ? f => onProgress(f * 0.6) : null);
  } catch (e) {
    if (e instanceof XmlError) return { ok: false, error: { message: e.message, offset: e.offset, ...lineCol(text, e.offset) } };
    throw e;
  }
  const { kind, start, end, match } = T;
  const out = [];
  const bom = text.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  const indents = [o.baseIndent];
  const ind = d => { while (indents.length <= d) indents.push(indents[indents.length - 1] + o.indent); return indents[d]; };
  let wrote = false; // something is on the current output line
  let blank = false; // write an empty line before the next item
  const newLine = depth => {
    if (wrote) out.push(o.eol);
    if (blank && wrote && !o.minify) out.push(o.eol);
    blank = false;
    out.push(ind(depth));
    wrote = true;
  };

  const tag = (i, depth) => {
    const s = start[i], e = end[i];
    const attrs = T.attrsOf.get(i);
    const name = tagName(text, s);
    const empty = kind[i] === K_EMPTY;
    let close = '>';
    if (empty) {
      // keep "<a />" or "<a/>" as the author wrote it
      close = (attrs ? hasSpaceBefore(text, e - 2, attrs[attrs.length - 1]) : hasSpaceBefore(text, e - 2, s + 1 + name.length)) ? ' />' : '/>';
    }
    if (!attrs) return '<' + name + close;
    const parts = [];
    for (let k = 0; k < attrs.length; k += 4) parts.push(text.slice(attrs[k], attrs[k + 1]) + '=' + text.slice(attrs[k + 2], attrs[k + 3]));
    let multi = false, firstOwnLine = false;
    if (o.attributes === 'onePerLine') { multi = parts.length > 1; firstOwnLine = false; }
    else if (o.attributes === 'keep') {
      // a line break between attributes (not inside a value) means "one attribute per line"
      firstOwnLine = hasNl(text, s + 1 + name.length, attrs[0]);
      multi = firstOwnLine;
      for (let k = 4; k < attrs.length && !multi; k += 4) multi = hasNl(text, attrs[k - 1], attrs[k]);
    }
    if (!multi) return '<' + name + ' ' + parts.join(' ') + close;
    const pad = o.eol + ind(depth + 1);
    return '<' + name + (firstOwnLine ? pad : ' ') + parts.join(pad) + close;
  };

  const n = kind.length;
  let depth = 0;
  for (let i = 0; i < n; i++) {
    if (onProgress && (i & 0x3ffff) === 0) onProgress(0.6 + 0.35 * (i / n));
    const k = kind[i];
    if (k === K_TEXT) {
      // Only whitespace reaches here (text makes its parent "keep as is"), or fragment text.
      const s = start[i], e = end[i];
      if (firstNonWs(text, s, e) >= 0) {
        // fragment with text at the top: copy it
        out.push(text.slice(s, e)); wrote = true; continue;
      }
      if (o.keepBlankLines && wrote && i > 0 && kind[i - 1] !== K_START && countNl(text, s, e) >= 2) {
        const next = i + 1 < n ? kind[i + 1] : 0;
        if (next && next !== K_END) blank = true;
      }
      continue;
    }
    if (k === K_COMMENT) {
      if (o.removeComments && o.minify) continue;
      const prev = i > 0 ? kind[i - 1] : 0;
      const sameLine = !o.minify && wrote && prev === K_TEXT && i > 1 && kind[i - 2] !== K_START
        && !hasNl(text, start[i - 1], end[i - 1]) && end[i - 1] > start[i - 1];
      if (sameLine) { out.push(' ' + text.slice(start[i], end[i])); continue; }
      newLine(depth); out.push(text.slice(start[i], end[i])); continue;
    }
    if (k === K_PI || k === K_DOCTYPE || k === K_CDATA) {
      newLine(depth); out.push(text.slice(start[i], end[i])); continue;
    }
    if (k === K_EMPTY) { newLine(depth); out.push(tag(i, depth)); continue; }
    if (k === K_START) {
      newLine(depth);
      out.push(tag(i, depth));
      const j = match[i];
      if (keepAsIs(T, text, i)) {
        out.push(text.slice(end[i], start[j]));
        out.push('</' + tagName(text, start[j] + 1).replace(/^\//, '') + '>');
        i = j;
        continue;
      }
      if (j === i + 1 || ((T.flags[i] & F_MARKUP) === 0)) {
        // only whitespace with a line break inside: <a></a>
        out.push('</' + tagName(text, start[j] + 1) + '>');
        i = j;
        continue;
      }
      depth++;
      continue;
    }
    if (k === K_END) {
      depth--;
      blank = false;
      newLine(depth);
      out.push('</' + tagName(text, start[i] + 1) + '>');
    }
  }
  if (!o.fragment && !o.minify && /\r?\n[ \t]*$/.test(text.slice(-64))) out.push(o.eol);
  if (o.fragment && /\r?\n$/.test(text.slice(-2))) out.push(o.eol);
  if (onProgress) onProgress(0.97);
  const result = bom + out.join('');
  return { ok: true, text: result, changed: result !== text };
}

function hasSpaceBefore(text, slashAt, from) {
  return slashAt > from && /\s/.test(text[slashAt - 1]);
}

function minify(text, options = {}, onProgress) {
  return format(text, { ...options, minify: true }, onProgress);
}

module.exports = { format, minify, tokenize };
