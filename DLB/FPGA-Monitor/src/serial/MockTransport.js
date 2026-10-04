/**
 * Responsibility: Deterministic 50 Hz mock byte transport and SET_PARAM echo through Telemetry.
 * Allowed dependencies: Events, protocol modules (mock device only).
 * Forbidden responsibilities: DOM, default business names or writable configuration.
 * Public API: open(), close(), write(), injectCRCError(); same events as SerialTransport.
 * Architecture invariants: Demo data enters the real stream decoder, including split headers.
 */
import { Events } from '../core/Events.js';
import { makeTelemetry } from '../protocol/ProtocolEncoder.js';
import { MSG, TYPE } from '../protocol/ProtocolConstants.js';
import { crc16 } from '../protocol/CRC16.js';
export class MockTransport extends Events {
  connected = false;
  portLabel = 'Demo · virtual UART';
  async open() {
    this.seq = 0; this.tick = 0; this.overrides = new Map(); this.connected = true;
    this.emit('state', 'Connected'); this.timer = setInterval(() => this.produce(), 20);
  }
  produce(corrupt = false) {
    const t = this.tick++ / 50;
    const step = Math.floor(t / 4) % 2 ? 1000 : 0;
    const samples = [
      { sourceId: 1, type: 1, value: step },
      { sourceId: 2, type: 1, value: Math.round(step + 180 * Math.sin(t * 3)) },
      { sourceId: 3, type: 1, value: Math.round(180 * Math.exp(-(t % 4)) * Math.cos(t * 6)) },
      { sourceId: 0x10, type: 3, value: 0.25 },
      { sourceId: 0x11, type: 3, value: 0.2 },
      { sourceId: 0x12, type: 3, value: -0.05 },
      { sourceId: 0x20, type: TYPE.FLOAT32, value: Math.sin(t * 0.8) },
    ].map(s => this.overrides.has(s.sourceId) ? { ...s, ...this.overrides.get(s.sourceId) } : s);
    const frame = makeTelemetry(this.seq++ & 0xffff, samples);
    if (corrupt) frame[frame.length - 1] ^= 0x80;
    const split = this.tick % (frame.length - 1) + 1;
    this.emit('bytes', frame.subarray(0, split)); this.emit('bytes', frame.subarray(split));
  }
  async write(bytes) {
    if (!this.connected) throw new Error('Demo 未连接');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length !== 16 || bytes[0] !== 0xa5 || bytes[1] !== 0x5a || bytes[2] !== 1 || bytes[3] !== MSG.SET_PARAM || view.getUint16(6, true) !== 6 || crc16(bytes.subarray(2, -2)) !== view.getUint16(14, true)) throw new Error('Mock rejected invalid SET_PARAM');
    this.overrides.set(bytes[8], { type: bytes[9], rawBits: view.getUint32(10, true) });
  }
  injectCRCError() { if (this.connected) this.produce(true); }
  async close() { clearInterval(this.timer); this.connected = false; this.emit('state', 'Disconnected'); }
}
