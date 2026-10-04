/**
 * Responsibility: Protocol V1 constants and display identifiers.
 * Allowed dependencies: None.
 * Forbidden responsibilities: Business names for parameter IDs, conversion, UI.
 * Public API: VERSION, MSG, TYPE, MAX_PAYLOAD, hexId().
 * Architecture invariants: PARAM_ID is only a machine identity.
 */
export const VERSION = 1;
export const MSG = Object.freeze({ TELEMETRY: 1, SET_PARAM: 0x10 });
export const TYPE = Object.freeze({ INT32: 1, UINT32: 2, Q16_16: 3, Q8_24: 4, FLOAT32: 0x05 });
export const MAX_PAYLOAD = 1531;
export const hexId = id => `0x${id.toString(16).padStart(2, '0').toUpperCase()}`;
