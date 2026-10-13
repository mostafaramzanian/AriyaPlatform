# Aria ERP - Monorepo Folder Structure

**Version**: 1.0  
**Date**: 2026-07-27  

---

## Project Structure

```
aria-erp/
│
├── apps/                                    # Applications
│   ├── web/                                # Next.js Marketing & Portal Frontend
│   │   ├── app/                           # Next.js App Router
│   │   │   ├── (marketing)/               # Public marketing pages group
│   │   │   │   ├── page.tsx               # Home page
│   │   │   │   ├── product/page.tsx
│   │   │   │   ├── modules/page.tsx
│   │   │   │   ├── industries/page.tsx
│   │   │   │   ├── pricing/page.tsx
│   │   │   │   ├── roi-calculator/page.tsx
│   │   │   │   ├── case-studies/page.tsx
│   │   │   │   ├── partners/page.tsx
│   │   │   │   ├── support/page.tsx
│   │   │   │   ├── resources/page.tsx
│   │   │   │   ├── blog/
│   │   │   │   │   ├── page.tsx           # Blog listing
│   │   │   │   │   ├── [slug]/page.tsx    # Blog post detail
│   │   │   │   │   └── layout.tsx
│   │   │   │   ├── integration/page.tsx
│   │   │   │   ├── about/page.tsx
│   │   │   │   ├── contact/page.tsx
│   │   │   │   ├── contact-sales/page.tsx
│   │   │   │   ├── request-demo/page.tsx
│   │   │   │   ├── book-meeting/page.tsx
│   │   │   │   ├── security/page.tsx
│   │   │   │   ├── sla/page.tsx
│   │   │   │   ├── status/page.tsx
│   │   │   │   ├── api-docs/page.tsx
│   │   │   │   ├── release-notes/page.tsx
│   │   │   │   ├── careers/page.tsx
│   │   │   │   ├── roadmap/page.tsx
│   │   │   │   ├── privacy/page.tsx
│   │   │   │   ├── terms/page.tsx
│   │   │   │   └── layout.tsx              # Marketing layout
│   │   │   │
│   │   │   ├── (auth)/                    # Authentication pages group
│   │   │   │   ├── login/page.tsx
│   │   │   │   ├── register/page.tsx
│   │   │   │   ├── forgot-password/page.tsx
│   │   │   │   ├── reset-password/page.tsx
│   │   │   │   ├── verify-email/page.tsx
│   │   │   │   ├── magic-link/page.tsx
│   │   │   │   └── layout.tsx              # Auth layout
│   │   │   │
│   │   │   ├── portal/                     # Customer Portal (protected)
│   │   │   │   ├── layout.tsx              # Portal layout with sidebar
│   │   │   │   ├── page.tsx                # Portal dashboard
│   │   │   │   ├── profile/page.tsx
│   │   │   │   ├── licenses/page.tsx
│   │   │   │   ├── support/
│   │   │   │   │   ├── page.tsx            # Tickets list
│   │   │   │   │   └── [id]/page.tsx       # Ticket detail
│   │   │   │   ├── invoices/page.tsx
│   │   │   │   ├── downloads/page.tsx
│   │   │   │   ├── docs/page.tsx
│   │   │   │   ├── release-notes/page.tsx
│   │   │   │   └── notifications/page.tsx
│   │   │   │
│   │   │   ├── admin/                      # Admin Dashboard (protected)
│   │   │   │   ├── layout.tsx              # Admin layout with sidebar
│   │   │   │   ├── page.tsx                # Admin dashboard
│   │   │   │   ├── leads/
│   │   │   │   │   ├── page.tsx            # Leads table
│   │   │   │   │   ├── [id]/page.tsx       # Lead detail
│   │   │   │   │   └── [id]/edit/page.tsx
│   │   │   │   ├── customers/
│   │   │   │   │   ├── page.tsx
│   │   │   │   │   └── [id]/page.tsx
│   │   │   │   ├── meetings/
│   │   │   │   │   ├── page.tsx
│   │   │   │   │   └── [id]/page.tsx
│   │   │   │   ├── users/
│   │   │   │   │   ├── page.tsx
│   │   │   │   │   └── [id]/page.tsx
│   │   │   │   ├── blog/
│   │   │   │   │   ├── page.tsx
│   │   │   │   │   ├── new/page.tsx
│   │   │   │   │   └── [id]/edit/page.tsx
│   │   │   │   ├── analytics/page.tsx
│   │   │   │   ├── audit-logs/page.tsx
│   │   │   │   └── settings/page.tsx
│   │   │   │
│   │   │   ├── partners-portal/            # Partner Portal (protected)
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── page.tsx
│   │   │   │   ├── leads/page.tsx
│   │   │   │   ├── revenue/page.tsx
│   │   │   │   ├── documents/page.tsx
│   │   │   │   ├── training/page.tsx
│   │   │   │   ├── certificates/page.tsx
│   │   │   │   └── deals/page.tsx
│   │   │   │
│   │   │   ├── api/                        # Client-side API routes (thin layer)
│   │   │   │   └── auth/
│   │   │   │       └── callback/route.ts   # OAuth callback, etc.
│   │   │   │
│   │   │   ├── layout.tsx                  # Root layout
│   │   │   ├── not-found.tsx
│   │   │   ├── error.tsx
│   │   │   └── globals.css
│   │   │
│   │   ├── components/                     # React Components
│   │   │   ├── common/                     # Shared across multiple pages
│   │   │   │   ├── Header.tsx
│   │   │   │   ├── Footer.tsx
│   │   │   │   ├── Navigation.tsx
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── Navbar.tsx
│   │   │   │   ├── MobileMenu.tsx
│   │   │   │   ├── LanguageSwitcher.tsx
│   │   │   │   ├── ThemeToggle.tsx
│   │   │   │   ├── Breadcrumb.tsx
│   │   │   │   └── ...
│   │   │   │
│   │   │   ├── features/                   # Feature-specific components
│   │   │   │   ├── pricing/
│   │   │   │   │   ├── PricingTable.tsx
│   │   │   │   │   ├── PricingCard.tsx
│   │   │   │   │   └── PricingFAQ.tsx
│   │   │   │   ├── roi-calculator/
│   │   │   │   │   ├── ROICalculator.tsx
│   │   │   │   │   ├── ROIInputs.tsx
│   │   │   │   │   └── ROIResults.tsx
│   │   │   │   ├── blog/
│   │   │   │   │   ├── BlogCard.tsx
│   │   │   │   │   ├── BlogGrid.tsx
│   │   │   │   │   ├── RelatedPosts.tsx
│   │   │   │   │   └── BlogSearch.tsx
│   │   │   │   ├── meeting-booking/
│   │   │   │   │   ├── CalendarPicker.tsx
│   │   │   │   │   ├── TimeSlotSelector.tsx
│   │   │   │   │   └── BookingConfirmation.tsx
│   │   │   │   ├── testimonials/
│   │   │   │   │   ├── TestimonialCarousel.tsx
│   │   │   │   │   └── TestimonialCard.tsx
│   │   │   │   └── ...
│   │   │   │
│   │   │   ├── forms/                      # Form components
│   │   │   │   ├── ContactForm.tsx
│   │   │   │   ├── ContactSalesForm.tsx
│   │   │   │   ├── DemoRequestForm.tsx
│   │   │   │   ├── MeetingBookingForm.tsx
│   │   │   │   ├── LoginForm.tsx
│   │   │   │   ├── RegisterForm.tsx
│   │   │   │   ├── ResetPasswordForm.tsx
│   │   │   │   └── ...
│   │   │   │
│   │   │   ├── ui/                        # Shadcn/UI wrapper components
│   │   │   │   ├── button.tsx
│   │   │   │   ├── input.tsx
│   │   │   │   ├── dialog.tsx
│   │   │   │   ├── card.tsx
│   │   │   │   ├── form.tsx
│   │   │   │   └── ... (generated by shadcn)
│   │   │   │
│   │   │   └── sections/                   # Page sections
│   │   │       ├── HeroSection.tsx
│   │   │       ├── FeatureSection.tsx
│   │   │       ├── PricingSection.tsx
│   │   │       ├── TestimonialsSection.tsx
│   │   │       ├── CTASection.tsx
│   │   │       └── ...
│   │   │
│   │   ├── hooks/                          # Custom React Hooks
│   │   │   ├── useAuth.ts
│   │   │   ├── useApi.ts
│   │   │   ├── usePagination.ts
│   │   │   ├── useDarkMode.ts
│   │   │   ├── useWindowSize.ts
│   │   │   ├── useLocalStorage.ts
│   │   │   └── ...
│   │   │
│   │   ├── lib/                            # Utilities & Libraries
│   │   │   ├── api.ts                      # Axios/fetch API client
│   │   │   ├── auth.ts                     # Auth utilities
│   │   │   ├── seo.ts                      # SEO metadata utilities
│   │   │   ├── validation.ts               # Zod schemas
│   │   │   ├── utils.ts                    # General utilities
│   │   │   ├── constants.ts
│   │   │   └── date.ts                     # Date utilities
│   │   │
│   │   ├── types/                          # TypeScript Types
│   │   │   ├── index.ts
│   │   │   ├── api.ts                      # API response types
│   │   │   ├── auth.ts                     # Auth types
│   │   │   ├── forms.ts                    # Form input types
│   │   │   └── ...
│   │   │
│   │   ├── public/                         # Static Assets
│   │   │   ├── images/
│   │   │   │   ├── logo.png
│   │   │   │   ├── hero/
│   │   │   │   └── features/
│   │   │   ├── icons/
│   │   │   ├── fonts/
│   │   │   └── favicon.ico
│   │   │
│   │   ├── styles/                         # Global Styles
│   │   │   ├── globals.css
│   │   │   ├── tailwind.config.ts
│   │   │   └── variables.css
│   │   │
│   │   ├── middleware.ts                   # Next.js middleware (auth, redirects)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.mjs
│   │   ├── .env.example
│   │   ├── .env.local
│   │   ├── .eslintrc.json
│   │   ├── .prettierrc
│   │   └── README.md
│   │
│   └── api/                                 # NestJS Backend API
│       ├── src/
│       │   ├── main.ts                     # Application entry point
│       │   │
│       │   ├── common/                     # Shared, cross-cutting concerns
│       │   │   ├── decorators/
│       │   │   │   ├── IsPublic.ts
│       │   │   │   ├── Roles.ts
│       │   │   │   └── CurrentUser.ts
│       │   │   ├── guards/
│       │   │   │   ├── JwtAuthGuard.ts
│       │   │   │   └── RolesGuard.ts
│       │   │   ├── interceptors/
│       │   │   │   ├── TransformInterceptor.ts
│       │   │   │   ├── ErrorInterceptor.ts
│       │   │   │   └── LoggingInterceptor.ts
│       │   │   ├── pipes/
│       │   │   │   ├── ValidationPipe.ts
│       │   │   │   └── ParseObjectIdPipe.ts
│       │   │   ├── filters/
│       │   │   │   ├── HttpExceptionFilter.ts
│       │   │   │   └── AllExceptionsFilter.ts
│       │   │   ├── middleware/
│       │   │   │   ├── RateLimitingMiddleware.ts
│       │   │   │   ├── AuditLoggingMiddleware.ts
│       │   │   │   └── RequestLoggingMiddleware.ts
│       │   │   └── constants/
│       │   │       └── app.constants.ts
│       │   │
│       │   ├── auth/                       # Authentication Module
│       │   │   ├── auth.controller.ts
│       │   │   ├── auth.service.ts
│       │   │   ├── auth.module.ts
│       │   │   ├── strategies/
│       │   │   │   ├── jwt.strategy.ts
│       │   │   │   ├── local.strategy.ts
│       │   │   │   └── refresh.strategy.ts
│       │   │   ├── guards/
│       │   │   │   ├── jwt-auth.guard.ts
│       │   │   │   └── refresh-auth.guard.ts
│       │   │   ├── dto/
│       │   │   │   ├── login.dto.ts
│       │   │   │   ├── register.dto.ts
│       │   │   │   ├── refresh.dto.ts
│       │   │   │   └── password-reset.dto.ts
│       │   │   └── spec/
│       │   │       └── auth.spec.ts
│       │   │
│       │   ├── users/                      # User Management Module
│       │   │   ├── users.controller.ts
│       │   │   ├── users.service.ts
│       │   │   ├── users.module.ts
│       │   │   ├── dto/
│       │   │   │   ├── create-user.dto.ts
│       │   │   │   ├── update-user.dto.ts
│       │   │   │   └── user-profile.dto.ts
│       │   │   ├── entities/
│       │   │   │   └── user.entity.ts
│       │   │   ├── repositories/
│       │   │   │   └── users.repository.ts
│       │   │   └── spec/
│       │   │       └── users.spec.ts
│       │   │
│       │   ├── leads/                      # Lead Management Module
│       │   │   ├── leads.controller.ts
│       │   │   ├── leads.service.ts
│       │   │   ├── leads.module.ts
│       │   │   ├── dto/
│       │   │   │   ├── create-lead.dto.ts
│       │   │   │   ├── update-lead.dto.ts
│       │   │   │   └── lead-filter.dto.ts
│       │   │   ├── entities/
│       │   │   │   └── lead.entity.ts
│       │   │   ├── repositories/
│       │   │   │   └── leads.repository.ts
│       │   │   ├── services/
│       │   │   │   ├── lead-validation.service.ts
│       │   │   │   ├── lead-enrichment.service.ts
│       │   │   │   └── spam-detection.service.ts
│       │   │   └── spec/
│       │   │       └── leads.spec.ts
│       │   │
│       │   ├── customers/                  # Customer Module
│       │   │   ├── customers.controller.ts
│       │   │   ├── customers.service.ts
│       │   │   ├── customers.module.ts
│       │   │   ├── dto/
│       │   │   ├── entities/
│       │   │   ├── repositories/
│       │   │   └── spec/
│       │   │
│       │   ├── partners/                   # Partner Module
│       │   │   ├── partners.controller.ts
│       │   │   ├── partners.service.ts
│       │   │   ├── partners.module.ts
│       │   │   ├── dto/
│       │   │   ├── entities/
│       │   │   ├── repositories/
│       │   │   └── spec/
│       │   │
│       │   ├── meetings/                   # Meeting/Calendar Module
│       │   │   ├── meetings.controller.ts
│       │   │   ├── meetings.service.ts
│       │   │   ├── meetings.module.ts
│       │   │   ├── dto/
│       │   │   │   ├── create-meeting.dto.ts
│       │   │   │   └── meeting-slots.dto.ts
│       │   │   ├── entities/
│       │   │   ├── repositories/
│       │   │   ├── services/
│       │   │   │   ├── calendar.service.ts
│       │   │   │   └── availability.service.ts
│       │   │   └── spec/
│       │   │
│       │   ├── notifications/              # Email/Notification Module
│       │   │   ├── notifications.service.ts
│       │   │   ├── notifications.module.ts
│       │   │   ├── email/
│       │   │   │   ├── email.service.ts
│       │   │   │   ├── templates/
│       │   │   │   │   ├── welcome.template.ts
│       │   │   │   │   ├── reset-password.template.ts
│       │   │   │   │   ├── meeting-confirmation.template.ts
│       │   │   │   │   └── ...
│       │   │   └── spec/
│       │   │
│       │   ├── admin/                      # Admin Module
│       │   │   ├── admin.controller.ts
│       │   │   ├── admin.service.ts
│       │   │   ├── admin.module.ts
│       │   │   └── dto/
│       │   │
│       │   ├── blog/                       # Blog/CMS Module
│       │   │   ├── blog.controller.ts
│       │   │   ├── blog.service.ts
│       │   │   ├── blog.module.ts
│       │   │   ├── dto/
│       │   │   ├── entities/
│       │   │   └── repositories/
│       │   │
│       │   ├── database/                   # Database Configuration
│       │   │   ├── database.module.ts
│       │   │   ├── database.service.ts
│       │   │   └── providers/
│       │   │
│       │   ├── config/                     # Environment Configuration
│       │   │   ├── app.config.ts
│       │   │   ├── database.config.ts
│       │   │   ├── jwt.config.ts
│       │   │   ├── email.config.ts
│       │   │   └── redis.config.ts
│       │   │
│       │   ├── app.module.ts
│       │   └── app.controller.ts
│       │
│       ├── prisma/                         # Database Schema & Migrations
│       │   ├── schema.prisma
│       │   ├── migrations/
│       │   │   ├── 20260727_init/
│       │   │   │   └── migration.sql
│       │   │   └── ...
│       │   └── seed.ts                     # Database seed script
│       │
│       ├── test/                           # Test Files
│       │   ├── app.e2e-spec.ts
│       │   ├── jest-e2e.json
│       │   └── fixtures/
│       │
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsconfig.build.json
│       ├── .env.example
│       ├── .env.local
│       ├── .eslintrc.js
│       ├── .prettierrc
│       ├── docker/
│       │   ├── Dockerfile
│       │   └── Dockerfile.prod
│       └── README.md
│
├── packages/                                # Shared Packages (Monorepo)
│   ├── types/                              # Shared TypeScript Types
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── auth.types.ts
│   │   │   ├── api.types.ts
│   │   │   ├── forms.types.ts
│   │   │   └── models.types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── utils/                              # Shared Utilities
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── validation.ts              # Shared Zod schemas
│   │   │   ├── string.ts
│   │   │   ├── date.ts
│   │   │   ├── crypto.ts
│   │   │   └── email.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── config/                             # Shared Configuration
│       ├── src/
│       │   ├── index.ts
│       │   ├── constants.ts
│       │   ├── env.ts
│       │   └── errors.ts
│       ├── package.json
│       └── tsconfig.json
│
├── infrastructure/                         # Infrastructure as Code
│   ├── docker/
│   │   ├── docker-compose.yml             # Local development
│   │   ├── docker-compose.prod.yml        # Production
│   │   ├── Dockerfile.frontend
│   │   ├── Dockerfile.backend
│   │   ├── Dockerfile.postgres
│   │   ├── Dockerfile.redis
│   │   └── Dockerfile.rabbitmq
│   │
│   ├── nginx/
│   │   ├── nginx.conf
│   │   ├── conf.d/
│   │   │   ├── frontend.conf
│   │   │   └── api.conf
│   │   └── ssl/
│   │       └── .gitkeep
│   │
│   └── postgres/initdb/                  # Database bootstrap (GAP-ENV-1)
│       └── 01-create-databases.sql        # Seven owned databases, first-init only
│
├── .github/                                # GitHub Configuration
│   └── workflows/
│       └── ci.yml                         # CI checks (GAP-ENV-1; no deploy)
│
# (No root `scripts/`, `k8s/` or `terraform/` directories exist in this tree.)

├── docs/                                   # Documentation
│   ├── README.md                          # Main documentation
│   ├── SETUP.md                           # Setup guide
│   ├── ARCHITECTURE.md                    # Architecture (ADR)
│   ├── API.md                             # API documentation
│   ├── DATABASE.md                        # Database schema
│   ├── DEVELOPMENT.md                     # Development guide
│   ├── DEPLOYMENT.md                      # Deployment guide
│   ├── SECURITY.md                        # Security considerations
│   └── CONTRIBUTING.md                    # Contributing guide
│
├── .gitignore
├── .env.example                            # Example environment variables
├── .eslintrc.json                          # Root ESLint config
├── .prettierrc                             # Root Prettier config
├── package.json                            # Monorepo package.json
├── pnpm-workspace.yaml                    # pnpm workspaces (or yarn workspaces)
├── tsconfig.json                           # Root TypeScript config
├── turbo.json                              # Turbo monorepo config (optional)
├── docker-compose.yml                      # Root docker compose (references apps)
├── README.md                               # Project README
├── ROADMAP.md                              # Project roadmap
├── CHANGELOG.md                            # Changelog
└── LICENSE

```

