import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';
import { DirectoryQueryDto } from './dto/directory-query.dto';

/**
 * Phase 49D-1: Organization Directory reads.
 *
 * Deliberately does NOT reuse UsersService.safeUser(), which is a denylist that
 * strips only passwordHash/tokenVersion and would therefore leak tenantId,
 * emailVerified and any future column. Every read here uses an explicit Prisma
 * select so the projection is an allowlist.
 *
 * Tenant scope is derived only from the authenticated identity, resolved into
 * RequestContextService by the global TenantContextInterceptor — never from a
 * query parameter, body field or path segment. Same pattern as LeadService.
 */

export const DEFAULT_DIRECTORY_LIMIT = 20;
export const MAX_DIRECTORY_LIMIT = 100;

/**
 * Allowlisted directory projection. Never contains passwordHash, tokenVersion,
 * refresh/reset tokens, tenantId, emailVerified, login history or any audit or
 * security metadata.
 */
const DIRECTORY_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  avatarUrl: true,
  status: true,
  department: true,
  jobTitle: true,
  extension: true,
  managerId: true,
} satisfies Prisma.UserSelect;

/**
 * Bounded manager projection, fetched via a relation select so listing N members
 * still costs one query (no N+1).
 */
const MANAGER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  jobTitle: true,
} satisfies Prisma.UserSelect;

export interface DirectoryMember {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  status: string;
  department: string | null;
  jobTitle: string | null;
  extension: string | null;
  managerId: string | null;
  manager: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    jobTitle: string | null;
  } | null;
}

export interface DirectoryListResult {
  items: DirectoryMember[];
  hasMore: boolean;
}

@Injectable()
export class DirectoryService {
  constructor(private prisma: PrismaService) {}

  private tenantId(): string {
    const tenantId = RequestContextService.get()?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return tenantId;
  }

  /**
   * The manager relation is followed only inside the caller's own tenant. A
   * managerId that points at a foreign-tenant row therefore resolves to `null`
   * rather than leaking that row.
   */
  private managerRelation(tenantId: string) {
    return { where: { tenantId }, select: MANAGER_SELECT } as const;
  }

  async listDirectory(query: DirectoryQueryDto): Promise<DirectoryListResult> {
    const tenantId = this.tenantId();
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_DIRECTORY_LIMIT, 1), MAX_DIRECTORY_LIMIT);

    const where: Prisma.UserWhereInput = { tenantId };

    if (query.department) where.department = query.department;
    if (query.jobTitle) where.jobTitle = query.jobTitle;
    if (query.managerId) where.managerId = query.managerId;

    if (query.q) {
      where.OR = [
        { firstName: { contains: query.q, mode: 'insensitive' } },
        { lastName: { contains: query.q, mode: 'insensitive' } },
        { email: { contains: query.q, mode: 'insensitive' } },
        { phone: { contains: query.q, mode: 'insensitive' } },
        { extension: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    // Over-fetch by one to decide `hasMore` without a second COUNT query. The
    // ordering is deterministic (id breaks ties) so the cursor is stable.
    const rows = await this.prisma.user.findMany({
      where,
      select: { ...DIRECTORY_SELECT, manager: this.managerRelation(tenantId) },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return { items: rows as DirectoryMember[], hasMore };
  }

  async getDirectoryMember(id: string): Promise<DirectoryMember> {
    const tenantId = this.tenantId();

    // findFirst with the tenant in the predicate, so a foreign-tenant id is
    // indistinguishable from a non-existent one: both are 404.
    const member = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: { ...DIRECTORY_SELECT, manager: this.managerRelation(tenantId) },
    });

    if (!member) {
      throw new NotFoundException('Directory member not found');
    }

    return member as DirectoryMember;
  }
}
