# UserDirectoryContract

Platform port for identity lookups used by business modules.

## What callers may ask

- Is user X a member of tenant Y?
- What is the public profile (name, email) for a set of user IDs?
- Filter tenant members by a search string, in batches.

## What callers MUST NOT receive

- `passwordHash`
- `tokenVersion`
- refresh-token or session internals
- role/permission internals
- raw Core Prisma client/schema

## Implementation boundary

`CoreUserDirectoryAdapter` resolves the contract using Core's Prisma service.
For a remotely-deployed business module, the same contract should be resolved
via `ModuleClient` against a Core identity contract, not by importing Core Prisma.
