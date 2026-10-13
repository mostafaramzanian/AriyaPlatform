import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceMemberPicker } from '../settings/CommerceMemberPicker';
import { fetchDirectory, fetchDirectoryMember } from '@/lib/directory-api';

jest.mock('@/lib/directory-api', () => ({
  ...jest.requireActual('@/lib/directory-api'),
  fetchDirectory: jest.fn(),
  fetchDirectoryMember: jest.fn(),
}));

const directoryMock = fetchDirectory as jest.MockedFunction<typeof fetchDirectory>;
const memberMock = fetchDirectoryMember as jest.MockedFunction<typeof fetchDirectoryMember>;

const UUID_MEMBER = {
  id: '9b7c1d20-4321-4cba-9f8e-1a2b3c4d5e6f',
  firstName: 'رضا',
  lastName: 'کریمی',
  email: 'reza@example.com',
};

/** The seeded platform administrator: a REAL tenant member whose id is not a UUID. */
const OPAQUE_MEMBER = {
  id: 'super-admin-user',
  firstName: 'Super',
  lastName: 'Admin',
  email: 'admin@localhost',
};

/** PHASE UI-5, RE-ALIGNED IN GAP-8: the ONE picker every Commerce surface chooses a person with. */
describe('CommerceMemberPicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    memberMock.mockResolvedValue(UUID_MEMBER);
  });

  it('offers EVERY directory member exactly as returned — an opaque id is a legal id (GAP-8)', async () => {
    directoryMock.mockResolvedValue({
      items: [OPAQUE_MEMBER, UUID_MEMBER],
      hasMore: false,
    });

    render(
      <CommerceMemberPicker
        id="m"
        label="عضو"
        value={null}
        onChange={jest.fn()}
        enabled
        limitationText="محدودیت"
        testId="m"
      />
    );
    const user = userEvent.setup();

    await user.click(screen.getByTestId('m-search-submit'));

    await waitFor(() => expect(directoryMock).toHaveBeenCalled());
    expect(await screen.findByTestId('m-option-super-admin-user')).toBeInTheDocument();
    expect(screen.getByTestId(`m-option-${UUID_MEMBER.id}`)).toBeInTheDocument();
  });

  it('selects the opaque id and hands it to onChange VERBATIM — never reshaped in the browser', async () => {
    directoryMock.mockResolvedValue({ items: [OPAQUE_MEMBER], hasMore: false });
    const onChange = jest.fn();

    render(
      <CommerceMemberPicker
        id="m"
        label="عضو"
        value={null}
        onChange={onChange}
        enabled
        limitationText="محدودیت"
        testId="m"
      />
    );
    const user = userEvent.setup();

    await user.click(screen.getByTestId('m-search-submit'));
    await user.click(await screen.findByTestId('m-option-super-admin-user'));

    expect(onChange).toHaveBeenCalledWith('super-admin-user');
  });

  it('says plainly when a search finds nobody', async () => {
    directoryMock.mockResolvedValue({ items: [], hasMore: false });

    render(
      <CommerceMemberPicker
        id="m"
        label="عضو"
        value={null}
        onChange={jest.fn()}
        enabled
        limitationText="محدودیت"
        testId="m"
      />
    );
    const user = userEvent.setup();

    await user.click(screen.getByTestId('m-search-submit'));

    await waitFor(() => expect(directoryMock).toHaveBeenCalled());
    expect(await screen.findByText('کاربری با این مشخصات یافت نشد.')).toBeInTheDocument();
  });

  it('keeps the clear affordance for optional fields and removes it when asked not to', async () => {
    const onChange = jest.fn();
    const { unmount } = render(
      <CommerceMemberPicker
        id="a"
        label="رابط"
        value={UUID_MEMBER.id}
        onChange={onChange}
        enabled
        limitationText="محدودیت"
        testId="a"
      />
    );
    expect(await screen.findByTestId('a-clear')).toBeInTheDocument();
    unmount();

    render(
      <CommerceMemberPicker
        id="b"
        label="درخواست‌کننده"
        value={UUID_MEMBER.id}
        onChange={onChange}
        enabled
        limitationText="محدودیت"
        allowClear={false}
        testId="b"
      />
    );
    expect(await screen.findByTestId('b-selected')).toBeInTheDocument();
    expect(screen.queryByTestId('b-clear')).not.toBeInTheDocument();
  });

  it('states the limitation and issues no request without the directory grant', () => {
    render(
      <CommerceMemberPicker
        id="c"
        label="درخواست‌کننده"
        value={UUID_MEMBER.id}
        onChange={jest.fn()}
        enabled={false}
        limitationText="به مجوز admin.users.read نیاز است."
        testId="c"
      />
    );

    expect(screen.getByTestId('c-limitation')).toHaveTextContent('admin.users.read');
    expect(directoryMock).not.toHaveBeenCalled();
    expect(memberMock).not.toHaveBeenCalled();
  });
});
