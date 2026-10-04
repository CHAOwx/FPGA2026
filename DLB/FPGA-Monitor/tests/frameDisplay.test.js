import { describe, it, expect } from 'vitest';
import { formatFrameForDisplay, toHex } from '../src/logger/FrameDisplay.js';
import { FrameLogger } from '../src/logger/FrameLogger.js';
import { makeTelemetry, makeFrame, ProtocolEncoder } from '../src/protocol/ProtocolEncoder.js';
import { MSG, TYPE } from '../src/protocol/ProtocolConstants.js';
const data = bytes => formatFrameForDisplay(bytes).filter(s => s.type === 'data');
describe('log-only protocol grouping', () => {
  it('telemetry uses header/fields/count and exactly six bytes per parameter', () => {
    const bytes = makeTelemetry(0x9f, [{ sourceId: 1, type: TYPE.INT32, value: -42 }, { sourceId: 0x20, type: TYPE.FLOAT32, value: 1 }]);
    const before = [...bytes], groups = data(bytes);
    expect(groups.map(s => s.text)).toEqual(['A5 5A', '01', '01', '9F 00', '0D 00', '02', '01 01 D6 FF FF FF', '20 05 00 00 80 3F', toHex(bytes.slice(-2))]);
    expect(groups[6].label).toContain('Parameter 0'); expect(groups.at(-1).label).toBe('CRC16');
    expect([...bytes]).toEqual(before); expect(groups.map(s => s.text).join(' ')).toBe(toHex(bytes));
    expect(formatFrameForDisplay(bytes).filter(s => s.type === 'separator')).toHaveLength(groups.length - 1);
  });
  it('SET_PARAM payload stays one parameter group and raw HEX never contains commas', () => {
    const bytes = new ProtocolEncoder(0x23).setParam(0x20, TYPE.FLOAT32, 0.25).bytes;
    expect(data(bytes).map(s => s.text)).toEqual(['A5 5A', '01', '10', '23 00', '06 00', '20 05 00 00 80 3E', '97 3E']);
    const entry = new FrameLogger().add('TX', 'SET_PARAM', bytes);
    expect(entry.hex).toBe(toHex(bytes)); expect(entry.hex).not.toContain(',');
    bytes.fill(0); expect(entry.hex).toContain('20 05 00 00 80 3E'); expect(entry.segments[0].text).toBe('A5 5A');
  });
  it('unknown messages get an opaque payload; zero-count and max-count stay bounded', () => {
    expect(data(makeFrame(0x55, 0, Uint8Array.of(1, 2, 3)))[5]).toMatchObject({ text: '01 02 03', label: 'Payload' });
    expect(data(makeTelemetry(0, []))).toHaveLength(7);
    const bytes = makeTelemetry(0, Array.from({ length: 255 }, (_, sourceId) => ({ sourceId, type: TYPE.INT32, value: 0 })));
    expect(data(bytes)).toHaveLength(262); expect(data(bytes).map(s => s.text).join(' ')).toBe(toHex(bytes));
  });
  it.each([undefined, [], [0xa5, 0x5a], [0xa5, 0x5a, 2, 1, 0, 0, 1, 0, 0, 0, 0],
    [0xa5, 0x5a, 1, MSG.TELEMETRY, 0, 0, 1, 0, 2, 0, 0], [0xa5, 0x5a, 1, MSG.SET_PARAM, 0, 0, 1, 0, 2, 0, 0]])('malformed frame safely falls back %s', bytes => {
    expect(formatFrameForDisplay(bytes)).toEqual([{ type: 'data', text: toHex(bytes), label: 'Raw HEX' }]);
  });
  it('CRC diagnostics retain corrupt bytes without claiming validation', () => {
    const bytes = makeTelemetry(0, [{ sourceId: 1, type: TYPE.INT32, value: 0 }]); bytes[bytes.length - 1] ^= 0x80;
    expect(data(bytes).map(s => s.text).join(' ')).toBe(toHex(bytes));
  });
});
