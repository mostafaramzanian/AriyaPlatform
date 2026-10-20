/**
 * Permission Constants
 * Define all system permissions by domain
 * Format: domain.action (e.g., users.read, admin.users.read)
 */

export const Permissions = {
  // User Management
  USERS_READ: 'users.read',
  USERS_CREATE: 'users.create',
  USERS_UPDATE: 'users.update',
  USERS_DELETE: 'users.delete',

  // Lead Management
  LEADS_READ: 'leads.read',
  LEADS_CREATE: 'leads.create',
  LEADS_UPDATE: 'leads.update',
  LEADS_ASSIGN: 'leads.assign',
  LEADS_DELETE: 'leads.delete',

  // Meeting Management
  MEETINGS_READ: 'meetings.read',
  MEETINGS_SCHEDULE: 'meetings.schedule',
  MEETINGS_CANCEL: 'meetings.cancel',

  // Blog Management
  BLOG_READ: 'blog.read',
  BLOG_WRITE: 'blog.write',
  BLOG_PUBLISH: 'blog.publish',
  BLOG_DELETE: 'blog.delete',

  // Admin - User Management
  ADMIN_USERS_READ: 'admin.users.read',
  ADMIN_USERS_CREATE: 'admin.users.create',
  ADMIN_USERS_UPDATE: 'admin.users.update',
  ADMIN_USERS_DELETE: 'admin.users.delete',

  // Admin - Role Management
  ADMIN_ROLES_READ: 'admin.roles.read',
  ADMIN_ROLES_ASSIGN: 'admin.roles.assign',
  ADMIN_ROLES_REMOVE: 'admin.roles.remove',
  ADMIN_ROLES_PERMISSIONS: 'admin.roles.permissions',

  // Admin - System Management
  ADMIN_SYSTEM_READ: 'admin.system.read',
  ADMIN_SYSTEM_SETTINGS: 'admin.system.settings',
  ADMIN_SYSTEM_MAINTENANCE: 'admin.system.maintenance',

  // Admin - Audit
  ADMIN_AUDIT_READ: 'admin.audit.read',
  ADMIN_AUDIT_EXPORT: 'admin.audit.export',

  // Admin - Security
  ADMIN_SECURITY_READ: 'admin.security.read',
  ADMIN_SECURITY_MANAGE: 'admin.security.manage',

  // Admin - Analytics
  ADMIN_ANALYTICS_READ: 'admin.analytics.read',

  // Admin - Support
  ADMIN_SUPPORT_MANAGE: 'admin.support.manage',

  // Admin - AI Provider Configuration (Phase 49J-0)
  //
  // Two permissions, mirroring the surveys split: reading which provider and
  // model are live is a diagnostic capability (OPERATIONS_ADMIN has it), while
  // writing a provider row — and with it an API key — is platform
  // administration. Collapsing them would force "can see the config" to imply
  // "can replace the credential".
  //
  // Domain is ADMIN. `PermissionDomain` in the Prisma schema has no AI member,
  // and these sit beside `admin.system.settings` semantically: platform
  // configuration, not a business domain.
  ADMIN_AI_MANAGE: 'admin.ai.manage',
  ADMIN_AI_READ: 'admin.ai.read',

  // Admin - Automation & Integration Platform (Phase 49L)
  //
  // Two permissions, mirroring the 49J-0 AI split for the same reason: reading
  // whether automation is reaching the external engine is a diagnostic
  // capability (OPERATIONS_ADMIN has it), while writing an integration — and
  // with it an outbound destination and a shared HMAC secret — is platform
  // administration. Collapsing them would force "can see the integration" to
  // imply "can repoint it and rotate its secret".
  //
  // Domain is ADMIN. `PermissionDomain` in the Prisma schema has no INTEGRATIONS
  // member, and these sit beside `admin.ai.*` and `admin.system.settings`
  // semantically: platform configuration, not a business domain.
  //
  // Both are seeded by 20260904120500_seed_integration_permission_grants, so the
  // gates on IntegrationController are real rather than authorization theatre.
  ADMIN_INTEGRATIONS_MANAGE: 'admin.integrations.manage',
  ADMIN_INTEGRATIONS_READ: 'admin.integrations.read',

  // Admin - Distributed Module Platform (Phase 49M)
  //
  // Two permissions, the same split as 49L and for the same reason: reading which
  // modules are registered and whether they are reachable is a DIAGNOSTIC
  // capability (OPERATIONS_ADMIN has it), while registering a module, enabling
  // one, changing its tenant scope or rotating its credential is PLATFORM
  // ADMINISTRATION. Collapsing them would force "can see the module list" to
  // imply "can admit a new module to the platform".
  //
  // NEITHER STRING NAMES A MODULE. There is no `admin.modules.finance.*` and
  // there never should be: a module's own business permissions belong to that
  // module, and a per-module permission here would make adding a module a change
  // to Core's permission catalogue — the coupling this phase exists to prevent.
  //
  // Domain is ADMIN. `PermissionDomain` in the Prisma schema has no MODULES
  // member, and these sit beside `admin.integrations.*` and `admin.ai.*`
  // semantically: platform configuration, not a business domain.
  //
  // Both are seeded by 20260905120500_seed_module_permission_grants, so the gates
  // on ModuleRegistryController are real rather than authorization theatre.
  ADMIN_MODULES_MANAGE: 'admin.modules.manage',
  ADMIN_MODULES_READ: 'admin.modules.read',

  // Admin - Observability Platform (Phase 49M-2)
  //
  // ONE PERMISSION, NOT TWO, and the asymmetry with 49L/49M above is deliberate:
  // there is nothing here to `manage`. The observability platform has no
  // administrator-writable configuration — levels, queue sizes, flush cadence and
  // retention windows are environment variables read once at startup, and every
  // row is written by the platform itself. A `admin.observability.manage` string
  // would gate an empty set of operations, which is authorization theatre.
  //
  // WHY IT IS NOT `admin.audit.read`, which already exists: that permission gates
  // core_db."AuditLog", it is held by ADMIN, and it is still used by the existing
  // audit endpoints (§51 KEEP). Reusing it here would silently widen ADMIN's reach
  // to the new `SecurityEvent` table, whose failed-login and permission-denial
  // rows are read under `admin.security.read` by SUPER_ADMIN/SECURITY_ADMIN only.
  //
  // THIS PERMISSION DOES NOT GRANT SECURITY EVENTS. `GET /admin/observability/security-events`
  // is gated by `admin.security.read` INSTEAD of this one, not in addition to it,
  // because RolesGuard resolves `@Roles(...)` with `.some(...)` — naming two
  // permissions would grant access to holders of EITHER, widening the route rather
  // than narrowing it. Substitution is the only way to express a narrower audience
  // under OR semantics.
  //
  // WHY IT IS NOT `admin.system.read` either: that is a broad diagnostic
  // capability covering settings and health, whereas these tables contain user
  // ids, IP addresses, user agents and redacted before/after values. Log access
  // deserves to be grantable and revocable on its own.
  //
  // Domain is ADMIN, beside `admin.modules.*` and `admin.integrations.*`:
  // platform operation, not a business domain.
  //
  // Seeded by 20260905160000_seed_observability_permission_grants, so the gate on
  // ObservabilityController is real rather than declarative.
  ADMIN_OBSERVABILITY_READ: 'admin.observability.read',

  // Admin - Surveys (Phase 49H)
  //
  // Two permissions, not one, because authoring a survey and reading its
  // aggregated results are genuinely different privileges: an author may
  // legitimately be denied sight of the answers, and a results viewer has no
  // business editing the questionnaire. Collapsing them would make the split
  // unexpressible.
  ADMIN_SURVEYS_MANAGE: 'admin.surveys.manage',
  ADMIN_SURVEYS_RESULTS: 'admin.surveys.results',

  // Correspondence / Official Letters (Phase 50)
  //
  // THREE permissions, and the personal workflow is deliberately gated by NONE of
  // them — creating drafts, sending, being a recipient, referring letters you may
  // see and archiving into your own folders are ordinary authenticated-user
  // capabilities bounded by ownership/recipient edges and tenant scope in
  // CorrespondenceService, exactly as 49H treated survey participation and 49G
  // treated support tickets. A 'correspondence.use' string would gate an empty set
  // of operations and imply a per-role participation model this phase does not
  // build.
  //
  //   manage — tenant-wide correspondence administration: read any letter in the
  //            tenant (including BCC identities) and change a SENT letter's
  //            classification. Classification can be RAISED or LOWERED only here.
  //   confidential.manage — author (or refer) CONFIDENTIAL/SECRET letters at all.
  //            Normal creation is ungated: the capability to write an ordinary
  //            letter is personal, the capability to classify one محرمانه/سری is
  //            not.
  //   confidential.read — see confidential letters one is NOT a participant of
  //            (manager views + search). Participants never need it: a letter
  //            addressed TO you implies need-to-know, and gating the recipient's
  //            own read would break the feature rather than harden it.
  //
  // Domain is CORRESPONDENCE — a NEW PermissionDomain member, because this is the
  // FIRST business-domain permission set in the catalogue: everything before it
  // sat in ADMIN/partner/customer/support. Adding the member keeps the admin UI's
  // PermissionsByDomain grouping honest instead of pretending correspondence is
  // platform configuration.
  //
  // All three are seeded by 20260912120500_seed_correspondence_permission_grants,
  // granted to SUPER_ADMIN and ADMIN only — so the gates are real rather than
  // authorization theatre.
  CORRESPONDENCE_MANAGE: 'correspondence.manage',
  CORRESPONDENCE_CONFIDENTIAL_READ: 'correspondence.confidential.read',
  CORRESPONDENCE_CONFIDENTIAL_MANAGE: 'correspondence.confidential.manage',

  // Human Resources (Phase 51-HR-1)
  //
  // SIX PERMISSIONS, IN PAIRS — read and manage — one pair per aggregate the module
  // owns: personnel records, the organization hierarchy, and the position catalogue.
  //
  // WHY THE PAIR, AND WHY NOT MORE. Reading personnel data and changing it are
  // genuinely different entitlements: an HR analyst needs the first without the
  // second, and collapsing them would force "can see the org chart" to imply "can
  // transfer an employee". Going further (a separate `hr.employees.terminate`, or a
  // per-field grant) would be authorization theatre: there is no HR operation here
  // that a manager may read but not write, nor one a writer may not read.
  //
  // Domain is HR. The `PermissionDomain` enum gains its HR member in the companion
  // Core migration `20260916100000_add_hr_permission_domain` — as its OWN migration,
  // before the seed, because PostgreSQL forbids USING a freshly added enum value in
  // the transaction that added it (SQLSTATE 55P04).
  //
  // All six are seeded in core_db by `20260916100100_seed_hr_permission_grants`,
  // granted to SUPER_ADMIN and ADMIN only, so the gates on the HR controllers are
  // real rather than authorization theatre. A permission string that only lives in
  // this file is a permission NOBODY has.
  HR_EMPLOYEES_READ: 'hr.employees.read',
  HR_EMPLOYEES_MANAGE: 'hr.employees.manage',
  HR_ORGANIZATION_READ: 'hr.organization.read',
  HR_ORGANIZATION_MANAGE: 'hr.organization.manage',
  HR_POSITIONS_READ: 'hr.positions.read',
  HR_POSITIONS_MANAGE: 'hr.positions.manage',

  // Human Resources — attendance (Phase 51-HR-3).
  //
  // TWO PERMISSIONS, the same pair shape as the aggregates above, for exactly the
  // reason recorded there: reading the register and writing to it are different
  // entitlements. Seeded, together with every other `hr.*` string, by a Core
  // migration (`20260918130000_seed_hr_attendance_permission_grants`) — granted to
  // SUPER_ADMIN and ADMIN only, so the gates on `AttendanceController` are real.
  //
  // The scoped variants the readiness audit sketches (`hr.attendance.read.self`,
  // `hr.attendance.read.team`) are deliberately ABSENT. Self-service needs an
  // authoritative employee→login link the module does not have yet, and team scope
  // needs a server-derived reporting subtree (audit risk R6) that does not exist yet.
  // A permission declared before its surface is granted into nothing and implies a
  // capability the API does not have — see the migration header, and the Phase 50
  // note above about `*.use` strings.
  HR_ATTENDANCE_READ: 'hr.attendance.read',
  HR_ATTENDANCE_MANAGE: 'hr.attendance.manage',

  // Human Resources — leave (Phase 51-HR-3A; extended by Phase 54-E).
  //
  // THREE PERMISSIONS now. The original pair reads and writes the register; the third
  // is the APPROVAL capability Phase 54-E establishes.
  //
  // `hr.leave.approve` IS A CAPABILITY, NOT A DECISION AUTHORITY. It answers "may this
  // actor ever decide a leave step in this tenant". It does NOT answer "may they decide
  // THIS request": that second question is answered by the flow, and only by the flow —
  // the actor must be the RESOLVED APPROVER of the step that is currently ACTIVE
  // (§18.3). Both are required, and the service checks them separately so neither can
  // stand in for the other. A holder of this string who is not the resolved approver of
  // the live step is refused; that refusal is the whole point of the split.
  //
  // The reason the string is granted to SUPER_ADMIN and ADMIN (§15) and nobody else is
  // that both roles are TENANT-WIDE administrators: "who may be named as an approver" is
  // not a per-person entitlement but a statement about the tenant's own flow. A manager
  // who is NAMED as an approver in a flow still needs this string to act — which is why
  // the earlier note below, recording it as deliberately absent, is now superseded.
  //
  // Seeded in `core_db` by `20260922120000_seed_hr_leave_approve_permission_grant`,
  // granted to SUPER_ADMIN and ADMIN only.
  HR_LEAVE_READ: 'hr.leave.read',
  HR_LEAVE_MANAGE: 'hr.leave.manage',
  HR_LEAVE_APPROVE: 'hr.leave.approve',

  // Human Resources — leave POLICY authoring (Phase 54-F).
  //
  // ONE PERMISSION, NOT A READ/MANAGE PAIR, and the asymmetry is the point rather than an
  // omission. A policy version decides what the organization is GOVERNED BY, and there is no
  // legitimate tenant role that may READ the rules but not state them: the rules are already
  // published, in force against every employee, and invisible to nobody who can file a
  // request against them. Introducing a read half would therefore grant a string that no
  // route would gate on — the "a permission that claims authority before it exists is the
  // widest kind of lie" failure §39 warns about, in mirror image: a permission that claims
  // LEAST privilege before anything needs it.
  //
  // READ ACCESS IS `hr.leave.read`. That is deliberate reuse rather than a second string:
  // both answer "may this actor see what this tenant grants", and a policy IS what the
  // tenant grants. Splitting them would let a tenant grant one and not the other, which
  // would produce a request surface whose rules its own administrators cannot read.
  //
  // WHAT IT GATES, PRECISELY (§25's separation applied to configuration): authoring a draft,
  // validating it, publishing it, and archiving it. It does NOT gate deciding a leave
  // request (`hr.leave.approve`) and it does not imply it: an approver applies the flow,
  // and restating the flow is a different act by a different role. A tenant may therefore
  // grant the ability to decide a request WITHOUT granting the ability to rewrite the rule
  // that governs it, which is exactly the separation the approval split exists to keep.
  //
  // NOT YET SEEDED IN `core_db`. `Permission` rows are created by a Core migration, and this
  // string is introduced with the service that gates on it, ahead of its seed — the same
  // order Phase 54-E used. Until the companion seed lands, the string is resolvable by the
  // guards and granted to nobody, which fails CLOSED: a route gated on it refuses rather
  // than admitting an unentitled caller.
  HR_LEAVE_POLICY: 'hr.leave.policy',

  // Human Resources — Mission (Phase 55).
  //
  // Same read / manage / approve / policy split as leave, for the same authority separation:
  // reading the register, editing it, deciding a step, and authoring the rule set are four
  // different acts. The seed migration grants all four to SUPER_ADMIN and ADMIN only.
  HR_MISSION_READ: 'hr.mission.read',
  HR_MISSION_MANAGE: 'hr.mission.manage',
  HR_MISSION_APPROVE: 'hr.mission.approve',
  HR_MISSION_POLICY: 'hr.mission.policy',

  // Partner Portal
  PARTNER_DASHBOARD: 'partner.dashboard',
  PARTNER_DEALS: 'partner.deals',
  PARTNER_REVENUE: 'partner.revenue',

  // Customer Portal
  CUSTOMER_DASHBOARD: 'customer.dashboard',
  CUSTOMER_PROFILE: 'customer.profile',

  // Support
  SUPPORT_TICKETS: 'support.tickets',
  SUPPORT_DOWNLOADS: 'support.downloads',

  // Commerce (Phase C1, §10)
  //
  // SIX PERMISSIONS, THE EXACT NAMES THE AUTHORITATIVE C1 SPECIFICATION DECLARES in its
  // §10 — none invented here, because a permission name outside the spec's list would be
  // a gate nobody can justify (the NO-GUESS rule names "permission names" explicitly).
  // Each maps to API behavior the C1 API DESIGN (§8) requires of THIS phase:
  //
  //   commerce.read              — purchase read/list/detail, workflow history, the
  //                                commercial entry reads behind their §8 routes;
  //   commerce.manage            — purchase create / update / submit;
  //   commerce.approve           — commercial approval and workflow decision actions;
  //   commerce.configure         — procurement workflow configuration (§6's product
  //                                capability, §8's workflow configuration endpoints);
  //   commerce.workflow.manage   — workflow definition/version lifecycle: author,
  //                                validate, publish, archive;
  //   commerce.commercial.manage — assignment, quotation entry, confirmation, correction.
  //
  // Domain is COMMERCE — a NEW PermissionDomain member, added in its OWN companion Core
  // migration `20260926100000_add_commerce_permission_domain` BEFORE the seed, because
  // PostgreSQL forbids USING a freshly added enum value in the transaction that added it
  // (SQLSTATE 55P04) — the same reason the CORRESPONDENCE and HR members were added in
  // their own migrations. Grouping them under ADMIN instead would make the admin UI's
  // PermissionsByDomain honest-looking but the domain column dishonest: this is a business
  // module's remit, not platform configuration.
  //
  // All six are seeded in `core_db` by `20260926100100_seed_commerce_permission_grants`,
  // granted to SUPER_ADMIN and ADMIN only. At the moment of registration no Commerce
  // controller exists yet (they arrive with the domain steps); that is safe rather than
  // premature: RolesGuard resolves a permission only where a route DECLARES it with
  // `@Roles(...)`, so an unenforced catalogue row grants nothing — registration makes the
  // gate POSSIBLE, the route decorator makes it REAL. The inverse failure is the one the
  // seed exists to prevent: a string living only in this file is a permission NOBODY has,
  // and every Commerce route would then 403 for every caller including SUPER_ADMIN.
  COMMERCE_READ: 'commerce.read',
  COMMERCE_MANAGE: 'commerce.manage',
  COMMERCE_APPROVE: 'commerce.approve',
  COMMERCE_CONFIGURE: 'commerce.configure',
  COMMERCE_WORKFLOW_MANAGE: 'commerce.workflow.manage',
  COMMERCE_COMMERCIAL_MANAGE: 'commerce.commercial.manage',
  // SEVENTH (supplier master data): create/update the supplier directory and read
  // its SENSITIVE BANKING projection. Seeded by
  // `20261017140100_seed_commerce_supplier_permission` (core_db), granted to
  // SUPER_ADMIN and ADMIN. Deliberately NOT folded into
  // `commerce.commercial.manage`: supplier banking details are ring-fenced by the
  // business requirements, and the quotation/assignment remit must not carry them.
  COMMERCE_SUPPLIER_MANAGE: 'commerce.supplier.manage',

  // Production (Phase PRODUCTION-BOM-HEADER)
  //
  // THREE PERMISSIONS, THE EXACT NAMES the completed M-1…M-7 decision closure declared in
  // its §17.3 proposal — none invented here, because a permission name outside an agreed
  // list is a gate nobody can justify (the NO-GUESS rule names "permission names"
  // explicitly). Each maps to API behavior this phase actually ships:
  //
  //   production.bom.read    — BOM list and detail (the two GET routes);
  //   production.bom.manage  — create, edit-while-draft, and submit (the authorship remit);
  //   production.bom.approve — the three decision acts: approve, reject, request-correction.
  //
  // WHY `read` IS SEPARATE FROM `manage` AND `approve` IS SEPARATE FROM BOTH. An engineer
  // who may look at a BOM is not thereby entitled to author one, and an author is not
  // thereby entitled to decide one — the same three-way split `commerce.read` /
  // `commerce.manage` / `commerce.approve` establishes, and the same reason HR splits its
  // remits. Collapsing them would make "can read the BOM register" imply "can approve a
  // BOM", which is the authorization failure the source avoided only by accident (its
  // approver was whoever SharePoint's task happened to be assigned to).
  //
  // Domain is PRODUCTION — a NEW PermissionDomain member, added in its OWN companion Core
  // migration `20261002100000_add_production_permission_domain` BEFORE the seed, because
  // PostgreSQL forbids USING a freshly added enum value in the transaction that added it
  // (SQLSTATE 55P04) — the same reason CORRESPONDENCE, HR and COMMERCE each have a
  // standalone domain migration.
  //
  // All three are seeded in `core_db` by `20261002100100_seed_production_permission_grants`,
  // granted to SUPER_ADMIN and ADMIN only. A permission string that only lives in this file
  // is a permission NOBODY has, and every Production route would then 403 for every caller
  // including SUPER_ADMIN.
  PRODUCTION_BOM_READ: 'production.bom.read',
  PRODUCTION_BOM_MANAGE: 'production.bom.manage',
  PRODUCTION_BOM_APPROVE: 'production.bom.approve',

  // Financial (Phase F1 — FINANCIAL FOUNDATION)
  //
  // THREE PERMISSIONS, THE EXACT NAMES the Preflight's §14 proposal declared — none
  // invented here, because a permission name outside an agreed list is a gate nobody can
  // justify (the NO-GUESS rule names "permission names" explicitly). Each maps to API
  // behavior this phase actually ships:
  //
  //   financial.check.read    — the register, one request, its timeline and its
  //                             attachments list (the read remit);
  //   financial.check.manage  — create, edit while requester-owned (states 0/1),
  //                             submit, and attachment upload / metadata / delete;
  //   financial.check.approve — the three manager decision acts: approve, reject,
  //                             request-correction.
  //
  // WHY `read` IS SEPARATE FROM `manage`, AND `approve` FROM BOTH: the same three-way
  // split `commerce.*` and `production.bom.*` establish. An engineer who may look at a
  // request is not thereby entitled to author one, and an author is not thereby entitled
  // to decide one — collapsing them would let a requester approve their own request
  // through a permission they already hold.
  //
  // Domain is FINANCIAL — a NEW PermissionDomain member, added in its OWN companion Core
  // migration `20261003160000_add_financial_permission_domain` BEFORE the seed, because
  // PostgreSQL forbids USING a freshly added enum value in the transaction that added it
  // (SQLSTATE 55P04) — the same reason PRODUCTION, COMMERCE, HR and CORRESPONDENCE each
  // have a standalone domain migration.
  //
  // All three are seeded in `core_db` by `20261003160100_seed_financial_permission_grants`,
  // granted to SUPER_ADMIN and ADMIN only. A permission string that only lives in this
  // file is a permission NOBODY has, and every Financial route would then 403 for every
  // caller including SUPER_ADMIN.
  FINANCIAL_CHECK_READ: 'financial.check.read',
  FINANCIAL_CHECK_MANAGE: 'financial.check.manage',
  FINANCIAL_CHECK_APPROVE: 'financial.check.approve',

  // Inventory (Phase W1 — WAREHOUSE / INVENTORY FOUNDATION)
  //
  //   inventory.read    — every register, balance, movement and report read;
  //   inventory.manage  — warehouses, locations, items/units, receipts, issues,
  //                       adjustments, reversals, transfers, count data-entry;
  //   inventory.approve — posting a stock count's variances: the counter and
  //                       the poster are not the same privilege, because a
  //                       variance writes ledger rows with a balance effect.
  //
  // Domain is INVENTORY — added in its OWN companion Core migration before the
  // grant seed (PostgreSQL 55P04 rule, the same reason every earlier domain got
  // a standalone enum migration). Granted to SUPER_ADMIN and ADMIN only.
  INVENTORY_READ: 'inventory.read',
  INVENTORY_MANAGE: 'inventory.manage',
  INVENTORY_APPROVE: 'inventory.approve',
  // Phase CHECK-ISSUATION: FOUR stage remits, added with the stages they gate. The
  // Preflight §17 candidate list proposed exactly these four (plus a separate executive
  // permission this phase deliberately does NOT create — see below), and each names a
  // capability that exists only from this phase on:
  //
  //   financial.check.allocate  — stage 3 «صدور فرم تخصیص»: the allocation form;
  //   financial.check.review     — stage 4 «بررسی اسناد»: the document-review decision;
  //   financial.check.issue      — stage 6 «صدور چک»: cheque image + issuance confirm;
  //   financial.check.deliver    — stage 7 «دریافت رسید تحویل»: receipt + completion.
  //
  // WHY FOUR AND NOT ONE `approve`: six source stages are acted by six DIFFERENT
  // people — collapsing them would let one holder act at every stage. WHY NO
  // `approve.executive`: stage 5 is an approval act whose actor separation the source
  // expresses only through the (not modelled) `ArjaBe` name, so the brief's §12 rule —
  // a new permission ONLY for a genuinely separate capability — keeps the presidency on
  // `financial.check.approve`, with the self-approval refusal as the enforceable rule.
  FINANCIAL_CHECK_ALLOCATE: 'financial.check.allocate',
  FINANCIAL_CHECK_REVIEW: 'financial.check.review',
  FINANCIAL_CHECK_ISSUE: 'financial.check.issue',
  FINANCIAL_CHECK_DELIVER: 'financial.check.deliver',
} as const;

