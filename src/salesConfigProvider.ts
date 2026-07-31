import { ERP_API_TOKEN } from './erpApiToken';

/**
 * Config de VENDAS da Renata: planos/preços/trials estruturados do Receps
 * (GET /api/v1/bot/sales-config). O modelo NUNCA cita preço de memória — a
 * Renata injeta este bloco no placeholder {{PLANOS}} do system prompt. Cache em
 * memória de 1h (preço muda raramente; o Receps deriva de PLAN_METADATA).
 */

const ERP_BASE_URL = process.env.ERP_BASE_URL ?? 'http://localhost:3000';
const SALES_CONFIG_TTL_MS = 60 * 60 * 1000; // 1h (spec §B4.1)

export interface SalesConfigPlan {
  slug: string;
  name: string;
  sellable: boolean;
  priceMonthly: number;
  priceMonthlyFormatted: string;
  priceAnnualTotalFormatted: string;
  priceAnnualMonthlyFormatted: string;
  annualFreeMonths: number;
  trialDays: number;
  maxProfessionals: number | null;
  features: string[];
  waitlist?: { reason: string; href: string };
}

export interface SalesConfig {
  currency: string;
  annualFreeMonths: number;
  signupBaseUrl: string;
  plans: SalesConfigPlan[];
  anaBeta: { testing: boolean; waitlistHref: string; notice: string };
}

let cache: { data: SalesConfig; expiresAt: number } | null = null;

/**
 * Busca a config de vendas (cacheada 1h). Lança se não conseguir buscar E não
 * houver cache — o salesBrain trata (fallback sem preço, nunca inventa valor).
 */
export async function getSalesConfig(): Promise<SalesConfig> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const url = new URL('/api/v1/bot/sales-config', ERP_BASE_URL);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${ERP_API_TOKEN}` },
    cache: 'no-store',
  });

  if (!response.ok) {
    // Cache velho é melhor que nada (preço muda raramente).
    if (cache) {
      console.warn(
        `⚠️ sales-config retornou ${response.status} — usando cache anterior.`
      );
      return cache.data;
    }
    throw new Error(`sales-config indisponível (HTTP ${response.status}).`);
  }

  const data = (await response.json()) as SalesConfig;
  cache = { data, expiresAt: Date.now() + SALES_CONFIG_TTL_MS };
  return data;
}

/**
 * Renderiza o bloco {{PLANOS}} em texto corrido (compliance: valores absolutos,
 * sem comparação, sem promessa de lucro). Plano NÃO vendável vira aviso de
 * lista de interesse com o link — a Renata NUNCA o vende.
 */
export function renderPlansBlock(config: SalesConfig): string {
  const lines = config.plans.map((plan) => {
    if (!plan.sellable) {
      const href = plan.waitlist?.href ?? config.anaBeta.waitlistHref;
      return `- ${plan.name}: EM ATUALIZAÇÃO — NÃO vender agora. Se a pessoa quiser só o atendimento, ofereça a lista de interesse (link: ${href}) e apresente o Essencial como opção disponível hoje. A conexão da Ana funciona normalmente no Essencial e no Pro.`;
    }

    const limite =
      plan.maxProfessionals == null
        ? 'profissionais ilimitados'
        : plan.maxProfessionals === 1
          ? '1 profissional'
          : `até ${plan.maxProfessionals} profissionais`;

    const features = plan.features.join('; ');

    return `- ${plan.name}: ${plan.priceMonthlyFormatted}/mês (ou ${plan.priceAnnualMonthlyFormatted}/mês no anual — ${plan.annualFreeMonths} meses por nossa conta, ${plan.priceAnnualTotalFormatted} à vista). Trial grátis de ${plan.trialDays} dias, sem cartão. ${limite}. Inclui: ${features}. slug para o link: "${plan.slug}".`;
  });

  return `PLANOS E PREÇOS (fonte da verdade — use SOMENTE estes valores, NUNCA cite preço de memória):\n${lines.join('\n')}`;
}

/** Seam de teste: limpa o cache entre casos do smoke. */
export function __resetSalesConfigCacheForTest(): void {
  cache = null;
}

/** Seam de teste: injeta um valor no cache (evita rede no smoke). */
export function __seedSalesConfigForTest(data: SalesConfig): void {
  cache = { data, expiresAt: Date.now() + SALES_CONFIG_TTL_MS };
}
