/**
 * Role Constants & Hierarchy
 * Defines role structure, hierarchy, and default permissions
 */

import { Permissions } from './permissions';

export enum RoleHierarchy {
  SUPER_ADMIN = 0,
  ADMIN = 1,
  SECURITY_ADMIN = 2,
  OPERATIONS_ADMIN = 3,
  PARTNER = 4,
  CUSTOMER = 5,
  EMPLOYEE = 6,
  VISITOR = 7,
}

/**
 * Default permissions for each role
 * Lower hierarchy (SUPER_ADMIN) gets all permissions automatically
 */
export const RolePermissions = {
  SUPER_ADMIN: [
    // All permissions
    Permissions.USERS_READ,
    Permissions.USERS_CREATE,
    Permissions.USERS_UPDATE,
    Permissions.USERS_DELETE,
    Permissions.LEADS_READ,
    Permissions.LEADS_CREATE,
    Permissions.LEADS_UPDATE,
    Permissions.LEADS_ASSIGN,
    Permissions.LEADS_DELETE,
    Permissions.MEETINGS_READ,
    Permissions.MEETINGS_SCHEDULE,
    Permissions.MEETINGS_CANCEL,
    Permissions.BLOG_READ,
    Permissions.BLOG_WRITE,
    Permissions.BLOG_PUBLISH,
    Permissions.BLOG_DELETE,
    Permissions.ADMIN_USERS_READ,
    Permissions.ADMIN_USERS_CREATE,
    Permissions.ADMIN_USERS_UPDATE,
    Permissions.ADMIN_USERS_DELETE,
    Permissions.ADMIN_ROLES_READ,
    Permissions.ADMIN_ROLES_ASSIGN,
    Permissions.ADMIN_ROLES_REMOVE,
    Permissions.ADMIN_ROLES_PERMISSIONS,
    Permissions.ADMIN_SYSTEM_READ,
    Permissions.ADMIN_SYSTEM_SETTINGS,
    Permissions.ADMIN_SYSTEM_MAINTENANCE,
    Permissions.ADMIN_AUDIT_READ,
    Permissions.ADMIN_AUDIT_EXPORT,
    Permissions.ADMIN_SECURITY_READ,
    Permissions.ADMIN_SECURITY_MANAGE,
    Permissions.ADMIN_ANALYTICS_READ,
    Permissions.ADMIN_SUPPORT_MANAGE,
    Permissions.ADMIN_SURVEYS_MANAGE,
    Permissions.ADMIN_SURVEYS_RESULTS,
    Permissions.ADMIN_AI_MANAGE,
    Permissions.ADMIN_AI_READ,
    // Automation & integration configuration (Phase 49L). SUPER_ADMIN holds the
    // whole catalogue by definition.
    Permissions.ADMIN_INTEGRATIONS_MANAGE,
    Permissions.ADMIN_INTEGRATIONS_READ,
    // Distributed module platform (Phase 49M). Same reason.
    Permissions.ADMIN_MODULES_MANAGE,
    Permissions.ADMIN_MODULES_READ,
    // Observability platform (Phase 49M-2). Same reason. Combined with
    // ADMIN_SECURITY_READ above, this is the only role that reads every category.
    Permissions.ADMIN_OBSERVABILITY_READ,
    // Correspondence (Phase 50). SUPER_ADMIN holds the whole catalogue by
    // definition, including all three correspondence permissions.
    Permissions.CORRESPONDENCE_MANAGE,
    Permissions.CORRESPONDENCE_CONFIDENTIAL_READ,
    Permissions.CORRESPONDENCE_CONFIDENTIAL_MANAGE,
    // Human Resources (Phase 51-HR-1). SUPER_ADMIN holds the whole catalogue by
    // definition, so it holds all six HR permissions. The module's routes are gated on
    // these, and the seed migration grants the same six rows to this role in core_db.
    Permissions.HR_EMPLOYEES_READ,
    Permissions.HR_EMPLOYEES_MANAGE,
    Permissions.HR_ORGANIZATION_READ,
    Permissions.HR_ORGANIZATION_MANAGE,
    Permissions.HR_POSITIONS_READ,
    Permissions.HR_POSITIONS_MANAGE,
    // Attendance register (Phase 51-HR-3). Same rule as the six above: the whole
    // catalogue belongs to SUPER_ADMIN, and the seed migration grants the same two
    // rows to this role in core_db.
    Permissions.HR_ATTENDANCE_READ,
    Permissions.HR_ATTENDANCE_MANAGE,
    // Leave (Phase 51-HR-3A). The whole catalogue by definition, including the pair that
    // covers both the leave register and the tenant-owned leave-type catalogue.
    Permissions.HR_LEAVE_READ,
    Permissions.HR_LEAVE_MANAGE,
    // Production — BOM (Phase PRODUCTION-BOM-HEADER). SUPER_ADMIN holds the whole
    // catalogue by definition, so it holds all three BOM permissions. The module's routes
    // are gated on these, and the seed migration grants the same three rows to this role
    // in core_db (20261002100100), which is what makes this entry and that SQL agree.
    Permissions.PRODUCTION_BOM_READ,
    Permissions.PRODUCTION_BOM_MANAGE,
    Permissions.PRODUCTION_BOM_APPROVE,
    // Financial — check request (Phase F1 + Phase CHECK-ISSUATION). SUPER_ADMIN holds the
    // whole catalogue by definition: the three F1 remits plus the four stage remits
    // (allocate / review / issue / deliver) that arrive WITH the stages they gate. The
    // seed migrations `20261003160100` (F1) and `20261004160000` (this phase) grant the
    // same seven rows to this role in core_db, which is what makes this entry and that
    // SQL agree. F1 shipped without this mirror — an oversight, now closed, because the
    // array above is what any code-side seeding path reads and the catalogue claim
    // "SUPER_ADMIN holds the whole catalogue" must be true in BOTH places.
    Permissions.FINANCIAL_CHECK_READ,
    Permissions.FINANCIAL_CHECK_MANAGE,
    Permissions.FINANCIAL_CHECK_APPROVE,
    Permissions.FINANCIAL_CHECK_ALLOCATE,
    Permissions.FINANCIAL_CHECK_REVIEW,
    Permissions.FINANCIAL_CHECK_ISSUE,
    Permissions.FINANCIAL_CHECK_DELIVER,
    Permissions.PARTNER_DASHBOARD,
    Permissions.PARTNER_DEALS,
    Permissions.PARTNER_REVENUE,
    Permissions.CUSTOMER_DASHBOARD,
    Permissions.CUSTOMER_PROFILE,
    Permissions.SUPPORT_TICKETS,
    Permissions.SUPPORT_DOWNLOADS,
  ],

  ADMIN: [
    // User management
    Permissions.USERS_READ,
    Permissions.USERS_CREATE,
    Permissions.USERS_UPDATE,
    Permissions.USERS_DELETE,
    // Lead management
    Permissions.LEADS_READ,
    Permissions.LEADS_CREATE,
    Permissions.LEADS_UPDATE,
    Permissions.LEADS_ASSIGN,
    Permissions.LEADS_DELETE,
    // Meeting management
    Permissions.MEETINGS_READ,
    Permissions.MEETINGS_SCHEDULE,
    Permissions.MEETINGS_CANCEL,
    // Blog management
    Permissions.BLOG_READ,
    Permissions.BLOG_WRITE,
    Permissions.BLOG_PUBLISH,
    Permissions.BLOG_DELETE,
    // Admin users
    Permissions.ADMIN_USERS_READ,
    Permissions.ADMIN_USERS_CREATE,
    Permissions.ADMIN_USERS_UPDATE,
    Permissions.ADMIN_USERS_DELETE,
    // Admin roles
    Permissions.ADMIN_ROLES_READ,
    Permissions.ADMIN_ROLES_ASSIGN,
    Permissions.ADMIN_ROLES_REMOVE,
    Permissions.ADMIN_ROLES_PERMISSIONS,
    // Admin audit
    Permissions.ADMIN_AUDIT_READ,
    // Admin analytics
    Permissions.ADMIN_ANALYTICS_READ,
    // Admin support
    Permissions.ADMIN_SUPPORT_MANAGE,
    // Admin surveys (Phase 49H). ADMIN authors surveys and reads their results;
    // no other role gains either permission by default, so participation is not
    // silently upgraded into result access anywhere.
    Permissions.ADMIN_SURVEYS_MANAGE,
    Permissions.ADMIN_SURVEYS_RESULTS,
    // Correspondence (Phase 50). ADMIN is the tenant's correspondence
    // administrator: tenant-wide reads (including BCC), classification changes
    // after send, and confidential authoring. Other roles gain none by default;
    // confidential authoring is opt-in through role management.
    Permissions.CORRESPONDENCE_MANAGE,
    Permissions.CORRESPONDENCE_CONFIDENTIAL_READ,
    Permissions.CORRESPONDENCE_CONFIDENTIAL_MANAGE,
    // Human Resources (Phase 51-HR-1). ADMIN is the tenant's HR administrator, so it
    // holds all six. No other role gains any HR permission by default: personnel data
    // is not a capability that should be silently attached to an existing role, and a
    // tenant that wants an HR-only operator creates a role through the existing
    // role-management surface. OPERATIONS_ADMIN / SECURITY_ADMIN in particular get
    // NONE — their remits are system operations and audit/security, not personnel.
    Permissions.HR_EMPLOYEES_READ,
    Permissions.HR_EMPLOYEES_MANAGE,
    Permissions.HR_ORGANIZATION_READ,
    Permissions.HR_ORGANIZATION_MANAGE,
    Permissions.HR_POSITIONS_READ,
    Permissions.HR_POSITIONS_MANAGE,
    // Attendance register (Phase 51-HR-3). ADMIN is the tenant's HR administrator,
    // so it holds the pair too. Still NO other role by default: a register that names
    // people and their working hours is personnel data, not a capability to attach
    // silently to an existing role.
    Permissions.HR_ATTENDANCE_READ,
    Permissions.HR_ATTENDANCE_MANAGE,
    // Leave (Phase 51-HR-3A). ADMIN records and withdraws the tenant's leave requests
    // and maintains its leave-type catalogue. Still NO other role by default, for the
    // reason above: which days a person is absent is personnel data. `hr.leave.approve`
    // does not exist in this phase — approval policy is deferred, and the permission
    // arrives with the state it gates.
    Permissions.HR_LEAVE_READ,
    Permissions.HR_LEAVE_MANAGE,
    // Production — BOM (Phase PRODUCTION-BOM-HEADER). ADMIN is the tenant's
    // administrator, so it holds all three BOM permissions. Still NO other role by
    // default: reading the register, authoring a BOM and DECIDING one are the
    // administrator's remit, and a tenant that wants a BOM-only operator creates a role
    // through the existing role-management surface. OPERATIONS_ADMIN / SECURITY_ADMIN in
    // particular get NONE — their remits are system operations and audit/security, not
    // production data.
    Permissions.PRODUCTION_BOM_READ,
    Permissions.PRODUCTION_BOM_MANAGE,
    Permissions.PRODUCTION_BOM_APPROVE,
    // Financial — check request (Phase F1 + Phase CHECK-ISSUATION). ADMIN is the tenant's
    // administrator, so it holds all seven check-request remits — the three F1 strings and
    // the four stage strings — matching the seed migrations' ADMIN grants exactly. Still
    // NO other role by default: reading the register, authoring a request and performing
    // each stage's act are deliberately separable, and a tenant that wants a stage-only
    // operator creates a role through the existing role-management surface.
    Permissions.FINANCIAL_CHECK_READ,
    Permissions.FINANCIAL_CHECK_MANAGE,
    Permissions.FINANCIAL_CHECK_APPROVE,
    Permissions.FINANCIAL_CHECK_ALLOCATE,
    Permissions.FINANCIAL_CHECK_REVIEW,
    Permissions.FINANCIAL_CHECK_ISSUE,
    Permissions.FINANCIAL_CHECK_DELIVER,
    // Admin AI provider configuration (Phase 49J-0). ADMIN both reads and writes
    // provider rows; OPERATIONS_ADMIN below gets read only.
    Permissions.ADMIN_AI_MANAGE,
    Permissions.ADMIN_AI_READ,
    // Automation & integration configuration (Phase 49L). Same split as AI:
    // ADMIN configures endpoints and rotates webhook secrets, OPERATIONS_ADMIN
    // below only observes.
    Permissions.ADMIN_INTEGRATIONS_MANAGE,
    Permissions.ADMIN_INTEGRATIONS_READ,
    // Distributed module platform (Phase 49M). Same split again: ADMIN admits
    // modules to the platform, sets tenant scope and rotates module credentials;
    // OPERATIONS_ADMIN below only observes.
    Permissions.ADMIN_MODULES_MANAGE,
    Permissions.ADMIN_MODULES_READ,

    // Observability platform (Phase 49M-2). ONE permission, because there is nothing
    // to manage: levels, queue sizes, flush cadence and retention windows are
    // environment variables, and every row is written by the platform itself.
    //
    // This does NOT grant sight of SecurityEvent. That route is gated on
    // ADMIN_SECURITY_READ instead, which ADMIN does not hold — so ADMIN reads
    // application logs, audit events and lifecycle history, while failed logins and
    // permission denials stay with SUPER_ADMIN/SECURITY_ADMIN.
    Permissions.ADMIN_OBSERVABILITY_READ,
  ],

  SECURITY_ADMIN: [
    // Security management
    Permissions.ADMIN_SECURITY_READ,
    Permissions.ADMIN_SECURITY_MANAGE,
    // Audit access
    Permissions.ADMIN_AUDIT_READ,
    Permissions.ADMIN_AUDIT_EXPORT,
    // Read roles (cannot assign)
    Permissions.ADMIN_ROLES_READ,
    // Observability platform (Phase 49M-2). The security-event route is gated on
    // ADMIN_SECURITY_READ above; this adds the application-log, audit-event and
    // lifecycle context an incident review needs around it.
    Permissions.ADMIN_OBSERVABILITY_READ,
    // Blog read
    Permissions.BLOG_READ,
  ],

  OPERATIONS_ADMIN: [
    // System management
    Permissions.ADMIN_SYSTEM_READ,
    Permissions.ADMIN_SYSTEM_SETTINGS,
    Permissions.ADMIN_SYSTEM_MAINTENANCE,
    // Support management
    Permissions.ADMIN_SUPPORT_MANAGE,
    // AI configuration: READ ONLY (Phase 49J-0). Seeing which provider and model
    // are live is part of diagnosing the platform; writing a provider credential
    // is not in this role's remit, so ADMIN_AI_MANAGE is deliberately absent.
    Permissions.ADMIN_AI_READ,
    // Integration configuration: READ ONLY (Phase 49L), for exactly the same
    // reason. Seeing whether automation reached the external engine is
    // diagnosis; repointing an outbound destination or rotating its shared
    // secret is not, so ADMIN_INTEGRATIONS_MANAGE is deliberately absent.
    Permissions.ADMIN_INTEGRATIONS_READ,
    // Module registry: READ ONLY (Phase 49M), for exactly the same reason. Seeing
    // whether a module is registered and reachable is diagnosis; admitting a module
    // to the platform, changing its tenant scope or rotating its credential is not,
    // so ADMIN_MODULES_MANAGE is deliberately absent.
    Permissions.ADMIN_MODULES_READ,
    // Observability platform: READ (Phase 49M-2). This is the role that diagnoses
    // incidents, so withholding log access would make the permission useless in
    // practice. It does NOT reach SecurityEvent — that route is gated on
    // ADMIN_SECURITY_READ, which this role deliberately does not hold, so failed
    // logins and permission denials remain outside operations' view.
    Permissions.ADMIN_OBSERVABILITY_READ,
    // Blog read
    Permissions.BLOG_READ,
  ],

  PARTNER: [
    // View leads
    Permissions.LEADS_READ,
    // Assign leads to self
    Permissions.LEADS_ASSIGN,
    // Meeting management
    Permissions.MEETINGS_READ,
    Permissions.MEETINGS_SCHEDULE,
    Permissions.MEETINGS_CANCEL,
    // Partner portal
    Permissions.PARTNER_DASHBOARD,
    Permissions.PARTNER_DEALS,
    Permissions.PARTNER_REVENUE,
    // Read blog
    Permissions.BLOG_READ,
  ],

  CUSTOMER: [
    // Read leads (own)
    Permissions.LEADS_READ,
    // Meeting management
    Permissions.MEETINGS_READ,
    Permissions.MEETINGS_SCHEDULE,
    // Customer portal
    Permissions.CUSTOMER_DASHBOARD,
    Permissions.CUSTOMER_PROFILE,
    // Support
    Permissions.SUPPORT_TICKETS,
    Permissions.SUPPORT_DOWNLOADS,
    // Read blog
    Permissions.BLOG_READ,
  ],

  EMPLOYEE: [
    // Read leads (assigned)
    Permissions.LEADS_READ,
    // Read meetings
    Permissions.MEETINGS_READ,
    // Read blog
    Permissions.BLOG_READ,
  ],

  VISITOR: [
    // Read public blog only
    Permissions.BLOG_READ,
  ],
} as const;

