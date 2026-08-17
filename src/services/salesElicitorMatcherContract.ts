import { type ElicitorMatcherContractRow } from './elicitorMatcher/contract';
import {
  classifyEmailConfirmationReply,
  EMAIL_CONFIRMATION_REQUIRED_HINT,
  requiresHandoff,
} from './salesGuards';
import { HANDOFF_TO_HUMAN_DESCRIPTION, SALES_TOOLS } from './salesBrain';

export const SALES_ELICITOR_CONTRACT_EMAIL = 'contrato@clinica.example.com';

const EMAIL_CONFIRMATION_NATURAL_REPLIES = [
  'beleza',
  'blz',
  'show',
  'fechado',
  'combinado',
  'tá bom',
  'pode sim',
  'sim',
  'ok',
  'confirmo',
  'isso mesmo',
  'perfeito',
  'aham',
  '👍',
  'tudo certo',
] as const;

function handoffElicitor(): string {
  const description = SALES_TOOLS.find(
    (tool) => tool.name === 'handoffToHuman'
  )?.description;
  return description ?? HANDOFF_TO_HUMAN_DESCRIPTION;
}

export function salesElicitorMatcherContractRows(): ElicitorMatcherContractRow[] {
  return [
    {
      nome: 'confirmação de e-mail × email_confirmation_required',
      elicitor: EMAIL_CONFIRMATION_REQUIRED_HINT,
      respostasNaturais: EMAIL_CONFIRMATION_NATURAL_REPLIES,
      negacoes: [
        'incerto',
        'não tá certo',
        'não está tudo certo',
        'pode me ligar?',
        'pode deixar pra depois',
        'showroom',
        'pode',
      ],
      interrogativas: [
        'pode me ligar?',
        'confirma o telefone?',
        'qual email você tem?',
        'o e-mail está certo ou errado?',
      ],
      matcher: (reply) =>
        classifyEmailConfirmationReply(reply, SALES_ELICITOR_CONTRACT_EMAIL),
    },
    {
      nome: 'pedido de humano × handoffToHuman',
      elicitor: handoffElicitor(),
      respostasNaturais: [
        'pode me passar pro Victor',
        'chama o Victor por favor',
        'tem alguém de vocês?',
      ],
      respostasNaturaisAutorizam: false,
      negacoes: ['quero o link', 'não, obrigada', 'depois eu vejo'],
      interrogativas: ['o Victor atende agora?', 'vocês têm suporte humano?'],
      matcher: (reply) => requiresHandoff([{ role: 'user', content: reply }]),
    },
  ];
}

export { extractQuotedElicitorAnswers } from './elicitorMatcher/contract';
