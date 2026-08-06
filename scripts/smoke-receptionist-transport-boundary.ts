import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const messageHandler = readFileSync(resolve(root, 'src/messageHandler.ts'), 'utf8');
const optOut = readFileSync(resolve(root, 'src/services/optOutService.ts'), 'utf8');
const questionReply = readFileSync(resolve(root, 'src/services/questionReplyService.ts'), 'utf8');
assert.match(messageHandler, /validateReceptionistOutbound/);
assert.match(messageHandler, /canonicalReceptionistOutbound\(\s*'TRANSCRIPTION_FALLBACK'/);
assert.match(messageHandler, /canonicalReceptionistOutbound\(\s*'OUTSIDE_HOURS'/);
assert.match(optOut, /canonicalReceptionistOutbound\('OPT_OUT'/);
assert.match(questionReply, /validateReceptionistOutbound\(envelope\)/);
assert.match(questionReply, /transportInput\.text/);
console.log('smoke receptionist transport boundary: OK');
