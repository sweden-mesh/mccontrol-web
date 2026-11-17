// Registering the signing key with the command broker: the public key, published once to
// mccontrol/register as a line signed by that very key; the broker answers `ok` or
// `refused <reason>` on mccontrol/register/<64 hex key>/ack (topics.registerAckTopic).
import { toHex } from '../bytes.js';
import { FIELD_SEP, REGISTER_TOPIC, REGISTER_VERSION } from './constants.js';
import { signedMessage } from './envelope.js';

const nowSecs = () => Math.floor(Date.now() / 1000);

// reg1|<64 hex public key>|<unix secs>|<128 hex Ed25519 over "mccontrol/register\n" + the rest>
export function registerPayload(handle, { now = nowSecs() } = {}) {
  const part = `${REGISTER_VERSION}${FIELD_SEP}${handle.publicKeyHex}${FIELD_SEP}${now}`;
  const signature = toHex(handle.sign(signedMessage(REGISTER_TOPIC, part)), true);
  return `${part}${FIELD_SEP}${signature}`;
}
