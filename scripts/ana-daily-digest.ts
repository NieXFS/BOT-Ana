/**
 * Digest diário scrubbado das conversas da Ana — insumo da rotina de melhoria na nuvem.
 *
 * Extrai as últimas 24h de conversas dos tenants AUTORIZADOS (allowlist explícita:
 * autorização da dona registrada pelo Victor; NUNCA adicionar tenant sem isso),
 * scrubba PII com o scrubText canônico (nome de perfil/telefone nunca saem daqui),
 * cruza com os recibos de turno (rota, fallback, boundary, gate) e escreve
 * analysis/ana-daily/YYYY-MM-DD.md. O commit/push é responsabilidade do cron
 * (ver bloco no docs/features/crons.md).
 *
 * Uso: npx tsx --env-file=.env scripts/ana-daily-digest.ts [--date YYYY-MM-DD]
 */
import { Pool } from 'pg';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { scrubText } from '../src/observability/scrub';
import {
  buildProviderStatusDigestV2,
  projectProviderStatusForDigestDayV2,
  type ProviderDeliveryStatusV2,
} from '../src/services/conversationalV2/providerStatus';

// Autorização registrada: Jackeline (tia do Victor) em 2026-08-17, verbal ao Victor;
// studio-viti é tenant de teste do próprio Victor. Rose: SEM autorização — fora.
const AUTHORIZED_TENANTS: Record<string, string> = {
  '861272377075210': 'centro-estetico-jackeline-hussar',
  '1104061759449838': 'studio-viti',
};

const dateArg = process.argv.indexOf('--date');
const targetDay =
  dateArg > -1
    ? process.argv[dateArg + 1]
    : new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);

const pool = new Pool({
  connectionString:
    process.env.RECEPS_IA_DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
});

function anonKey(conversationKey: string): string {
  // cliente vira c-<4 hex estáveis por dia> — nunca o telefone.
  const phone = conversationKey.split(':')[1] ?? '';
  let h = 0;
  const salted = `${targetDay}:${phone}`;
  for (let i = 0; i < salted.length; i++) h = (h * 31 + salted.charCodeAt(i)) >>> 0;
  return `c-${h.toString(16).slice(0, 4)}`;
}

