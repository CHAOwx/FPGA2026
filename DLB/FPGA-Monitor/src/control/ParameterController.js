/**
 * Responsibility: Validate writable edits, throttle drag requests and track Telemetry synchronization.
 * Allowed dependencies: ChannelStore, ValueCodec, ProtocolEncoder, injected transport and logger.
 * Forbidden responsibilities: SerialPort access, byte construction, business names, chart.
 * Public API: send(), drag(), finish(), cancel(); control UI calls these with human values.
 * Architecture invariants: At most one drag send per 50 ms; final edit sends immediately; no ACK invented.
 */
import { encode, decode, rawText, typeName } from '../protocol/ValueCodec.js';
import { hexId } from '../protocol/ProtocolConstants.js';
export class ParameterController {
  constructor(store, encoder, getTransport, logger, onError) {
    Object.assign(this, { store, encoder, getTransport, logger, onError }); this.drags = new Map();
  }
  validate(id, value) {
    const c = this.store.channels.get(id);
    if (!c?.writable || !c.seen) throw new Error('通道不可写或当前连接尚未发现该通道');
    if (!Number.isFinite(value) || value < c.sliderMin || value > c.sliderMax) throw new Error('输入超出 Slider 范围或不是有限数值');
    encode(c.type, value); return c;
  }
  async send(id, value) {
    const c = this.validate(id, value); const transport = this.getTransport();
    if (!transport?.connected) throw new Error('请先连接串口或 Demo');
    const encoded = this.encoder.setParam(id, c.type, value);
    const target = { value: decode(c.type, encoded.rawBits), rawBits: encoded.rawBits, type: c.type, at: performance.now(), synced: false };
    c.requested = target;
    try {
      await transport.write(encoded.bytes); this.store.stats.tx++;
      this.logger.add('TX', `SET_PARAM SEQ=${encoded.seq} ID=${hexId(id)} TYPE=${typeName(c.type)} RAW=${rawText(c.type, encoded.rawBits)} VALUE=${target.value}`, encoded.bytes);
    } catch (error) { if (c.requested === target) c.requested = null; throw error; }
  }
  drag(id, value) {
    this.validate(id, value);
    const d = this.drags.get(id) ?? { last: -Infinity };
    d.value = value; this.drags.set(id, d);
    const elapsed = performance.now() - d.last;
    const fire = () => { d.timer = null; d.last = performance.now(); this.send(id, d.value).catch(this.onError); };
    if (elapsed >= 50) { clearTimeout(d.timer); fire(); }
    else if (!d.timer) d.timer = setTimeout(fire, 50 - elapsed);
  }
  finish(id, value) { const d = this.drags.get(id); clearTimeout(d?.timer); this.drags.delete(id); return this.send(id, value); }
  cancel() { for (const d of this.drags.values()) clearTimeout(d.timer); this.drags.clear(); }
}
