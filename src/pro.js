'use strict';
// Zovo Pro for XML Formatter & XPath Tools, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Three Pro tools (src/protools.js), 3 free tries each on this computer. A try
// counts only after a result (results opened, files formatted or the report shown, the comparison shown); Escape,
// Cancel, an XPath syntax error or a folder with no XML files never uses one.
// Nothing about Pro shows on open, activation or update: the panel appears only after a click on a Pro tool with no
// tries left. Format Document, Minify, XPath on the open file, Copy XPath, the tree and the checks stay free.
const { createLicense } = require('./license');
const { withSurface } = require('./reach');

const SKU = 'xml-xpath-tools-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'xmlXpathTools.proTrial';

const FEATURES = {
  xpathFolder: {
    title: 'Run XPath on a folder',
    detail: 'Runs one XPath on every XML file in a folder (each file with its own namespaces) and opens the results as CSV, JSON or a Markdown report: file, line, kind, name and value.',
  },
  formatFolder: {
    title: 'Format all XML files in a folder',
    detail: 'Checks every XML file in a folder with the same safe formatter as Format Document, shows how many would change, then formats them all or gives a Markdown report for review or CI.',
  },
  compare: {
    title: 'Compare XML ignoring formatting',
    detail: 'Compares two XML files with indentation, line breaks, attribute order, quotes and empty-tag style ignored, so only real changes show in the diff. Or it tells you the two are the same XML.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'xmlXpathTools', productName = 'XML Formatter & XPath Tools' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one Pro panel. */
  async function allowed(f) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, withSurface({ detail: feat.detail, triesUsed: used(f), tools: TOOLS })));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS };
