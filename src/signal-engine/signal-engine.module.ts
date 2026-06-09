import { Global, Module } from '@nestjs/common';
import { DashboardConnectionsModule } from '../dashboard-connections/dashboard-connections.module';
import { RoomsModule } from '../rooms/rooms.module';
import { SignalEngineSubscriberService } from './signal-engine-subscriber.service';

@Global()
@Module({
  imports: [RoomsModule, DashboardConnectionsModule],
  providers: [SignalEngineSubscriberService],
  exports: [SignalEngineSubscriberService],
})
export class SignalEngineModule {}
