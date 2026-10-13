import { NestFactory } from '@nestjs/core';
import { Logger, UnprocessableEntityException, ValidationPipe, WebSocketAdapter } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger as PinoLogger } from 'nestjs-pino';
import { initializeOpenTelemetry } from './common/otel-bootstrap';
import { AppModule } from './app.module';
import { setupSwagger } from './common/setup-swagger';
import { buildCorsOrigin } from './config/env.validation';
import { TOKEN_JWKS_PATH } from './platform/auth/token-contract';
import helmet from 'helmet';
import { ValidationError } from 'class-validator';

// Initialize OpenTelemetry first (before creating app)
initializeOpenTelemetry();

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const configService = app.get(ConfigService);

  // Global pipes
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

  // Security headers
  app.use(helmet());

  // CORS
  // Phase 49S-1: origin allowlist must be explicit. Wildcard is rejected when
  // credentials are enabled. The allowlist is empty only when no origins are
  // configured and the request has no origin (server-to-server, curl, etc.).
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
  // Phase 52-ARCH-3C: `/.well-known/jwks.json` is EXCLUDED from the prefix. That URL is a
  // contract for OTHER runtimes rather than an API of this one — a verifier points
  // `JWT_JWKS_URI` at it (see `.env.example`) — and a well-known location belongs at the root:
  // a versioned prefix there would make every verifier depend on which API version happened to
  // serve the keys it needs. Exactly this path is excluded, so no existing route moves.
  app.setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] });

  // Phase 49F: Internal Messaging runs on raw `ws` (RFC 6455) via
  // @nestjs/platform-ws, sharing this process's HTTP server. This mirrors the
  // Core bootstrap and avoids a runtime dependency on @nestjs/platform-socket.io.
  app.useWebSocketAdapter(new WsAdapter(app) as unknown as WebSocketAdapter);

  // Swagger documentation
  setupSwagger(app, configService);

  const port = configService.get<number>('PORT') || 3001;
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
  logger.log(`Swagger docs available at: http://localhost:${port}/api/v1/docs`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  logger.error('Failed to start application:', err);
  process.exit(1);
});
