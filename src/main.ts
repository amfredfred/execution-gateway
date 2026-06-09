import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true enables req.rawBody for webhook signature verification.
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error', 'warn', 'log'] });
  const config = app.get(ConfigService);

  // Allow the customer dashboard origin to call HTTP endpoints.
  // In production, restrict this to the deployed dashboard URL via
  // GATEWAY_CORS_ORIGIN env var.
  const corsRaw = config.get<string>('runtime.corsOrigin') ?? '*';
  // Support comma-separated list of origins, e.g.:
  //   GATEWAY_CORS_ORIGIN=https://app.somicast.com,http://localhost:3000
  const corsOrigin: string | string[] =
    corsRaw === '*'
      ? '*'
      : corsRaw.includes(',')
        ? corsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : corsRaw;
  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: corsOrigin !== '*',
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  await app.listen(config.get<number>('runtime.port', 4000));
}

void bootstrap();
