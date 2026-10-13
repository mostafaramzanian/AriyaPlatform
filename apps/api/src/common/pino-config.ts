import type { Request, Response } from 'express';

export function getPinoHttpConfig() {
  return {
    transport: {
      target: 'pino-pretty',
      options: {
        singleLine: false,
        colorize: process.env.NODE_ENV !== 'production',
      },
    },
    serializers: {
      req(request: Request) {
        return {
          method: request.method,
          url: request.url,
          headers: request.headers,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        };
      },
      res(reply: Response) {
        return {
          statusCode: reply.statusCode,
          headers: reply.getHeaders(),
        };
      },
    },
    autoLogging: true,
    level: process.env.LOG_LEVEL || 'info',
  };
}

/**
 * Paths redacted from every pino-http request/response log line. Node lowercases
 * incoming header names, but the wildcard + capitalised variants also cover
 * headers copied in by custom serializers or raw request objects.
 */
export const AUTHORIZATION_REDACT_PATHS = {
  paths: [
    'req.headers.authorization',
    'req.headers.Authorization',
    'req.raw.headers.authorization',
    'req.raw.headers.Authorization',
    '*.headers.authorization',
    '*.headers.Authorization',
  ],
  censor: '[REDACTED]',
};


export const pinoLoggerConfig = {
  pinoHttp: {
    transport: {
      target: 'pino/file',
      options: {
        destination: '/dev/stdout',
        sync: true,
      },
    },
    level: process.env.LOG_LEVEL || 'info',
    timestamp: true,
    customProps: () => ({
      service: 'aria-erp-api',
      environment: process.env.NODE_ENV || 'development',
    }),
  },
};
