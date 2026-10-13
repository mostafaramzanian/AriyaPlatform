# Aria ERP - Architecture Decision Record (ADR)

**Version**: 1.0  
**Date**: 2026-07-27  
**Status**: Active  
**Decision Maker**: Principal Frontend Architect & Full-Stack Engineer  

---

## Executive Summary

This document outlines the architectural decisions for transforming Aria ERP from a static HTML/CSS prototype into a production-ready, enterprise-grade SaaS marketing platform. The platform will serve as a corporate website, marketing platform, lead generation system, and customer portal comparable to Odoo, SAP, and Oracle NetSuite.

---

## Table of Contents

1. [Technology Stack Decisions](#technology-stack-decisions)
2. [Architecture Patterns](#architecture-patterns)
3. [Frontend Architecture](#frontend-architecture)
4. [Backend Architecture](#backend-architecture)
5. [Database Design](#database-design)
6. [Authentication & Authorization](#authentication--authorization)
7. [API Design](#api-design)
8. [Infrastructure & Deployment](#infrastructure--deployment)
9. [Security Considerations](#security-considerations)
10. [Performance Strategy](#performance-strategy)
11. [Scalability & Growth](#scalability--growth)

---

## 1. Technology Stack Decisions

### 1.1 Frontend Stack

**Decision**: Use Next.js 16 with TypeScript, Tailwind CSS, and shadcn/UI

**Rationale**:
- **Next.js 16 (App Router)**: Modern React framework with server components, improved performance, built-in optimizations
- **TypeScript**: Type safety, improved developer experience, catches errors at compile time
- **Tailwind CSS**: Utility-first, highly maintainable, excellent for rapid UI development and dark mode
- **shadcn/UI**: Pre-built component library based on Radix UI, highly customizable, enterprise-ready
- **Framer Motion**: Industry-standard for animations and micro-interactions
- **React Hook Form + Zod**: Type-safe form handling with validation

**Trade-offs**:
- Initial learning curve for Next.js App Router
- Bundle size considerations (mitigated by dynamic imports and code splitting)

**Alternatives Considered**:
- Vite + React: Faster builds but less opinionated, requires more configuration
- Vue.js: Excellent but narrower enterprise adoption
- Svelte: Great performance but smaller ecosystem

### 1.2 Backend Stack

**Decision**: Use NestJS with TypeScript, PostgreSQL, Prisma, Redis, and RabbitMQ

**Rationale**:
- **NestJS**: Enterprise-grade Node.js framework, excellent for scalable applications, built-in dependency injection
- **TypeScript**: Same benefits as frontend, shared type definitions with client
- **PostgreSQL**: Reliable ACID-compliant database, excellent for complex business logic
- **Prisma ORM**: Type-safe database access, excellent TypeScript integration, auto-generated migrations
- **Redis**: Caching, session management, rate limiting
- **RabbitMQ**: Message queuing for async operations (email, notifications, webhooks)

**Trade-offs**:
- Higher operational complexity (more services to manage)
- NestJS has learning curve for Spring/Django developers

**Alternatives Considered**:
- Django + PostgreSQL: More batteries-included but Python backend, language mismatch with frontend team
- Express.js: Simpler but less structure, requires more custom middleware
- Go + PostgreSQL: Excellent performance but language mismatch

### 1.3 Styling System

**Decision**: Tailwind CSS with custom theme configuration and dark mode support

**Rationale**:
- Utility-first approach enables rapid development
- Excellent performance (purged CSS in production)
- Built-in dark mode support
- Highly composable component design
- Integration with shadcn/UI for pre-built components

---

## 2. Architecture Patterns

### 2.1 Overall Architecture

**Approach**: Monorepo structure with separate frontend and backend applications

```
aria-erp/
├── apps/
│   ├── web/          # Next.js frontend (SPA/SSR hybrid)
│   └── api/          # NestJS backend (REST API + WebSocket)
├── packages/
│   ├── types/        # Shared TypeScript types
│   ├── utils/        # Shared utilities
│   └── config/       # Shared configuration
└── infrastructure/   # Docker, Nginx, Postgres initdb
```

**Benefits**:
- Code reuse between frontend and backend
- Consistent TypeScript configuration
- Easier dependency management
- Simplified deployment

### 2.2 Frontend Architecture Pattern

**Pattern**: Feature-based architecture with Server Components

```
apps/web/
├── app/              # Next.js App Router
│   ├── (marketing)   # Public marketing pages group
│   ├── (auth)        # Authentication pages group
│   ├── portal        # Customer portal (protected)
│   ├── admin         # Admin dashboard (protected)
│   ├── api/          # Client-side API routes (thin layer)
│   └── layout.tsx    # Root layout
├── components/
│   ├── common/       # Reusable UI components (Header, Footer, etc.)
│   ├── features/     # Feature-specific components
│   ├── forms/        # Form components
│   └── ui/           # Shadcn/UI wrapper components
├── hooks/            # Custom React hooks
├── lib/
│   ├── api.ts        # API client utilities
│   ├── auth.ts       # Authentication utilities
│   ├── seo.ts        # SEO utilities
│   └── utils.ts      # General utilities
├── types/            # TypeScript types
├── public/           # Static assets
└── styles/           # Global styles and Tailwind config
```

**Rationale**:
- Feature-based organization scales better than type-based (components, hooks, utils)
- Server components reduce JavaScript bundle size
- Colocation of related files improves maintainability

### 2.3 Backend Architecture Pattern

**Pattern**: Layered architecture with Domain-Driven Design (DDD) principles

```
apps/api/
├── src/
│   ├── common/       # Shared, cross-cutting concerns
│   ├── auth/         # Authentication module
│   ├── leads/        # Lead management module
│   ├── users/        # User management module
│   ├── customers/    # Customer module
│   ├── partners/     # Partner module
│   ├── admin/        # Admin module
│   ├── notifications/# Email/notification module
│   ├── meetings/     # Meeting/calendar module
│   ├── database/     # Database configuration
│   ├── config/       # Environment configuration
│   └── main.ts       # Application entry point
├── prisma/
│   └── schema.prisma # Database schema
├── test/
└── dist/
```

**Rationale**:
- Each module is self-contained with clear dependencies
- DDD ensures business logic is isolated and testable
- Clear separation of concerns (controllers, services, repositories)

---

## 3. Frontend Architecture

### 3.1 Page Structure

**Pages to Build**:

1. **Marketing Pages** (`/(marketing)/*`):
   - Home, Product, Modules, Industries, Pricing
   - ROI Calculator, Case Studies, Partners, Support, Resources
   - Blog, Integration, About, Contact, Contact Sales
   - Request Demo, Book Meeting, Security, SLA, Status
   - API Documentation, Release Notes, Careers, Roadmap
   - Privacy Policy, Terms of Service

2. **Authentication Pages** (`/(auth)/*`):
   - Login, Register, Forgot Password, Reset Password
   - Email Verification, Magic Link

3. **Protected Pages** (Require Authentication):
   - `/portal/*` - Customer Portal
   - `/admin/*` - Admin Dashboard
   - `/partners-portal/*` - Partner Portal

### 3.2 Component Strategy

**Common Components** (Used across multiple pages):
- `Header`: Navigation, authentication status, language selector
- `Footer`: Links, social media, contact info, newsletter signup
- `Navigation`: Main navigation menu
- `Sidebar`: Admin and portal sidebar navigation
- `HeroSection`: Title, description, CTA
- `FeatureGrid`: Display features in grid layout
- `Testimonials`: Customer testimonials carousel
- `Pricing`: Pricing table with comparisons
- `CTASection`: Call-to-action sections

**Form Components**:
- `ContactForm`: Name, email, message
- `ContactSalesForm`: Company info, budget, timeline
- `DemoRequestForm`: Department, use cases, timeline
- `MeetingBookingForm`: Calendar integration

### 3.3 State Management

**Decision**: Client-side state with React Context API + hooks, server state with React Query/TanStack Query

**Rationale**:
- React Context API sufficient for simple state (theme, auth status)
- TanStack Query/SWR for server state management (leads, customers, analytics)
- Reduces need for Redux in most scenarios
- Better performance with automatic cache invalidation

### 3.4 Authentication Flow

**Frontend Authentication Strategy**:
1. JWT tokens stored in httpOnly cookies (XSS protection)
2. Access token (short-lived, 15 min)
3. Refresh token (long-lived, 7 days, httpOnly)
4. Automatic token refresh on API calls
5. Protected routes with middleware

---

## 4. Backend Architecture

### 4.1 API Design

**Approach**: RESTful API with versioning, follows OpenAPI standards

**Base URL**: `https://api.aria-erp.com/v1`

**Endpoints Structure**:
```
POST   /v1/auth/register              # User registration
POST   /v1/auth/login                 # User login
POST   /v1/auth/logout                # User logout
POST   /v1/auth/refresh               # Refresh tokens
POST   /v1/auth/forgot-password       # Request password reset
POST   /v1/auth/reset-password        # Reset password with token

POST   /v1/leads                       # Create lead
GET    /v1/leads                       # List leads (admin)
GET    /v1/leads/:id                   # Get lead details
PUT    /v1/leads/:id                   # Update lead
DELETE /v1/leads/:id                   # Delete lead

POST   /v1/meetings                    # Schedule meeting
GET    /v1/meetings/available-slots    # Get available time slots
GET    /v1/meetings/:id                # Get meeting details
PUT    /v1/meetings/:id                # Update meeting
DELETE /v1/meetings/:id                # Cancel meeting

GET    /v1/users/:id                   # Get user profile
PUT    /v1/users/:id                   # Update user profile

GET    /v1/admin/dashboard             # Admin dashboard data
GET    /v1/admin/customers             # List customers
GET    /v1/admin/analytics             # Analytics data

# WebSocket for real-time notifications
WS     /v1/ws                          # WebSocket connection
```

### 4.2 Database Schema - Key Tables

**users**:
- id, email, password_hash, first_name, last_name, role, status, created_at, updated_at

**leads**:
- id, email, name, company, phone, industry, company_size, modules_interested, lead_source, status, created_at, updated_at

**meetings**:
- id, lead_id, scheduled_at, duration, status, meeting_link, created_at, updated_at

**customers**:
- id, user_id, company_name, licenses, subscription_status, created_at, updated_at

**partners**:
- id, user_id, company_name, revenue_share, status, created_at, updated_at

**audit_logs**:
- id, user_id, action, resource_type, resource_id, changes, created_at

### 4.3 NestJS Module Structure

**Modules**:
- `auth`: Authentication, JWT strategy, guards
- `users`: User management, profile
- `leads`: Lead management, CRUD operations
- `customers`: Customer management
- `partners`: Partner management
- `meetings`: Meeting scheduling
- `notifications`: Email and in-app notifications
- `admin`: Admin-specific operations
- `common`: Shared pipes, guards, interceptors, decorators

### 4.4 Bounded Contexts & Runtime Boundaries

The current backend is composed of independently-owned bounded contexts:

| Context | Datasource env var | Prisma project | Module location |
|---|---|---|---|
| Core | `CORE_DATABASE_URL` | `prisma/core` | `database/` |
| CMS | `CMS_DATABASE_URL` | `prisma/cms` | `modules/cms/` (uses `database/cms-prisma.*`) |
| Observability | `OBSERVABILITY_DATABASE_URL` | `prisma/observability` | `observability/` |
| Correspondence | `CORRESPONDENCE_DATABASE_URL` | `prisma/correspondence` | `modules/correspondence/` |
| HR | `HR_DATABASE_URL` | `prisma/hr` | `modules/hr/` |
| Commerce | `COMMERCE_DATABASE_URL` | `prisma/commerce` | `modules/commerce/` |
| Production | `PRODUCTION_DATABASE_URL` | `prisma/production` | `modules/production/` |
| Financial | `FINANCE_DATABASE_URL` | `prisma/financial` | `modules/financial/` |

**Canonical registry**: `apps/api/src/runtime-datasources.ts` owns the datasource
ownership matrix. `apps/api/runtime-policy.json` is a machine-readable projection
emitted by `npm run arch:policy`; Docker health probes and the architecture tests
derive their truth from this single source.

**Auth boundary**: business modules declare `@Roles(...)` as metadata only. The
`RolesGuard` and `PermissionSource` are provided globally by `AuthModule` / `RbacModule`
at each runtime root. Financial, Production, Commerce, HR and Correspondence do
**not** import `RbacModule`; they consume the platform auth contract rather than
Core's authorization implementation.

**Deployment topology**: the `combined` runtime (`dist/main.js`) hosts Core, CMS,
Correspondence, HR, Commerce, Production and Financial. The `core` and `cms`
runtimes exclude business contexts so each image ships only the generated Prisma
clients it actually uses (`runtime-policy.json` controls pruning).

---

## 5. Database Design

### 5.1 Design Principles

- **Normalization**: 3NF for relational data
- **Audit Trail**: Track all changes with audit_logs table
- **Soft Deletes**: Mark records as deleted for compliance
- **Timestamps**: created_at, updated_at on all tables
- **Indexes**: On frequently queried columns (email, status, created_at)

### 5.2 Core Schema

```prisma
model User {
  id           String    @id @default(cuid())
  email        String    @unique
  passwordHash String
  firstName    String
  lastName     String
  role         UserRole  @default(VISITOR)
  status       String    @default("active")
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  
  leads        Lead[]
  customer     Customer?
  partner      Partner?
  auditLogs    AuditLog[]
}

enum UserRole {
  VISITOR
  LEAD
  CUSTOMER
  PARTNER
  ADMIN
}

model Lead {
  id              String   @id @default(cuid())
  email           String
  name            String
  company         String?
  phone           String?
  industry        String?
  companySize     String?
  modulesInterestedString?
  leadSource      String
  status          String   @default("new")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  user            User?    @relation(fields: [userId], references: [id])
  userId          String?
  meetings        Meeting[]
}

model Meeting {
  id           String   @id @default(cuid())
  lead         Lead     @relation(fields: [leadId], references: [id])
  leadId       String
  scheduledAt  DateTime
  duration     Int      // in minutes
  status       String   @default("scheduled")
  meetingLink  String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

model AuditLog {
  id            String   @id @default(cuid())
  user          User     @relation(fields: [userId], references: [id])
  userId        String
  action        String   // CREATE, READ, UPDATE, DELETE
  resourceType  String   // User, Lead, Meeting, etc.
  resourceId    String
  changes       Json     // JSON of what changed
  createdAt     DateTime @default(now())
}
```

---

## 6. Authentication & Authorization

### 6.1 Authentication Strategy

**JWT-Based Authentication**:
- Two-token system (access + refresh)
- Access token: 15 minutes, stored in memory or httpOnly cookie
- Refresh token: 7 days, stored in httpOnly cookie only
- Logout: Blacklist refresh token in Redis
- Email verification: Send verification link on registration

**MFA Support** (Future):
- TOTP-based 2FA for admin users
- SMS-based 2FA option

### 6.2 Authorization Strategy

**Role-Based Access Control (RBAC)**:

| Role | Permissions |
|------|------------|
| VISITOR | Read public pages, submit contact forms |
| LEAD | View lead portal, book meetings, access demo |
| CUSTOMER | Access customer portal, manage licenses, support tickets |
| PARTNER | Access partner portal, manage leads, revenue tracking |
| ADMIN | Full access to all dashboards and operations |

**Implementation**:
- NestJS Guards for route protection
- Custom decorators for permission checking
- Middleware for audit logging

---

## 7. API Design

### 7.1 Response Format

**Standardized Response Structure**:
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2026-07-27T21:58:26Z",
    "version": "v1"
  }
}
```

**Error Response**:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "Validation failed",
    "details": [...]
  }
}
```

### 7.2 Rate Limiting

**Strategy**:
- Redis-based rate limiting
- General limit: 100 requests/minute per IP
- Lead form submission: 5 requests/hour per IP
- Login attempts: 10 requests/15 minutes per IP
- Authenticated endpoints: 1000 requests/hour per user

### 7.3 Pagination

**Query Parameters**:
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 20, max: 100)
- `sort`: Sorting field and direction (`sort=-created_at`)
- `filter`: JSON-encoded filters

---

## 8. Infrastructure & Deployment

### 8.1 Containerization

**Docker Strategy**:
- Separate containers for frontend, backend, PostgreSQL, Redis
- Docker Compose for local development
- Multi-stage builds for production optimization

**Dockerfile Strategy**:
```dockerfile
# Frontend (Next.js)
FROM node:20-alpine AS base
FROM base AS deps
FROM base AS builder
FROM node:20-alpine AS runner
```

### 8.2 CI/CD Pipeline

**GitHub Actions** (`.github/workflows/ci.yml`, GAP-ENV-1):
- Install dependencies (`npm ci --legacy-peer-deps`)
- Generate all six Prisma clients
- API `tsc --noEmit` and web `tsc --noEmit`
- Contract suites: `env.validation.spec.ts`, `architecture-boundaries.spec.ts`,
  `runtime-policy.spec.ts`, plus focused Commerce unit regressions
- Build `apps/api` (`nest build`) and `apps/web` (`next build`)

CI is checks-only: it does not deploy, run e2e, or publish images. E2E requires
the compose postgres + `e2e-dbproxy` (see `docs/DEPLOYMENT.md`).

### 8.3 Deployment Architecture

**Staging Environment**:
- Docker Compose stack (see `docs/DEPLOYMENT.md`); an external orchestrator may replace it
- Real PostgreSQL database
- Redis cache
- RabbitMQ message queue
- Nginx reverse proxy

**Production Environment**:
- Docker Compose stack or external orchestrator running the same images
- PostgreSQL 16 with pgvector (seven databases, one per owner)
- Redis, RabbitMQ, MinIO-compatible object storage
- TLS terminated by an external load balancer/ingress (this repository does not
  manage certificates); the compose nginx edge serves HTTP only

---

## 9. Security Considerations

### 9.1 Frontend Security

**Implemented Measures**:
- **Content Security Policy (CSP)**: Restrict resource loading
- **XSS Protection**: Input validation, output encoding
- **CSRF Protection**: Double-submit cookies + token validation
- **Security Headers**: X-Frame-Options, X-Content-Type-Options, etc.
- **HTTPS Only**: Enforce SSL/TLS
- **Secure Cookies**: HttpOnly, Secure, SameSite attributes

### 9.2 Backend Security

**Implemented Measures**:
- **Input Validation**: Zod schemas for all inputs
- **SQL Injection Prevention**: Prisma parameterized queries
- **Rate Limiting**: Redis-based rate limiter
- **CORS**: Restricted to allowed origins
- **API Key Management**: Secure storage in environment variables
- **Secrets Rotation**: Regular key rotation strategy
- **Password Hashing**: Bcrypt with salt

### 9.3 Data Protection

**Encryption**:
- Sensitive data encrypted at rest (AES-256)
- Sensitive data encrypted in transit (TLS 1.3)
- Personally Identifiable Information (PII) handled per GDPR

**Data Retention**:
- Audit logs: 2 years
- Deleted user data: Purged after 30 days
- Compliance data: Retained as per regulations

---

## 10. Performance Strategy

### 10.1 Frontend Performance

**Target Metrics**:
- Lighthouse Score: > 95
- First Contentful Paint (FCP): < 1.5s
- Largest Contentful Paint (LCP): < 2s
- Cumulative Layout Shift (CLS): < 0.1
- Time to Interactive (TTI): < 3.5s

**Optimization Techniques**:
1. **Code Splitting**: Dynamic imports for routes and heavy components
2. **Image Optimization**: Next.js Image component, WebP format, AVIF fallback
3. **Lazy Loading**: Intersection Observer for below-fold content
4. **Server Components**: Use Server Components for data fetching
5. **Compression**: Gzip/Brotli for assets
6. **Caching**: Service workers for offline support
7. **Minification**: JavaScript and CSS minification in production
8. **Font Optimization**: System fonts, variable fonts, font-display strategy

### 10.2 Backend Performance

**Optimization Strategies**:
1. **Database Indexing**: Indexes on frequently queried columns
2. **Query Optimization**: Avoid N+1 queries with Prisma relations
3. **Caching Layer**: Redis for session and data caching
4. **Pagination**: Default limit of 20 items per request
5. **Connection Pooling**: PgBouncer for PostgreSQL
6. **Async Processing**: RabbitMQ for heavy operations (email, reports)
7. **API Response Compression**: Gzip compression

### 10.3 Monitoring & Analytics

**Tools**:
- **Frontend**: Google Analytics 4, Web Vitals, Error tracking (Sentry)
- **Backend**: Application Performance Monitoring (DataDog/New Relic)
- **Infrastructure**: Container monitoring (Prometheus + Grafana)
- **Uptime**: Uptime monitoring service (StatusPage.io)

---

## 11. Scalability & Growth

### 11.1 Multi-Tenant Architecture (Future)

**Design Considerations**:
- Row-level security (RLS) for tenant data isolation
- Separate databases per tenant (or shared with RLS)
- Tenant-specific branding and configuration
- Tenant-specific API keys and webhooks

### 11.2 Multi-Language Support

**Implementation**:
- i18n library (next-intl for Next.js)
- Translation management system (Tolgee/Lokalise)
- Language-aware routing (`/en/pages`, `/fr/pages`)
- RTL support for Arabic, Hebrew

### 11.3 International Expansion

**Considerations**:
- GDPR compliance for EU users
- Local payment methods (Stripe, PayPal, local options)
- CDN for global asset delivery
- Regional database replication for compliance
- Localized support and documentation

### 11.4 High Availability

**Strategy**:
- Database: Primary + standby replica with automatic failover
- Application: Multiple instances behind load balancer
- Cache: Redis cluster with replication
- Message Queue: RabbitMQ cluster with durable queues
- Static Assets: CDN with origin failover

---

## Decision Summary Table

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Frontend Framework | Next.js 16 | React ecosystem, SSR, performance, DX |
| Frontend Language | TypeScript | Type safety, catches errors early |
| Frontend Styling | Tailwind CSS | Utility-first, maintainable, performant |
| UI Components | shadcn/UI | Enterprise-ready, customizable, accessible |
| Backend Framework | NestJS | Scalable, TypeScript, enterprise patterns |
| Database | PostgreSQL | Reliable, ACID, complex business logic |
| ORM | Prisma | Type-safe, excellent TypeScript support |
| Caching | Redis | Fast, reliable, versatile use cases |
| Message Queue | RabbitMQ | Reliable, scalable, easy to operate |
| Testing Framework | Vitest + Playwright | Fast, modern, comprehensive testing |
| Deployment | Docker + Docker Compose | Portable, reproducible from this repository |

---

## Implementation Timeline

**Phase 1** (Week 1-2): Next.js Setup + Core Pages
**Phase 2** (Week 3-4): NestJS Backend + Authentication
**Phase 3** (Week 5-6): Portals (Admin, Customer, Partner)
**Phase 4** (Week 7-8): Interactive Features + Blog + Animations
**Phase 5** (Week 9-10): Docker + CI/CD + Security Hardening

---

## Approval & Review

- **Approved by**: Principal Frontend Architect & Full-Stack Engineer
- **Last Updated**: 2026-07-27
- **Next Review**: Upon major architectural changes

---

## Appendix

### A. References

- Next.js Documentation: https://nextjs.org/docs
- NestJS Documentation: https://docs.nestjs.com
- TypeScript Documentation: https://www.typescriptlang.org/docs
- PostgreSQL Documentation: https://www.postgresql.org/docs

### B. Related Documents

- FOLDER_STRUCTURE.md (Generated Next)
- MIGRATION_PLAN.md (Generated Next)
- DATABASE_SCHEMA.md
- API_DOCUMENTATION.md
- SECURITY_CHECKLIST.md
