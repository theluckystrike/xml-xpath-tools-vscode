'use strict';
// Talks to dist/worker.js. One long-lived worker for the index and XPath; a fresh worker for each big format job,
// so a long format never delays the tree and can be cancelled by ending its worker.
const { Worker } = require('worker_threads');

class WorkerClient {
  constructor(script, { heapMb = 4096 } = {}) {
    this.script = script; this.heapMb = heapMb;
    this.worker = null; this.seq = 0; this.pending = new Map();
  }
  spawn() {
    if (this.worker) return this.worker;
    const w = new Worker(this.script, { resourceLimits: { maxOldGenerationSizeMb: this.heapMb } });
    w.on('message', m => {
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.progress !== undefined && m.ok === undefined) { if (p.onProgress) p.onProgress(m.progress); return; }
      this.pending.delete(m.id);
      p.resolve(m);
    });
    const fail = err => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const [, p] of this.pending) p.resolve({ ok: false, internal: true, error: err });
      this.pending.clear();
    };
    w.on('error', e => fail('The worker stopped: ' + String((e && e.message) || e).slice(0, 300)));
    w.on('exit', code => fail(code ? `The worker stopped (code ${code}). The file may be too big for the memory limit.` : 'The worker stopped.'));
    this.worker = w;
    return w;
  }
  /** Sends a message; resolves with the reply ({ ok, ... }). Never rejects. */
  request(msg, { onProgress, token } = {}) {
    const w = this.spawn();
    const id = ++this.seq;
    return new Promise(resolve => {
      this.pending.set(id, { resolve, onProgress });
      if (token) {
        if (token.isCancellationRequested) { this.pending.delete(id); resolve({ ok: false, cancelled: true }); return; }
        token.onCancellationRequested(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          resolve({ ok: false, cancelled: true });
          this.terminate();
        });
      }
      w.postMessage({ ...msg, id });
    });
  }
  terminate() {
    const w = this.worker;
    this.worker = null;
    for (const [, p] of this.pending) p.resolve({ ok: false, cancelled: true });
    this.pending.clear();
    if (w) w.terminate().catch(() => {});
  }
}

/** Runs one job in its own worker and ends the worker after it. */
async function oneShot(script, msg, opts) {
  const c = new WorkerClient(script);
  try { return await c.request(msg, opts); } finally { c.terminate(); }
}

module.exports = { WorkerClient, oneShot };
