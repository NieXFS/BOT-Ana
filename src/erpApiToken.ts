import crypto from 'crypto';

/**
 * Resolve o token usado para autenticar a Ana contra a API interna do Receps
 * (header `Authorization: Bearer <token>`). Espelha o ERP_API_TOKEN do Receps.
 *
 * Fail-FAST em produção: sem ERP_API_TOKEN o módulo LANÇA no carregamento (top
 * level), então o processo não sobe (PM2 reinicia e expõe o erro) em vez de
 * autenticar com um default público. Em dev, avisa e gera um token efêmero por
 * processo (crypto.randomBytes) para não travar o ambiente local — chamadas ao
 * Receps falharão com 401, o que é aceitável fora de produção.
 *
 * NÃO use um default hardcoded aqui: o ponto desta correção (M25) é eliminar o
 * 'minha-chave-secreta-receps-123' que vivia em configProvider/optOutService/
 * calendarService.
 */
export function resolveErpApiToken(): string {
  const token = process.env.ERP_API_TOKEN?.trim();
  if (token) {
    return token;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('ERP_API_TOKEN missing — required in production');
  }

  const ephemeral = crypto.randomBytes(32).toString('hex');
  console.warn(
    '⚠️ ERP_API_TOKEN ausente — usando token efêmero aleatório (apenas dev). Chamadas ao Receps falharão com 401.'
  );
  return ephemeral;
}

/**
 * Avaliado em tempo de IMPORT (não lazy) de propósito: garante que o throw em
 * produção aconteça no carregamento do módulo (boot) — fazendo o PM2 falhar
 * rápido, em vez de só no primeiro request. Os três importadores
 * (configProvider, optOutService, calendarService) carregam no boot via
 * webhookServer, então o throw propaga e o processo não sobe.
 */
export const ERP_API_TOKEN = resolveErpApiToken();
