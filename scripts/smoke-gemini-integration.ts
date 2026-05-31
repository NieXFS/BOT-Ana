/**
 * Smoke de integração Gemini (wiring do @google/genai) — UMA chamada real.
 *
 * Isolado: NÃO importa o brainService (que puxa pg/contextManager e exigiria
 * DATABASE_URL). Valida só o transporte: chave + modelo + parsing de resposta +
 * aceitação do JSON Schema das tools (parametersJsonSchema) + thinkingBudget:0.
 *
 * Gated: sem GEMINI_API_KEY no ambiente, faz SKIP (exit 0) — não quebra CI.
 * Rodar: node scripts/smoke-gemini-integration.ts  (custa centavos).
 */
import 'dotenv/config';
import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.log('⏭️  SKIP: GEMINI_API_KEY ausente no ambiente — defina no .env para rodar a chamada real.');
    process.exit(0);
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
  console.log(`(modelo: ${model})`);

  const checks: { name: string; ok: boolean }[] = [];
  const rec = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok });
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 1) Chamada simples "Olá" → texto não-vazio (chave + modelo + thinkingBudget:0).
  const r1 = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: 'Olá' }] }],
    config: {
      systemInstruction: 'Você é a Ana, atendente virtual de um salão. Responda curto, em pt-BR.',
      maxOutputTokens: 100,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const text1 = (r1.text ?? '').trim();
  rec('chamada simples "Olá" → texto não-vazio', text1.length > 0, JSON.stringify(text1.slice(0, 80)));

  // 2) Chamada com functionDeclarations (mesmo formato de schema do brainService:
  //    object + string props + required via parametersJsonSchema) → API aceita o
  //    schema sem erro. "Olá, bom dia" não deve disparar tool, mas aceitamos texto
  //    OU functionCall — o que importa é a chamada não estourar (schema rejeitado).
  const r2 = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: 'Olá, bom dia!' }] }],
    config: {
      systemInstruction: 'Você é a Ana.',
      tools: [
        {
          functionDeclarations: [
            {
              name: 'getAvailableSlots',
              description: 'Consulta os horários disponíveis para um serviço numa data.',
              parametersJsonSchema: {
                type: 'object',
                properties: {
                  date: { type: 'string', description: 'YYYY-MM-DD' },
                  serviceId: { type: 'string', description: 'id técnico' },
                  professionalId: { type: 'string', description: 'opcional' },
                },
                required: ['date', 'serviceId'],
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      maxOutputTokens: 100,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const ok2 = (r2.text ?? '').trim().length > 0 || (r2.functionCalls ?? []).length > 0;
  rec(
    'chamada com tools (parametersJsonSchema aceito pela API) → sem erro',
    ok2,
    `text=${JSON.stringify((r2.text ?? '').slice(0, 40))} functionCalls=${(r2.functionCalls ?? []).length}`
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? '✅ WIRING GEMINI OK' : `❌ ${failed.length} CHECK(S) FALHARAM`}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('integração Gemini falhou:', e?.message ?? e);
  process.exit(1);
});
