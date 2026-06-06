export const PROTOCOL_VERSION = '1.0' as const;

export const EVENT_SCHEMA_FILES: Record<string, string> = {
  'activation.request': 'activation-request.schema.json',
  'engine.hello': 'engine-hello.schema.json',
  'engine.heartbeat': 'engine-heartbeat.schema.json',
  'room.subscribe': 'room-subscription.schema.json',
  'room.unsubscribe': 'room-subscription.schema.json',
  'telemetry.snapshot': 'telemetry-snapshot.schema.json',
  'execution.lifecycle': 'execution-lifecycle.schema.json',
  'signal.deliver': 'signal-deliver.schema.json',
  'command.pause': 'command.schema.json',
  'command.resume': 'command.schema.json',
  'command.emergency_stop': 'command.schema.json',
  'command.completed': 'command-result.schema.json',
  'command.failed': 'command-result.schema.json',
};
