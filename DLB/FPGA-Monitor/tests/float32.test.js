import { describe, it, expect } from 'vitest';
import { TYPE } from '../src/protocol/ProtocolConstants.js';
import { encode, decode, rawNumber, rawText, limits, supported, typeName } from '../src/protocol/ValueCodec.js';
import { ProtocolEncoder, makeTelemetry } from '../src/protocol/ProtocolEncoder.js';
import { ProtocolDecoder } from '../src/protocol/ProtocolDecoder.js';
import { crc16 } from '../src/protocol/CRC16.js';
import { ConfigStore, CONFIG_KEY } from '../src/store/ConfigStore.js';
import { ChannelStore } from '../src/store/ChannelStore.js';
import { ParameterController } from '../src/control/ParameterController.js';
import { FrameLogger } from '../src/logger/FrameLogger.js';
import { MockTransport } from '../src/serial/MockTransport.js';

describe('FLOAT32 IEEE-754 little endian', () => {
  it.each([[0, 0], [1, 0x3f800000], [-1, 0xbf800000], [0.25, 0x3e800000], [3.1415926, 0x40490fda],
    [-12.5, 0xc1480000], [0.2, 0x3e4ccccd], [-0, 0x80000000]])('round trip %s with exact bits', (value, bits) => {
    expect(encode(TYPE.FLOAT32, value)).toBe(bits);
    const actual = decode(TYPE.FLOAT32, bits);
    expect(actual).toBe(Math.fround(value));
    expect(Math.abs(actual - value)).toBeLessThanOrEqual(Math.max(1, Math.abs(value)) * 1e-7);
    if (Object.is(value, -0)) expect(Object.is(actual, -0)).toBe(true);
  });
  it.each([[1, [0, 0, 0x80, 0x3f]], [0.25, [0, 0, 0x80, 0x3e]]])('VALUE bytes for %s', (value, bytes) => {
    expect([...new ProtocolEncoder().setParam(0x20, TYPE.FLOAT32, value).bytes.slice(10, 14)]).toEqual(bytes);
  });
  it.each([NaN, Infinity, -Infinity, 3.5e38, -3.5e38, '0.25'])('rejects unsafe TX %s', value => {
    const encoder = new ProtocolEncoder();
    expect(() => encoder.setParam(0x20, TYPE.FLOAT32, value)).toThrow(); expect(encoder.seq).toBe(0);
  });
  it('finite limits, subnormal, underflow, names and raw bit display', () => {
    const { min, max, resolution } = limits(TYPE.FLOAT32);
    expect(decode(TYPE.FLOAT32, encode(TYPE.FLOAT32, min))).toBe(min);
    expect(decode(TYPE.FLOAT32, encode(TYPE.FLOAT32, max))).toBe(max);
    expect(encode(TYPE.FLOAT32, resolution)).toBe(1); expect(encode(TYPE.FLOAT32, resolution / 4)).toBe(0);
    expect(typeName(TYPE.FLOAT32)).toBe('FLOAT32'); expect(supported(TYPE.FLOAT32)).toBe(true);
    expect(rawNumber(TYPE.FLOAT32, 0xbf800000)).toBe(0xbf800000);
    expect(rawText(TYPE.FLOAT32, 0x40490fdb)).toBe('0x40490FDB'); expect(rawText(TYPE.INT32, 0xffffffff)).toBe('-1');
  });
  it('SET_PARAM reference vector, payload and CRC', () => {
    const { bytes } = new ProtocolEncoder(0x23).setParam(0x20, TYPE.FLOAT32, 0.25);
    expect([...bytes]).toEqual([0xa5, 0x5a, 1, 0x10, 0x23, 0, 6, 0, 0x20, TYPE.FLOAT32, 0, 0, 0x80, 0x3e, 0x97, 0x3e]);
    expect(crc16(bytes.subarray(2, -2))).toBe(0x3e97);
  });
  it('TELEMETRY reference vector decoded at every chunk boundary', () => {
    const bytes = Uint8Array.from([0xa5, 0x5a, 1, 1, 7, 0, 7, 0, 1, 0x20, TYPE.FLOAT32, 0, 0, 0x80, 0x3f, 0x3a, 0x9d]);
    expect([...makeTelemetry(7, [{ sourceId: 0x20, type: TYPE.FLOAT32, value: 1 }])]).toEqual([...bytes]);
    for (let i = 1; i < bytes.length; i++) {
      const decoder = new ProtocolDecoder(), frames = [];
      decoder.on('telemetry', f => frames.push(f)); decoder.push(bytes.subarray(0, i)); decoder.push(bytes.subarray(i));
      expect(frames).toHaveLength(1); expect(frames[0].samples[0]).toMatchObject({ sourceId: 0x20, type: TYPE.FLOAT32, value: 1, rawBits: 0x3f800000 });
    }
  });
  it('RX accepts NaN and both infinities then continues finite telemetry', () => {
    const decoder = new ProtocolDecoder(), frames = [], errors = [];
    decoder.on('telemetry', f => frames.push(f)); decoder.on('error', e => errors.push(e));
    [0x7fc01234, 0x7f800000, 0xff800000, 0x3f800000].forEach((rawBits, seq) => decoder.push(makeTelemetry(seq, [{ sourceId: 0x20, type: TYPE.FLOAT32, rawBits }])));
    expect(frames).toHaveLength(4); expect(frames[0].samples[0].value).toBeNaN();
    expect(frames.slice(1).map(f => f.samples[0].value)).toEqual([Infinity, -Infinity, 1]); expect(errors).toEqual([]);
    expect(frames[0].samples[0].rawBits).toBe(0x7fc01234);
  });
  it('writable mock sends FLOAT32, rejects unsafe values and syncs exact readback bits', async () => {
    const config = new ConfigStore({ getItem: () => null, setItem: () => {} }), store = new ChannelStore(config);
    const mock = new MockTransport(), decoder = new ProtocolDecoder(), logger = new FrameLogger();
    mock.on('bytes', b => decoder.push(b)); decoder.on('telemetry', f => store.ingest(f));
    const parameters = new ParameterController(store, new ProtocolEncoder(), () => mock, logger, () => {});
    await mock.open();
    try {
      mock.produce(); const c = store.channels.get(0x20);
      expect(c).toMatchObject({ name: 'Channel 0x20', type: TYPE.FLOAT32, writable: false });
      store.configure(0x20, { writable: true, sliderMin: -1, sliderMax: 1 });
      await parameters.send(0x20, 0.25); expect(c.requested.rawBits).toBe(0x3e800000); expect(c.requested.synced).toBe(false);
      mock.produce(); expect(c.value).toBe(0.25); expect(c.requested.synced).toBe(true);
      expect(logger.entries[0].hex).toContain('20 05 00 00 80 3E'); expect(logger.entries[0].summary).toContain('RAW=0x3E800000');
      for (const value of [NaN, Infinity, -Infinity, 2]) await expect(parameters.send(0x20, value)).rejects.toThrow();
      expect(store.stats.tx).toBe(1);
    } finally { parameters.cancel(); await mock.close(); }
  });
});

