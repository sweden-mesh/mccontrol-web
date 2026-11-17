// The protocol's fixed numbers and tags. They are the firmware's, as envelope.py states them;
// test/protocol-envelope.test.js pins every one to lib/data/protocol.json, so a change in Python
// that is not made here turns the tests red.
export const TOPIC_PREFIX = 'meshcore/';
export const FIELD_SEP = '|';
export const V1 = 'v1';
export const V2 = 'v2';
export const R1 = 'r1';
export const R2 = 'r2';
export const R3 = 'r3';
export const SIG_HEX_LEN = 128;
export const MAX_PAYLOAD = 512;
export const MAX_TOPIC = 160;
export const MAX_COMMAND = 160;
export const MAX_FUTURE_SECS = 3600;
export const DEFAULT_TTL_SECS = 300;
export const NODE_HEX_LEN = 8;
export const KEY_HEX_LEN = 64;
export const V2_INFO = 'mccontrol-v2|';
export const V2_COMMAND_PADS = Object.freeze([64, 160]);
export const R3_PADS = Object.freeze([256, 512]);
export const TAG_LEN = 16;
export const DIR_COMMAND = 0x00;
export const DIR_RESULT = 0x01;
export const REGISTER_TOPIC = 'mccontrol/register';
export const REGISTER_VERSION = 'reg1';
export const TOKEN = Object.freeze({ username_prefix: 'v1_', lifetime_secs: 86400, client: 'mccontrol' });
