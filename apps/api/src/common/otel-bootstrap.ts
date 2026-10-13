import { Logger } from '@nestjs/common';

const logger = new Logger('OpenTelemetry');

export function initializeOpenTelemetry() {
  try {
    const otelEnabled = process.env.OTEL_ENABLED === 'true';
    if (!otelEnabled) {
      logger.log('OpenTelemetry disabled (set OTEL_ENABLED=true to enable in Phase B)');
      return;
    }

    logger.log('OpenTelemetry enabled - full implementation in Phase B');
    logger.log(`OTEL_EXPORTER_OTLP_ENDPOINT: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces'}`);
  } catch (error) {
    logger.error('Failed to initialize OpenTelemetry:', error);
  }
}