describe('additive v1 UI configuration', () => {
  it('old v1 config keeps channel settings and defaults to expanded/grouped', () => {
    const saved = { version: 1, channels: {}, ui: { baud: 57600, timeWindow: 5 } };
    const config = new ConfigStore({ getItem: () => JSON.stringify(saved), setItem: () => {} });
    expect(config.data.ui).toMatchObject({ baud: 57600, timeWindow: 5, leftPanelCollapsed: false, rightPanelCollapsed: false, logPanelCollapsed: false, groupedHex: true });
  });
  it('all panel combinations and HEX preference persist', () => {
    const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
    const config = new ConfigStore(storage);
    for (let mask = 0; mask < 8; mask++) {
      config.saveUI({ leftPanelCollapsed: !!(mask & 1), rightPanelCollapsed: !!(mask & 2), logPanelCollapsed: !!(mask & 4), groupedHex: !!(mask & 1) });
      expect(new ConfigStore(storage).data).toEqual(config.data); expect(JSON.parse(data.get(CONFIG_KEY)).version).toBe(1);
    }
    for (const key of ['leftPanelCollapsed', 'rightPanelCollapsed', 'logPanelCollapsed', 'groupedHex']) expect(() => config.saveUI({ [key]: 'false' })).toThrow();
  });
});
