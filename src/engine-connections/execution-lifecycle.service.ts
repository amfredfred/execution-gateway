import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface ExecutionLifecycleTransition {
  signal_id: string;
  account_login: string;
  stage:
    | 'received'
    | 'accepted'
    | 'rejected'
    | 'attempted'
    | 'opened'
    | 'failed';
  observed_at: string;
  reason?: string;
  trade_id?: string;
  broker_ticket?: string;
}

@Injectable()
export class ExecutionLifecycleService {
  private readonly logger = new Logger(ExecutionLifecycleService.name);
  private readonly supabase?: SupabaseClient;

  constructor(config: ConfigService) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  record(
    engineDeviceId: string,
    engineSessionId: string | null,
    transition: ExecutionLifecycleTransition,
  ) {
    if (!this.supabase) return;
    void this.supabase
      .rpc('record_execution_lifecycle', {
        p_engine_device_id: engineDeviceId,
        p_engine_session_id: engineSessionId,
        p_signal_id: transition.signal_id,
        p_account_login: transition.account_login,
        p_stage: transition.stage,
        p_observed_at: transition.observed_at,
        p_reason: transition.reason ?? null,
        p_trade_id: transition.trade_id ?? null,
        p_broker_ticket: transition.broker_ticket ?? null,
      })
      .then(({ error }) => {
        if (error) {
          this.logger.warn(
            `Failed to persist execution lifecycle: ${error.message}`,
          );
        }
      });
  }
}
