import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';

/**
 * Persists engine session lifecycle events (open / heartbeat / close) to
 * Supabase via direct PostgREST RPC calls.
 *
 * We intentionally bypass the supabase-js client here because v2 of that
 * library expects the service-role key to be a JWT (eyJ…).  The newer
 * sb_secret_* key format causes v2 to attempt an auth/v1/token exchange
 * before every request, which fails with "TypeError: fetch failed".
 * Calling PostgREST directly avoids that auth layer entirely — the REST
 * API accepts any valid apikey header regardless of format.
 */
@Injectable()
export class EngineSessionService {
  private readonly logger = new Logger(EngineSessionService.name);
  private readonly rpcBase: string | null = null;
  private readonly headers: Record<string, string> | null = null;
  private readonly gatewayInstance: string;

  constructor(config: ConfigService) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    this.gatewayInstance = `${hostname()}:${process.pid}`;

    if (url && key) {
      this.rpcBase = `${url.replace(/\/$/, '')}/rest/v1/rpc`;
      this.headers = {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      };
    }
  }

  private async rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: string | null }> {
    if (!this.rpcBase || !this.headers) {
      return { data: null, error: 'Supabase not configured' };
    }
    try {
      const res = await fetch(`${this.rpcBase}/${fn}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        return { data: null, error: `HTTP ${res.status}: ${text}` };
      }
      const data = await res.json().catch(() => null);
      return { data, error: null };
    } catch (err: unknown) {
      return {
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async open(engineDeviceId: string, engineId: string): Promise<string | null> {
    if (!this.rpcBase) return null;
    const { data, error } = await this.rpc('open_engine_session', {
      p_engine_device_id: engineDeviceId,
      p_gateway_instance: this.gatewayInstance,
      p_metadata: { engine_id: engineId },
    });
    if (error) {
      this.logger.error(`Failed to open engine session: ${error}`);
      return null;
    }
    return typeof data === 'string' ? data : null;
  }

  touch(sessionId: string): void {
    if (!this.rpcBase) return;
    void this.rpc('touch_engine_session', { p_session_id: sessionId }).then(
      ({ error }) => {
        if (error) this.logger.warn(`Failed to persist heartbeat: ${error}`);
      },
    );
  }

  close(sessionId: string, reason: string): void {
    if (!this.rpcBase) return;
    void this.rpc('close_engine_session', {
      p_session_id: sessionId,
      p_reason: reason,
    }).then(({ error }) => {
      if (error) this.logger.warn(`Failed to close engine session: ${error}`);
    });
  }
}
