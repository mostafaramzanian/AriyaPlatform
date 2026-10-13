import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsFutureDate } from '../../common/validators/is-future-date.decorator';

export class PublishBlogDto {
  @ApiPropertyOptional({ description: 'Scheduled publish time', example: '2030-01-01T12:00:00.000Z' })
  @IsOptional()
  @IsFutureDate()
  scheduledAt?: string;

  @ApiPropertyOptional({ description: 'Expected updatedAt for optimistic locking', example: '2025-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  expectedUpdatedAt?: string;

  @ApiPropertyOptional({ description: 'SEO title', example: 'Aria ERP for enterprise growth', maxLength: 60 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(60)
  metaTitle?: string;

  @ApiPropertyOptional({ description: 'SEO description', example: 'See how Aria ERP helps teams operate with clarity.', maxLength: 160 })
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
}
