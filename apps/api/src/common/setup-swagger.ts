import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication, configService: ConfigService): void {
  // Only enable Swagger if ENABLE_SWAGGER env var is explicitly set to 'true'
  const enabled = (configService.get<string>('ENABLE_SWAGGER') || '').toLowerCase() === 'true';
  if (!enabled) return;

  const apiVersion = '1.0.0';
  const config = new DocumentBuilder()
    .setTitle('Aria ERP API')
    .setDescription('Enterprise Resource Planning System - API Documentation')
    .setVersion(apiVersion)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT token',
      },
      'bearer',
    )
    .addServer(configService.get<string>('API_URL') || 'http://localhost:3001')
    .addTag('Auth', 'Authentication endpoints')
    .addTag('Users', 'User management endpoints')
    .addTag('Leads', 'Lead management endpoints')
    .addTag('Health', 'Health check endpoints')
    .addTag('Admin', 'Admin endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);
}
