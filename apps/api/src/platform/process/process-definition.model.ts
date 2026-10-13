/**
 * Phase CHECK-ISSUATION — PROCESS PRIMITIVES: the domain-neutral model of a versioned,
 * configurable business process.
 *
 * WHY THIS LIVES IN `platform/process/`
 * -------------------------------------
 * Commerce's Workflow subsystem (definition/version/step/actor source/conditional
 * execution/runtime instance) is real and well built, but its runtime is CLOSED to
 * `PURCHASE_DOCUMENT` / `PURCHASE_LINE` subjects: its facts, handlers and lifecycle are
 * Commercial. Financial's check-issuance process must not import that, and copying it
 * would create a second engine that answers the same seven questions differently.
 * The extraction below keeps ONLY what both — and any later financial process (payment,
 * allocation, treasury) — genuinely share: a step graph over opaque state ordinals, an
 * action catalogue with capability + actor policy, transitions, document sections, field
 * policies and a validator that refuses an incoherent configuration.
 *
 * WHAT IS DELIBERATELY ABSENT (and forbidden here)
 * -----------------------------------------------
 *  * NO business subject of any kind. No `PurchaseDocument`, no `PurchaseLine`, no
 *    `CommercialLifecycle`, no `CommerceSubjectType`, no receiving/returns vocabulary.
 *    State ordinals are `number` — their MEANING belongs to the owning bounded context.
 *  * NO handlers, no scripts, no webhooks, no arbitrary queries (brief §37): an action's
 *    execution is a route in the owning module, gated by the action's permission. The
 *    configuration cannot say HOW anything runs — only WHAT may move WHERE, WHO may ask,
 *    and WHAT the UI shows.
 *  * NO persistence. A definition is an immutable value registered by its bounded
 *    context; `version` pinning happens on the OWNING row (e.g. `CheckRequest`), and a
 *    published version is frozen — a change is a NEW version, never an edit.
 *  * NO NestJS, no Prisma, no clock, no HTTP — pure data and pure functions, the same
 *    rule `check-request-status.ts` and `bom-status.ts` state.
 *
 * THE CONFIGURATION BOUNDARY (brief §6), RESTATED AS A TYPE CONTRACT
 * ------------------------------------------------------------------
 * Everything in this model is CONFIGURABLE because none of it is a business invariant:
 * titles, order, visibility, labels, capabilities, actor policies, transition targets,
 * document sections, field policies. What this model CANNOT express — tenant isolation,
 * authentication, self-approval refusal execution, concurrency, atomicity, audit — is
 * therefore code-owned BY CONSTRUCTION: a configuration cannot turn off a rule it
 * cannot mention.
 */

/** A process identity — stable across versions, e.g. `financial.check-issuance`. */
export type ProcessKey = string;

/** A step key within one process, e.g. `manager-review`. */
export type ProcessStepKey = string;

/** An action key, e.g. `approve` / `allocate`. Maps to exactly one route in the owner. */
export type ProcessActionKey = string;

/**
 * A state ordinal in the OWNING domain's vocabulary. Opaque here: the platform never
 * interprets a value, it only requires that configuration references states that exist.
 */
export type ProcessState = number;

/** How an action's actor is resolved. The ONLY shapes the platform supports. */
export type ProcessActorKind =
  /** The row's own requester (create/edit/submit remits). */
  | 'REQUESTER'
  /** Any tenant member holding the configured capability (role-shaped, id-free). */
  | 'PERMISSION'
  /**
   * One configured user id. Declared for completeness; NEVER populated from legacy
   * person names — the source's hard-coded «جلیلی/مرتضوی/انفرادی/نداف» are evidence of
   * role separation, not identifiers, and must never reach a configuration.
   */
  | 'USER';

/**
 * WHO may exercise an action, beyond the capability itself.
 *
 * `permission` is the route-level capability (`RolesGuard` enforces it). The policy adds
 * the relational rule the source's `ArjaBe` assignment could only express as a name:
 * `forbidSelfApproval` is the brief's fail-closed self-approval refusal (Preflight U5 —
 * NOT ESTABLISHED in source, so the restriction is applied, not invented per person).
 */
export interface ProcessActorPolicy {
  readonly key: string;
  readonly kind: ProcessActorKind;
  /** Required iff `kind === 'PERMISSION'` — the capability string. */
  readonly permission?: string;
  /** Required iff `kind === 'USER'` — an opaque platform user id. */
  readonly userId?: string;
  /** The acting user must not be the row's requester. Code-enforced, config-stated. */
  readonly forbidSelfApproval: boolean;
}

