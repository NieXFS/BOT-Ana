import 'dotenv/config';
import { resolveAnaRuntimeConfig } from '../src/runtimePolicy';

async function main(): Promise<void> {
  const runtime = resolveAnaRuntimeConfig(process.env);
  if (runtime.mode !== 'lab') {
    throw new Error('Bootstrap de schema só é permitido em ANA_RUNTIME_MODE=lab.');
  }

  const [
    labSchema,
    processed,
    wave2,
    silentHold,
    v2State,
    salesFollowups,
    ttsCache,
    ttsUsage,
    channelPrefs,
    mediaCache,
  ] = await Promise.all([
    import('../src/services/labSchema'),
    import('../src/services/processedMessages'),
    import('../src/services/anaWave2Store'),
    import('../src/services/silentEscalationHold'),
    import('../src/services/conversationalV2/stateStore'),
    import('../src/services/salesFollowups'),
    import('../src/voice/ttsCache'),
    import('../src/voice/costMeter'),
    import('../src/voice/channelPref'),
    import('../src/media/mediaCache'),
  ]);

  await labSchema.assertLabStorageEmpty();
  await processed.ensureProcessedMessagesTable();
  await wave2.ensureAnaWave2Tables();
  await silentHold.ensureSilentEscalationHoldTable();
  await v2State.ensureConversationalV2Tables();
  await salesFollowups.ensureSalesFollowupsTable();
  await ttsCache.ensureTtsCacheTable();
  await ttsUsage.ensureTtsUsageTable();
  await channelPrefs.ensureChannelPrefsTable();
  await mediaCache.ensureMediaCacheTable();
  await labSchema.writeLabSchemaMarker(runtime.databaseFingerprint);
  await labSchema.validateLabSchema(runtime.databaseFingerprint);

  console.log('bootstrap-ana-lab-schema: ok');
}

void main().catch((error) => {
  console.error(
    `bootstrap-ana-lab-schema: failed | error_kind=${
      error instanceof Error ? error.name : typeof error
    }`
  );
  process.exitCode = 1;
});
