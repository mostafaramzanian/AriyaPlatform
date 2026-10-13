# ADR-0004: Phase B.2 - Role-Based Access Control (RBAC)

**Date:** 2026-07-28  
**Status:** APPROVED  
**Phase:** B.2 (RBAC Foundation)  
**Context:** Enterprise-grade permission management with role hierarchy and permission inheritance

---

## Problem Statement

Aria ERP requires a sophisticated role-based access control system that:
1. Supports multiple roles per user
2. Implements role hierarchy (SUPER_ADMIN > ADMIN > PARTNER > CUSTOMER > EMPLOYEE > VISITOR)
3. Manages granular permissions (users, leads, meetings, blog, admin, partners)
4. Caches permissions in Redis for performance
5. Publishes audit events via RabbitMQ
6. Scales horizontally in distributed systems
7. Prevents unauthorized access at all endpoints
8. Maintains audit trail of all permission changes

---

## Decision

### 1. Role Hierarchy Model

```
SUPER_ADMIN (All permissions)
│
├── ADMIN (Admin operations)
│   ├── user.read, user.create, user.update, user.delete
│   ├── admin.dashboard, admin.settings, admin.audit
│   ├── leads.*, meetings.*, blog.*
│   │
│   ├── PARTNER (Partner operations)
│   │   ├── partner.dashboard, partner.deals, partner.revenue
│   │   ├── leads.read, leads.assign
│   │   └── meetings.read, meetings.schedule
│   │
│   ├── CUSTOMER (Customer operations)
│   │   ├── customer.dashboard, customer.profile
│   │   ├── leads.read, meetings.read
│   │   └── support.tickets, support.downloads
│   │
│   └── EMPLOYEE (Employee operations)
│       ├── user.read (self)
│       └── leads.read (assigned)
│
└── VISITOR (No permissions - public access only)
    └── blog.read, resources.read
```

### 2. Permission Model

Permissions organized by domain:

**User Management:**
- `users.read` - View users
- `users.create` - Create users
- `users.update` - Update users
- `users.delete` - Delete users

**Lead Management:**
- `leads.read` - View leads
- `leads.create` - Create leads
- `leads.update` - Update leads
- `leads.assign` - Assign leads
- `leads.delete` - Delete leads

**Meeting Management:**
- `meetings.read` - View meetings
- `meetings.schedule` - Schedule meetings
- `meetings.cancel` - Cancel meetings

**Blog Management:**
- `blog.read` - Read blog posts
- `blog.write` - Write blog posts
- `blog.publish` - Publish blog posts
- `blog.delete` - Delete blog posts

**Admin:**
- `admin.dashboard` - Access admin dashboard
- `admin.settings` - Manage system settings
- `admin.audit` - View audit logs

**Partner:**
- `partner.dashboard` - Access partner dashboard
- `partner.deals` - View/manage deals
- `partner.revenue` - View revenue sharing

**Customer:**
- `customer.dashboard` - Access customer portal
- `customer.profile` - Manage profile
- `support.tickets` - View/create support tickets
- `support.downloads` - Access downloads

### 3. Database Schema

**Role Table:**
- id (UUID, PK)
- name (ENUM: SUPER_ADMIN, ADMIN, PARTNER, CUSTOMER, EMPLOYEE, VISITOR)
- displayName (String)
- description (Text)
- hierarchy (Integer - for ordering)
- createdAt (DateTime)
- updatedAt (DateTime)

**Permission Table:**
- id (UUID, PK)
- name (String, unique) - e.g., "users.read"
- displayName (String)
- description (Text)
- domain (ENUM: USERS, LEADS, MEETINGS, BLOG, ADMIN, PARTNER, CUSTOMER)
- createdAt (DateTime)

**RolePermission Table:**
- id (UUID, PK)
- roleId (UUID, FK → Role.id)
- permissionId (UUID, FK → Permission.id)
- createdAt (DateTime)
- unique(roleId, permissionId)

