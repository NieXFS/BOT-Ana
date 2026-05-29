/**
 * Smoke test do hardening do webhook (Ana).
 *
 * Duas camadas:
 *   1. UNIT (sempre roda, sem rede): exercita `src/security` diretamente —
 *      verificação de assinatura HMAC (válida/forjada/segredo errado/ausente) e
 *      rate limit (N permitidas / (N+1) bloqueada, IP isolado).
 *   2. LIVE (opcional): se ANA_SMOKE_URL e META_APP_SECRET estiverem setados
 *      (o secret PRECISA ser o mesmo do servidor), bate o POST /webhook com
 *      assinatura INVÁLIDA → 401 e com assinatura VÁLIDA → 200. Senão, PULA.
 *
 * Rodar: node scripts/smoke-security.ts   (Node 24 faz type-stripping de .ts)
 */

import crypto from "crypto";
import {
  consumeRateLimit,
  isValidMetaSignature,
  resetRateLimitStore,
} from "../src/security.ts";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures += 1;
  }
}

function sign(rawBody: Buffer, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Assinatura da Meta
// ───────────────────────────────────────────────────────────────────────────
function testSignature() {
  console.log("\n[1] isValidMetaSignature");
  const secret = "test-app-secret-123";
  const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));

  const validSig = sign(body, secret);
  check("assinatura válida → true", isValidMetaSignature(body, validSig, secret) === true);

  check(
    "corpo adulterado → false",
    isValidMetaSignature(Buffer.from(body.toString() + " "), validSig, secret) === false
  );

  check(
    "segredo errado → false",
    isValidMetaSignature(body, validSig, "outro-secret") === false
  );

  check("assinatura ausente → false", isValidMetaSignature(body, undefined, secret) === false);
  check("corpo ausente → false", isValidMetaSignature(undefined, validSig, secret) === false);
  check("segredo vazio → false", isValidMetaSignature(body, validSig, "") === false);
  check(
    "header malformado (sem sha256=) → false",
    isValidMetaSignature(body, "deadbeef", secret) === false
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Rate limit
// ───────────────────────────────────────────────────────────────────────────
function testRateLimit() {
  console.log("\n[2] consumeRateLimit — 1000/min por IP");
  resetRateLimitStore();

  const limit = 1000;
  const windowMs = 60_000;
  const key = "webhook:ip:203.0.113.10";

  let allowed = 0;
  for (let i = 0; i < limit; i += 1) {
    if (consumeRateLimit(key, limit, windowMs).ok) allowed += 1;
  }
  check(`as primeiras ${limit} passam`, allowed === limit);

  const blocked = consumeRateLimit(key, limit, windowMs);
  check("a 1001ª é bloqueada", blocked.ok === false);
  check("retryAfter > 0 quando bloqueada", blocked.retryAfter > 0);

  const other = consumeRateLimit("webhook:ip:198.51.100.20", limit, windowMs);
  check("IP diferente NÃO é afetado", other.ok === true);
}

// ───────────────────────────────────────────────────────────────────────────
// 3. LIVE (opcional)
// ───────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[3] LIVE — POST /webhook (opcional)");
  const url = process.env.ANA_SMOKE_URL;
  const secret = process.env.META_APP_SECRET;
  if (!url || !secret) {
    console.log("  • ANA_SMOKE_URL e/ou META_APP_SECRET não setados — PULANDO teste live.");
    return;
  }

  const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));

  let invalid: Response;
  try {
    invalid = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=forjada" },
      body,
    });
  } catch {
    console.log("  • servidor não acessível em " + url + " — PULANDO teste live.");
    return;
  }
  check("assinatura inválida → 401", invalid.status === 401);

  const valid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body, secret),
    },
    body,
  });
  check("assinatura válida → 200", valid.status === 200);
}

async function main() {
  console.log("════════ smoke-security (Ana) ════════");
  testSignature();
  testRateLimit();
  await testLive();

  console.log("\n────────────────────────────────────────────");
  if (failures > 0) {
    console.error(`✗ ${failures} verificação(ões) falharam.`);
    process.exit(1);
  }
  console.log("✓ Todas as verificações passaram.");
  process.exit(0);
}

void main();
