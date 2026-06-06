import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { SignalEngineSubscriberService } from './signal-engine-subscriber.service';

@Module({
  imports: [RoomsModule],
  providers: [SignalEngineSubscriberService],
})
export class SignalEngineModule {}
