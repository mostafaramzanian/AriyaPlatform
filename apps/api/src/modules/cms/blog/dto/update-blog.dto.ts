import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateBlogDto } from './create-blog.dto';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBlogDto extends PartialType(CreateBlogDto) {
  @ApiPropertyOptional({ description: 'Blog status', enum: ['DRAFT', 'REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] })
  @IsOptional()
  @IsString()
  @IsIn(['DRAFT', 'REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'])
  status?: string;

  @ApiPropertyOptional({ description: 'Expected updatedAt timestamp for optimistic locking', example: '2025-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  expectedUpdatedAt?: string;

  @ApiPropertyOptional({ description: 'Editor notes', example: 'Ready for review' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  editorNotes?: string;

  @ApiPropertyOptional({ description: 'Pin the blog post' })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  readingTimeMin?: number;
}
