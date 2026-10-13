import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString, IsUrl, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { normalizeSlug } from '../../common/sanitize.util';

export class CreateBlogDto {
  @ApiProperty({ description: 'Title of the post', example: 'How Aria ERP accelerates enterprise growth', minLength: 5, maxLength: 200 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'Optional slug', example: 'how-aria-erp-accelerates-enterprise-growth' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizeSlug(value) : value))
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(120)
  slug?: string;

  @ApiProperty({ description: 'Markdown content', example: '# Aria ERP helps high-growth teams' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(20)
  content!: string;

  @ApiPropertyOptional({ description: 'Excerpt/summary', example: 'A concise summary for the blog card', maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  @ApiPropertyOptional({ description: 'SEO title', example: 'Aria ERP for enterprise growth', maxLength: 60 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(60)
  metaTitle?: string;

  @ApiPropertyOptional({ description: 'SEO description', example: 'See how Aria ERP helps SaaS leaders accelerate execution.', maxLength: 160 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(160)
  metaDescription?: string;

  @ApiPropertyOptional({ description: 'Canonical URL', example: 'https://www.ariaerp.com/blog/how-aria-erp-accelerates-enterprise-growth' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @IsUrl()
  canonicalUrl?: string;

  @ApiPropertyOptional({ description: 'Category IDs', type: [String], example: ['11111111-1111-1111-1111-111111111111'] })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  categories?: string[];

  @ApiPropertyOptional({ description: 'Tag IDs', type: [String], example: ['22222222-2222-2222-2222-222222222222'] })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Featured image id', example: '33333333-3333-3333-3333-333333333333' })
  @IsOptional()
  @IsUUID()
  featuredImageId?: string;
}
