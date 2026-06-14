export default () => ({
  runtime: {
    environment: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 4000),
    publicUrl: process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000',
    corsOrigin: process.env.GATEWAY_CORS_ORIGIN ?? '*',
  },
  protocol: {
    schemaDirectory: process.env.APEX_PROTOCOL_SCHEMA_DIR,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  licensing: {
    activationKeyPepper: process.env.ACTIVATION_KEY_PEPPER,
  },
  webhooks: {
    paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM ?? 'Apex Quantel <noreply@apexquantel.io>',
  },
  admin: {
    key: process.env.GATEWAY_ADMIN_KEY,
    emails: (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  },
  billing: {
    paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  },
  dashboard: {
    url: process.env.DASHBOARD_URL ?? 'https://app.apexquantel.io',
  },
  connections: {
    heartbeatIntervalSeconds: Number(process.env.ENGINE_HEARTBEAT_INTERVAL_SECONDS ?? 30),
    offlineAfterSeconds: Number(process.env.ENGINE_OFFLINE_AFTER_SECONDS ?? 90),
    maximum: Number(process.env.MAX_ENGINE_CONNECTIONS ?? 1000),
  },
  rooms: {
    defaultTtlSeconds: Number(process.env.ROOM_DEFAULT_TTL_SECONDS ?? 3600),
    evictionIntervalSeconds: Number(process.env.ROOM_EVICTION_INTERVAL_SECONDS ?? 15),
  },
  signalEngine: {
    url: process.env.SIGNAL_ENGINE_WS_URL ?? 'ws://localhost:8765',
    secret: process.env.SIGNAL_ENGINE_WS_SECRET,
    reconnectDelayMs: Number(process.env.SIGNAL_ENGINE_RECONNECT_DELAY_MS ?? 1000),
  },
  engineRegistry: {
    // Seconds without a heartbeat before an engine is marked stale.
    staleAfterSeconds: Number(process.env.ENGINE_STALE_AFTER_SECONDS ?? 30),
    // Seconds without a heartbeat before an engine is marked offline.
    offlineAfterSeconds: Number(process.env.ENGINE_OFFLINE_AFTER_SECONDS ?? 90),
  },
});
