import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { RequestContextService, RequestContext } from '../request-context.service';

/**
 * File-scoped augmentation of the Express request with the three context
 * fields this middleware writes. `declare module 'express-serve-static-core'`
 * (the module that declares Express's `Request` interface) is preferred over
 * `declare global { namespace Express }` — same reachability, no namespace
 * declaration (`@typescript-eslint/no-namespace`).
 */
declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    correlationId?: string;
    startTime?: number;
  }
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Generate or extract IDs
    const requestId = randomUUID();
    const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
    const startTime = Date.now();

    // Attach to request
    req.requestId = requestId;
    req.correlationId = correlationId;
    req.startTime = startTime;

    // Set response headers
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-correlation-id', correlationId);

    // Set context in AsyncLocalStorage for request lifecycle
    const context: RequestContext = {
      requestId,
      correlationId,
      startTime,
    };
    RequestContextService.set(context);

    next();
  }
}
