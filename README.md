# Aria ERP - Main README

## Project Overview

Aria ERP is an enterprise-grade Software-as-a-Service (SaaS) platform built with modern technologies. It functions as a:

- **Corporate Website**: Marketing and brand presence
- **Lead Generation Platform**: Capture and manage business leads
- **Customer Portal**: Self-service customer management
- **Partner Portal**: Partner collaboration and revenue sharing
- **Admin Dashboard**: Business operations and analytics

## Quick Start

### Prerequisites

- Node.js 20+
- npm 10+
- Docker & Docker Compose
- PostgreSQL 16 (or use Docker)

### Development Environment

**Option 1: Using Docker Compose**

```bash
# Start all services
npm run docker:up

# Stop services
npm run docker:down
```

**Option 2: Local Setup**

```bash
# Install dependencies
npm install

# Start frontend development server
npm run dev:web

# In another terminal, start backend API
npm run dev:api
```

### Accessing the Application

- **Frontend**: http://localhost:3000
- **API**: http://localhost:3001
- **API Health**: http://localhost:3001/api/v1/health and `/api/v1/ready`
- **API Docs**: http://localhost:3001/api/v1/docs (only when `ENABLE_SWAGGER` is set; disabled by default)
- **PostgreSQL**: localhost:5433 (published compose port; `localhost:5544` is the `e2e-dbproxy` service used by host-side tooling)
- **Redis**: localhost:6379
- **RabbitMQ**: http://localhost:15672

### Environment Setup

```bash
# Copy environment templates. The API has TWO consumers that read DIFFERENT
# files (see docs/DEPLOYMENT.md): copy to .env.local for Nest and to .env for
# the Prisma CLI and generated clients.
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env.local
cp apps/api/.env.example apps/api/.env

# Edit with your values
```

## Technology Stack

### Frontend

- **Framework**: Next.js 16 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Components**: Shadcn/UI + Radix UI
- **Forms**: React Hook Form + Zod
- **Animations**: Framer Motion
- **State**: React Context API + TanStack Query

### Backend

- **Framework**: NestJS
- **Language**: TypeScript
- **Database**: PostgreSQL + Prisma ORM
- **Caching**: Redis
- **Message Queue**: RabbitMQ
- **Authentication**: JWT
- **API Docs**: Swagger/OpenAPI

### Infrastructure

- **Containerization**: Docker & Docker Compose
- **Reverse Proxy**: Nginx (`infrastructure/nginx/`)
- **CI**: GitHub Actions (`.github/workflows/ci.yml` — type-checks, contract suites, builds; no deployment)

## Project Structure

```
aria-erp/
├── apps/
│   ├── web/              # Next.js frontend
│   └── api/              # NestJS backend
├── packages/
│   ├── types/            # Shared TypeScript types
│   ├── utils/            # Shared utilities
│   └── config/           # Shared configuration
├── infrastructure/       # Docker, Nginx, Postgres initdb
└── docs/                 # Documentation
```

## Development Workflow

### Building

```bash
# Build all applications
npm run build

# Build frontend only
npm run build:web

# Build backend only
npm run build:api
```

### Testing

```bash
# Run all tests
npm test

# Frontend tests
npm run test:web

# Backend tests
npm run test:api

# Coverage reports
npm run test:cov
```

### Code Quality

```bash
# Lint all code
npm run lint

# Format all code
npm run format

# Check formatting
npm run format:check
```

### Database Operations

```bash
# Owner-specific migrations (preferred for production deployments)
npm run db:migrate:core       # Core datasource (identity, RBAC, audit)
npm run db:migrate:cms        # CMS datasource
npm run db:migrate:observability  # Observability datasource (optional)
npm run db:migrate:correspondence # Correspondence datasource

# All-owner orchestration (full-stack development only)
npm run db:migrate

# Seed database
npm run db:seed
```

See `docs/ADR/ADR-0005-ARCH-1-RUNTIME-AND-DATABASE-BOUNDARIES.md` for the
runtime -> datasource ownership matrix.

## Key Features

### Authentication

- User registration and login
- Email verification
- JWT-based token authentication
- Password reset functionality
- Role-based access control (RBAC)

### Lead Management

- Lead capture forms (Contact, Sales, Demo, Meeting)
- Lead validation and enrichment
- Spam detection
- Audit logging
- CRM integration ready

### Customer Portal

- User profile management
- License and subscription management
- Support ticket system
- Invoice and download management
- Release notes and documentation

### Admin Dashboard

- Analytics and insights
- Lead and customer management
- User and role management
- CMS for blog content
- Audit logs and compliance

## Security

- Content Security Policy (CSP)
- XSS and CSRF protection
- SQL injection prevention (Prisma)
- Rate limiting
- Input validation with Zod
- JWT token management
- Secure password hashing (bcrypt)

## Performance

- Next.js optimizations (Server Components, dynamic imports)
- Image optimization
- Database indexing and query optimization
- Redis caching layer
- Gzip compression
- CDN-ready static asset serving

## Deployment

### Local / Docker Compose

```bash
npm run docker:up   # builds images from the current tree (--build), then starts
```

### Production

See `docs/DEPLOYMENT.md` for the deployment contract (entry point, databases,
secrets, edge/TLS, seed guard, CI).

## Documentation

- [Architecture Overview](./ARCHITECTURE.md)
- [Folder Structure](./FOLDER_STRUCTURE.md)
- [Deployment Guide](./docs/DEPLOYMENT.md)
- [Architecture Decision Records](./docs/ADR/)

## License

Proprietary - Aria ERP © 2026

## Support

For support, email support@aria-erp.com or visit https://aria-erp.com/support

---

**Last Updated**: 2026-07-27  
**Version**: 1.0.0  
**Status**: In Development