export const RoleDisplayNames = {
  SUPER_ADMIN: 'Super Administrator',
  ADMIN: 'Administrator',
  SECURITY_ADMIN: 'Security Administrator',
  OPERATIONS_ADMIN: 'Operations Administrator',
  PARTNER: 'Partner',
  CUSTOMER: 'Customer',
  EMPLOYEE: 'Employee',
  VISITOR: 'Visitor',
} as const;

export const RoleDescriptions = {
  SUPER_ADMIN: 'Full system access and administrative capabilities',
  ADMIN: 'Administrative access to users, leads, meetings, blog, and roles',
  SECURITY_ADMIN: 'Security and audit access, cannot assign admin roles',
  OPERATIONS_ADMIN: 'System operations and support management',
  PARTNER: 'Partner access to leads and revenue tracking',
  CUSTOMER: 'Customer access to their account and support',
  EMPLOYEE: 'Employee access to assigned leads and meetings',
  VISITOR: 'Public visitor access to blog and resources',
} as const;

/**
 * Get permissions for a role (including inherited permissions)
 * @param role Role name
 * @returns Array of permission strings
 */
export function getPermissionsForRole(role: keyof typeof RolePermissions): string[] {
  return [...RolePermissions[role]];
}

/**
 * Check if a role is higher in hierarchy than another
 * @param role1 First role
 * @param role2 Second role (to compare against)
 * @returns true if role1 is higher in hierarchy (lower hierarchy value)
 */
export function isRoleHigherThan(
  role1: keyof typeof RoleHierarchy,
  role2: keyof typeof RoleHierarchy,
): boolean {
  return RoleHierarchy[role1] < RoleHierarchy[role2];
}

/**
 * Get all roles that are subordinate to a given role
 */
export function getSubordinateRoles(role: keyof typeof RoleHierarchy): string[] {
  const hierarchy = RoleHierarchy[role];
  return Object.entries(RoleHierarchy)
    // Holes in the destructuring (`[, value]` / `[key]`) skip the unused entry
    // without binding a throwaway name the lint rule would then report.
    .filter(([, value]) => (value as number) > hierarchy)
    .map(([key]) => key);
}
