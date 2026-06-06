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

  it('accepts an execution lifecycle transition without a signal payload', () => {
    const result = service.validate({
      protocol_version: '1.0',
      message_id: 'message_lifecycle_001',
      event: 'execution.lifecycle',
      sent_at: '2026-06-06T12:00:00.000Z',
      payload: {
        engine_id: 'engine_device_001',
        signal_id: 'signal_reference_001',
        account_login: '106189638',
        stage: 'opened',
        trade_id: 'trade_reference_001',
        broker_ticket: '123456',
        observed_at: '2026-06-06T12:00:00.000Z',
      },
    });

    expect(result.valid).toBe(true);
    expect(result.message?.payload).not.toHaveProperty('signal');
  });
});
