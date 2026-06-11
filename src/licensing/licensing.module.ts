import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LicenseController } from './license.controller';
import { LicenseService } from './license.service';
import { ActivationController } from './activation.controller';
import { DeviceController } from './device.controller';

@Module({
  imports: [ConfigModule],
  controllers: [LicenseController, ActivationController, DeviceController],
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicensingModule {}
