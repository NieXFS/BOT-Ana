import type { ReceptionistToolChoice } from '../providerProtocol';

/**
 * Onde a máquina de estados já sabe que o próximo ato só pode ser tool.
 * Thinking mode não entra aqui: o emit do provider omite tool_choice.
 */
export function resolveForcedToolChoiceV2(input: {
  forceUpcomingRead?: boolean;
}): ReceptionistToolChoice | undefined {
  if (input.forceUpcomingRead === true) {
    return { type: 'function', name: 'getUpcomingAppointments' };
  }
  return undefined;
}
