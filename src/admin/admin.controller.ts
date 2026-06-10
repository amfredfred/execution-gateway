import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { LicenseService } from '../licensing/license.service';
import { ConnectionRegistryService } from '../engine-connections/connection-registry.service';
import { RemoteCommandService } from '../commands/remote-command.service';

const ALLOWED_COMMAND_TYPES = new Set([
  'command.pause',
  'command.resume',
  'command.emergency_stop',
]);

@Controller('admin')
export class AdminController {
  private readonly adminKey: string | undefined;
  private readonly adminEmails: string[];
  private readonly supabase?: SupabaseClient;

  constructor(
    private readonly licenses: LicenseService,
    private readonly engines: ConnectionRegistryService,
    private readonly commands: RemoteCommandService,
    config: ConfigService,
  ) {
    this.adminKey = config.get<string>('admin.key');
    this.adminEmails = config.get<string[]>('admin.emails') ?? [];
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  // ── JWT-protected admin reads (called directly from dashboard browser) ──

  /**
   * GET /admin/me
   * Verifies Supabase JWT and confirms the email is in ADMIN_EMAILS.
   */
  @Get('me')
  async me(@Headers('authorization') auth: string | undefined) {
    const { email } = await this.verifyAdminJwt(auth);
    return { email, isAdmin: true };
  }

  /**
   * GET /admin/stats
   * Platform-wide counts: licenses by status, devices, active sessions.
   */
  @Get('stats')
  async stats(@Headers('authorization') auth: string | undefined) {
    await this.verifyAdminJwt(auth);
    if (!this.supabase)
      throw new InternalServerErrorException('Supabase not configured');

    const [licRes, devRes, sesRes] = await Promise.all([
      this.supabase.from('licenses').select('status'),
      this.supabase.from('engine_devices').select('status'),
      this.supabase
        .from('engine_sessions')
        .select('id', { count: 'exact', head: true })
        .is('disconnected_at', null)
        .gte(
          'last_heartbeat_at',
          new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        ),
    ]);

    const ls = licRes.data ?? [];
    const ds = devRes.data ?? [];
    const byStatus = (arr: { status: string }[], s: string) =>
      arr.filter((x) => x.status === s).length;

    return {
      licenses: {
        total: ls.length,
        active: byStatus(ls, 'active'),
        suspended: byStatus(ls, 'suspended'),
        expired: byStatus(ls, 'expired'),
      },
      devices: { total: ds.length, active: byStatus(ds, 'active') },
      connectedEngines: sesRes.count ?? 0,
    };
  }

  /**
   * GET /admin/licenses
   * All licenses with owner email and assigned symbols.
   */
  @Get('licenses')
  async listLicenses(@Headers('authorization') auth: string | undefined) {
    await this.verifyAdminJwt(auth);
    if (!this.supabase)
      throw new InternalServerErrorException('Supabase not configured');

    const { data, error } = await this.supabase
      .from('licenses')
      .select('id, status, max_devices, expires_at, created_at, updated_at, owner_user_id')
      .order('created_at', { ascending: false });

    if (error) throw new InternalServerErrorException(error.message);

    const ids = (data ?? []).map((l) => l.id);
    const symbolMap: Record<string, string[]> = {};
    if (ids.length) {
      const { data: symRows } = await this.supabase
        .from('license_symbols')
        .select('license_id, symbol')
        .in('license_id', ids);
      for (const row of symRows ?? []) {
        (symbolMap[row.license_id] ??= []).push(row.symbol as string);
      }
    }

    const ownerIds = [...new Set((data ?? []).map((l) => l.owner_user_id))];
    const emailMap: Record<string, string> = {};
    await Promise.all(
      ownerIds.map(async (uid) => {
        const { data: u } = await this.supabase!.auth.admin.getUserById(uid);
        if (u?.user?.email) emailMap[uid] = u.user.email;
      }),
    );

    return (data ?? []).map((l) => ({
      ...l,
      owner_email: emailMap[l.owner_user_id] ?? l.owner_user_id,
      symbols: symbolMap[l.id] ?? [],
    }));
  }

  /**
   * GET /admin/engines
   * All engine devices with license info and live connection state.
   */
  @Get('engines')
  async listEngines(@Headers('authorization') auth: string | undefined) {
    await this.verifyAdminJwt(auth);
    if (!this.supabase)
      throw new InternalServerErrorException('Supabase not configured');

    const { data: devices, error } = await this.supabase
      .from('engine_devices')
      .select(
        'id, engine_id, device_name, engine_version, platform, status, activated_at, last_seen_at, license_id, licenses!inner(id, status, owner_user_id, expires_at)',
      )
      .order('activated_at', { ascending: false })
      .limit(200);

    if (error) throw new InternalServerErrorException(error.message);

    const liveSet = new Set(this.engines.connectedEngineIds());

    type LicenseJoin = { id: string; status: string; owner_user_id: string; expires_at: string | null };
    const ownerIds = [
      ...new Set(
        (devices ?? [])
          .map((d) => (d.licenses as unknown as LicenseJoin | null)?.owner_user_id)
          .filter(Boolean) as string[],
      ),
    ];
    const emailMap: Record<string, string> = {};
    await Promise.all(
      ownerIds.map(async (uid) => {
        const { data: u } = await this.supabase!.auth.admin.getUserById(uid);
        if (u?.user?.email) emailMap[uid] = u.user.email;
      }),
    );

    const ONLINE_MS = 90_000;
    const DEGRADED_MS = 300_000;
    const now = Date.now();

    return (devices ?? []).map((d) => {
      const license = d.licenses as unknown as LicenseJoin | null;
      const elapsed = now - (d.last_seen_at ? Date.parse(d.last_seen_at as string) : 0);
      const connectionState =
        liveSet.has(d.engine_id as string) || elapsed < ONLINE_MS
          ? 'online'
          : elapsed < DEGRADED_MS
            ? 'degraded'
            : 'offline';
      return {
        id: d.id,
        engine_id: d.engine_id,
        device_name: d.device_name,
        engine_version: d.engine_version,
        platform: d.platform,
        status: d.status,
        activated_at: d.activated_at,
        last_seen_at: d.last_seen_at,
        license_id: d.license_id,
        license_status: license?.status ?? null,
        license_expires_at: license?.expires_at ?? null,
        owner_user_id: license?.owner_user_id ?? null,
        owner_email: license?.owner_user_id ? (emailMap[license.owner_user_id] ?? license.owner_user_id) : null,
        connection_state: connectionState,
      };
    });
  }

  // ── License key management ────────────────────────────────────────────

  /**
   * POST /admin/licenses/:id/keys
   * Issues (or rotates) an activation key for any license, admin bypass.
   */
  @Post('licenses/:id/keys')
  @HttpCode(HttpStatus.CREATED)
  async issueKey(
    @Param('id') licenseId: string,
    @Headers('x-admin-key') key: string | undefined,
  ): Promise<{ key: string }> {
    this.verify(key);
    const result = await this.licenses.issueKeyAdmin(licenseId);
    if ('error' in result) {
      if (result.error === 'license not found')
        throw new NotFoundException(result.error);
      throw new InternalServerErrorException(result.error);
    }
    return { key: result.raw };
  }

  /**
   * DELETE /admin/licenses/:id/keys
   * Revokes the activation key for any license, admin bypass.
   */
  @Delete('licenses/:id/keys')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeKey(
    @Param('id') licenseId: string,
    @Headers('x-admin-key') key: string | undefined,
  ): Promise<void> {
    this.verify(key);
    const result = await this.licenses.revokeKeyAdmin(licenseId);
    if (!result.ok) {
      if (result.error === 'license not found')
        throw new NotFoundException(result.error);
      throw new InternalServerErrorException(result.error);
    }
  }

  /**
   * PATCH /admin/licenses/:id
   * Updates status and/or expires_at for any license.
   * Body: { status?: "active"|"suspended"|"expired", expires_at?: string|null }
   */
  @Patch('licenses/:id')
  @HttpCode(HttpStatus.OK)
  async patchLicense(
    @Param('id') licenseId: string,
    @Body() body: { status?: string; expires_at?: string | null },
    @Headers('x-admin-key') key: string | undefined,
  ) {
    this.verify(key);
    if (!this.supabase)
      throw new InternalServerErrorException('Supabase not configured');

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body?.status !== undefined) updates.status = body.status;
    if (body?.expires_at !== undefined) updates.expires_at = body.expires_at;

    const { error } = await this.supabase
      .from('licenses')
      .update(updates)
      .eq('id', licenseId);

    if (error) throw new InternalServerErrorException(error.message);
    return { ok: true };
  }

