/**
 * Responsibility: Batched durable sessions, bounded history-window reads and paged CSV export.
 * Allowed dependencies: Events, channelConfig, ValueCodec display names, IndexedDB.
 * Forbidden responsibilities: UART parsing, chart, live ring buffers, localStorage sample data.
 * Public API: init(), start(), capture(), flush(), stop(), list(), rename(), remove(), window(), csv().
 * Architecture invariants: One batch transaction includes frames and metadata; failed batches retain data.
 */
import { Events } from '../core/Events.js';
import { channelConfig } from '../store/ChannelStore.js';
import { typeName } from '../protocol/ValueCodec.js';
import { hexId } from '../protocol/ProtocolConstants.js';
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const completed = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted')); });
export const csvCell = value => {
  let text = String(value ?? '');
  // Spreadsheet formula injection protection for user-controlled names/units.
  if (/^[=+@\-]/.test(text) && !Number.isFinite(Number(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export class HistoryStore extends Events {
  constructor(idb = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange) {
    super(); this.idb = idb; this.keyRange = keyRange; this.pending = []; this.session = null; this.queue = Promise.resolve();
  }
  async init() {
    if (!this.idb) throw new Error('IndexedDB 不可用，实验记录已禁用');
    const req = this.idb.open('fpga-monitor-db-v1', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      const frames = db.createObjectStore('frames', { keyPath: ['sessionId', 'ordinal'] });
      frames.createIndex('time', ['sessionId', 'time']);
    };
    req.onblocked = () => this.emit('error', new Error('历史库升级被其他页面阻止，请关闭其他上位机页面'));
    this.db = await request(req);
    this.db.onversionchange = () => { this.db.close(); this.emit('error', new Error('历史数据库版本变化，请刷新')); };
    // Recover interrupted recordings from committed data; never fabricate an end timestamp.
    for (const session of await this.list()) {
      if (session.status === 'recording') {
        session.status = 'interrupted'; await this.putSession(session);
      }
    }
  }
  async putSession(session) {
    const tx = this.db.transaction('sessions', 'readwrite'); const done = completed(tx);
    tx.objectStore('sessions').put(session); await done;
  }
  async start(channels, sourceStart = performance.now()) {
    if (!this.db) throw new Error('历史数据库未就绪');
    if (this.session) throw new Error('已有记录中的 Session');
    const session = { id: crypto.randomUUID(), name: `实验 ${new Date().toLocaleString()}`, startedAt: new Date().toISOString(), endedAt: null,
      protocolVersion: 1, frames: 0, samples: 0, duration: 0, status: 'recording', channels: {}, sourceStart };
    for (const c of channels.values()) session.channels[c.sourceId] = { ...channelConfig(c), sourceId: c.sourceId, type: c.type };
    await this.putSession(session);
    this.session = session; this.pending = []; this.failure = null;
    this.timer = setInterval(() => this.flush().catch(() => {}), 500); this.emit('state', session);
    return session;
  }
  capture(frame, channels) {
    if (!this.session || this.stopping || this.failure) return;
    // Bound the write backlog. Stop visibly instead of silently dropping experimental samples.
    if (this.pending.length >= 5000) { this.fail(new Error('磁盘写入积压超过 5000 帧，记录已停止接收')); return; }
    for (const sample of frame.samples) {
      const c = channels.get(sample.sourceId);
      this.session.channels[sample.sourceId] = { ...channelConfig(c), sourceId: c.sourceId, type: sample.type };
    }
    const time = Math.max(0, (frame.hostReceiveTime - this.session.sourceStart) / 1000);
    this.pending.push({ sessionId: this.session.id, ordinal: this.session.frames++, time,
      seq: frame.seq, hostReceiveTime: frame.hostReceiveTime, samples: frame.samples.map(s => ({ ...s })) });
    this.session.samples += frame.samples.length; this.session.duration = time;
    if (this.pending.length >= 250) this.flush().catch(() => {});
  }
  fail(error) { this.failure = error; clearInterval(this.timer); this.emit('error', error); this.emit('state', this.session); }
  flush() {
    if (this.flushJob) return this.flushJob;
    const job = this.queue.then(async () => {
      if (!this.session || !this.pending.length) return;
      const batch = this.pending.splice(0, 250);
      try {
        const tx = this.db.transaction(['frames', 'sessions'], 'readwrite'); const done = completed(tx);
        for (const frame of batch) tx.objectStore('frames').put(frame);
        // Persist only counts for durable frames, not the remaining RAM backlog.
        const tail = batch.at(-1);
        const metadata = { ...this.session, frames: tail.ordinal + 1,
          samples: this.session.samples - this.pending.reduce((sum, f) => sum + f.samples.length, 0), duration: tail.time };
        tx.objectStore('sessions').put(metadata);
        await done;
      } catch (error) { this.pending.unshift(...batch); this.fail(error); throw error; }
    });
    this.flushJob = job.finally(() => { this.flushJob = null; });
    this.queue = this.flushJob.catch(() => {}); return this.flushJob;
  }
  stop() {
    if (this.stopJob) return this.stopJob;
    this.stopJob = this.finishStop().finally(() => { this.stopJob = null; });
    return this.stopJob;
  }
  async finishStop() {
    if (!this.session) return;
    this.stopping = true; clearInterval(this.timer);
    try {
      await this.queue;
      while (this.pending.length) await this.flush();
      this.session.endedAt = new Date().toISOString(); this.session.status = 'complete';
      await this.putSession(this.session);
      this.session = null; this.failure = null; this.emit('state', null);
    } finally { this.stopping = false; }
  }
  async list() {
    if (!this.db) return [];
    const tx = this.db.transaction('sessions');
    return (await request(tx.objectStore('sessions').getAll())).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async rename(id, name) {
    if (!name.trim() || name.length > 120) throw new Error('Session 名称需为 1–120 字符');
    if (id === this.session?.id) { this.session.name = name; await this.flush(); return; }
    const tx = this.db.transaction('sessions', 'readwrite'); const done = completed(tx); const store = tx.objectStore('sessions');
    const session = await request(store.get(id)); if (!session) throw new Error('Session 不存在');
    session.name = name; store.put(session); await done;
  }
  async remove(id) {
    if (id === this.session?.id) throw new Error('请先停止记录再删除');
    const tx = this.db.transaction(['sessions', 'frames'], 'readwrite'); const done = completed(tx);
    tx.objectStore('sessions').delete(id);
    tx.objectStore('frames').delete(this.keyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])); await done;
  }
  async window(id, min, max, buckets = 2000) {
    const tx = this.db.transaction('frames');
    const range = this.keyRange.bound([id, Math.max(0, min)], [id, Math.max(0, max)]);
    const rows = new Map();
    const width = Math.max((max - min) / buckets, 0.000001);
    await new Promise((resolve, reject) => {
      const req = tx.objectStore('frames').index('time').openCursor(range);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result; if (!cursor) return resolve();
        const frame = cursor.value;
        // Bounded temporal buckets per ID: min/max keeps narrow spikes visible.
        for (const s of frame.samples) {
          if (!rows.has(s.sourceId)) rows.set(s.sourceId, new Map());
          const groups = rows.get(s.sourceId);
          const bucket = Math.min(buckets - 1, Math.floor((frame.time - min) / width));
          const p = { time: frame.time, value: s.value };
          const pair = groups.get(bucket);
          if (!pair) groups.set(bucket, [p, p]);
          else if (Number.isFinite(p.value)) {
            if (!Number.isFinite(pair[0].value) || p.value < pair[0].value) pair[0] = p;
            if (!Number.isFinite(pair[1].value) || p.value > pair[1].value) pair[1] = p;
          }
        }
        cursor.continue();
      };
    });
    return new Map([...rows].map(([id, groups]) => [id, [...groups.values()].flatMap(([a, b]) => a === b ? [a] : [a, b]).sort((a, b) => a.time - b.time)]));
  }
  async page(id, after = -1, limit = 500) {
    const tx = this.db.transaction('frames');
    const req = tx.objectStore('frames').openCursor(this.keyRange.bound([id, after + 1], [id, Number.MAX_SAFE_INTEGER]));
    return new Promise((resolve, reject) => {
      const rows = []; req.onerror = () => reject(req.error);
      req.onsuccess = () => { const c = req.result; if (!c || rows.length >= limit) return resolve(rows); rows.push(c.value); c.continue(); };
    });
  }
  async csv(session) {
    const parts = ['\ufefftimestamp,seq,channelId,channelName,type,raw,value,hostReceiveTime,hostTimestamp\r\n'];
    let after = -1;
    while (true) {
      const frames = await this.page(session.id, after); if (!frames.length) break;
      const lines = [];
      for (const f of frames) for (const s of f.samples) {
        const hostTimestamp = new Date(Date.parse(session.startedAt) + f.time * 1000).toISOString();
        lines.push([f.time.toFixed(6), f.seq, hexId(s.sourceId), session.channels[s.sourceId]?.name ?? `Channel ${hexId(s.sourceId)}`,
          typeName(s.type), s.rawValue, s.value, f.hostReceiveTime, hostTimestamp].map(csvCell).join(','));
      }
      parts.push(lines.join('\r\n') + '\r\n'); after = frames.at(-1).ordinal;
    }
    return new Blob(parts, { type: 'text/csv;charset=utf-8' });
  }
}
