import type { TenantBotConfig } from '../../configProvider';
import type {
  DeliveryPreemptionV2,
  TurnFrameV2,
  TurnPlanReceiptV2,
} from './contracts';
import type { MaterializedPendingTransitionV2 } from './stateStore';
import type { ElicitationVariantV2 } from './elicitation';
import type { CopyVariantIdV2 } from './copyVariants';

export const ANA_CONVERSATIONAL_V2_PREPARED_KIND =
  'ana_conversational_v2_prepared' as const;

export type V2CheckpointStage =
  | 'during_primary'
  | 'before_regen'
  | 'during_regen'
  | 'during_voice'
  | 'before_transport';

export interface ConversationalV2Checkpoint {
  paused: boolean;
  latestInputSequence: number;
  successorInputSequence: number | null;
  successorInboundMessageIds: string[];
}

export interface ConversationalV2TurnRuntime {
  /** Id durável do lote sucessor; fixa a identidade do turno após restart. */
  turnId?: string;
  inputSequence: number;
  currentInboundIds: string[];
  currentInboundTextsById?: Readonly<Record<string, string>>;
  /** Sucessor de um turno com write confirmado deve começar por read autoritativo. */
  forceUpcomingRead?: boolean;
  checkpoint: (
    stage: V2CheckpointStage
  ) => Promise<ConversationalV2Checkpoint>;
}

export interface PreparedReceptionistTurnV2 {
  kind: typeof ANA_CONVERSATIONAL_V2_PREPARED_KIND;
  frame: TurnFrameV2;
  conversationKey: string;
  phoneNumberId: string;
  customerPhone: string;
  config: TenantBotConfig;
  payload: string | null;
  transition: MaterializedPendingTransitionV2;
  planReceipt: TurnPlanReceiptV2;
  preemption: DeliveryPreemptionV2 | null;
  successorTurnId: string | null;
  hasCommittedWrite: boolean;
  canonicalPendingQuestion: string | null;
  elicitationVariant: ElicitationVariantV2;
  copyVariant?: CopyVariantIdV2;
  /** Única entrega que pode atravessar a pausa recém-criada pela própria escalada. */
  authoritativeEscalationQuestionId?: string;
}

export function isPreparedReceptionistTurnV2(
  value: unknown
): value is PreparedReceptionistTurnV2 {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { kind?: unknown }).kind === ANA_CONVERSATIONAL_V2_PREPARED_KIND
  );
}
