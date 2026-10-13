20260728_initial_schema

This migration was generated during E2E production-hardening to restore a missing migration history. It creates the full initial schema derived from prisma/schema.prisma. Reason: repository was missing earlier migration folders; database is freshly created during validation so creating an initial migration to establish base schema is acceptable.

Root cause: prior migration files not present in repo. Fix: add baseline migration. Impact: creates all tables and enums on a fresh DB. Regression risk: low for fresh DB; high if applied to an existing DB with data. Use only on fresh/destroyed volumes during production-hardening.
