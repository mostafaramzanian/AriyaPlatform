import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { PrismaService } from '../database/prisma.service';

describe('TenantService', () => {
  let service: TenantService;
  let prisma: PrismaService;

  const mockTenant = {
    id: 'tenant-1',
    code: 'tenant-a',
    status: null,
    region: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        {
          provide: PrismaService,
          useValue: {
            tenant: {
              findUnique: jest.fn(),
              create: jest.fn(),
            },
            user: {
              update: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<TenantService>(TenantService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('create', () => {
    it('should create a tenant with a unique code', async () => {
      (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.tenant.create as jest.Mock).mockResolvedValue(mockTenant);

      const result = await service.create({ code: 'tenant-a' });

      expect(result).toEqual(mockTenant);
      expect(prisma.tenant.create).toHaveBeenCalledWith({
        data: { code: 'tenant-a', status: null, region: null },
      });
    });

    it('should reject duplicate tenant codes', async () => {
      (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(mockTenant);

      await expect(service.create({ code: 'tenant-a' })).rejects.toThrow(ConflictException);
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('should return a tenant by id', async () => {
      (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(mockTenant);

      const result = await service.findById('tenant-1');

      expect(result).toEqual(mockTenant);
    });

    it('should throw NotFoundException for missing tenant', async () => {
      (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByCode', () => {
    it('should return a tenant by code', async () => {
      (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(mockTenant);

      const result = await service.findByCode('tenant-a');

      expect(result).toEqual(mockTenant);
    });
  });

  describe('assignUserToTenant', () => {
    it('should update user tenantId', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue({ id: 'user-1', tenantId: 'tenant-1' });

      const result = await service.assignUserToTenant('user-1', 'tenant-1');

      expect(result.tenantId).toBe('tenant-1');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { tenantId: 'tenant-1' },
      });
    });
  });
});
