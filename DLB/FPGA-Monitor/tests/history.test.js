import { describe, it, expect, afterEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { HistoryStore, csvCell } from '../src/recorder/HistoryStore.js';
import { ConfigStore } from '../src/store/ConfigStore.js';
import { ChannelStore } from '../src/store/ChannelStore.js';
const instances = [];
afterEach(async () => { for (const h of instances.splice(0)) { clearInterval(h.timer); h.db?.close(); } });
async function setup() {
  const h = new HistoryStore(new IDBFactory(), IDBKeyRange); instances.push(h); await h.init();
  const store = new ChannelStore(new ConfigStore({ getItem: () => null, setItem: () => {} })); store.resetTimeline(0);
  const frame = seq => ({ seq: seq & 65535, hostReceiveTime: seq * 20, samples: [{ sourceId: 0x10, type: 3, rawValue: -98304, rawBits: 0xfffe8000, value: -1.5 }] });
  store.ingest(frame(0)); store.configure(0x10, { name: '电流,"test"', visible: false });
  store.on('frame', f => h.capture(f, store.channels));
  return { h, store, frame };
}
describe('durable batched sessions', () => {
  it('records hidden data, flushes Stop and preserves accurate metadata/SEQ/raw', async () => {
    const { h, store, frame } = await setup(); const session = await h.start(store.channels, 0);
    for (let i = 1; i <= 620; i++) store.ingest(frame(i)); await h.stop();
    const saved = (await h.list())[0]; expect(saved).toMatchObject({ frames: 620, samples: 620, status: 'complete', protocolVersion: 1 });
    expect(saved.endedAt).toBeTruthy(); expect(saved.duration).toBe(12.4);
    const page = await h.page(session.id); expect(page).toHaveLength(500); expect(page[0].samples[0]).toMatchObject({ rawValue: -98304, value: -1.5 });
    expect((await h.page(session.id, 499))).toHaveLength(120);
    const csv = await (await h.csv(saved)).text(); expect(csv).toContain('timestamp,seq,channelId,channelName,type,raw,value');
    expect(csv).toContain('"电流,""test"""'); expect(csv).toContain('"-98304","-1.5"'); expect(csv.split('\r\n')).toHaveLength(622);
    await h.rename(session.id, '新实验'); expect((await h.list())[0].name).toBe('新实验');
    await h.remove(session.id); expect(await h.list()).toEqual([]); expect(await h.page(session.id)).toEqual([]);
  });
  it('bounded window keeps spikes and does not load other sessions', async () => {
    const { h, store, frame } = await setup(); const s = await h.start(store.channels, 0);
    for (let i = 1; i <= 2000; i++) { const f = frame(i); f.samples[0].value = i === 101 ? 1000 : -1.5; store.ingest(f); }
    await h.stop(); const rows = await h.window(s.id, 0, 40, 20); expect(rows.get(0x10).length).toBeLessThanOrEqual(40); expect(rows.get(0x10).some(p => p.value === 1000)).toBe(true);
    const subset = await h.window(s.id, 10, 11); expect(subset.get(0x10).every(p => p.time >= 10 && p.time <= 11)).toBe(true);
  }, 15000);
  it('interrupted session recovered with only durable counts', async () => {
    const { h, store, frame } = await setup(); const s = await h.start(store.channels, 0);
    for (let i = 1; i <= 25; i++) store.ingest(frame(i)); await h.flush(); clearInterval(h.timer); h.db.close();
    const recovered = new HistoryStore(h.idb, IDBKeyRange); instances.push(recovered); await recovered.init();
    expect((await recovered.list())[0]).toMatchObject({ id: s.id, frames: 25, status: 'interrupted', endedAt: null });
  });
  it('write failure is visible, retains RAM batch and Stop can retry', async () => {
    const { h, store, frame } = await setup(); const s = await h.start(store.channels, 0); store.ingest(frame(1));
    const native = h.db.transaction.bind(h.db); h.db.transaction = (...args) => {
      const tx = native(...args); if (Array.isArray(args[0])) queueMicrotask(() => tx.abort()); return tx;
    };
    await expect(h.flush()).rejects.toThrow(); expect(h.failure).toBeTruthy(); expect(h.pending).toHaveLength(1);
    h.db.transaction = native; await h.stop(); expect((await h.list())[0]).toMatchObject({ id: s.id, frames: 1, status: 'complete' });
  });
  it('protects user names from spreadsheet formulas while preserving numeric negatives', () => {
    expect(csvCell('=HYPERLINK("evil")')).toContain("'=HYPERLINK"); expect(csvCell(-1.5)).toBe('"-1.5"');
  });
  it('concurrent Stop shares completion and synchronous DB failure retains batch', async () => {
    const { h, store, frame } = await setup(); await h.start(store.channels, 0); store.ingest(frame(1));
    const native = h.db.transaction.bind(h.db);
    h.db.transaction = () => { throw new Error('DB closed'); };
    await expect(h.flush()).rejects.toThrow('DB closed'); expect(h.pending).toHaveLength(1);
    h.db.transaction = native;
    const first = h.stop(), second = h.stop(); expect(first).toBe(second); await first;
    expect((await h.list())[0].frames).toBe(1); expect(h.session).toBeNull();
  });
  it('retains exceptional FLOAT32 bits in history/CSV while finite bucket extrema recover after NaN', async () => {
    const { h, store } = await setup(); const s = await h.start(store.channels, 0);
    const { TYPE } = await import('../src/protocol/ProtocolConstants.js');
    const { decode, rawNumber } = await import('../src/protocol/ValueCodec.js');
    [0x7fc01234, 0x7f800000, 0xff800000, 0xbf800000, 0x3e800000].forEach((rawBits, seq) => store.ingest({ seq,
      hostReceiveTime: seq * 20, samples: [{ sourceId: 0x20, type: TYPE.FLOAT32, rawBits, rawValue: rawNumber(TYPE.FLOAT32, rawBits), value: decode(TYPE.FLOAT32, rawBits) }] }));
    await h.stop(); const rows = await h.page(s.id);
    expect(rows[0].samples[0]).toMatchObject({ rawBits: 0x7fc01234, value: NaN });
    const window = await h.window(s.id, 0, 1, 1); expect(window.get(0x20).map(p => p.value)).toEqual([-1, 0.25]);
    const csv = await (await h.csv((await h.list())[0])).text(); expect(csv).toContain('FLOAT32'); expect(csv).toContain('NaN'); expect(csv).toContain('"1048576000","0.25"');
  });
});
