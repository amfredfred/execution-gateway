import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { hostname } from 'node:os';

@Injectable()
export class EngineSessionService {
  private readonly logger = new Logger(EngineSessionService.name);
  private readonly supabase?: SupabaseClient;
  private readonly gatewayInstance: string;

  constructor(config: ConfigService) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    this.gatewayInstance = `${hostname()}:${process.pid}`;
    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  async open(engineDeviceId: string, engineId: string): Promise<string | null> {
    if (!this.supabase) return null;
    const response = await this.supabase.rpc('open_engine_session', {
      p_engine_device_id: engineDeviceId,
      p_gateway_instance: this.gatewayInstance,
      p_metadata: { engine_id: engineId },
    });
    if (response.error) {
      this.logger.error(
        `Failed to open engine session: ${response.error.message}`,
      );
      return null;
    }
    return typeof response.data === 'string' ? response.data : null;
  }

  touch(sessionId: string) {
    if (!this.supabase) return;
    void this.supabase
      .rpc('touch_engine_session', { p_session_id: sessionId })
      .then(({ error }) => {
        if (error)
          this.logger.warn(`Failed to persist heartbeat: ${error.message}`);
      });
  }

  close(sessionId: string, reason: string) {
    if (!this.supabase) return;
    void this.supabase
      .rpc('close_engine_session', {
        p_session_id: sessionId,
        p_reason: reason,
      })
      .then(({ error }) => {
        if (error)
          this.logger.warn(`Failed to close engine session: ${error.message}`);
      });
  }
}
