#!/bin/sh
set -e

# Migrations are intentionally not run here. Deployment executes `npm run db:migrate`
# as a separate, observable step before starting a required runtime.
echo "Starting application..."
exec "$@"
