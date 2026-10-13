import { NestFactory } from '@nestjs/core';
import { Logger, UnprocessableEntityException, ValidationPipe, WebSocketAdapter } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger as PinoLogger } from 'nestjs-pino';
import { initializeOpenTelemetry } from './common/otel-bootstrap';
import { CoreAppModule } from './core-app.module';
import { setupSwagger } from './common/setup-swagger';
import { buildCorsOrigin } from './config/env.validation';
import { TOKEN_JWKS_PATH } from './platform/auth/token-contract';
import helmet from 'helmet';
import { ValidationError } from 'class-validator';

// Phase 33K: independent Core process entrypoint. Boots only Core modules
// (Auth, Users, RBAC, Health, Storage, AI, Notifications) against
// CORE_DATABASE_URL. Never imports BlogModule or the CMS Prisma client.
initializeOpenTelemetry();

const logger = new Logger('CoreBootstrap');

async function bootstrap() {
  const app = await NestFactory.create(CoreAppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const configService = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      stopAtFirstError: false,
      transformOptions: {
        enableImplicitConversion: true,
      },
      exceptionFactory: (errors: ValidationError[]) => {
        const details = errors.map((error) => ({
          property: error.property,
          constraints: error.constraints,
          children: error.children?.map((child) => child.property),
        }));
        return new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: 'Validation failed',
          details,
        });
      },
    }),
  );

  app.use(helmet());

  const corsOrigins = buildCorsOrigin({
    CORS_ORIGINS: configService.get<string>('CORS_ORIGINS'),
    CORS_ORIGIN: configService.get<string>('CORS_ORIGIN'),
  });
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  // API version prefix.
  //
  // Phase 52-ARCH-3C: `/.well-known/jwks.json` is EXCLUDED from the prefix, exactly as in the
  // combined bootstrap (`main.ts`). Core is the ISSUER, so Core is the process that publishes the
  // keys — and the path it publishes them at is a contract: a verifier points `JWT_JWKS_URI` at
  // the root location (see `.env.example`), and the ADR fixes the venue as the issuer's own
  // process rather than a second deployment. Without the exclusion this bootstrap would serve the
  // document at `/api/v1/.well-known/jwks.json` and 404 at the documented root path, which is
  // precisely the deployment that Core runs in (`node dist/core-main.js`). Exactly this path is
  // excluded, so no existing route moves.
  app.setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] });

  // Phase 49F: Internal Messaging runs on raw `ws` (RFC 6455) via
  // @nestjs/platform-ws, sharing this process's HTTP server on /ws/messaging.
  // Deliberately NOT Socket.IO — no fallback transports and no extra framing, so a
  // plain browser WebSocket can connect. Registered before listen() so the upgrade
  // handler is attached to the server that actually starts.
  //
  // The global prefix does not apply to WebSocket paths, so the gateway path stays
  // /ws/messaging rather than /api/v1/ws/messaging.
  // The cast bridges a declaration-only mismatch: @nestjs/common 11.1.28 added
  // `isAckHandledManually` to WsMessageHandler, while @nestjs/websockets /
  // @nestjs/platform-ws 11.1.6 still describe handlers as MessageMappingProperties.
  // Nothing at runtime is affected — websockets 11.1.6 both produces and consumes
  // those handler objects, and platform-ws 11.1.6 only reads `message`/`callback`,
  // which are present in both shapes. Drop the cast once websockets/platform-ws are
  // upgraded in lockstep with @nestjs/common.
  app.useWebSocketAdapter(new WsAdapter(app) as unknown as WebSocketAdapter);

  setupSwagger(app, configService);

  const port = configService.get<number>('CORE_PORT') || configService.get<number>('PORT') || 3001;
  await app.listen(port);

  logger.log(`Core process running on: http://localhost:${port}`);
  logger.log(`Swagger docs available at: http://localhost:${port}/api/v1/docs`);
}

bootstrap().catch((err) => {
  logger.error('Failed to start Core process:', err);
  process.exit(1);
});
