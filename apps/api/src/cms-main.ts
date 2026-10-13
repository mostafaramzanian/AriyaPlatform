import { NestFactory } from '@nestjs/core';
import { Logger, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import { initializeOpenTelemetry } from './common/otel-bootstrap';
import { CmsAppModule } from './cms-app.module';
import { setupSwagger } from './common/setup-swagger';
import helmet from 'helmet';
import { buildCorsOrigin } from './config/env.validation';
import { TOKEN_JWKS_PATH } from './platform/auth/token-contract';
import { ValidationError } from 'class-validator';

// Phase 33K: independent CMS process entrypoint. Boots CMS's own business
// modules against CMS_DATABASE_URL (never imports Core's Prisma client for
// CMS's own data), plus AuthModule for request authentication/authorization,
// which requires CORE_DATABASE_URL — see cms-app.module.ts for why.
initializeOpenTelemetry();

const logger = new Logger('CmsBootstrap');

async function bootstrap() {
  const app = await NestFactory.create(CmsAppModule, { bufferLogs: true });
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

  // Phase ARCH-1.2: CMS uses the same centralized CORS policy as Core/Combined.
  // Wildcard with credentials is forbidden; production requires explicit origins.
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
  // combined bootstrap (`main.ts`) and the Core bootstrap (`core-main.ts`). This runtime binds
  // `AuthModule`, so it registers the JWKS route and would otherwise serve it under the version
  // prefix — while a verifier points `JWT_JWKS_URI` at the root location this platform documents.
  // Exactly this path is excluded, so no existing route moves.
  app.setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] });

  setupSwagger(app, configService);

  const port = configService.get<number>('CMS_PORT') || 3002;
  await app.listen(port);

  logger.log(`CMS process running on: http://localhost:${port}`);
  logger.log(`Swagger docs available at: http://localhost:${port}/api/v1/docs`);
}

bootstrap().catch((err) => {
  logger.error('Failed to start CMS process:', err);
  process.exit(1);
});
