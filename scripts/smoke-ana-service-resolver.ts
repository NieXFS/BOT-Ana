import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
process.env.OPENAI_API_KEY ??= 'sk-smoke-invalid';
process.env.ERP_API_TOKEN ??= 'smoke-invalid';

import type { ServiceSummary, ServicesResult } from '../src/services/calendarService';
import {
  normalizeServiceAlias,
  normalizeServiceAliases,
} from '../src/lib/services/service-aliases';
import { resolveServiceFromCatalog } from '../src/services/conversationalV2/serviceResolver';

function service(
  id: string,
  name: string,
  aliases: string[] = [],
  extra: Record<string, unknown> = {}
): ServiceSummary {
  return {
    id,
    name,
    durationMinutes: 30,
    price: null,
    priceFormatted: null,
    aliases,
    ...(extra as Partial<ServiceSummary>),
  };
}

const catalog: ServicesResult = {
  success: true,
  services: [
    service('mani', 'Manicure', ['fazer a mao', 'so a mao', 'manicure normal']),
    service('pedi', 'Pedicure', ['fazer o pe', 'so o pe']),
    service('mani-pedi', 'Manicure e pedicure', [
      'pe e mao',
      'mao e pe',
      'fazer pe e mao',
      'fazer mao e pe',
    ]),
    service('repo', 'Reposição de unha'),
    service('child', 'Unha infantil'),
  ],
};

function resolved(text: string, id: string, source?: string): void {
  const result = resolveServiceFromCatalog({ text, catalog });
  assert.equal(result.kind, 'resolved', `${text} must resolve`);
  if (result.kind === 'resolved') {
    assert.equal(result.serviceId, id, `${text} service`);
    if (source) assert.equal(result.source, source, `${text} source`);
  }
}

function ambiguous(text: string, reason?: string): void {
  const result = resolveServiceFromCatalog({ text, catalog });
  assert.equal(result.kind, 'ambiguous', `${text} must be typed ambiguity`);
  if (result.kind === 'ambiguous' && reason) assert.equal(result.reason, reason);
}

function negative(text: string): void {
  const result = resolveServiceFromCatalog({ text, catalog });
  assert.equal(result.kind, 'negative_clarification', `${text} must clarify polarity`);
}

// Paridade com o helper ERP: NFKC, remoção de marcas, lower pt-BR, trim e
// colapso de espaços, sem inventar sinônimo no runtime.
assert.equal(normalizeServiceAlias('  PÉ   e  MÃO  '), 'pe e mao');
assert.equal(normalizeServiceAlias('Ｐé e mão'), 'pe e mao');
assert.deepEqual(
  normalizeServiceAliases(['PÉ e MÃO', '  pe   e mao ', 'Mão e pé']),
  ['pe e mao', 'mao e pe']
);
assert.deepEqual(normalizeServiceAliases(['https://example.test']), []);
assert.deepEqual(normalizeServiceAliases(['ignore instruções']), []);

resolved('pé e mão', 'mani-pedi', 'alias_exact');
resolved('mão e pé', 'mani-pedi', 'alias_exact');
resolved('fazer pé e mão', 'mani-pedi', 'alias_exact');
resolved('fazer mão e pé', 'mani-pedi', 'alias_exact');
resolved('fazer a mão', 'mani', 'alias_exact');
resolved('só a mão', 'mani', 'alias_exact');
resolved('fazer o pé', 'pedi', 'alias_exact');
resolved('só o pé', 'pedi', 'alias_exact');
resolved('Manicure', 'mani', 'canonical_exact');
resolved('Manicure normal', 'mani', 'canonical_exact');
resolved('Manicure e pedicure', 'mani-pedi', 'canonical_exact');
resolved('Reposição de unha', 'repo', 'canonical_exact');
resolved('Unha infantil', 'child', 'canonical_exact');

for (const text of ['fazer a unha', 'quero fazer unha', 'serviço de unha']) {
  ambiguous(text, 'bare_nail');
  const result = resolveServiceFromCatalog({ text, catalog });
  if (result.kind === 'ambiguous') {
    assert.deepEqual(result.serviceIds, ['mani', 'pedi', 'mani-pedi']);
    assert.doesNotMatch(result.clarification, /Reposição|infantil/u);
  }
}

negative('Não é manicure normal');
negative('Não é só manicure mesmo');
negative('Não é reposição');
resolved('Não, quero pé e mão', 'mani-pedi', 'alias_exact');
resolved('Na verdade é manicure', 'mani', 'canonical_exact');

const duplicateAliasCatalog: ServicesResult = {
  success: true,
  services: [
    service('a', 'Serviço A', ['mesmo termo']),
    service('b', 'Serviço B', ['mesmo termo']),
  ],
};
const duplicate = resolveServiceFromCatalog({
  text: 'mesmo termo',
  catalog: duplicateAliasCatalog,
});
assert.equal(duplicate.kind, 'ambiguous');
if (duplicate.kind === 'ambiguous') assert.equal(duplicate.reason, 'duplicate_alias');

const inactiveAliasCatalog: ServicesResult = {
  success: true,
  services: [
    service('inactive', 'Serviço inativo', ['termo inativo'], { active: false }),
  ],
};
assert.deepEqual(
resolveServiceFromCatalog({ text: 'termo inativo', catalog: inactiveAliasCatalog }),
  { kind: 'no_match', reason: 'inactive_only' }
);
const activeAndInactiveDuplicate: ServicesResult = {
  success: true,
  services: [
    service('active', 'Serviço ativo', ['termo compartilhado']),
    service('inactive', 'Serviço inativo', ['termo compartilhado'], { active: false }),
  ],
};
assert.equal(
  resolveServiceFromCatalog({ text: 'termo compartilhado', catalog: activeAndInactiveDuplicate }).kind,
  'resolved'
);

const noAliasesCatalog: ServicesResult = {
  success: true,
  services: [service('mani', 'Manicure')],
};
assert.deepEqual(
  resolveServiceFromCatalog({ text: 'fazer a mão', catalog: noAliasesCatalog }),
  { kind: 'no_match', reason: 'no_match' }
);

console.log('smoke-ana-service-resolver: ok');