// Map permission to domain
export const PermissionToDomain = {
  [Permissions.USERS_READ]: 'USERS',
  [Permissions.USERS_CREATE]: 'USERS',
  [Permissions.USERS_UPDATE]: 'USERS',
  [Permissions.USERS_DELETE]: 'USERS',

  [Permissions.LEADS_READ]: 'LEADS',
  [Permissions.LEADS_CREATE]: 'LEADS',
  [Permissions.LEADS_UPDATE]: 'LEADS',
  [Permissions.LEADS_ASSIGN]: 'LEADS',
  [Permissions.LEADS_DELETE]: 'LEADS',

  [Permissions.MEETINGS_READ]: 'MEETINGS',
  [Permissions.MEETINGS_SCHEDULE]: 'MEETINGS',
  [Permissions.MEETINGS_CANCEL]: 'MEETINGS',

  [Permissions.BLOG_READ]: 'BLOG',
  [Permissions.BLOG_WRITE]: 'BLOG',
  [Permissions.BLOG_PUBLISH]: 'BLOG',
  [Permissions.BLOG_DELETE]: 'BLOG',

  [Permissions.ADMIN_USERS_READ]: 'ADMIN',
  [Permissions.ADMIN_USERS_CREATE]: 'ADMIN',
  [Permissions.ADMIN_USERS_UPDATE]: 'ADMIN',
  [Permissions.ADMIN_USERS_DELETE]: 'ADMIN',

  [Permissions.ADMIN_ROLES_READ]: 'ADMIN',
  [Permissions.ADMIN_ROLES_ASSIGN]: 'ADMIN',
  [Permissions.ADMIN_ROLES_REMOVE]: 'ADMIN',
  [Permissions.ADMIN_ROLES_PERMISSIONS]: 'ADMIN',

  [Permissions.ADMIN_SYSTEM_READ]: 'ADMIN',
  [Permissions.ADMIN_SYSTEM_SETTINGS]: 'ADMIN',
  [Permissions.ADMIN_SYSTEM_MAINTENANCE]: 'ADMIN',

  [Permissions.ADMIN_AUDIT_READ]: 'ADMIN',
  [Permissions.ADMIN_AUDIT_EXPORT]: 'ADMIN',

  [Permissions.ADMIN_SECURITY_READ]: 'ADMIN',
  [Permissions.ADMIN_SECURITY_MANAGE]: 'ADMIN',

  [Permissions.ADMIN_ANALYTICS_READ]: 'ADMIN',

  [Permissions.ADMIN_SUPPORT_MANAGE]: 'ADMIN',

  [Permissions.ADMIN_SURVEYS_MANAGE]: 'ADMIN',
  [Permissions.ADMIN_SURVEYS_RESULTS]: 'ADMIN',

  [Permissions.CORRESPONDENCE_MANAGE]: 'CORRESPONDENCE',
  [Permissions.CORRESPONDENCE_CONFIDENTIAL_READ]: 'CORRESPONDENCE',
  [Permissions.CORRESPONDENCE_CONFIDENTIAL_MANAGE]: 'CORRESPONDENCE',

  [Permissions.HR_EMPLOYEES_READ]: 'HR',
  [Permissions.HR_EMPLOYEES_MANAGE]: 'HR',
  [Permissions.HR_ORGANIZATION_READ]: 'HR',
  [Permissions.HR_ORGANIZATION_MANAGE]: 'HR',
  [Permissions.HR_POSITIONS_READ]: 'HR',
  [Permissions.HR_POSITIONS_MANAGE]: 'HR',
  [Permissions.HR_ATTENDANCE_READ]: 'HR',
  [Permissions.HR_ATTENDANCE_MANAGE]: 'HR',

  [Permissions.HR_LEAVE_READ]: 'HR',
  [Permissions.HR_LEAVE_MANAGE]: 'HR',
  [Permissions.HR_LEAVE_APPROVE]: 'HR',
  [Permissions.HR_LEAVE_POLICY]: 'HR',

  [Permissions.HR_MISSION_READ]: 'HR',
  [Permissions.HR_MISSION_MANAGE]: 'HR',
  [Permissions.HR_MISSION_APPROVE]: 'HR',
  [Permissions.HR_MISSION_POLICY]: 'HR',

  [Permissions.ADMIN_AI_MANAGE]: 'ADMIN',
  [Permissions.ADMIN_AI_READ]: 'ADMIN',

  [Permissions.ADMIN_INTEGRATIONS_MANAGE]: 'ADMIN',
  [Permissions.ADMIN_INTEGRATIONS_READ]: 'ADMIN',

  [Permissions.ADMIN_MODULES_MANAGE]: 'ADMIN',
  [Permissions.ADMIN_MODULES_READ]: 'ADMIN',

  [Permissions.PARTNER_DASHBOARD]: 'PARTNER',
  [Permissions.PARTNER_DEALS]: 'PARTNER',
  [Permissions.PARTNER_REVENUE]: 'PARTNER',

  [Permissions.CUSTOMER_DASHBOARD]: 'CUSTOMER',
  [Permissions.CUSTOMER_PROFILE]: 'CUSTOMER',

  [Permissions.SUPPORT_TICKETS]: 'SUPPORT',
  [Permissions.SUPPORT_DOWNLOADS]: 'SUPPORT',

  [Permissions.COMMERCE_READ]: 'COMMERCE',
  [Permissions.COMMERCE_MANAGE]: 'COMMERCE',
  [Permissions.COMMERCE_APPROVE]: 'COMMERCE',
  [Permissions.COMMERCE_CONFIGURE]: 'COMMERCE',
  [Permissions.COMMERCE_WORKFLOW_MANAGE]: 'COMMERCE',
  [Permissions.COMMERCE_COMMERCIAL_MANAGE]: 'COMMERCE',
  [Permissions.COMMERCE_SUPPLIER_MANAGE]: 'COMMERCE',

  [Permissions.PRODUCTION_BOM_READ]: 'PRODUCTION',
  [Permissions.PRODUCTION_BOM_MANAGE]: 'PRODUCTION',
  [Permissions.PRODUCTION_BOM_APPROVE]: 'PRODUCTION',

  [Permissions.FINANCIAL_CHECK_READ]: 'FINANCIAL',
  [Permissions.FINANCIAL_CHECK_MANAGE]: 'FINANCIAL',
  [Permissions.FINANCIAL_CHECK_APPROVE]: 'FINANCIAL',
  [Permissions.FINANCIAL_CHECK_ALLOCATE]: 'FINANCIAL',
  [Permissions.FINANCIAL_CHECK_REVIEW]: 'FINANCIAL',
  [Permissions.FINANCIAL_CHECK_ISSUE]: 'FINANCIAL',
  [Permissions.FINANCIAL_CHECK_DELIVER]: 'FINANCIAL',
} as const;

