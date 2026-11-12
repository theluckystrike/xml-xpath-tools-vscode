'use strict';
// Writes the big test files outside the repo (default ~/xml-tools-work/big), streamed, so no large string is held:
//   big-catalog.xml   about 49 MB (just under the 50 MB size VS Code passes to extensions), ~1.1 million lines
//   one-line-5mb.xml  5 MB on a single line (hostile: no line breaks)
// usage: node scripts/make-samples.js [outDir] [targetMB]
const fs = require('fs');
const path = require('path');
const os = require('os');
const out = process.argv[2] || path.join(os.homedir(), 'xml-tools-work', 'big');
const targetMB = Number(process.argv[3] || 49);
fs.mkdirSync(out, { recursive: true });

function writeBig(file, target, oneLine) {
  const fd = fs.openSync(file, 'w');
  const nl = oneLine ? '' : '\n';
  const ind = oneLine ? '' : '  ';
  let size = 0, i = 0;
  const put = s => { fs.writeSync(fd, s); size += Buffer.byteLength(s); };
  put(`<?xml version="1.0" encoding="UTF-8"?>${nl}<catalog xmlns="urn:example:catalog" xmlns:p="urn:example:price">${nl}`);
  const parts = [];
  while (size < target) {
    i++;
    const rec = `${ind}<product id="P${i}" sku="SKU-${(i * 7919) % 1000003}">${nl}${ind}${ind}<name>Product ${i} &amp; spare part</name>${nl}`
      + `${ind}${ind}<p:price currency="EUR">${(i % 997) + 0.99}</p:price>${nl}${ind}${ind}<stock warehouse="W${i % 7}">${i % 50}</stock>${nl}`
      + (i % 10 === 0 ? `${ind}${ind}<!-- restock ${i} -->${nl}${ind}${ind}<note><![CDATA[keep  <raw>  text ${i}]]></note>${nl}` : '')
      + `${ind}</product>${nl}`;
    parts.push(rec);
    if (parts.length >= 2000) { put(parts.join('')); parts.length = 0; }
  }
  if (parts.length) put(parts.join(''));
  put(`</catalog>${nl}`);
  fs.closeSync(fd);
  return { file, bytes: size, products: i };
}

const a = writeBig(path.join(out, 'big-catalog.xml'), targetMB * 1000 * 1000, false);
const b = writeBig(path.join(out, 'one-line-5mb.xml'), 5 * 1000 * 1000, true);
console.log(JSON.stringify([a, b]));
