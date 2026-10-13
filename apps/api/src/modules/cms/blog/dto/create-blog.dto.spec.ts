import { validate } from 'class-validator';
import { CreateBlogDto } from './create-blog.dto';
import { PublishBlogDto } from './publish-blog.dto';

describe('Blog DTO validation', () => {
  it('rejects short titles', async () => {
    const dto = new CreateBlogDto();
    dto.title = 'Hi';
    dto.content = 'This content is long enough for validation';
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });

  it('rejects past scheduled dates', async () => {
    const dto = new PublishBlogDto();
    dto.scheduledAt = '2000-01-01T00:00:00.000Z';
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'scheduledAt')).toBe(true);
  });
});