// All permissions by domain for admin UI
export const PermissionsByDomain = {
  USERS: [
    Permissions.USERS_READ,
    Permissions.USERS_CREATE,
    Permissions.USERS_UPDATE,
    Permissions.USERS_DELETE,
  ],
  LEADS: [
    Permissions.LEADS_READ,
    Permissions.LEADS_CREATE,
    Permissions.LEADS_UPDATE,
    Permissions.LEADS_ASSIGN,
    Permissions.LEADS_DELETE,
  ],
  MEETINGS: [Permissions.MEETINGS_READ, Permissions.MEETINGS_SCHEDULE, Permissions.MEETINGS_CANCEL],
  BLOG: [
    Permissions.BLOG_READ,
    Permissions.BLOG_WRITE,
    Permissions.BLOG_PUBLISH,
    Permissions.BLOG_DELETE,
  ],
  ADMIN: [
    // User Management
    Permissions.ADMIN_USERS_READ,
    Permissions.ADMIN_USERS_CREATE,
    Permissions.ADMIN_USERS_UPDATE,
    Permissions.ADMIN_USERS_DELETE,
    // Role Management
    Permissions.ADMIN_ROLES_READ,
    Permissions.ADMIN_ROLES_ASSIGN,
    Permissions.ADMIN_ROLES_REMOVE,
    Permissions.ADMIN_ROLES_PERMISSIONS,
    // System Management
    Permissions.ADMIN_SYSTEM_READ,
    Permissions.ADMIN_SYSTEM_SETTINGS,
    Permissions.ADMIN_SYSTEM_MAINTENANCE,
    // Audit
    Permissions.ADMIN_AUDIT_READ,
    Permissions.ADMIN_AUDIT_EXPORT,
    // Security
    Permissions.ADMIN_SECURITY_READ,
    Permissions.ADMIN_SECURITY_MANAGE,
    // Analytics
    Permissions.ADMIN_ANALYTICS_READ,
    // Support
    Permissions.ADMIN_SUPPORT_MANAGE,
    // Surveys
    Permissions.ADMIN_SURVEYS_MANAGE,
    Permissions.ADMIN_SURVEYS_RESULTS,
    // AI provider configuration
    Permissions.ADMIN_AI_MANAGE,
    Permissions.ADMIN_AI_READ,
    // Automation & integration configuration (Phase 49L)
    Permissions.ADMIN_INTEGRATIONS_MANAGE,
    Permissions.ADMIN_INTEGRATIONS_READ,
    // Distributed module platform (Phase 49M)
    Permissions.ADMIN_MODULES_MANAGE,
    Permissions.ADMIN_MODULES_READ,
  ],
  CORRESPONDENCE: [
    Permissions.CORRESPONDENCE_MANAGE,
    Permissions.CORRESPONDENCE_CONFIDENTIAL_READ,
    Permissions.CORRESPONDENCE_CONFIDENTIAL_MANAGE,
  ],
  HR: [
    // Personnel records
    Permissions.HR_EMPLOYEES_READ,
    Permissions.HR_EMPLOYEES_MANAGE,
    // Organization hierarchy
    Permissions.HR_ORGANIZATION_READ,
    Permissions.HR_ORGANIZATION_MANAGE,
    // Position catalogue
    Permissions.HR_POSITIONS_READ,
    Permissions.HR_POSITIONS_MANAGE,
    // Attendance register (Phase 51-HR-3)
    Permissions.HR_ATTENDANCE_READ,
    Permissions.HR_ATTENDANCE_MANAGE,
    // Leave (Phase 51-HR-3A; Phase 54-E adds approval): the request register, the
    // tenant-owned leave-type catalogue, and the approval capability. The third is a
    // separate remit from writing the register — deciding a step is not editing a
    // request — even though all three carry the same `HR` domain tag.
    Permissions.HR_LEAVE_READ,
    Permissions.HR_LEAVE_MANAGE,
    Permissions.HR_LEAVE_APPROVE,
    // Leave policy authoring (Phase 54-F): the fourth remit, and the widest — an
    // administrator who may state the rules may not be replaced by anyone else, and a
    // tenant that does not want one of its administrators publishing policies can revoke
    // this string without touching the other three.
    Permissions.HR_LEAVE_POLICY,
    // Mission (Phase 55): the same four-remit split as leave.
    Permissions.HR_MISSION_READ,
    Permissions.HR_MISSION_MANAGE,
    Permissions.HR_MISSION_APPROVE,
    Permissions.HR_MISSION_POLICY,
  ],
  PARTNER: [Permissions.PARTNER_DASHBOARD, Permissions.PARTNER_DEALS, Permissions.PARTNER_REVENUE],
  CUSTOMER: [Permissions.CUSTOMER_DASHBOARD, Permissions.CUSTOMER_PROFILE],
  SUPPORT: [Permissions.SUPPORT_TICKETS, Permissions.SUPPORT_DOWNLOADS],
  COMMERCE: [
    // Procurement remits (Phase C1 §10 + the supplier-directory permission): reading
    // the purchase register, running it, deciding steps, authoring workflow
    // configuration, the commercial acts, and administering the supplier directory —
    // seven distinct strings under the ONE `COMMERCE` domain, exactly as HR's remits
    // share the `HR` tag.
    Permissions.COMMERCE_READ,
    Permissions.COMMERCE_MANAGE,
    Permissions.COMMERCE_APPROVE,
    Permissions.COMMERCE_CONFIGURE,
    Permissions.COMMERCE_WORKFLOW_MANAGE,
    Permissions.COMMERCE_COMMERCIAL_MANAGE,
    Permissions.COMMERCE_SUPPLIER_MANAGE,
  ],
  PRODUCTION: [
    // The BOM remits (Phase PRODUCTION-BOM-HEADER): reading the BOM register, authoring and
    // routing a BOM, and deciding one — three distinct strings under the ONE `PRODUCTION`
    // domain, exactly as HR's and Commerce's remits share their module's tag.
    Permissions.PRODUCTION_BOM_READ,
    Permissions.PRODUCTION_BOM_MANAGE,
    Permissions.PRODUCTION_BOM_APPROVE,
  ],
  FINANCIAL: [
    // The check-request remits (Phase F1 — FINANCIAL FOUNDATION): reading the request
    // register (and its timeline and attachments), authoring a request and managing its
    // attachments, and deciding one — three distinct strings under the ONE `FINANCIAL`
    // domain, exactly as Production's and Commerce's remits share their module's tag.
    // Phase CHECK-ISSUATION adds the four STAGE remits — allocation, document review,
    // issuance and delivery — one per source stage with its own actor, so a holder of
    // one stage's capability cannot perform a different stage's act.
    Permissions.FINANCIAL_CHECK_READ,
    Permissions.FINANCIAL_CHECK_MANAGE,
    Permissions.FINANCIAL_CHECK_APPROVE,
    Permissions.FINANCIAL_CHECK_ALLOCATE,
    Permissions.FINANCIAL_CHECK_REVIEW,
    Permissions.FINANCIAL_CHECK_ISSUE,
    Permissions.FINANCIAL_CHECK_DELIVER,
  ],
} as const;
