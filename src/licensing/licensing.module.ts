import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LicenseController } from './license.controller';
import { LicenseService } from './license.service';

@Module({
  imports: [ConfigModule],
  controllers: [LicenseController],
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicensingModule {}
