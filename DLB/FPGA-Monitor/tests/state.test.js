import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigStore, CONFIG_KEY } from '../src/store/ConfigStore.js';
import { ChannelStore, RingBuffer } from '../src/store/ChannelStore.js';
import { FrameLogger } from '../src/logger/FrameLogger.js';
import { ParameterController } from '../src/control/ParameterController.js';
import { ProtocolEncoder } from '../src/protocol/ProtocolEncoder.js';
import { MockTransport } from '../src/serial/MockTransport.js';
import { ProtocolDecoder } from '../src/protocol/ProtocolDecoder.js';
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) }; };
const sampleFrame = (seq, time = seq * 20, rawBits = 16384) => ({ seq, hostReceiveTime: time, samples: [{ sourceId: 0x10, type: 3, rawBits, rawValue: rawBits, value: rawBits === 16384 ? 0.25 : 0.2 }] });
afterEach(() => vi.useRealTimers());
describe('state and interaction boundaries', () => {
  it('config reload restores every channel property and axis/baud/window/filter', () => {
    const storage = memory(), config = new ConfigStore(storage), store = new ChannelStore(config); store.resetTimeline(0); store.ingest(sampleFrame(0));
    store.configure(0x10, { name: '位置环', unit: 'V', color: '#123456', visible: false, axis: 'right', writable: true, sliderMin: -2, sliderMax: 2, sliderStep: 0.01 });
    config.saveUI({ baud: 57600, timeWindow: 30, right: { mode: 'manual', min: -3, max: 3 }, logFilters: ['ERR'] });
    const restored = new ConfigStore(storage); expect(restored.data).toEqual(config.data);
    const next = new ChannelStore(restored); next.ingest(sampleFrame(1)); expect(next.channels.get(0x10)).toMatchObject({ name: '位置环', visible: false, color: '#123456', axis: 'right' });
  });
  it('invalid JSON/version and quota failures degrade safely', () => {
    for (const text of ['{', '{"version":2}', '{"version":1,"channels":{},"ui":{"timeWindow":2}}']) {
      const errors = []; const config = new ConfigStore({ getItem: () => text }, e => errors.push(e)); expect(config.data.ui.baud).toBe(115200); expect(errors).toHaveLength(1);
    }
    const errors = []; const config = new ConfigStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, e => errors.push(e)); config.saveUI({ timeWindow: 5 }); expect(errors).toHaveLength(1);
  });
  it('bounded rings retain most recent points', () => {
    const ring = new RingBuffer(3); for (let time = 0; time < 100; time++) ring.push({ time }); expect(ring.size).toBe(3); expect(ring.values().map(p => p.time)).toEqual([97, 98, 99]);
  });
  it('persisted extras cannot overwrite channel machine identity or ring buffers', () => {
    const storage = memory(), config = new ConfigStore(storage), store = new ChannelStore(config); store.ingest(sampleFrame(0));
    const saved = JSON.parse(storage.getItem(CONFIG_KEY)); Object.assign(saved.channels[16], { sourceId: 99, points: null, value: 999 });
    storage.setItem(CONFIG_KEY, JSON.stringify(saved)); const restored = new ChannelStore(new ConfigStore(storage)); restored.ingest(sampleFrame(1));
    expect(restored.channels.get(16).sourceId).toBe(16); expect(restored.channels.get(16).points.size).toBe(1); expect(restored.channels.get(16).value).toBe(0.25);
  });
  it('hidden channels continue samples and frame subscriptions', () => {
    const store = new ChannelStore(new ConfigStore(memory()), 3); store.resetTimeline(0); const frames = []; store.on('frame', f => frames.push(f));
    store.ingest(sampleFrame(0)); store.configure(0x10, { visible: false }); for (let seq = 1; seq < 10; seq++) store.ingest(sampleFrame(seq));
    expect(store.channels.get(0x10).points.size).toBe(3); expect(frames).toHaveLength(10);
  });
  it('lost, wraparound, duplicate and reordered diagnostics', () => {
    const store = new ChannelStore(new ConfigStore(memory())); for (const seq of [65534, 65535, 0, 2, 2, 1, 3]) store.ingest(sampleFrame(seq));
    expect(store.stats).toMatchObject({ lost: 1, duplicates: 1, reordered: 1, seq: 3 });
  });
  it('logs bounded independently from samples', () => {
    const logger = new FrameLogger(3); for (let i = 0; i < 100; i++) logger.add('RX', String(i), [0xa5, 0]);
    expect(logger.entries).toHaveLength(3); expect(logger.entries[0].hex).toBe('A5 00');
  });
  it('parameter write validates, encodes, then synchronizes only from matching telemetry', async () => {
    const store = new ChannelStore(new ConfigStore(memory())); store.ingest(sampleFrame(0)); const transport = { connected: true, write: vi.fn(async () => {}) };
    const controller = new ParameterController(store, new ProtocolEncoder(), () => transport, new FrameLogger(), () => {});
    await expect(controller.send(0x10, 0.25)).rejects.toThrow(); store.configure(0x10, { writable: true });
    await controller.send(0x10, 0.25); const c = store.channels.get(0x10); expect(c.requested.synced).toBe(false); expect(c.requested.rawBits).toBe(16384);
    store.ingest(sampleFrame(1)); expect(c.requested.synced).toBe(true); store.ingest(sampleFrame(2, 40, 13107)); expect(c.requested.synced).toBe(false);
    await expect(controller.send(0x10, 2)).rejects.toThrow(); expect(transport.write).toHaveBeenCalledTimes(1);
  });
  it('drag is <=20Hz, release sends final immediately and cancels pending timer', async () => {
    vi.useFakeTimers(); const store = new ChannelStore(new ConfigStore(memory())); store.ingest(sampleFrame(0)); store.configure(0x10, { writable: true });
    const transport = { connected: true, write: vi.fn(async () => {}) }; const controller = new ParameterController(store, new ProtocolEncoder(), () => transport, new FrameLogger(), () => {});
    for (let i = 0; i < 20; i++) controller.drag(0x10, i / 100);
    await Promise.resolve(); expect(transport.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50); expect(transport.write).toHaveBeenCalledTimes(2);
    controller.drag(0x10, 0.2); await controller.finish(0x10, 0.25); expect(transport.write).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100); expect(transport.write).toHaveBeenCalledTimes(3);
  });
  it('mock split bytes use real decoder and SET_PARAM echoes through telemetry', async () => {
    vi.useFakeTimers(); const mock = new MockTransport(), decoder = new ProtocolDecoder(), frames = [], errors = [];
    decoder.on('telemetry', f => frames.push(f)); decoder.on('error', e => errors.push(e)); mock.on('bytes', b => decoder.push(b));
    await mock.open(); await vi.advanceTimersByTimeAsync(100); expect(frames).toHaveLength(5); expect(frames[0].samples).toHaveLength(7);
    await mock.write(new ProtocolEncoder().setParam(0x10, 3, -0.5).bytes); await vi.advanceTimersByTimeAsync(20);
    expect(frames.at(-1).samples.find(s => s.sourceId === 0x10).value).toBe(-0.5);
    mock.injectCRCError(); expect(errors[0].kind).toBe('CRC'); await mock.close(); await vi.advanceTimersByTimeAsync(100); expect(frames).toHaveLength(6);
  });
});
