/**
 * Global E2E Teardown
 * Runs once after all E2E tests
 */

export default async () => {
  console.log('[E2E] Starting global teardown...');

  try {
    // Reset test database (optional: delete all test data)
    console.log('[E2E] Cleaning up test database...');
    await resetTestDatabase();
  } catch (error) {
    console.error('[E2E] Teardown error (non-fatal):', error);
  }

  console.log('[E2E] Global teardown complete');
};

async function resetTestDatabase(): Promise<void> {
  // This can be extended to reset all tables or drop/recreate the test DB
  // For now, just log that teardown completed
  console.log('[E2E] Test database cleanup skipped (data retained for inspection)');
  return Promise.resolve();
}