  // ── Command dispatch ──────────────────────────────────────────────────

  /**
   * POST /admin/commands
   * Dispatches a remote command to any engine without ownership check.
   * Body: { engine_id: string, command_type: string }
   */
  @Post('commands')
  @HttpCode(HttpStatus.CREATED)
  async issueCommand(
    @Body() body: { engine_id?: string; command_type?: string },
    @Headers('x-admin-key') key: string | undefined,
  ) {
    this.verify(key);

    const engineId = body?.engine_id?.trim();
    const commandType = body?.command_type?.trim();
    if (!engineId) throw new BadRequestException('engine_id is required');
    if (!commandType || !ALLOWED_COMMAND_TYPES.has(commandType)) {
      throw new BadRequestException(
        `command_type must be one of: ${[...ALLOWED_COMMAND_TYPES].join(', ')}`,
      );
    }

    const result = await this.commands.createAdmin(engineId, commandType);
    if (!result.ok || !result.command) {
      if (result.error?.includes('not found'))
        throw new NotFoundException(result.error);
      throw new InternalServerErrorException(
        result.error ?? 'Command creation failed',
      );
    }

    const command = result.command;
    const delivered = this.engines.sendToEngine(engineId, commandType, {
      command_id: command.id,
      command_type: commandType,
      issued_at: command.created_at,
      expires_at: command.expires_at,
    });

    if (delivered) void this.commands.markDelivered(command.id);

    return {
      command_id: command.id,
      command_type: commandType,
      status: delivered ? 'delivered' : 'pending',
      delivered,
      expires_at: command.expires_at,
    };
  }

  // ── Live registry read ────────────────────────────────────────────────

  /**
   * GET /admin/connected-engines
   * Returns a snapshot of all currently connected engine IDs from the
   * in-memory registry (complement to Supabase device rows).
   */
  @Get('connected-engines')
  connectedEngines(@Headers('x-admin-key') key: string | undefined) {
    this.verify(key);
    return { engines: this.engines.connectedEngineIds() };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private verify(key: string | undefined): void {
    if (!this.adminKey)
      throw new InternalServerErrorException('Admin key not configured');
    if (!key || key !== this.adminKey)
      throw new ForbiddenException('Invalid admin key');
  }

  private async verifyAdminJwt(authHeader: string | undefined): Promise<{ email: string }> {
    const token = authHeader?.replace(/^bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Missing Authorization header');
    if (!this.supabase) throw new InternalServerErrorException('Auth not configured');

    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) throw new UnauthorizedException('Invalid token');

    const email = (data.user.email ?? '').toLowerCase();
    if (!this.adminEmails.length || !this.adminEmails.includes(email))
      throw new ForbiddenException('Not an admin');

    return { email };
  }
}
