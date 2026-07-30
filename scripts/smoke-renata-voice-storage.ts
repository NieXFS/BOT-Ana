/**
 * Smoke determinístico do cache, preferência reversível e custo. Query fakes;
 * sem Postgres real.
 */
process.env.DATABASE_URL ||= 'postgres://smoke:smoke@127.0.0.1:1/smoke';

import type { CostMeterDeps } from '../src/voice/costMeter';
import type { TtsCacheQuery } from '../src/voice/ttsCache';
import type { ChannelPrefQuery } from '../src/voice/channelPref';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  const cache = await import('../src/voice/ttsCache');
  const cost = await import('../src/voice/costMeter');
  const prefs = await import('../src/voice/channelPref');

  console.log('▶ cache raw pg');
  const cacheCalls: Array<{ text: string; params?: unknown[] }> = [];
  const cacheQuery: TtsCacheQuery = async (text, params) => {
    cacheCalls.push({ text, params });
    if (text.includes('SELECT text_hash')) {
      return {
        rows: [{
          text_hash: 'hash',
          voice_fingerprint: 'fp',
          ogg_bytes: Buffer.from('ogg'),
          media_id: 'MID',
          media_uploaded_at: new Date('2026-07-23T12:00:00.000Z'),
          hit_count: 2,
          created_at: new Date('2026-07-23T11:00:00.000Z'),
        }],
      };
    }
    return { rows: [], rowCount: 1 };
  };
  const row = await cache.lookup('hash', 'fp', cacheQuery);
  check('lookup mapeia bytea/media', row?.oggBytes.toString() === 'ogg' && row.mediaId === 'MID');
  check('hit_count incrementado em hit', cacheCalls.some((call) => call.text.includes('hit_count = hit_count + 1')));
  await cache.saveNew('hash', 'fp', Buffer.from('new'), 'MID2', cacheQuery);
  check('save usa ON CONFLICT', cacheCalls.some((call) => call.text.includes('ON CONFLICT (text_hash, voice_fingerprint)')));
  await cache.refreshMediaId('hash', 'fp', 'MID3', cacheQuery);
  check('refresh atualiza media_uploaded_at', cacheCalls.some((call) => call.text.includes('media_uploaded_at = now()')));

  const now = new Date('2026-07-23T12:00:00.000Z').getTime();
  check(
    'media com 24d é fresco',
    cache.isMediaFresh({ mediaId: 'x', mediaUploadedAt: new Date(now - 24 * 86400_000) }, now)
  );
  check(
    'media com 26d é velho',
    !cache.isMediaFresh({ mediaId: 'x', mediaUploadedAt: new Date(now - 26 * 86400_000) }, now)
  );

  console.log('▶ custo + alarme 80% uma vez');
  const state = {
    elevenlabs: {
      chars: 0,
      audioTokens: 0,
      audioSeconds: 0,
      hits: 0,
      misses: 0,
      alerted: false,
    },
    gemini: {
      chars: 0,
      audioTokens: 0,
      audioSeconds: 0,
      hits: 0,
      misses: 0,
      alerted: false,
    },
  };
  let warnings = 0;
  const meterDeps: CostMeterDeps = {
    query: async (text, params) => {
      const provider = String(params?.[1] ?? 'elevenlabs') as keyof typeof state;
      const providerState = state[provider];
      if (text.includes('INSERT INTO tts_daily_usage') && text.includes('hits')) {
        providerState.hits += 1;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO tts_daily_usage') && text.includes('misses')) {
        providerState.chars += Number(params?.[2] ?? 0);
        providerState.audioTokens += Number(params?.[3] ?? 0);
        providerState.audioSeconds += Number(params?.[4] ?? 0);
        providerState.misses += 1;
        return {
          rows: [{
            chars: providerState.chars,
            audio_seconds: providerState.audioSeconds,
            alerted: providerState.alerted,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SET alerted = true')) {
        if (providerState.alerted) return { rows: [], rowCount: 0 };
        providerState.alerted = true;
        return { rows: [{ day: params?.[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    captureBudgetWarning: () => {
      warnings += 1;
    },
  };
  const day = '2026-07-23';
  await cost.recordHit(day, 'elevenlabs', meterDeps);
  await cost.recordMiss(day, 'elevenlabs', 40, 100, undefined, meterDeps);
  await cost.recordMiss(day, 'elevenlabs', 40, 100, undefined, meterDeps);
  await cost.recordMiss(day, 'elevenlabs', 10, 100, undefined, meterDeps);
  check(
    'hit não soma chars',
    state.elevenlabs.hits === 1 && state.elevenlabs.chars === 90
  );
  check('misses contados', state.elevenlabs.misses === 3);
  check(
    'ElevenLabs mantém audio_tokens/audio_seconds em zero e régua por chars',
    state.elevenlabs.audioTokens === 0 &&
      state.elevenlabs.audioSeconds === 0
  );
  check(
    'alarme exatamente 1x/dia',
    warnings === 1 && state.elevenlabs.alerted
  );
  check(
    'dayKey civil SP na borda UTC',
    cost.dayKey(new Date('2026-07-24T02:30:00.000Z')) === '2026-07-23'
  );

  console.log('▶ preferência reversível');
  let prefersText = false;
  const prefQuery: ChannelPrefQuery = async (text, params) => {
    if (text.includes('INSERT INTO renata_channel_prefs')) {
      prefersText = Boolean(params?.[1]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SELECT prefers_text')) {
      return { rows: [{ prefers_text: prefersText }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  await prefs.setChannelPref('PN:lead', true, prefQuery);
  check('set text persiste true', await prefs.getChannelPref('PN:lead', prefQuery));
  await prefs.setChannelPref('PN:lead', false, prefQuery);
  check('pedido de áudio reverte pra false', !(await prefs.getChannelPref('PN:lead', prefQuery)));

  if (failures) process.exit(1);
  console.log('\n✅ smoke-renata-voice-storage OK');
}

main().catch((error) => {
  console.error('❌ smoke falhou:', error);
  process.exit(1);
});
