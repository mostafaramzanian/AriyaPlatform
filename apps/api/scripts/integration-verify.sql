-- Phase 49L verification: prove the two new tables, their enums, their indexes and
-- their CHECK constraints exist exactly as the migration declares, and that nothing
-- else in core_db changed shape.
\echo '== TABLES =='
select table_name from information_schema.tables
where table_schema='public' and table_name in ('IntegrationConfig','AutomationExecution')
order by table_name;

\echo '== ENUMS =='
select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
from pg_type t join pg_enum e on e.enumtypid=t.oid
where t.typname in ('IntegrationKey','AutomationStatus')
group by t.typname order by t.typname;

\echo '== CHECKS =='
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid in ('"IntegrationConfig"'::regclass,'"AutomationExecution"'::regclass)
  and contype='c'
order by conname;

\echo '== INDEXES =='
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename in ('IntegrationConfig','AutomationExecution')
order by indexname;

\echo '== FOREIGN KEYS (expect none) =='
select count(*) from pg_constraint
where conrelid in ('"IntegrationConfig"'::regclass,'"AutomationExecution"'::regclass)
  and contype='f';

\echo '== PERMISSIONS =='
select name, domain from "Permission" where name like 'admin.integrations%' order by name;

\echo '== GRANTS =='
select r.name, p.name from "RolePermission" rp
join "Role" r on r.id=rp."roleId"
join "Permission" p on p.id=rp."permissionId"
where p.name like 'admin.integrations%'
order by r.name, p.name;

\echo '== MIGRATIONS =='
select count(*) as applied from "_prisma_migrations" where finished_at is not null;
select count(*) as unfinished from "_prisma_migrations" where finished_at is null;
select count(*) as rolled_back from "_prisma_migrations" where rolled_back_at is not null;

\echo '== ROW COUNTS =='
select (select count(*) from "IntegrationConfig") as configs,
       (select count(*) from "AutomationExecution") as executions;
