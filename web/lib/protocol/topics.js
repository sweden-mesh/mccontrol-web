// Topics: command, result, broadcast, registration. A node is named by the first eight hex of
// its public key; from ar-11 its topics carry the whole key (envelope.py, topic_leaf).
import { KEY_HEX_LEN, NODE_HEX_LEN, REGISTER_TOPIC, TOPIC_PREFIX } from './constants.js';

function hexText(value) {
  const text = (value || '').trim().toUpperCase();
  if (/[^0-9A-F]/.test(text)) throw new Error('a node is named by the hex of its public key');
  return text;
}

// Eight upper-case hex characters, from a prefix or a whole public key.
export function nodeId(value) {
  const text = hexText(value);
  if (text.length < NODE_HEX_LEN) {
    throw new Error('a node is named by the first 8 hex characters of its public key');
  }
  return text.slice(0, NODE_HEX_LEN);
}

// The whole key, 64 upper-case hex, or null when only a prefix was given.
export function nodeKey(value) {
  const text = hexText(value);
  return text.length === KEY_HEX_LEN ? text : null;
}

// What names the node on its topics: the whole key when known, else the id.
export function topicLeaf(node, key = null) {
  const full = key ? nodeKey(key) : nodeKey(node);
  return full || nodeId(node);
}

// One node's command topic, or the region's broadcast topic when `node` is not given.
export function commandTopic(iata, node = null, key = null) {
  const leaf = node ? topicLeaf(node, key) : 'all';
  return `${TOPIC_PREFIX}${iata.toUpperCase()}/${leaf}/cmd`;
}

export const broadcastTopic = (iata) => commandTopic(iata);

export function resultTopic(iata, node, key = null) {
  return `${TOPIC_PREFIX}${iata.toUpperCase()}/${topicLeaf(node, key)}/res`;
}

// Every result topic in a region, for discovery.
export const regionResultTopics = (iata) => `${TOPIC_PREFIX}${iata.toUpperCase()}/+/res`;

// The leaf of a result topic as published: 8 or 64 upper-case hex, or null.
export function nodeFromResultTopic(topic) {
  const parts = (topic || '').split('/');
  if (parts.length < 3 || parts[parts.length - 1] !== 'res') return null;
  const leaf = parts[parts.length - 2].toUpperCase();
  if ((leaf.length !== NODE_HEX_LEN && leaf.length !== KEY_HEX_LEN) || /[^0-9A-F]/.test(leaf)) return null;
  return leaf;
}

// The command topic a result topic answers for (a v2 key is derived from it).
export function commandTopicOf(topic) {
  if (!topic || !topic.endsWith('/res')) return null;
  return `${topic.slice(0, -'res'.length)}cmd`;
}

export { REGISTER_TOPIC };
export const registerAckTopic = (publicHex) => `${REGISTER_TOPIC}/${publicHex.toUpperCase()}/ack`;
