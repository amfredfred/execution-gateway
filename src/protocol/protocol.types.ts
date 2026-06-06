export interface ProtocolEnvelope {
  protocol_version: string;
  message_id: string;
  event: string;
  sent_at: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export type ProtocolMessage = Omit<ProtocolEnvelope, 'event'>;

export interface ProtocolValidationResult {
  valid: boolean;
  errors: string[];
  message?: ProtocolEnvelope;
}
