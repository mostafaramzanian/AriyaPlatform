# Phase C.1.8 — Enterprise Request/Response Instrumentation & Tracing

## Overview
This phase implements request-level observability through:
- **Request ID Generation**: Unique identifier per request (x-request-id header)
- **Correlation ID Tracking**: Trace related requests across services (x-correlation-id header)
- **Request Context Storage**: AsyncLocalStorage for context access throughout request lifetime
- **Audit Integration**: Automatic context injection into audit logs
- **Performance Tracking**: Request duration measurement

## Architecture

### Components

#### RequestContextMiddleware (apps/api/src/common/middleware/request-context.middleware.ts)
- Runs on every request
- Generates requestId and correlationId (or uses provided correlationId)
- Stores context in AsyncLocalStorage
- Sets response headers (x-request-id, x-correlation-id)

#### RequestContextService (apps/api/src/common/request-context.service.ts)
- Provides access to request context throughout the application
- Exposed via AsyncLocalStorage (thread-safe in Node.js)
- Available in services, guards, interceptors, exception filters
- Methods:
  - `get()` — retrieve full context
  - `getRequestId()` — extract request ID
  - `getCorrelationId()` — extract correlation ID
  - `getUserId()` — extract user ID (set by auth guard)
  - `getDurationMs()` — measure elapsed time since request start

#### Integration Points

**AppModule**
- Registers RequestContextService as provider
- Applies RequestContextMiddleware to all routes

**BlogService**
- Injects RequestContextService
- `getAuditContext()` helper pulls request context for audit logs
- All audit.log calls now include requestId, correlationId, ip, userAgent

**AuditService**
- Receives context fields via audit options
- Persists with every audit record

## Data Flow

```
HTTP Request
    ↓
[RequestContextMiddleware]
  - Generate requestId (UUID)
  - Extract/Generate correlationId
  - Store in AsyncLocalStorage
  - Set response headers
    ↓
[Auth/Guards/Interceptors]
  - Can access RequestContextService.get()
  - Add userId to context if authenticated
    ↓
[BlogService.createPost()]
  - Calls this.getAuditContext()
  - Pulls requestId, correlationId from context
  - Passes to auditService.log()
    ↓
[AuditService.log()]
  - Persists audit record with context fields
  - Publishes to RabbitMQ
    ↓
HTTP Response
  - Headers: x-request-id, x-correlation-id
```

## Usage Examples

### Accessing Context in Services
```typescript
constructor(private requestContextService: RequestContextService) {}

async someMethod() {
  const requestId = RequestContextService.get()?.requestId;
  const userId = RequestContextService.get()?.userId;
  const elapsed = this.requestContextService.getDurationMs();
}
```

### Audit Log with Context
```typescript
const ctx = this.getAuditContext(); // BlogService helper
await this.auditService?.log({
  ...ctx,  // spreads requestId, correlationId, userId, ip, userAgent
  action: 'created',
  resource: 'blog',
  resourceId: created.id,
  oldValue: null,
  newValue: created,
  success: true,
});
```

### Distributed Tracing
All related requests share same `correlationId` via header:
```bash
curl -H "X-Correlation-ID: abc123" http://localhost:3001/api/v1/blog
# Response headers include:
# x-request-id: f47ac10b-58cc-4372-a567-0e02b2c3d479
# x-correlation-id: abc123
```

## Database Schema

AuditLog table now captures:
- `requestId` (UUID) — unique to this request
- `correlationId` (UUID) — shared across related operations
- `ipAddress` — client IP from middleware
- `userAgent` — client User-Agent header
- `userId` — authenticated user ID
- `sessionId` — session identifier

Example query to trace request:
```sql
SELECT * FROM "AuditLog" WHERE requestId = 'f47ac10b-...' ORDER BY timestamp;
```

Example query to trace correlation:
```sql
SELECT * FROM "AuditLog" WHERE correlationId = 'abc123' ORDER BY timestamp;
```

## Configuration

Environment variables (.env):
```bash
LOG_LEVEL=info                    # Pino log level
CORRELATION_ID_HEADER=x-correlation-id  # Header name (default)
REQUEST_ID_HEADER=x-request-id          # Header name (default)
```

## Observability

### Request Tracing
1. Client sends optional `X-Correlation-ID` header
2. Middleware assigns unique `X-Request-ID` per request
3. Both headers returned in response
4. Audit log captures both IDs
5. Search audit logs by either ID

### Performance Metrics
RequestContextService.getDurationMs() available in:
- Interceptors (for response time tracking)
- Exception filters (for error timing)
- Services (for operation-specific timing)

### Log Enrichment
Every Pino log entry automatically includes:
- `requestId` (via AsyncLocalStorage context)
- `correlationId` (via AsyncLocalStorage context)
- `userId` (via AsyncLocalStorage context, if authenticated)

## Security Considerations

- **No sensitive data in headers** — requestId/correlationId are opaque UUIDs
- **PII protection** — audit redaction filters sensitive fields before persistence
- **Context isolation** — AsyncLocalStorage prevents context leakage between requests
- **Header injection** — correlationId accepts user input (safe; just UUID string)

## Testing

### Unit Tests (blog.service.spec.ts)
- ✅ Mock RequestContextService in tests
- ✅ Tests verify audit context propagation

### Integration Tests (to be added)
- Verify request/correlation ID headers in responses
- Verify audit logs capture context correctly
- Verify AsyncLocalStorage isolation between concurrent requests

## Future Enhancements

1. **OpenTelemetry Integration**
   - Use correlationId as trace ID
   - Automatic span creation per endpoint
   - Export to Jaeger/DataDog

2. **Distributed Tracing**
   - Propagate correlationId to downstream services (API → Cache → DB)
   - Trace requests across microservices

3. **Request Lifecycle Hooks**
   - Before/After middleware for custom instrumentation
   - Request/Response logging interceptor

4. **Analytics**
   - Query audit logs for metrics (avg response time, error rate, etc.)
   - Per-user activity tracking
   - Access pattern analysis

## References

- Express Middleware: https://expressjs.com/en/guide/using-middleware.html
- AsyncLocalStorage: https://nodejs.org/api/async_context.html#async_context_class_asynclocalstorage
- Distributed Tracing: https://opentelemetry.io/docs/concepts/what-is-opentelemetry/
