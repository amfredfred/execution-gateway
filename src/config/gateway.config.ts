export default () => ({
  runtime: {
    environment: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 4000),
    publicUrl: process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000',
  },
  protocol: {
    schemaDirectory: process.env.TRADERELAY_PROTOCOL_SCHEMA_DIR,
  },
  licensing: {
    licensesJson: process.env.ACTIVATION_LICENSES_JSON ?? '[]',
  },
  connections: {
    heartbeatIntervalSeconds: Number(
      process.env.ENGINE_HEARTBEAT_INTERVAL_SECONDS ?? 30,
    ),
    offlineAfterSeconds: Number(process.env.ENGINE_OFFLINE_AFTER_SECONDS ?? 90),
    maximum: Number(process.env.MAX_ENGINE_CONNECTIONS ?? 1000),
  },
  rooms: {
    defaultTtlSeconds: Number(process.env.ROOM_DEFAULT_TTL_SECONDS ?? 3600),
    evictionIntervalSeconds: Number(
      process.env.ROOM_EVICTION_INTERVAL_SECONDS ?? 15,
    ),
  },
  signalEngine: {
    url: process.env.SIGNAL_ENGINE_WS_URL ?? 'ws://localhost:8765',
    secret: process.env.SIGNAL_ENGINE_WS_SECRET,
    reconnectDelayMs: Number(
      process.env.SIGNAL_ENGINE_RECONNECT_DELAY_MS ?? 1000,
    ),
  },
});
