import { Test, TestingModule } from '@nestjs/testing';
import { MediaService } from './media.service';
import { CmsPrismaService } from '../../../database/cms-prisma.service';

describe('MediaService', () => {
  let service: MediaService;
  const mockStorage = {
    upload: jest.fn(),
    getUrl: jest.fn(),
    delete: jest.fn(),
  };
  const mockPrisma: any = {
    media: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: CmsPrismaService, useValue: mockPrisma },
        { provide: 'IStorageProvider', useValue: mockStorage },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
    jest.clearAllMocks();
  });

  it('uploads file and creates media row', async () => {
    const fakeFile: any = { originalname: 'a.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 1 };
    mockStorage.upload.mockResolvedValue('http://minio/media/a.png');
    mockPrisma.media.create.mockResolvedValue({ id: '1', name: 'a.png' });

    const res = await service.uploadFile(fakeFile, 'user-1');
    expect(mockStorage.upload).toHaveBeenCalled();
    expect(mockPrisma.media.create).toHaveBeenCalled();
    expect(res).toHaveProperty('id');
  });

  it('cleans up storage on DB failure', async () => {
    const fakeFile: any = { originalname: 'b.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 2 };
    mockStorage.upload.mockResolvedValue('http://minio/media/b.pdf');
    mockPrisma.media.create.mockRejectedValue(new Error('DB error'));
    mockStorage.delete.mockResolvedValue(true);

    await expect(service.uploadFile(fakeFile, 'user-1')).rejects.toThrow();
    expect(mockStorage.upload).toHaveBeenCalled();
    expect(mockPrisma.media.create).toHaveBeenCalled();
    expect(mockStorage.delete).toHaveBeenCalled();
  });
});
