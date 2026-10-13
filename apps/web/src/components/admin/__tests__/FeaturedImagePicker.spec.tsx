import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeaturedImagePicker } from '../FeaturedImagePicker';
import * as cmsApi from '@/lib/cms-api';

jest.mock('@/lib/cms-api', () => ({
  ...jest.requireActual('@/lib/cms-api'),
  getMedia: jest.fn(),
  uploadMedia: jest.fn(),
}));

const getMedia = cmsApi.getMedia as jest.MockedFunction<typeof cmsApi.getMedia>;
const uploadMedia = cmsApi.uploadMedia as jest.MockedFunction<typeof cmsApi.uploadMedia>;

describe('FeaturedImagePicker', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders an empty state before an image is selected', () => {
    render(<FeaturedImagePicker value={null} onChange={jest.fn()} />);

    expect(screen.getByText('هنوز تصویری انتخاب نشده است.')).toBeInTheDocument();
  });

  it('uploads a file and reports the selected media id', async () => {
    const onChange = jest.fn();
    uploadMedia.mockResolvedValue({ id: 'media-123', url: 'https://cdn.example/media.png' });

    render(<FeaturedImagePicker value={null} onChange={onChange} />);

    const file = new File(['image-content'], 'banner.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('تصویر شاخص'), file);

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledWith(file));
    expect(onChange).toHaveBeenCalledWith('media-123');
    expect(screen.getByRole('img', { name: 'تصویر شاخص' })).toHaveAttribute(
      'src',
      'https://cdn.example/media.png',
    );
  });

  it('shows an error when the upload fails', async () => {
    uploadMedia.mockRejectedValue(new cmsApi.CmsApiError(500, 'UPLOAD_FAILED', 'آپلود ناموفق بود.'));

    render(<FeaturedImagePicker value={null} onChange={jest.fn()} />);

    const file = new File(['bad'], 'bad.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('تصویر شاخص'), file);

    expect(await screen.findByRole('alert')).toHaveTextContent('آپلود ناموفق بود.');
  });

  it('removes the current image selection', async () => {
    const onChange = jest.fn();
    getMedia.mockResolvedValue({ id: 'media-321', url: 'https://cdn.example/existing.png' });

    render(<FeaturedImagePicker value="media-321" onChange={onChange} />);

    expect(await screen.findByRole('img', { name: 'تصویر شاخص' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'حذف تصویر' }));

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