**UserRole Table:**
- id (UUID, PK)
- userId (UUID, FK → User.id)
- roleId (UUID, FK → Role.id)
- assignedAt (DateTime)
- assignedBy (UUID, FK → User.id - admin who assigned)
- updatedAt (DateTime)
- unique(userId, roleId) - prevent duplicate role assignments

### 4. Permission Caching Strategy

**Redis Keys:**
```
user:permissions:{userId} → Set of permission strings (TTL: 15 min)
role:permissions:{roleId} → Set of permission strings (TTL: 1 hour)
user:roles:{userId} → Set of role IDs (TTL: 15 min)
role:hierarchy → Sorted set with role hierarchy (TTL: 1 hour)
permissions:list → All permissions in system (TTL: 24 hours)
```

**Cache Invalidation:**
- On user role assignment/removal: delete `user:permissions:{userId}`, `user:roles:{userId}`
- On role permission change: delete `role:permissions:{roleId}`, invalidate all users with that role
- On role creation: update `role:hierarchy`, `permissions:list`

### 5. Permission Resolution Algorithm

```typescript
async hasPermission(userId: string, permission: string): Promise<boolean> {
  // 1. Check cache first
  const cachedPerms = await redis.smembers(`user:permissions:${userId}`);
  if (cachedPerms.includes(permission)) return true;

  // 2. If cache miss, query database
  const userRoles = await db.userRole.findMany({
    where: { userId },
    include: { role: { include: { permissions: true } } }
  });

  // 3. Collect all permissions from roles
  const allPermissions = new Set<string>();
  for (const userRole of userRoles) {
    for (const perm of userRole.role.permissions) {
      allPermissions.add(perm.name);
    }
  }

  // 4. Cache result
  await redis.sadd(`user:permissions:${userId}`, Array.from(allPermissions));
  await redis.expire(`user:permissions:${userId}`, 15 * 60); // 15 minutes

  return allPermissions.has(permission);
}
```

### 6. RolesGuard Implementation

```typescript
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissionService: PermissionService,
    private logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Get required permissions from @Roles() decorator
    const requiredPermissions = this.reflector.get<string[]>(
      'permissions',
      context.getHandler(),
    );
    if (!requiredPermissions) {
      return true; // No permissions required
    }

    // 2. Extract user from request
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('User not found in request');
    }

    // 3. Check if user has any required permission
    for (const permission of requiredPermissions) {
      const hasPermission = await this.permissionService.hasPermission(
        user.sub,
        permission,
      );
      if (hasPermission) {
        return true;
      }
    }

    // 4. Log unauthorized attempt
    this.logger.warn(
      `Unauthorized access attempt: user=${user.email}, permissions=${requiredPermissions}`,
    );

    throw new ForbiddenException(
      `User lacks required permissions: ${requiredPermissions.join(', ')}`,
    );
  }
}
```

### 7. Event-Driven Audit Trail

**Events Published:**
```
rbac.role.assigned
  - userId, roleId, assignedBy, timestamp

rbac.role.removed
  - userId, roleId, removedBy, timestamp

rbac.permission.updated
  - roleId, permissionId, action (added/removed), updatedBy, timestamp

rbac.role.created
  - roleId, name, hierarchy, timestamp

rbac.role.deleted
  - roleId, name, timestamp
```

### 8. Decorator Patterns

**@Roles() with permission check:**
```typescript
@Roles('users.read')
@Get()
getUsers() { }

@Roles('users.create', 'users.update')
@Post()
createUser() { }

@Roles('admin.dashboard', 'admin.settings')
@Get('admin')
getAdminDashboard() { }
```

**Multiple permission options (OR logic):**
```typescript
@Roles('partner.dashboard', 'customer.dashboard', 'admin.dashboard')
@Get('dashboard')
getDashboard() { }
```

### 9. API Endpoint Protection

All endpoints protected by:
1. **JwtAuthGuard** (global) - Validates JWT token
2. **RolesGuard** (global) - Validates permissions
3. **@Public()** - Explicitly bypass both guards for public endpoints
4. **@Roles()** - Specify required permissions for endpoint

