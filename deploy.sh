#!/usr/bin/env bash
# Despliegue a Cloudflare. Requiere haber corrido `npx wrangler login` antes.
#
# Es idempotente: si la base ya existe la reutiliza, y si el database_id ya
# está puesto en wrangler.toml no lo vuelve a tocar.
set -euo pipefail
cd "$(dirname "$0")"

DB=cartilla-fenologica
PLACEHOLDER="00000000-0000-0000-0000-000000000000"

echo "==> Verificando sesión de Cloudflare"
if ! npx wrangler whoami >/dev/null 2>&1 || npx wrangler whoami 2>&1 | grep -q "not authenticated"; then
  echo "No hay sesión. Corre primero:  npx wrangler login"
  exit 1
fi
npx wrangler whoami 2>&1 | grep -E "associated with the email|account" | head -2 || true

CURRENT_ID=$(grep -oP 'database_id = "\K[^"]+' wrangler.toml)

if [ "$CURRENT_ID" = "$PLACEHOLDER" ]; then
  echo "==> Creando base D1 '$DB'"
  CREATE_OUT=$(npx wrangler d1 create "$DB" 2>&1 || true)
  echo "$CREATE_OUT" | tail -5

  NEW_ID=$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

  # Si ya existía, la sacamos del listado en vez de fallar.
  if [ -z "$NEW_ID" ]; then
    echo "   (parece que ya existe; buscando su id)"
    NEW_ID=$(npx wrangler d1 list --json 2>/dev/null \
      | python3 -c "import sys,json;print(next((d['uuid'] for d in json.load(sys.stdin) if d['name']=='$DB'),''))")
  fi

  if [ -z "$NEW_ID" ]; then
    echo "No se pudo obtener el database_id. Créala a mano:"
    echo "  npx wrangler d1 create $DB"
    echo "y pega el id en wrangler.toml"
    exit 1
  fi

  echo "==> database_id: $NEW_ID"
  sed -i "s/database_id = \"$PLACEHOLDER\"/database_id = \"$NEW_ID\"/" wrangler.toml
else
  echo "==> Usando database_id ya configurado: $CURRENT_ID"
fi

echo "==> Aplicando migraciones en remoto"
npx wrangler d1 migrations apply "$DB" --remote

echo "==> Desplegando el Worker"
npx wrangler deploy

cat <<'FIN'

==> Listo.

Falta un paso para cerrar el registro de cuentas (si no, cualquiera con la
URL puede crearse una):

    npx wrangler secret put REGISTRATION_CODE

La primera cuenta que se registre queda como admin.
FIN
