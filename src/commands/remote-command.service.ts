import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface CommandRecord {
  id: string;
  engine_device_id: string;
  command_type: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export interface CommandResult {
  ok: boolean;
  command?: CommandRecord;
  error?: string;
}

@Injectable()
export class RemoteCommandService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RemoteCommandService.name);
  private readonly supabase?: SupabaseClient;
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  onModuleInit() {
    // Sweep expired commands every 60 s
    this.sweepTimer = setInterval(() => void this.sweepExpired(), 60_000);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /**
   * Creates a command record in Supabase (verifying ownership via RPC)
   * and returns it ready to be delivered to the engine.
   */
  async create(
    ownerUserId: string,
    engineId: string,
    commandType: string,
    expiresInSeconds = 30,
  ): Promise<CommandResult> {
    if (!this.supabase) {
      return { ok: false, error: 'Supabase is not configured' };
    }

    const { data, error } = await this.supabase.rpc('create_remote_command', {
      p_owner_user_id: ownerUserId,
      p_engine_id: engineId,
      p_command_type: commandType,
      p_expires_in_s: expiresInSeconds,
    });

    if (error) {
      this.logger.warn(`Failed to create command: ${error.message}`);
      return { ok: false, error: error.message };
    }

    const row = (data as CommandRecord[] | null)?.[0];
    if (!row) return { ok: false, error: 'Command creation returned no result' };

    this.logger.log(`Command ${row.id} (${commandType}) created for engine ${engineId}`);
    return { ok: true, command: row };
  }

  /**
   * Admin variant: creates a command for any engine without ownership check.
   * Resolves the engine_device_id and owner from engine_devices + licenses,
   * then inserts directly (bypassing the ownership RPC).
   */
  async createAdmin(
    engineId: string,
    commandType: string,
    expiresInSeconds = 30,
  ): Promise<CommandResult> {
    if (!this.supabase) return { ok: false, error: 'Supabase is not configured' };

    const { data: device, error: devErr } = await this.supabase
      .from('engine_devices')
      .select('id, license_id, licenses!inner(owner_user_id)')
      .eq('engine_id', engineId)
      .eq('status', 'active')
      .maybeSingle();

    if (devErr || !device) {
      return { ok: false, error: `Engine ${engineId} not found or inactive` };
    }

    const ownerUserId =
      (device as { licenses?: { owner_user_id?: string } }).licenses?.owner_user_id ?? null;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    const { data, error } = await this.supabase
      .from('remote_commands')
      .insert({
        engine_device_id: device.id,
        command_type: commandType,
        status: 'pending',
        expires_at: expiresAt,
        owner_user_id: ownerUserId,
      })
      .select('id,engine_device_id,command_type,status,expires_at,created_at')
      .single();

    if (error || !data) {
      this.logger.warn(`Admin command insert failed: ${error?.message}`);
      return { ok: false, error: error?.message ?? 'Insert failed' };
    }

    const row = data as CommandRecord;
    this.logger.log(`Admin command ${row.id} (${commandType}) created for engine ${engineId}`);
    return { ok: true, command: row };
  }

  /**
   * Marks a command as delivered in Supabase after the engine socket send succeeds.
   */
  async markDelivered(commandId: string): Promise<void> {
    if (!this.supabase) return;
    await this.supabase
      .from('remote_commands')
      .update({ status: 'delivered', delivered_at: new Date().toISOString() })
      .eq('id', commandId);
  }

  /**
   * Updates a command's final status (completed / failed) when the engine replies.
   */
  async markFinished(
    commandId: string,
    status: 'completed' | 'failed',
    result: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.supabase) return;
    const { error } = await this.supabase.rpc('update_command_status', {
      p_command_id: commandId,
      p_status: status,
      p_result: result,
    });
    if (error) {
      this.logger.warn(`Failed to update command ${commandId} status: ${error.message}`);
    } else {
      this.logger.log(`Command ${commandId} marked ${status}`);
    }
  }

  /**
   * Returns a single command by ID — used by the status-polling endpoint.
   * The ownerUserId is verified server-side.
   */
  async getCommand(
    commandId: string,
    ownerUserId: string,
  ): Promise<CommandRecord | null> {
    if (!this.supabase) return null;
    const { data, error } = await this.supabase
      .from('remote_commands')
      .select('id,engine_device_id,command_type,status,expires_at,created_at,delivered_at,completed_at,result')
      .eq('id', commandId)
      .eq('owner_user_id', ownerUserId)
      .maybeSingle();
    if (error || !data) return null;
    return data as CommandRecord;
  }

  /**
   * Returns recent commands for a user + engine (for the dashboard history view).
   */
  async listCommands(
    ownerUserId: string,
    engineDeviceId: string,
    limit = 20,
  ): Promise<CommandRecord[]> {
    if (!this.supabase) return [];
    const { data } = await this.supabase
      .from('remote_commands')
      .select('id,engine_device_id,command_type,status,expires_at,created_at,delivered_at,completed_at,result')
      .eq('owner_user_id', ownerUserId)
      .eq('engine_device_id', engineDeviceId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data ?? []) as CommandRecord[];
  }

  private async sweepExpired() {
    if (!this.supabase) return;
    const { data, error } = await this.supabase.rpc('expire_stale_commands');
    if (!error && data) {
      const count = Number(data);
      if (count > 0) this.logger.log(`Expired ${count} stale command(s)`);
    }
  }
}
