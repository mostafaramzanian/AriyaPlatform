-- Phase 49L E2E cleanup. Deliberately narrow: only the two tables this phase
-- created, and only after a run that was interrupted before its own cleanup ran.
DELETE FROM "AutomationExecution";
DELETE FROM "IntegrationConfig";
SELECT count(*) AS executions_left FROM "AutomationExecution";
SELECT count(*) AS configs_left FROM "IntegrationConfig";
