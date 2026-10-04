/**
 * Responsibility: Sole live-channel state, bounded samples and sequence diagnostics.
 * Allowed dependencies: Events, ConfigStore, Constants.
 * Forbidden responsibilities: SerialPort, byte parsing, Q conversion, database writes, chart.
 * Public API: ingest(), configure(), resetTimeline(), channels, stats, frame/config/discover events.
 * Architecture invariants: Hidden channels retain samples; every accepted frame reaches recorder.
 */
import { Events } from '../core/Events.js';
import { PALETTE, validateChannel } from './ConfigStore.js';
import { hexId } from '../protocol/ProtocolConstants.js';
export class RingBuffer {
  constructor(capacity = 20000) { this.capacity = capacity; this.data = new Array(capacity); this.head = 0; this.size = 0; }
  push(point) { this.data[this.head] = point; this.head = (this.head + 1) % this.capacity; this.size = Math.min(this.size + 1, this.capacity); }
  values(min = -Infinity, max = Infinity) {
    const result = [];
    for (let i = 0; i < this.size; i++) {
      const p = this.data[(this.head - this.size + i + this.capacity) % this.capacity];
      if (p.time >= min && p.time <= max) result.push(p);
    }
    return result;
  }
}
export function channelConfig(channel) {
  return Object.fromEntries(['name', 'unit', 'visible', 'color', 'axis', 'writable', 'sliderMin', 'sliderMax', 'sliderStep'].map(k => [k, channel[k]]));
}
export class ChannelStore extends Events {
  constructor(config, capacity = 20000) {
    super(); this.config = config; this.capacity = capacity; this.channels = new Map();
    this.resetTimeline();
  }
  resetTimeline(start = performance.now()) {
    this.started = start; this.latestTime = 0;
    this.stats = { frames: 0, tx: 0, seq: null, lost: 0, crc: 0, format: 0, duplicates: 0, reordered: 0 };
    for (const c of this.channels.values()) {
      c.points = new RingBuffer(this.capacity); c.value = null; c.rawValue = null; c.rawBits = null; c.requested = null; c.seen = false;
    }
  }
  ingest(frame) {
    const time = Math.max(0, (frame.hostReceiveTime - this.started) / 1000);
    const previous = this.stats.seq;
    if (previous !== null) {
      const delta = (frame.seq - previous + 65536) % 65536;
      if (!delta) this.stats.duplicates++;
      else if (delta < 32768) this.stats.lost += delta - 1;
      else this.stats.reordered++;
      if (delta && delta < 32768) this.stats.seq = frame.seq;
    } else this.stats.seq = frame.seq;
    this.stats.frames++; this.latestTime = time;
    for (const sample of frame.samples) {
      let c = this.channels.get(sample.sourceId);
      if (!c) {
        c = { sourceId: sample.sourceId, name: `Channel ${hexId(sample.sourceId)}`, unit: '', visible: true,
          color: PALETTE[this.channels.size % PALETTE.length], axis: 'left', writable: false,
          sliderMin: 0, sliderMax: 1, sliderStep: 0.001, points: new RingBuffer(this.capacity), requested: null };
        Object.assign(c, this.config.channel(sample.sourceId));
        this.channels.set(sample.sourceId, c);
        this.config.saveChannel(sample.sourceId, channelConfig(c));
        this.emit('discover', c);
      }
      Object.assign(c, sample, { seen: true });
      c.points.push({ time, value: sample.value, seq: frame.seq, rawValue: sample.rawValue, type: sample.type });
      if (c.requested) c.requested.synced = c.requested.rawBits === sample.rawBits && c.requested.type === sample.type;
    }
    this.emit('frame', { time, seq: frame.seq, hostReceiveTime: frame.hostReceiveTime, samples: frame.samples });
  }
  configure(id, patch) {
    const c = this.channels.get(id);
    if (!c) throw new Error('Channel not found');
    const next = validateChannel({ ...channelConfig(c), ...patch });
    Object.assign(c, next); this.config.saveChannel(id, next); this.emit('config', c);
  }
}
