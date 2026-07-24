import type { TenantBotConfig } from '../configProvider';
import {
  getServices,
  type ServicesResult,
} from './calendarService';

export interface DemoServiceResolverDeps {
  getServices: (config: TenantBotConfig) => Promise<ServicesResult>;
}

const defaultDeps: DemoServiceResolverDeps = {
  getServices,
};

/** Resolve o serviço canônico de demonstração no tenant `receps-vendas`. */
export async function resolveDemoServiceId(
  config: TenantBotConfig,
  overrides: Partial<DemoServiceResolverDeps> = {}
): Promise<string | null> {
  const deps = { ...defaultDeps, ...overrides };
  const result = await deps.getServices(config);
  if (!result.success || !result.services || result.services.length === 0) {
    return null;
  }
  const demo = result.services.find((service) => /demonstra/i.test(service.name));
  return (demo ?? result.services[0]).id;
}
