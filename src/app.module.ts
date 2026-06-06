import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import gatewayConfig from './config/gateway.config';
import { EngineConnectionsModule } from './engine-connections/engine-connections.module';
import { ProtocolModule } from './protocol/protocol.module';
import { RoomsModule } from './rooms/rooms.module';
import { SignalEngineModule } from './signal-engine/signal-engine.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [gatewayConfig],
    }),
    ProtocolModule,
    RoomsModule,
    EngineConnectionsModule,
    SignalEngineModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
