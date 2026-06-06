import { ProtocolService } from './protocol.service';
import { ConfigService } from '@nestjs/config';

describe('ProtocolService', () => {
  let service: ProtocolService;

  beforeEach(() => {
    service = new ProtocolService(new ConfigService());
    service.onModuleInit();
  });

  it('accepts a valid engine heartbeat', () => {
    const result = service.validate({
      protocol_version: '1.0',
      message_id: 'message_heartbeat_001',
      event: 'engine.heartbeat',
      sent_at: '2026-06-06T12:00:00.000Z',
      payload: {
        engine_id: 'engine_device_001',
        status: 'running',
        sequence: 42,
        observed_at: '2026-06-06T12:00:00.000Z',
        mt5_connected: true,
        signal_queue_depth: 0,
      },
    });

    expect(result.valid).toBe(true);
  });

  it('rejects private or unsupported events', () => {
    const result = service.validate({
      protocol_version: '1.0',
      message_id: 'message_private_001',
      event: 'signal.pending',
      sent_at: '2026-06-06T12:00:00.000Z',
      payload: {},
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Unsupported protocol event');
  });

  it('accepts a symbol room subscription', () => {
    const result = service.validate({
      protocol_version: '1.0',
      message_id: 'message_room_subscribe_001',
      event: 'room.subscribe',
      sent_at: '2026-06-06T12:00:00.000Z',
      payload: {
        engine_id: 'engine_device_001',
        symbols: ['XAUUSD'],
        ttl_seconds: 3600,
      },
    });

    expect(result.valid).toBe(true);
  });
});
