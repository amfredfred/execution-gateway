import { Module } from '@nestjs/common';
import { DashboardConnectionsModule } from '../dashboard-connections/dashboard-connections.module';
import { RoomsModule } from '../rooms/rooms.module';
import { SignalEngineSubscriberService } from './signal-engine-subscriber.service';

@Module({
  imports: [RoomsModule, DashboardConnectionsModule],
  providers: [SignalEngineSubscriberService],
})
export class SignalEngineModule {}
