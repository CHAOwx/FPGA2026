/**
 * Responsibility: Bounded communication records and raw-HEX formatting.
 * Allowed dependencies: Events, FrameDisplay.
 * Forbidden responsibilities: Parsing UART, experimental sample storage.
 * Public API: add(), filtered(), clear(), revision.
 * Architecture invariants: At most capacity log records, independent of recording.
 */
import { Events } from '../core/Events.js';
import { toHex, formatFrameForDisplay } from './FrameDisplay.js';
export { toHex } from './FrameDisplay.js';
export class FrameLogger extends Events {
  constructor(capacity = 2000) { super(); this.capacity = capacity; this.entries = []; this.revision = 0; }
  add(direction, summary, bytes) {
    const entry = { time: new Date().toISOString(), direction, summary, hex: toHex(bytes), segments: formatFrameForDisplay(bytes) };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this.revision++; return entry;
  }
  filtered(filters, limit = 150) { return this.entries.filter(e => filters.includes(e.direction)).slice(-limit); }
  clear() { this.entries = []; this.revision++; }
}