/**
 * One declared action: the label the UI renders, the capability the route declares, and
 * the actor policy the service re-checks. An action with no transition is rejected by
 * the validator — configuration may not describe a button that does nothing.
 */
export interface ProcessAction {
  readonly key: ProcessActionKey;
  readonly label: string;
  readonly permission: string;
  readonly actorPolicy: string;
}

/**
 * ONE state-to-state move. `action` + `fromState` is the identity: several transitions
 * may share an action (submit from 0 and from 1), but never the same pair twice — the
 * validator refuses a duplicate so "what does this button do?" has exactly one answer.
 *
 * This is the SINGLE definition of a transition the brief's §16 demands: routes,
 * available-actions, the wizard and the domain pipeline all read THIS list.
 */
export interface ProcessTransition {
  readonly action: ProcessActionKey;
  readonly fromState: ProcessState;
  readonly toState: ProcessState;
}

/** A document section (the source's «پیوست ها» `Section` vocabulary: 2 / 6 / 7). */
export interface ProcessDocumentSection {
  /** The section ordinal, as the source stores it. */
  readonly section: number;
  readonly key: string;
  readonly title: string;
  /** States in which this section is MANAGED (upload/delete allowed). */
  readonly states: readonly ProcessState[];
  /**
   * The section's document-type vocabulary. `null` = the section carries no type picker
   * and `documentType` is not required — the source's section-6/7 grids never asked for
   * «نوع سند», so requiring one there would invent a rule. Otherwise a NON-EMPTY list:
   * an empty list would be a vocabulary that permits nothing.
   */
  readonly allowedDocumentTypes: readonly string[] | null;
  /**
   * Actions that refuse to run until this section holds at least one document — the
   * source's «تصویر چک صادر شده بارگذاری نشده است!» / «تصویر رسید تحویل بارگذاری
   * نشده است!» gates, stated as configuration instead of a magic number.
   */
  readonly requiredForActions: readonly ProcessActionKey[];
  /** Who may write this section while it is active. */
  readonly permission: string;
}

/** Field visibility/editability for one field of the owning module's own DTOs. */
export interface ProcessFieldPolicy {
  readonly field: string;
  /** States in which the wizard shows the field. */
  readonly states: readonly ProcessState[];
  /** States in which the wizard renders it editable (⊆ `states`, validator-enforced). */
  readonly editableStates: readonly ProcessState[];
}

/** ONE step of the wizard — a phase of the process, keyed by the states it owns. */
export interface ProcessStep {
  readonly key: ProcessStepKey;
  /** Position in the stepper. Unique — validator-enforced. */
  readonly order: number;
  readonly title: string;
  /** The progress word the stepper renders (may equal `title`). */
  readonly progressLabel: string;
  /** The states this step covers. Every configured state belongs to EXACTLY one step. */
  readonly states: readonly ProcessState[];
  /** False = configured out of the stepper without deleting its history. */
  readonly active: boolean;
  /** False = hidden from the stepper (the step still governs its states). */
  readonly visible: boolean;
  /** Actions offered while in one of this step's states. */
  readonly actions: readonly ProcessActionKey[];
  readonly fields: readonly ProcessFieldPolicy[];
}

/**
 * A COMPLETE, versioned process configuration.
 *
 * IMMUTABILITY: the owning registry deep-freezes a published definition. The validator
 * refuses an incoherent configuration, and the registry serves only `published`
 * versions — a request PINNED to version N keeps reading the frozen N forever, so
 * editing the process means registering N+1 (brief §5 / §35), never mutating N.
 */
export interface ProcessDefinition {
  readonly processKey: ProcessKey;
  readonly version: number;
  readonly status: 'draft' | 'published';
  readonly title: string;
  readonly steps: readonly ProcessStep[];
  readonly actions: readonly ProcessAction[];
  readonly actorPolicies: readonly ProcessActorPolicy[];
  readonly transitions: readonly ProcessTransition[];
  readonly documentSections: readonly ProcessDocumentSection[];
  /** States after which no action exists. Declared terminals must have no outgoing move. */
  readonly terminalStates: readonly ProcessState[];
  /**
   * Bounded extension metadata — STRING values only (JSON-safe scalar), never structure.
   * Structural facts (steps, transitions, policies) stay typed above so a typo is a
   * validation error rather than a key nobody reads (brief §7: typed structure + a
   * bounded extension, not one giant JSON blob).
   */
  readonly extension?: Readonly<Record<string, string>>;
}


