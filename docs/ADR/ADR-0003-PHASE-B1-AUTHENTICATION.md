# ADR-0003: Phase B.1 - Authentication System Design

**Date:** 2026-07-28  
**Status:** APPROVED  
**Phase:** B.1 (Authentication)  
**Context:** Production-grade authentication with JWT, refresh token rotation, email verification

---

## Problem Statement

Aria ERP requires a production-ready authentication system that:
1. Issues and validates JWT access tokens (15-minute expiration)
2. Manages refresh token rotation (30-day expiration, hashed in database)
3. Supports email verification workflow
4. Supports password reset workflow
5. Publishes domain events instead of sending emails directly
6. Maintains sessions in Redis
7. Supports "Remember Me" functionality
8. Provides foundation for RBAC (Phase B.2)

---

## Decisions

### 1. JWT Strategy
- **Choice:** JWT with 15-minute access token expiration
- **Stateless:** Scalable across multiple instances
- **Payload:** `{sub, email, role, iat, exp}`

### 2. Refresh Token Strategy
- **Choice:** Hashed tokens in PostgreSQL, 30-day expiration
- **Rotation:** Old token revoked when new token issued
- **Process:** Login → Issue access + refresh → User submits refresh → Validate hash → Issue new pair

### 3. Password Security
- **Choice:** bcryptjs (12 rounds)
- **Storage:** Never plaintext, always hashed

### 4. Email Verification
- **Choice:** 24-hour secure random tokens, one-time use
- **Events:** Auth module publishes → RabbitMQ → Email consumer
- **Process:** Register → Send verification email → Click link → Verify

### 5. Password Reset
- **Choice:** 2-hour secure random tokens, one-time use
- **Events:** Publish event → Email consumer sends link
- **Process:** Forgot password → Send reset link → Click → New password

### 6. Session Management
- **Choice:** Redis for session storage + optional "Remember Me"
- **Cookie:** Secure HTTP-only cookie with refresh token ID
- **TTL:** 30 days (matching refresh token expiration)

### 7. Event-Driven Architecture
- **Never:** Send emails directly from AuthService
- **Always:** Publish events to RabbitMQ
- **Events:** user.registered, email.verification.requested, password.reset.requested, user.logged_in, user.logged_out

### 8. "Remember Me" Implementation
- **Method:** Secure HTTP-only cookie + refresh token ID
- **Cookie:** `__Host-refreshToken` (HTTP-only, Secure, SameSite=Strict)
- **Process:** Store refresh token ID in cookie, validate on refresh requests

---

## Folder Structure

```
apps/api/src/auth/
├── auth.module.ts                    # Module registration
├── auth.service.ts                   # Core business logic
├── auth.controller.ts                # HTTP endpoints
├── refresh-token.service.ts          # Token management
│
├── dto/
│   ├── register.dto.ts
│   ├── login.dto.ts
│   ├── refresh-token.dto.ts
│   ├── forgot-password.dto.ts
│   ├── reset-password.dto.ts
│   ├── verify-email.dto.ts
│   └── auth-response.dto.ts          # NEW
│
├── strategies/
│   ├── jwt.strategy.ts
│   └── local.strategy.ts
│
├── guards/
│   ├── local-auth.guard.ts
│   ├── jwt-auth.guard.ts             # NEW
│   └── optional-auth.guard.ts        # NEW
│
├── decorators/                       # NEW
│   ├── current-user.decorator.ts
│   ├── public.decorator.ts
│   └── roles.decorator.ts
│
├── entities/                         # NEW
│   └── auth-token.entity.ts
│
├── services/                         # NEW
│   ├── token-hash.service.ts
│   └── session.service.ts
│
└── test/
    ├── auth.service.spec.ts
    └── auth.e2e.spec.ts
```

---

## API Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | /api/v1/auth/register | - | Register new user |
| POST | /api/v1/auth/login | - | Login user |
| POST | /api/v1/auth/logout | JWT | Logout user |
| POST | /api/v1/auth/refresh | - | Refresh access token |
| GET | /api/v1/auth/verify-email | - | Verify email address |
| POST | /api/v1/auth/forgot-password | - | Request password reset |
| POST | /api/v1/auth/reset-password | - | Reset password |
| POST | /api/v1/auth/resend-verification | - | Resend verification email |

---

## Security Requirements

- Passwords: bcryptjs, 12 rounds, 8+ characters
- Tokens: Signed JWT with validation
- Refresh tokens: Hashed in database, revokable
- Cookies: HTTP-only, Secure flag, SameSite=Strict
- Audit logging: All auth attempts recorded
- No direct email sending: Events only via RabbitMQ

---

## Success Criteria

- [x] ADR created and approved
- [ ] All DTOs validated
- [ ] Token hashing implemented
- [ ] Endpoints returning correct responses
- [ ] Events publishing to RabbitMQ
- [ ] Tests passing (>90% coverage)
- [ ] Swagger documentation complete
- [ ] No console.log in production code
- [ ] Secure cookie configuration verified

---

**Approved:** 2026-07-28