---

## Directory Naming Conventions

### Frontend (Next.js)

- **Route segments** in parentheses: `(marketing)`, `(auth)` for logical grouping
- **Dynamic segments** in brackets: `[id]`, `[slug]` for routes with parameters
- **Private routes** in `protected/`: Routes requiring authentication
- **Component files**: PascalCase (e.g., `ContactForm.tsx`)
- **Utility files**: camelCase (e.g., `apiClient.ts`)
- **Type files**: camelCase with `.types.ts` suffix (e.g., `user.types.ts`)
- **Hook files**: camelCase with `use` prefix (e.g., `useAuth.ts`)

### Backend (NestJS)

- **Module folders**: Feature name in kebab-case (e.g., `lead-management`)
- **File naming**: Feature name with extension (e.g., `leads.controller.ts`, `leads.service.ts`)
- **Class names**: PascalCase (e.g., `LeadsController`, `LeadsService`)
- **DTO files**: Feature name + `.dto.ts` (e.g., `create-lead.dto.ts`)
- **Entity files**: Feature name + `.entity.ts` (e.g., `lead.entity.ts`)

---

## Key Files Summary

| File | Purpose |
|------|---------|
| `apps/web/app/layout.tsx` | Root layout for entire app |
| `apps/web/middleware.ts` | Route protection and auth redirects |
| `apps/api/src/app.module.ts` | Combined runtime root module for NestJS app |
| `apps/api/src/core-app.module.ts` | Core runtime root module |
| `apps/api/src/cms-app.module.ts` | CMS runtime root module |
| `apps/api/prisma/core/schema.prisma` | Core datasource schema (CORE_DATABASE_URL) |
| `apps/api/prisma/cms/schema.prisma` | CMS datasource schema (CMS_DATABASE_URL) |
| `apps/api/prisma/observability/schema.prisma` | Observability datasource schema (OBSERVABILITY_DATABASE_URL) |
| `apps/api/prisma/correspondence/schema.prisma` | Correspondence datasource schema (CORRESPONDENCE_DATABASE_URL) |
| `apps/api/prisma/hr/schema.prisma` | HR datasource schema (HR_DATABASE_URL) |
| `apps/api/prisma/commerce/schema.prisma` | Commerce datasource schema (COMMERCE_DATABASE_URL) |
| `apps/api/prisma/production/schema.prisma` | Production datasource schema (PRODUCTION_DATABASE_URL) |
| `apps/api/prisma/financial/schema.prisma` | Financial datasource schema (FINANCE_DATABASE_URL) |
| `apps/api/src/runtime-datasources.ts` | Canonical datasource ownership registry |
| `apps/api/scripts/runtime-policy.mjs` | Runtime-policy projection tooling for Docker |
| `apps/api/runtime-policy.json` | Machine-readable runtime policy projection |
| `apps/api/prisma/schema.prisma` | Deprecated legacy schema kept for historical migration compatibility only |
| `packages/types/src/index.ts` | Shared types for entire monorepo |
| `infrastructure/docker-compose.yml` | Local development environment |
| `.github/workflows/ci.yml` | CI/CD pipeline |

