import { SetMetadata } from '@nestjs/common';

export function RateLimit(options: { key?: string; points?: number; duration?: number } = {}) {
  return SetMetadata('rateLimit', options);
}
