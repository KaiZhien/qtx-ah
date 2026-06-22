#!/usr/bin/env bash
set -e

DLMS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DLMS_DIR"

echo "==> DLMS Phase 0 Setup"
echo ""

# 1. Install dependencies
echo "1/5  Installing npm dependencies..."
npm install

# 2. Copy .env if missing
if [ ! -f .env.local ]; then
  echo "2/5  Creating .env.local from template..."
  cp .env.local.example .env.local
  echo "     NOTE: Edit .env.local if you need custom values."
else
  echo "2/5  .env.local already exists — skipping."
fi

# 3. Start Supabase (Docker must be running)
echo "3/5  Starting local Supabase..."
npx supabase start

# 4. Apply migrations and seed
echo "4/5  Resetting DB and applying migrations..."
npx supabase db reset --no-seed

echo "     Seeding database..."
# Extract DB port from supabase status and seed via psql
DB_URL=$(npx supabase status --output json 2>/dev/null | grep -o '"DB_URL":"[^"]*"' | cut -d'"' -f4)
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
psql "$DB_URL" -f supabase/seed.sql

echo ""
echo "5/5  Setup complete!"
echo ""
echo "  App:      http://localhost:3001   (npm run dev)"
echo "  Studio:   http://localhost:54323"
echo "  API:      http://localhost:54321"
echo ""
echo "  Demo logins (all use password: demo1234)"
echo "    admin@demo.quantumtx.com    — full admin access"
echo "    engineer@demo.quantumtx.com — CRUD + import/export"
echo "    viewer@demo.quantumtx.com   — read-only"
echo ""
echo "Start the dev server:  npm run dev"
echo "Run tests:             npm test"
echo ""
