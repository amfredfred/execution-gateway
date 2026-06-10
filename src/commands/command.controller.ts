import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { ConnectionRegistryService } from '../engine-connections/connection-registry.service';
import { RemoteCommandService } from './remote-command.service';

const ALLOWED_COMMAND_TYPES = new Set([
  'command.pause',
  'command.resume',
  'command.emergency_stop',
]);

interface IssueCommandBody {
  engine_id?: string;
  command_type?: string;
}

@Controller('commands')
export class CommandController {
  private readonly supabase?: SupabaseClient;

  constructor(
    private readonly commands: RemoteCommandService,
    private readonly engines: ConnectionRegistryService,
    config: ConfigService,
  ) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  /**
   * POST /commands
   *
   * Issues a remote command to a connected execution engine.
   * The caller must own the target engine.
   *
   * Body: { engine_id: string, command_type: "command.pause" | "command.resume" | "command.emergency_stop" }
   *
   * Response 201: { command_id, status, command_type, expires_at, delivered }
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async issue(
    @Body() body: IssueCommandBody,
    @Headers('authorization') authHeader: string | undefined,
  ) {
    const user = await this.resolveUser(authHeader);

    const engineId = body?.engine_id?.trim();
    const commandType = body?.command_type?.trim();

    if (!engineId) throw new BadRequestException('engine_id is required');
    if (!commandType || !ALLOWED_COMMAND_TYPES.has(commandType)) {
      throw new BadRequestException(
        `command_type must be one of: ${[...ALLOWED_COMMAND_TYPES].join(', ')}`,
      );
    }

    // Create command record in Supabase (ownership verified inside RPC)
    const result = await this.commands.create(user.id, engineId, commandType);
    if (!result.ok || !result.command) {
      if (
        result.error?.includes('not found') ||
        result.error?.includes('not owned')
      ) {
        throw new ForbiddenException(result.error);
      }
      throw new InternalServerErrorException(
        result.error ?? 'Command creation failed',
      );
    }

    const command = result.command;

    // Deliver to the engine if it is currently connected
    const delivered = this.engines.sendToEngine(engineId, commandType, {
      command_id: command.id,
      command_type: commandType,
      issued_at: command.created_at,
      expires_at: command.expires_at,
    });

    if (delivered) {
      void this.commands.markDelivered(command.id);
    }

    return {
      command_id: command.id,
      command_type: commandType,
      status: delivered ? 'delivered' : 'pending',
      delivered,
      expires_at: command.expires_at,
      created_at: command.created_at,
    };
  }

  /**
   * GET /commands/:id
   *
   * Returns the current status of a command.
   * Caller must own the command.
   *
   * Response 200: full command record
   */
  @Get(':id')
  async getStatus(
    @Param('id') commandId: string,
    @Headers('authorization') authHeader: string | undefined,
  ) {
    const user = await this.resolveUser(authHeader);
    const command = await this.commands.getCommand(commandId, user.id);
    if (!command) throw new NotFoundException('Command not found');
    return command;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async resolveUser(authHeader: string | undefined): Promise<User> {
    const token = authHeader?.replace(/^bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Missing Authorization header');
    if (!this.supabase)
      throw new InternalServerErrorException('Auth not configured');

    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user)
      throw new UnauthorizedException('Invalid or expired token');

    return data.user;
  }
}