---

## Environment Variables Structure

**Frontend (`.env.local`)**:
```
NEXT_PUBLIC_API_URL=http://localhost:3001/api
NEXT_PUBLIC_GOOGLE_ANALYTICS_ID=G_...
```

**Backend (`.env.local`)**:
```
CORE_DATABASE_URL=postgresql://user:pass@localhost:5433/core_db
CMS_DATABASE_URL=postgresql://user:pass@localhost:5433/cms_db
CORRESPONDENCE_DATABASE_URL=postgresql://user:pass@localhost:5433/correspondence_db
HR_DATABASE_URL=postgresql://user:pass@localhost:5433/hr_db
COMMERCE_DATABASE_URL=postgresql://user:pass@localhost:5433/commerce_db
PRODUCTION_DATABASE_URL=postgresql://user:pass@localhost:5433/production_db
FINANCE_DATABASE_URL=postgresql://user:pass@localhost:5433/finance_db
OBSERVABILITY_DATABASE_URL=postgresql://user:pass@localhost:5433/observability_db
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_secret_key
```

`DATABASE_URL` is a deprecated legacy variable for `prisma/schema.prisma` and is not a runtime contract. Each datasource has its own owner-specific Prisma project and migration command.

---

## Next Steps

1. Initialize monorepo root
2. Create Next.js app with `create-next-app`
3. Create NestJS app with `nest new`
4. Setup shared packages
5. Configure Docker Compose
6. GitHub Actions CI exists (`.github/workflows/ci.yml` — checks only, no deployment)

