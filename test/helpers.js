'use strict';
// Canonical form of an XML document for "same tree before and after formatting" checks.
// Whitespace-only text is dropped where the formatter is allowed to change it: in an element that holds tags and no
// other text and is not under xml:space="preserve", or a whitespace-only element body with a line break.
const { DOMParser } = require('@xmldom/xmldom');
const fs = require('fs');
const path = require('path');

const SAMPLES = path.join(__dirname, '..', 'samples');

function parse(text) {
  return new DOMParser({ onError: (level, msg) => { if (level !== 'warning') throw new Error(level + ': ' + msg); } }).parseFromString(text, 'text/xml');
}

function canon(node, preserve = false) {
  const out = [];
  const walk = (n, pres) => {
    switch (n.nodeType) {
      case 9: for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType !== 3) walk(c, pres); break;
      case 1: {
        const attrs = [];
        for (let i = 0; i < n.attributes.length; i++) attrs.push(n.attributes[i].name + '=' + JSON.stringify(n.attributes[i].value));
        attrs.sort();
        const sp = n.getAttribute('xml:space');
        const p = sp === 'preserve' ? true : sp === 'default' ? false : pres;
        out.push(`<${n.nodeName} ${attrs.join(' ')}>`);
        const kids = [];
        for (let c = n.firstChild; c; c = c.nextSibling) kids.push(c);
        const hasText = kids.some(c => (c.nodeType === 3 && /\S/.test(c.data)) || c.nodeType === 4);
        const hasMarkup = kids.some(c => c.nodeType === 1 || c.nodeType === 7 || c.nodeType === 8);
        for (const c of kids) {
          if (c.nodeType === 3 && !/\S/.test(c.data) && !p && !hasText) {
            if (hasMarkup) continue;
            if (/[\r\n]/.test(c.data)) continue;
          }
          walk(c, p);
        }
        out.push(`</${n.nodeName}>`);
        break;
      }
      case 3: out.push('T' + JSON.stringify(n.data)); break;
      case 4: out.push('C' + JSON.stringify(n.data)); break;
      case 7: out.push('P' + n.target + JSON.stringify(n.data)); break;
      case 8: out.push('!' + JSON.stringify(n.data)); break;
      case 10: out.push('D' + n.name); break;
      default: break;
    }
  };
  walk(node, preserve);
  return out.join('\n');
}

function sampleFiles() {
  const out = [];
  for (const f of fs.readdirSync(SAMPLES)) {
    const p = path.join(SAMPLES, f);
    if (fs.statSync(p).isFile()) out.push(p);
  }
  return out.sort();
}

module.exports = { parse, canon, sampleFiles, SAMPLES };
