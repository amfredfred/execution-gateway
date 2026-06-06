import { Module } from '@nestjs/common';
import { RoomRegistryService } from './room-registry.service';

@Module({
  providers: [RoomRegistryService],
  exports: [RoomRegistryService],
})
export class RoomsModule {}
