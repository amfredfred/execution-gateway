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
  private readonly supabase?: SupabaseClient;

  constructor(
    private readonly licenses: LicenseService,
    private readonly engines: ConnectionRegistryService,
    private readonly commands: RemoteCommandService,
    config: ConfigService,
  ) {
    this.adminKey = config.get<string>('admin.key');
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
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
}
