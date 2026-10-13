export class BlogEntity {
  id?: string;
  title?: string;
  slug?: string;
  excerpt?: string;
  content?: string;
  status?: string;
  authorId?: string;
  editorId?: string;
  publishedAt?: Date;
  scheduledAt?: Date;
  featuredImageId?: string;
  readingTimeMin?: number;
  viewCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}
