import {
  DIRECTORY_MAX_PAGE_SIZE,
  buildDirectoryQuery,
  directoryFullName,
  directoryInitials,
  distinctValues,
  fetchDirectory,
  fetchDirectoryMember,
  type DirectoryMember,
} from '../directory-api';
import { coreGet } from '../core-http';

jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
}));

const coreGetMock = coreGet as jest.MockedFunction<typeof coreGet>;

function member(overrides: Partial<DirectoryMember> = {}): DirectoryMember {
  return {
    id: 'u1',
    firstName: 'بهار',
    lastName: 'نوری',
    email: 'bahar@example.com',
    phone: '021-2001',
    avatarUrl: null,
    status: 'EMPLOYEE',
    department: 'مالی',
    jobTitle: 'حسابدار',
    extension: '201',
    managerId: null,
    manager: null,
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('buildDirectoryQuery', () => {
  it('returns an empty string when nothing is filtered', () => {
    expect(buildDirectoryQuery({})).toBe('');
  });

  it('omits blank and whitespace-only filters instead of sending them', () => {
    expect(buildDirectoryQuery({ q: '   ', department: '', jobTitle: undefined })).toBe('');
  });

  it('trims filter values', () => {
    expect(buildDirectoryQuery({ q: '  بهار  ' })).toBe(`?q=${encodeURIComponent('بهار')}`);
  });

  it('caps limit at the backend maximum', () => {
    expect(buildDirectoryQuery({ limit: 5000 })).toBe(`?limit=${DIRECTORY_MAX_PAGE_SIZE}`);
  });

  it('never emits a tenant identifier, even if one is smuggled in', () => {
    const query = buildDirectoryQuery({ tenantId: 'other-tenant' } as never);
    expect(query).toBe('');
  });

  it('serializes every supported filter', () => {
    const query = buildDirectoryQuery({
      cursor: 'c1',
      limit: 20,
      q: 'a',
      department: 'd',
      jobTitle: 'j',
      managerId: 'm',
    });
    expect(query).toContain('cursor=c1');
    expect(query).toContain('limit=20');
    expect(query).toContain('q=a');
    expect(query).toContain('department=d');
    expect(query).toContain('jobTitle=j');
    expect(query).toContain('managerId=m');
  });
});

describe('fetchDirectory / fetchDirectoryMember', () => {
  it('calls the directory list endpoint with the serialized query', async () => {
    coreGetMock.mockResolvedValue({ items: [member()], hasMore: false });

    const result = await fetchDirectory({ limit: 20, q: 'بهار' });

    expect(coreGetMock).toHaveBeenCalledWith(
      `/users/directory?limit=20&q=${encodeURIComponent('بهار')}`,
    );
    expect(result.items).toHaveLength(1);
  });

  it('encodes the member id so a crafted id cannot alter the path', async () => {
    coreGetMock.mockResolvedValue(member());

    await fetchDirectoryMember('a/../b');

    expect(coreGetMock).toHaveBeenCalledWith('/users/directory/a%2F..%2Fb');
  });
});

describe('display helpers', () => {
  it('joins first and last name, and returns null when both are missing', () => {
    expect(directoryFullName({ firstName: 'بهار', lastName: 'نوری' })).toBe('بهار نوری');
    expect(directoryFullName({ firstName: null, lastName: null })).toBeNull();
  });

  it('builds initials from the name, falling back to the email', () => {
    expect(directoryInitials({ firstName: 'Ali', lastName: 'Reza' })).toBe('AR');
    expect(directoryInitials({ email: 'zed@example.com' })).toBe('Z');
  });

  it('returns sorted distinct filter values and ignores blanks', () => {
    const items = [
      member({ id: 'a', department: 'مالی' }),
      member({ id: 'b', department: 'فروش' }),
      member({ id: 'c', department: 'مالی' }),
      member({ id: 'd', department: null }),
      member({ id: 'e', department: '   ' }),
    ];

    expect(distinctValues(items, 'department')).toHaveLength(2);
    expect(distinctValues(items, 'department')).toEqual(expect.arrayContaining(['مالی', 'فروش']));
  });
});
