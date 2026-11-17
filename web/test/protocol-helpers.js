// Shared by the protocol tests: the vectors, the generated data, and key handles made from the
// vectors' fixed test seeds (SHA-256 of phrases, never a real key). Production code never sees
// a seed; only tests build a handle this way.
import { readFileSync } from 'node:fs';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex } from '../lib/bytes.js';

export const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));

export const data = (name) => JSON.parse(readFileSync(new URL(`../lib/data/${name}.json`, import.meta.url), 'utf8'));

export const ownerHandle = () => keyFromSeed(fromHex(V.seed));
export const nodeHandle = () => keyFromSeed(fromHex(V.node_seed));
