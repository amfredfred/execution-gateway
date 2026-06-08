import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/**
 * Global module — import once in AppModule.
 * RateLimitService is then available for injection everywhere.
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports:   [RateLimitService],
})
export class RateLimitModule {}
