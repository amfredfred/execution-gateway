import { Module } from '@nestjs/common';
import { ProtocolService } from './protocol.service';

@Module({
  providers: [ProtocolService],
  exports: [ProtocolService],
})
export class ProtocolModule {}
