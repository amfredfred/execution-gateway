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
    activationKeyPepper:          process.env.ACTIVATION_KEY_PEPPER,
    variantStarterMonthly:        process.env.LS_VARIANT_STARTER_MONTHLY        ? Number(process.env.LS_VARIANT_STARTER_MONTHLY)        : undefined,
    variantStarterYearly:         process.env.LS_VARIANT_STARTER_YEARLY         ? Number(process.env.LS_VARIANT_STARTER_YEARLY)         : undefined,
    variantProMonthly:            process.env.LS_VARIANT_PRO_MONTHLY            ? Number(process.env.LS_VARIANT_PRO_MONTHLY)            : undefined,
    variantProYearly:             process.env.LS_VARIANT_PRO_YEARLY             ? Number(process.env.LS_VARIANT_PRO_YEARLY)             : undefined,
    variantInfrastructure:        process.env.LS_VARIANT_INFRASTRUCTURE         ? Number(process.env.LS_VARIANT_INFRASTRUCTURE)         : undefined,
  },
  webhooks: {
    lemonSqueezySecret: process.env.LEMON_SQUEEZY_WEBHOOK_SECRET,
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',   // true for port 465
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM ?? 'Apex Quantel <noreply@apexquantel.io>',
  },
  billing: {
    lsApiKey:  process.env.LS_API_KEY,
    lsStoreId: process.env.LS_STORE_ID,
  },
  dashboard: {
    url: process.env.DASHBOARD_URL ?? 'https://app.apexquantel.io',
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
