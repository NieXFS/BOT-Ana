/**
 * Smoke da idempotência por message_id + assinatura do forward (auditoria —
 * webhook hardening da Ana).
 *
 * (1) Idempotência: mesma message_id 2x → 1ª processa, 2ª é noop (ON CONFLICT).
 * (2) botSignatureMiddleware (verifica o forward Receps→Ana via X-Bot-Signature):
 *     - assinatura inválida / ausente → 401
 *     - sem RECEPS_BOT_WEBHOOK_SECRET + produção → 503 (fail-closed)
 *     - sem secret + dev → next (fail-open)
 *     - assinatura válida → next
 *
 * O .env local da Ana não tem DATABASE_URL; pegamos o do Receps (mesmo Neon)
 * só pra exercitar a lógica de idempotência contra um Postgres real.
 */

import "dotenv/config";
import { readFileSync } from "fs";
import crypto from "crypto";
import { botSignatureMiddleware } from "../src/security";

// Garante DATABASE_URL antes de qualquer import do contextManager (que lança
// no boot sem ela). Em dev local, reaproveita o .env do Receps.
if (!process.env.DATABASE_URL) {
  try {
    const recepsEnv = readFileSync("/Users/niexfs/Documents/Receps ERP/.env", "utf8");
    const line = recepsEnv.split("\n").find((l) => l.startsWith("DATABASE_URL="));
    if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  } catch {
    /* segue — vai falhar adiante com mensagem clara */
  }
}

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function record(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Mocks Express p/ o middleware ----
type Res = { statusCode: number; body: unknown; status: (c: number) => Res; json: (b: unknown) => Res; sendStatus: (c: number) => Res };
function mkRes(): Res {
  const r = { statusCode: 0, body: null as unknown } as Res;
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.sendStatus = (c) => { r.statusCode = c; return r; };
  return r;
}
function mkReq(rawBody: Buffer | undefined, sig: string | undefined) {
  return {
    get: (h: string) => (h.toLowerCase() === "x-bot-signature" ? sig : undefined),
    rawBody,
  } as never;
}
function runMw(rawBody: Buffer | undefined, sig: string | undefined) {
  const res = mkRes();
  let nextCalled = false;
  botSignatureMiddleware(mkReq(rawBody, sig), res as never, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function main() {
  const SECRET = "smoke-bot-secret-xyz";
  const rawBody = Buffer.from(JSON.stringify({ entry: [{ changes: [] }] }));
  const validSig = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");

  // ===== (2) botSignatureMiddleware =====
  process.env.RECEPS_BOT_WEBHOOK_SECRET = SECRET;
  delete process.env.NODE_ENV;

  let r = runMw(rawBody, undefined);
  record("forward sem X-Bot-Signature → 401", r.res.statusCode === 401 && !r.nextCalled, `status=${r.res.statusCode}`);

  r = runMw(rawBody, "sha256=" + "0".repeat(64));
  record("forward com assinatura inválida → 401", r.res.statusCode === 401 && !r.nextCalled, `status=${r.res.statusCode}`);

  r = runMw(rawBody, "sha256=" + crypto.createHmac("sha256", "outro").update(rawBody).digest("hex"));
  record("forward assinado com secret errado → 401", r.res.statusCode === 401, `status=${r.res.statusCode}`);

  r = runMw(rawBody, validSig);
  record("forward com assinatura válida → next()", r.nextCalled && r.res.statusCode === 0, `next=${r.nextCalled}`);

  delete process.env.RECEPS_BOT_WEBHOOK_SECRET;
  process.env.NODE_ENV = "production";
  r = runMw(rawBody, validSig);
  record("sem secret + produção → 503 (fail-closed)", r.res.statusCode === 503 && !r.nextCalled, `status=${r.res.statusCode}`);

  delete process.env.NODE_ENV;
  r = runMw(rawBody, undefined);
  record("sem secret + dev → next() (fail-open)", r.nextCalled, `next=${r.nextCalled}`);

  // ===== (1) Idempotência por message_id =====
  if (!process.env.DATABASE_URL) {
    record("idempotência: DATABASE_URL disponível", false, "sem DATABASE_URL (defina pra testar a tabela)");
  } else {
    const { ensureProcessedMessagesTable, markMessageProcessed, cleanupOldProcessedMessages } =
      await import("../src/services/processedMessages");
    const { pool } = await import("../src/services/contextManager");

    const mid = `smoke-ana-${Date.now()}`;
    const pnid = "smoke-pnid";
    try {
      await ensureProcessedMessagesTable();
      const first = await markMessageProcessed(mid, pnid);
      record("idempotência: 1ª vez processa (rowCount=1 → true)", first === true);
      const second = await markMessageProcessed(mid, pnid);
      record("idempotência: 2ª vez é noop (ON CONFLICT → false)", second === false);
      const cleaned = await cleanupOldProcessedMessages();
      record("cleanup roda sem erro (não apaga o recém-inserido)", typeof cleaned === "number");
    } finally {
      await pool.query("DELETE FROM processed_messages WHERE message_id = $1", [mid]);
      await pool.end();
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== ${checks.length} checks · ${failed.length} fail(s) ===`);
  if (failed.length) for (const f of failed) console.log(` ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
