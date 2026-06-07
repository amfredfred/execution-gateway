import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EngineConnectionsModule } from '../engine-connections/engine-connections.module';
import { CommandController } from './command.controller';

@Module({
  imports: [ConfigModule, EngineConnectionsModule],
  controllers: [CommandController],
})
export class CommandsModule {}
