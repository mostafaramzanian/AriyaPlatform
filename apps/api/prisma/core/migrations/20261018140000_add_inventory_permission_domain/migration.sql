-- Phase W1 — WAREHOUSE / INVENTORY FOUNDATION: register the INVENTORY domain
-- member on PermissionDomain, in its OWN migration — PostgreSQL forbids USING
-- a freshly added enum value inside the transaction that added it (55P04), the
-- same reason every earlier domain got a standalone file.

ALTER TYPE "PermissionDomain" ADD VALUE IF NOT EXISTS 'INVENTORY';
