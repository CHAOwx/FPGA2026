/**
 * Responsibility: Pure HEX display segments for Protocol V1 field boundaries.
 * Allowed dependencies: ProtocolConstants.
 * Forbidden responsibilities: Stream decoding, CRC validation, value conversion, DOM, mutation.
 * Public API: toHex(), formatFrameForDisplay(bytes).
 * Architecture invariants: Separators are presentation only; malformed input falls back to raw HEX.
 */
import { VERSION, MSG } from '../protocol/ProtocolConstants.js';
export const toHex = bytes => Array.from(bytes ?? [], b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

// Add future message layouts here; unknown payloads remain one opaque group.
const payloadGroups = new Map([
  [MSG.TELEMETRY, bytes => {
    const count = bytes[8], length = bytes.length - 10;
    if (length !== 1 + count * 6) return null;
    return [[8, 9, 'Count'], ...Array.from({ length: count }, (_, i) => [9 + i * 6, 15 + i * 6, `Parameter ${i} · ID / Type / Value`])];
  }],
  [MSG.SET_PARAM, bytes => bytes.length === 16 ? [[8, 14, 'Parameter · ID / Type / Value']] : null],
]);
export function formatFrameForDisplay(bytes) {
  const raw = () => [{ type: 'data', text: toHex(bytes), label: 'Raw HEX' }];
  if (!bytes || bytes.length < 10 || bytes[0] !== 0xa5 || bytes[1] !== 0x5a || bytes[2] !== VERSION) return raw();
  const length = bytes[6] | bytes[7] << 8;
  if (bytes.length !== length + 10) return raw();
  const layout = payloadGroups.get(bytes[3]);
  const payload = layout ? layout(bytes) : length ? [[8, bytes.length - 2, 'Payload']] : [];
  if (!payload) return raw();
  const message = bytes[3] === MSG.TELEMETRY ? 'TELEMETRY' : bytes[3] === MSG.SET_PARAM ? 'SET_PARAM' : 'Message Type';
  const groups = [[0, 2, 'Header'], [2, 3, 'Version'], [3, 4, message], [4, 6, 'SEQ'], [6, 8, 'Payload Length'],
    ...payload, [bytes.length - 2, bytes.length, 'CRC16']];
  return groups.flatMap(([start, end, label], i) => [
    ...(i ? [{ type: 'separator', text: ', ' }] : []),
    { type: 'data', text: toHex(bytes.slice(start, end)), label },
  ]);
}
