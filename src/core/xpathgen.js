'use strict';
// XPath of an element (and optionally one of its attributes), in three styles:
//   indexed     /project/dependencies/dependency[2]                 position among same-name siblings
//   predicates  /project/dependencies/dependency[@id='core']         a unique id/name/key attribute, else the position
//   portable    /*[local-name()='project']/*[local-name()='dependencies']/*[local-name()='dependency'][2]
//               works in any XPath 1.0 tool without namespace bindings
// The indexed and predicates styles match how this extension evaluates XPath: a name without a prefix matches
// that name in any default namespace (pom.xml, SVG, XAML, .csproj), and prefixes are the ones declared in the file.
// Each step is checked against the same sibling rule, so the copied path selects exactly that element.
const { localName, prefixOf } = require('./index');

function quote(v) {
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"')) return `"${v}"`;
  return null;
}

/** How a step names the element, and which siblings the same name test also matches. */
function nameTest(ix, i, style) {
  const local = localName(ix, i);
  const pre = prefixOf(ix, i);
  const ns = ix.uris[ix.nsId[i]];
  if (style === 'portable') {
    return { test: `*[local-name()=${quote(local)}]`, same: j => localName(ix, j) === local };
  }
  if (!pre) {
    // unprefixed name: matches unprefixed siblings with this local name
    return { test: local, same: j => !prefixOf(ix, j) && localName(ix, j) === local };
  }
  if (ix.prefixes[pre] === ns && !(ix.conflicts || []).includes(pre)) {
    // prefix resolves to the element's namespace: matches siblings with this local name in that namespace
    return { test: `${pre}:${local}`, same: j => localName(ix, j) === local && ix.uris[ix.nsId[j]] === ns };
  }
  return {
    test: `*[local-name()=${quote(local)} and namespace-uri()=${quote(ns)}]`,
    same: j => localName(ix, j) === local && ix.uris[ix.nsId[j]] === ns,
  };
}

function siblingsOf(ix, i) {
  const p = ix.parent[i];
  const out = [];
  if (p < 0) return ix.roots.slice();
  for (let c = ix.firstChild[p]; c >= 0; c = ix.nextSibling[c]) out.push(c);
  return out;
}

function step(ix, i, style) {
  const nt = nameTest(ix, i, style);
  const sibs = siblingsOf(ix, i);
  let pos = 0, total = 0;
  for (const j of sibs) {
    if (nt.same(j)) { total++; if (j === i) pos = total; }
  }
  if (style === 'predicates' && ix.keyName[i]) {
    const kn = ix.keyName[i], kv = ix.keyValue[i];
    const q = quote(kv);
    const kc = kn.indexOf(':');
    const prefixOk = kc < 0 || kn.startsWith('xml:') || (ix.prefixes[kn.slice(0, kc)] !== undefined && !(ix.conflicts || []).includes(kn.slice(0, kc)));
    if (q && prefixOk) {
      let same = 0;
      for (const j of sibs) if (nt.same(j) && ix.keyName[j] === kn && ix.keyValue[j] === kv) same++;
      if (same === 1) return `${nt.test}[@${kn}=${q}]`;
    }
  }
  return total > 1 ? `${nt.test}[${pos}]` : nt.test;
}

/**
 * XPath for element i. attr: optional attribute name (as written in the tag) to add as "/@name".
 * Unprefixed attributes have no namespace, so "@name" is exact. A prefixed attribute uses its prefix
 * when the file declares it once, else a local-name() test.
 */
function xpathFor(ix, i, style = 'indexed', attr) {
  if (i < 0) return '/';
  const steps = [];
  for (let e = i; e >= 0; e = ix.parent[e]) steps.push(step(ix, e, style));
  steps.reverse();
  let p = '/' + steps.join('/');
  if (attr) {
    const c = attr.indexOf(':');
    if (c < 0 || attr.startsWith('xml:')) p += style === 'portable' && c > 0 ? `/@*[local-name()=${quote(attr.slice(c + 1))}]` : `/@${attr}`;
    else if (style !== 'portable' && ix.prefixes[attr.slice(0, c)] !== undefined && !(ix.conflicts || []).includes(attr.slice(0, c))) p += `/@${attr}`;
    else p += `/@*[local-name()=${quote(attr.slice(c + 1))}]`;
  }
  return p;
}

module.exports = { xpathFor, step };
