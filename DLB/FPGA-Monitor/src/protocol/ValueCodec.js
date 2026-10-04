/**
 * Responsibility: The only RAW bits / signed RAW / human-value conversion boundary.
 * Allowed dependencies: ProtocolConstants.
 * Forbidden responsibilities: UART, frame layout, DOM, chart, parameter names.
 * Public API: supported(), typeName(), limits(), encode(), decode(), rawNumber(), rawText().
 * Architecture invariants: Unknown types preserve bits without guessing; encode rejects invalid values.
 */
import { TYPE, hexId } from './ProtocolConstants.js';
const formats = new Map([
  [TYPE.INT32, { name: 'INT32', scale: 1, min: -2147483648, max: 2147483647 }],
  [TYPE.UINT32, { name: 'UINT32', scale: 1, min: 0, max: 4294967295 }],
  [TYPE.Q16_16, { name: 'Q16.16', scale: 65536, min: -2147483648, max: 2147483647 }],
  [TYPE.Q8_24, { name: 'Q8.24', scale: 16777216, min: -2147483648, max: 2147483647 }],
  [TYPE.FLOAT32, { name: 'FLOAT32', scale: 1, min: -3.4028234663852886e38, max: 3.4028234663852886e38 }],
]);
export const supported = type => formats.has(type);
export const typeName = type => formats.get(type)?.name ?? `Unsupported Type ${hexId(type)}`;
export function limits(type) {
  const f = formats.get(type);
  if (!f) throw new RangeError(typeName(type));
  return { min: f.min / f.scale, max: f.max / f.scale, resolution: type === TYPE.FLOAT32 ? 2 ** -149 : 1 / f.scale };
}
export function rawNumber(type, bits) { return type === TYPE.UINT32 || type === TYPE.FLOAT32 || !supported(type) ? bits >>> 0 : bits | 0; }
export function rawText(type, bits) {
  if (bits === null || bits === undefined) return '—';
  return type === TYPE.FLOAT32 ? `0x${(bits >>> 0).toString(16).padStart(8, '0').toUpperCase()}` : String(rawNumber(type, bits));
}
export function decode(type, bits) {
  if (type === TYPE.FLOAT32) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, bits, true); return view.getFloat32(0, true);
  }
  return supported(type) ? rawNumber(type, bits) / formats.get(type).scale : null;
}
export function encode(type, value) {
  const f = formats.get(type);
  if (!f) throw new RangeError(typeName(type));
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('请输入有限数值');
  if (value < f.min / f.scale || value > f.max / f.scale) throw new RangeError('数值超出数据类型范围');
  if (type === TYPE.FLOAT32) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    if (!Number.isFinite(view.getFloat32(0, true))) throw new RangeError('量化后超出 FLOAT32 范围');
    return view.getUint32(0, true);
  }
  if (f.scale === 1 && !Number.isInteger(value)) throw new RangeError('整数类型不接受小数');
  const raw = Math.round(value * f.scale);
  if (raw < f.min || raw > f.max) throw new RangeError('量化后超出 32 bit 范围');
  return raw >>> 0;
}
