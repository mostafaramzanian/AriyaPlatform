'use client';

import * as React from 'react';

import Image from 'next/image';
import { directoryInitials } from '@/lib/directory-api';

/**
 * Phase 49D-1: directory avatar.
 *
 * Reuses the 49C avatar contract (`User.avatarUrl`) — no new avatar system. A
 * missing or broken image degrades to the same initials monogram used by the
 * profile view, so a dead URL never renders a broken-image icon.
 */

const SIZES = {
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-20 w-20 text-lg',
} as const;

export function DirectoryAvatar({
  member,
  size = 'md',
  className = '',
}: {
  member: { firstName?: string | null; lastName?: string | null; email?: string; avatarUrl?: string | null };
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const initials = directoryInitials(member);
  const showImage = Boolean(member.avatarUrl) && !failed;

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted font-semibold text-foreground ${SIZES[size]} ${className}`}
    >
      {showImage ? (
        <Image
          src={member.avatarUrl as string}
          alt=""
          unoptimized
          width={40}
          height={40}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}