### 10. SOLID Principles Application

- **Single Responsibility:** PermissionService manages permissions, RolesGuard handles authorization
- **Open/Closed:** New permissions added to database, no code changes needed
- **Liskov Substitution:** Guards implement CanActivate interface consistently
- **Interface Segregation:** Separate interfaces for RoleService, PermissionService
- **Dependency Inversion:** Guards depend on abstraction (PermissionService), not concrete implementations

---

## Folder Structure

```
src/auth/
├── rbac/
│   ├── guards/
│   │   └── roles.guard.ts              # NEW: Permission-based guard
│   │
│   ├── services/
│   │   ├── permission.service.ts       # NEW: Permission lookup & caching
│   │   ├── role.service.ts             # NEW: Role management
│   │   └── rbac.service.ts             # NEW: RBAC orchestration
│   │
│   ├── constants/
│   │   ├── permissions.ts              # NEW: Permission constants
│   │   └── roles.ts                    # NEW: Role constants
│   │
│   ├── dto/
│   │   ├── assign-role.dto.ts          # NEW: Assign role to user
│   │   ├── remove-role.dto.ts          # NEW: Remove role from user
│   │   └── permission-response.dto.ts  # NEW: Permission response
│   │
│   ├── entities/
│   │   ├── role.entity.ts              # NEW: Role domain model
│   │   └── permission.entity.ts        # NEW: Permission domain model
│   │
│   └── test/
│       ├── roles.guard.spec.ts         # NEW: Guard tests
│       ├── permission.service.spec.ts  # NEW: Service tests
│       └── rbac.e2e.spec.ts            # NEW: Integration tests
│
├── decorators/
│   └── roles.decorator.ts              # UPDATE: Rename @Roles to @Permissions
│
└── auth.module.ts                      # UPDATE: Register RBAC providers
```

---

## Success Criteria

- [x] ADR created and documented
- [ ] Database schema created (Prisma)
- [ ] Migrations generated
- [ ] RolesGuard implemented
- [ ] PermissionService implemented
- [ ] Redis caching implemented
- [ ] RabbitMQ events publishing
- [ ] Global guard registration
- [ ] Swagger documentation
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] No breaking changes to Phase A/B.1
- [ ] All endpoints protected
- [ ] Performance validated

---

## Performance Considerations

- **Cache Hit Ratio:** Target >90% (most requests use cached permissions)
- **Permission Lookup:** <5ms with Redis cache, <50ms without cache
- **Database Queries:** Minimized with Redis caching
- **Scalability:** Horizontal scaling enabled via Redis cache
- **Memory:** ~1KB per cached user (minimal Redis footprint)

---

## Security Review

- ✅ Permissions checked on every protected request
- ✅ JWT required before RBAC evaluation
- ✅ Role inheritance prevents privilege escalation
- ✅ Audit events logged for compliance
- ✅ Cache invalidation prevents stale permissions
- ✅ No direct role/permission modification without audit

---

## Future Enhancements (Phase B.3+)

1. **Dynamic Permissions** - Runtime permission configuration
2. **Permission Groups** - Bundle related permissions
3. **Conditional Permissions** - Time-based, IP-based restrictions
4. **OAuth 2.0 Scopes** - Align with standard OAuth scopes
5. **API Keys** - Service-to-service authentication with permissions
6. **Audit Trail UI** - Admin interface to view permission changes
7. **Role Duplication** - Copy existing role as template
8. **Permission Delegation** - Allow admins to delegate specific permissions

---

## Related Documents

- ADR-0001: Technology Stack
- ADR-0002: Phase A Infrastructure
- ADR-0003: Phase B.1 Authentication
- PHASE_B_1_AUTH.md (Implementation Report)

---

**Approved By:** Architecture Review Board  
**Implementation Lead:** RBAC Team  
**Review Date:** 2026-07-28
