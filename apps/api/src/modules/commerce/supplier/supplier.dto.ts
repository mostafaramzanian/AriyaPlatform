import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import {
  CARD_NUMBER_PATTERN,
  MAX_SUPPLIER_ADDRESS_LENGTH,
  MAX_SUPPLIER_BANK_NAME_LENGTH,
  MAX_SUPPLIER_COMPANY_NAME_LENGTH,
  MAX_SUPPLIER_EMAIL_LENGTH,
  MAX_SUPPLIER_NAME_LENGTH,
  MAX_SUPPLIER_NOTES_LENGTH,
  MAX_SUPPLIER_PHONE_LENGTH,
  NATIONAL_CODE_PATTERN,
  PHONE_PATTERN,
  SHEBA_PATTERN,
  SUPPLIER_ENTITY_TYPES,
  SUPPLIER_STATUSES,
} from './supplier.constants';

/**
 * The supplier directory's wire contract — create, update and list. Nothing
 * else. `tenantId` and every actor id are deliberately absent (the session
 * resolves both — the global pipe's `whitelist` + `forbidNonWhitelisted` makes
 * sending one a 400), `id` is server-minted, and `createdAt`/`updatedAt` are
 * never client-stated.
 *
 * CONDITIONALS ARE SERVICE RULES, NOT DTO RULES: "LEGAL requires companyName"
 * and "an update must name a field" both depend on values the closed DTO
 * vocabulary cannot cross-reference, so the service refuses them with named
 * codes rather than pretending a validator can see another field.
 */

/** Create one supplier (`POST commerce/suppliers`). */
export class CreateSupplierDto {
  @IsIn(SUPPLIER_ENTITY_TYPES)
  entityType!: (typeof SUPPLIER_ENTITY_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SUPPLIER_NAME_LENGTH)
  name!: string;

  /** Required by the SERVICE for LEGAL rows; free for INDIVIDUAL. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SUPPLIER_COMPANY_NAME_LENGTH)
  companyName?: string;

  @IsOptional()
  @Matches(NATIONAL_CODE_PATTERN, {
    message: 'nationalCode must be exactly 10 digits',
  })
  nationalCode?: string;

  /** `IR` + 24 digits; the prefix may be omitted or lowercase — the service normalises. */
  @IsOptional()
  @Matches(SHEBA_PATTERN, {
    message: 'shebaNumber must be IR followed by 24 digits',
  })
  shebaNumber?: string;

  @IsOptional()
  @Matches(CARD_NUMBER_PATTERN, { message: 'cardNumber must be exactly 16 digits' })
  cardNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUPPLIER_BANK_NAME_LENGTH)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUPPLIER_ADDRESS_LENGTH)
  address?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'phone must be a plausible phone number' })
  @MaxLength(MAX_SUPPLIER_PHONE_LENGTH)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(MAX_SUPPLIER_EMAIL_LENGTH)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUPPLIER_NOTES_LENGTH)
  notes?: string;

  /** Optional on create (defaults server-side to ACTIVE); the normal way to
   *  import a retired supplier is create-then-inactivate, never a hidden field. */
  @IsOptional()
  @IsIn(SUPPLIER_STATUSES)
  status?: (typeof SUPPLIER_STATUSES)[number];
}

/**
 * Update one supplier (`PATCH commerce/suppliers/:id`) — every field optional,
 * absent fields are untouched (Prisma's partial update), and a body naming no
 * field is the service's `SUPPLIER_UPDATE_EMPTY` refusal rather than a silent
 * no-op write.
 */
export class UpdateSupplierDto {
  @IsOptional()
  @IsIn(SUPPLIER_ENTITY_TYPES)
  entityType?: (typeof SUPPLIER_ENTITY_TYPES)[number];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SUPPLIER_NAME_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SUPPLIER_COMPANY_NAME_LENGTH)
  companyName?: string;

  @IsOptional()
  @Matches(NATIONAL_CODE_PATTERN, {
    message: 'nationalCode must be exactly 10 digits',
  })
  nationalCode?: string;

  @IsOptional()
  @Matches(SHEBA_PATTERN, {
    message: 'shebaNumber must be IR followed by 24 digits',
  })
  shebaNumber?: string;

  @IsOptional()
  @Matches(CARD_NUMBER_PATTERN, { message: 'cardNumber must be exactly 16 digits' })
  cardNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUPPLIER_BANK_NAME_LENGTH)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUPPLIER_ADDRESS_LENGTH)
  address?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'phone must be a plausible phone number' })
  @MaxLength(MAX_SUPPLIER_PHONE_LENGTH)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(MAX_SUPPLIER_EMAIL_LENGTH)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUPPLIER_NOTES_LENGTH)
  notes?: string;

  /** The supported retirement / re-activation switch. */
  @IsOptional()
  @IsIn(SUPPLIER_STATUSES)
  status?: (typeof SUPPLIER_STATUSES)[number];
}

/**
 * The directory list query (`GET commerce/suppliers`): the shared page window
 * plus an exact-enum filter pair. `search` (inherited, ≤200 chars) matches the
 * supplier's name OR company name — the two columns a person actually types —
 * case-insensitively, server-side.
 */
export class ListSuppliersQueryDto extends CommercePageQueryDto {
  @IsOptional()
  @IsIn(SUPPLIER_ENTITY_TYPES)
  entityType?: (typeof SUPPLIER_ENTITY_TYPES)[number];

  @IsOptional()
  @IsIn(SUPPLIER_STATUSES)
  status?: (typeof SUPPLIER_STATUSES)[number];
}
