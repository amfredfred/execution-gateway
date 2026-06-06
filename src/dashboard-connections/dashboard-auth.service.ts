import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';

@Injectable()
export class DashboardAuthService {
  private readonly logger = new Logger(DashboardAuthService.name);
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

  async verify(accessToken: string): Promise<User | null> {
    if (!this.supabase || !accessToken) return null;
    const { data, error } = await this.supabase.auth.getUser(accessToken);
    if (error) {
      this.logger.warn(`Dashboard authentication rejected: ${error.message}`);
      return null;
    }
    return data.user;
  }
}