async function main() {
  const pnids = Object.keys(AUTHORIZED_TENANTS);
  const { rows: messages } = await pool.query(
    `SELECT "conversationKey" ck, role, content, "createdAt"
     FROM ana_conversation_history
     WHERE "createdAt" >= $1::date AND "createdAt" < ($1::date + interval '1 day')
       AND split_part("conversationKey", ':', 1) = ANY($2)
     ORDER BY "conversationKey", "createdAt"`,
    [targetDay, pnids]
  );

  const { rows: receipts } = await pool.query(
    `SELECT receipt_json rj
     FROM ana_v2_turn_receipts
     WHERE receipt_kind = 'plan'
       AND created_at >= $1::date AND created_at < ($1::date + interval '1 day')`,
    [targetDay]
  );

  // Aceitação do POST e status assíncrono são autoridades distintas. O
  // snapshot do outbox conta aceites mesmo quando ainda não houve callback;
  // a projeção de status nunca transforma accepted+failed em delivered.
  const { rows: deliveryRows } = await pool.query(
    `SELECT state, provider_status, provider_status_at, provider_failure_code,
            NULLIF(commit_payload_json->'deliveryReceipt'->>'terminalAt', '')::timestamptz
              AS accepted_at
       FROM ana_v2_outbound_outbox
      WHERE state IN ('accepted_by_provider', 'accepted_uncommitted')
        AND (
          (
            NULLIF(commit_payload_json->'deliveryReceipt'->>'terminalAt', '')::timestamptz
              >= $1::date
            AND NULLIF(commit_payload_json->'deliveryReceipt'->>'terminalAt', '')::timestamptz
              < ($1::date + interval '1 day')
          )
          OR (
            provider_status_at >= $1::date
            AND provider_status_at < ($1::date + interval '1 day')
          )
        )`,
    [targetDay]
  );
  const deliveryDigest = buildProviderStatusDigestV2(
    deliveryRows.map((row) =>
      projectProviderStatusForDigestDayV2(
        {
          acceptedAt: row.accepted_at ?? null,
          providerStatus: (row.provider_status ?? null) as ProviderDeliveryStatusV2 | null,
          providerStatusAt: row.provider_status_at ?? null,
          providerFailureCode:
            typeof row.provider_failure_code === 'string'
              ? row.provider_failure_code
              : null,
        },
        targetDay
      )
    )
  );

  const stats = {
    turns: 0,
    fastPath: 0,
    model: 0,
    fallback: 0,
    regen: 0,
    boundaryBlocks: {} as Record<string, number>,
    gateDeclines: {} as Record<string, number>,
  };
  for (const { rj } of receipts) {
    stats.turns++;
    const route = String(rj.route ?? '');
    if (route.includes('fast_path')) stats.fastPath++;
    else if (route === 'fallback') stats.fallback++;
    else if (route === 'regen') stats.regen++;
    else stats.model++;
    for (const a of rj.boundaryAttempts ?? [])
      for (const r of a.reasonCodes ?? [])
        stats.boundaryBlocks[r] = (stats.boundaryBlocks[r] ?? 0) + 1;
    const g = rj.gateDecline?.reason;
    if (g) stats.gateDeclines[g] = (stats.gateDeclines[g] ?? 0) + 1;
  }

  const byConv = new Map<string, typeof messages>();
  for (const m of messages) {
    if (!byConv.has(m.ck)) byConv.set(m.ck, []);
    byConv.get(m.ck)!.push(m);
  }

  const lines: string[] = [];
  lines.push(`# Digest diário Ana — ${targetDay}`);
  lines.push('');
  lines.push(
    `Tenants autorizados: ${Object.values(AUTHORIZED_TENANTS).join(', ')}. ` +
      'Conteúdo scrubbado (scrubText canônico); clientes anonimizados por hash diário.'
  );
  lines.push('');
  lines.push('## Métricas de turno (recibos v2, todos os tenants v2 do dia)');
  lines.push('');
  lines.push(
    `- turnos: ${stats.turns} · fast-path: ${stats.fastPath} · modelo: ${stats.model} · regen: ${stats.regen} · fallback: ${stats.fallback}`
  );
  lines.push(
    `- bloqueios de fronteira: ${JSON.stringify(stats.boundaryBlocks)}`
  );
  lines.push(`- gate declines: ${JSON.stringify(stats.gateDeclines)}`);
  lines.push('');
  lines.push('## Entrega WhatsApp (aceite e status assíncrono)');
  lines.push('');
  lines.push(
    `- accepted_by_provider: ${deliveryDigest.acceptedByProvider} · sent: ${deliveryDigest.sent} · delivered: ${deliveryDigest.delivered} · read: ${deliveryDigest.read} · failed: ${deliveryDigest.failed} · awaiting_status: ${deliveryDigest.awaitingStatus}`
  );
  lines.push(
    `- failures por código: ${JSON.stringify(deliveryDigest.failuresByCode)}`
  );
  lines.push('');
  lines.push(`## Conversas (${byConv.size})`);
  for (const [ck, msgs] of byConv) {
    const tenant = AUTHORIZED_TENANTS[ck.split(':')[0]];
    lines.push('');
    lines.push(`### ${tenant} · cliente ${anonKey(ck)} · ${msgs.length} mensagens`);
    lines.push('');
    for (const m of msgs) {
      let text = m.content as string;
      if (text.startsWith('[catalogo-licenciado] ')) {
        try {
          text = JSON.parse(text.slice('[catalogo-licenciado] '.length)).visibleText;
        } catch {
          /* envelope ilegível fica como está — ainda passa pelo scrub */
        }
      }
      const who = m.role === 'user' ? 'CLIENTE' : m.role === 'assistant' ? 'ANA' : m.role;
      lines.push(`- **${who}** (${new Date(m.createdAt).toISOString().slice(11, 16)}): ${scrubText(text).replace(/\n/g, ' ')}`);
    }
  }
  lines.push('');

  const dir = join(process.cwd(), 'analysis', 'ana-daily');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${targetDay}.md`);
  writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(`[digest] ${file} | conversas=${byConv.size} turnos=${stats.turns}`);
  await pool.end();
}

main().catch((e) => {
  console.error('[digest] ERRO:', e?.message ?? e);
  process.exit(1);
});
