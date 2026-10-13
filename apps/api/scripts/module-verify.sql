-- Phase 49M verification: prove the two new tables, their five enums, their indexes (including the
-- PARTIAL one Prisma cannot express), their CHECK constraints and the single internal foreign key
-- exist exactly as the migration declares — and that nothing else in core_db changed shape.
--
-- Mirrors scripts/integration-verify.sql (49L) in structure so the two can be compared at a glance.
\echo '== TABLES =='
select table_name from information_schema.tables
where table_schema='public' and table_name in ('ModuleRegistration','ModuleInstance')
order by table_name;

\echo '== ENUMS =='
select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
from pg_type t join pg_enum e on e.enumtypid=t.oid
where t.typname in ('ModuleType','ModuleDeploymentMode','ModuleLifecycleState','ModuleHealthState','ModuleTenantScope')
group by t.typname order by t.typname;

\echo '== CHECKS =='
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid in ('"ModuleRegistration"'::regclass,'"ModuleInstance"'::regclass)
  and contype='c'
order by conname;

\echo '== INDEXES =='
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename in ('ModuleRegistration','ModuleInstance')
order by indexname;

\echo '== PARTIAL INDEX PREDICATE (must match SWEEPABLE_LIFECYCLES) =='
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='ModuleInstance' and indexdef like '%WHERE%';

\echo '== FOREIGN KEYS (expect exactly ONE, internal to this phase) =='
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid in ('"ModuleRegistration"'::regclass,'"ModuleInstance"'::regclass)
  and contype='f'
order by conname;

\echo '== PERMISSIONS =='
select name, domain from "Permission" where name like 'admin.modules%' order by name;

\echo '== GRANTS =='
select r.name, p.name from "RolePermission" rp
join "Role" r on r.id=rp."roleId"
join "Permission" p on p.id=rp."permissionId"
where p.name like 'admin.modules%'
order by r.name, p.name;

\echo '== NO BUSINESS TABLE WAS CREATED (expect 0) =='
select count(*) as business_tables from information_schema.tables
where table_schema='public'
  and (table_name ilike '%hr%' or table_name ilike '%finance%' or table_name ilike '%employee%'
       or table_name ilike '%invoice%' or table_name ilike '%payroll%');

\echo '== NO SYNC / CONFLICT / PROVISIONING TABLE (expect 0) =='
select count(*) as foundation_tables from information_schema.tables
where table_schema='public'
  and (table_name ilike '%sync%' or table_name ilike '%conflict%' or table_name ilike '%provision%'
       or table_name ilike '%mesh%');

\echo '== 49L TABLES UNCHANGED (expect 2) =='
select count(*) as integration_tables from information_schema.tables
where table_schema='public' and table_name in ('IntegrationConfig','AutomationExecution');

\echo '== MIGRATIONS =='
select count(*) as applied from "_prisma_migrations" where finished_at is not null;
select count(*) as unfinished from "_prisma_migrations" where finished_at is null;
select count(*) as rolled_back from "_prisma_migrations" where rolled_back_at is not null;

\echo '== ROW COUNTS (expect 0 / 0 — no seed row) =='
select (select count(*) from "ModuleRegistration") as registrations,
       (select count(*) from "ModuleInstance") as instances;
