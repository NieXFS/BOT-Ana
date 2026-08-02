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
  tracks?: {
    flexivel: FlexibleSalesTrack | null;
    fidelidade: FidelitySalesTrack | null;
  };
  priceMonthly: number;
  priceMonthlyFormatted: string;
  /** @deprecated Oferta anual aposentada; presente apenas em payloads legados. */
  priceAnnualTotalFormatted: string;
  /** @deprecated Oferta anual aposentada; presente apenas em payloads legados. */
  priceAnnualMonthlyFormatted: string;
  /** @deprecated Semântica legada; nunca autoriza oferta anual. */
  annualFreeMonths: number;
  annualSellable?: false;
  /** Compatibilidade v1: trial da cobrança mensal, hoje chamada Flexível. */
  trialDays: number;
  maxProfessionals: number | null;
  features: string[];
  waitlist?: { reason: string; href: string };
}

export interface FlexibleSalesTrack {
  priceMonthly: number;
  priceMonthlyFormatted: string;
  trialDays: number;
  trialRequiresCard: false;
}

export interface FidelitySalesTrack {
  priceMonthly: number;
  priceMonthlyFormatted: string;
  commitmentMonths: 12;
  penaltyPercent: 20;
  regretDays: 7;
  trialDays: 0;
  firstChargeAtSignup: true;
}

export interface SalesConfig {
  /** Ausente no payload v1. */
  version?: 1 | 2;
  currency: 'BRL';
  annualFreeMonths: number;
  annualSellable?: false;
  deprecationNote?: string;
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
  const hasStructuredTracks = config.plans.some(
    (plan) => plan.tracks !== undefined
  );
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
    const planHeader = `- ${plan.name} — slug para o link: "${plan.slug}". ${limite}. Inclui: ${features}.`;

    // Compatibilidade com Receps v1: `tracks` não existia. A única oferta
    // segura é a mensal antiga, agora tratada como Flexível. Os campos anuais
    // legados são deliberadamente ignorados.
    if (!plan.tracks) {
      return `${planHeader}\n  - Flexível: ${plan.priceMonthlyFormatted}/mês. Teste grátis de ${plan.trialDays} dias, sem cartão.`;
    }

    const trackLines: string[] = [];
    if (plan.tracks.flexivel) {
      const flexivel = plan.tracks.flexivel;
      trackLines.push(
        `  - Flexível: ${flexivel.priceMonthlyFormatted}/mês. Teste grátis de ${flexivel.trialDays} dias, sem cartão.`
      );
    }
    if (plan.tracks.fidelidade) {
      const fidelidade = plan.tracks.fidelidade;
      trackLines.push(
        `  - Fidelidade 12m: ${fidelidade.priceMonthlyFormatted}/mês. Compromisso de ${fidelidade.commitmentMonths} meses. Sem teste grátis — primeira cobrança no ato. Há ${fidelidade.regretDays} dias de arrependimento com reembolso integral; cancelando depois desse prazo, multa de ${fidelidade.penaltyPercent}% sobre as mensalidades que faltam. Depois dos ${fidelidade.commitmentMonths} meses, o preço continua o mesmo mês a mês, sem renovar o compromisso.`
      );
    }

    if (trackLines.length === 0) {
      const href = plan.waitlist?.href ?? config.anaBeta.waitlistHref;
      return `${planHeader}\n  - NENHUMA trilha vendável no momento. Não gere link; ofereça a lista de interesse: ${href}.`;
    }

    return `${planHeader}\n${trackLines.join('\n')}`;
  });

  const retiredOfferRule = hasStructuredTracks
    ? '- NUNCA ofereça plano anual nem a oferta aposentada de "2 meses grátis", "2 meses por nossa conta" ou equivalentes.'
    : '- Não mencione nem ofereça condições descontinuadas que não aparecem acima.';

  return `PLANOS E PREÇOS (fonte da verdade — use SOMENTE estes valores, NUNCA cite preço de memória):
${lines.join('\n')}

REGRAS DURAS DE OFERTA:
- Venda somente planos e trilhas explicitamente listados acima; trilha ausente ou nula está indisponível.
- Na Fidelidade, SEMPRE informe junto o compromisso de 12 meses e a multa de 20% sobre as mensalidades restantes após os 7 dias de arrependimento. Nunca negue nem minimize esse compromisso.
- "Teste grátis de 14 dias, sem cartão" pertence SOMENTE à Flexível. A Fidelidade não tem teste grátis e cobra a primeira mensalidade no ato.
${retiredOfferRule}
- O Somente Atendente IA não é vendável; ofereça apenas a lista de interesse e apresente Essencial ou Pro.
- Cite valores absolutos. Não compare preço com concorrentes e não prometa lucro, economia garantida ou retorno financeiro.`;
}

/** Seam de teste: limpa o cache entre casos do smoke. */
export function __resetSalesConfigCacheForTest(): void {
  cache = null;
}

/** Seam de teste: injeta um valor no cache (evita rede no smoke). */
export function __seedSalesConfigForTest(data: SalesConfig): void {
  cache = { data, expiresAt: Date.now() + SALES_CONFIG_TTL_MS };
}
