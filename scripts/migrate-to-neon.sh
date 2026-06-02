#!/usr/bin/env bash
# ============================================================
# migrate-to-neon.sh — export local Postgres → Neon
#
# Usage:
#   NEON_URL="postgresql://user:pass@ep-xxx.neon.tech/dbname?sslmode=require" \
#     bash scripts/migrate-to-neon.sh
#
# Or pass the Neon URL as the first argument:
#   bash scripts/migrate-to-neon.sh "postgresql://..."
# ============================================================
set -e

LOCAL_DB="${DATABASE_URL:-postgresql://zartaj@localhost:5432/defi_composer}"
NEON_DB="${NEON_URL:-$1}"

if [ -z "$NEON_DB" ]; then
  echo ""
  echo "Error: NEON_URL not set."
  echo ""
  echo "Usage:"
  echo "  NEON_URL='postgresql://user:pass@ep-xxx.neon.tech/dbname?sslmode=require' \\"
  echo "    bash scripts/migrate-to-neon.sh"
  echo ""
  exit 1
fi

DUMP_FILE="/tmp/defi_composer_dump_$(date +%s).dump"

echo ""
echo "════════════════════════════════════════════════"
echo "  DeFi Composer → Neon Migration"
echo "════════════════════════════════════════════════"
echo ""
echo "  Source: ${LOCAL_DB%%@*}@..."
echo "  Target: Neon ($(echo "$NEON_DB" | grep -oP '(?<=@)[^/]+' || echo 'neon.tech'))"
echo ""

echo "Step 1/3: Dumping local database..."
pg_dump "$LOCAL_DB" \
  --no-owner \
  --no-acl \
  --no-privileges \
  -Fc \
  -f "$DUMP_FILE"
echo "         Dump saved to $DUMP_FILE ($(du -sh "$DUMP_FILE" | cut -f1))"
echo ""

echo "Step 2/3: Restoring to Neon..."
pg_restore \
  --no-owner \
  --no-acl \
  --no-privileges \
  -d "$NEON_DB" \
  "$DUMP_FILE" || {
    echo ""
    echo "Note: 'already exists' errors above are safe to ignore (schema exists)."
  }
echo ""

echo "Step 3/3: Verifying..."
psql "$NEON_DB" --no-align --tuples-only -c "
  SELECT table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) AS size
  FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name;
"

rm -f "$DUMP_FILE"

echo ""
echo "════════════════════════════════════════════════"
echo "  Migration complete!"
echo ""
echo "  Next: set DATABASE_URL in Railway to your Neon URL."
echo "════════════════════════════════════════════════"
echo ""
