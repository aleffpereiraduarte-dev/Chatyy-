#!/bin/bash
# ============================================
# Chatyy - Build iOS & Submit to TestFlight
# Um comando faz TUDO: commit + build + submit
#
# Uso: ./scripts/build-ios.sh "descricao da mudanca"
# ============================================
set -e
cd "$(dirname "$0")/.."

MSG="${1:-Build update}"

echo "========================================"
echo "  Chatyy iOS Build Pipeline"
echo "========================================"

# 1. Commit todas as mudancas (OBRIGATORIO pro EAS)
echo ""
echo "[1/4] Commitando codigo..."
git add -A
if git diff --cached --quiet 2>/dev/null; then
  echo "    Nenhuma mudanca nova, usando ultimo commit"
else
  git commit -m "$MSG"
  echo "    Commit feito!"
fi

# Mostrar build number atual
BUILD_NUM=$(python3 -c "import json; print(json.load(open('app.json'))['expo']['ios']['buildNumber'])")
echo "    Build number: $BUILD_NUM"
echo ""

# 2. Build iOS no EAS
echo "[2/4] Buildando no EAS (5-8 min)..."
npx eas-cli build --platform ios --profile production --non-interactive --clear-cache 2>&1 | tee /tmp/eas-build.log

# Pegar Build ID do log
BUILD_ID=$(grep -oP 'builds/\K[a-f0-9-]+' /tmp/eas-build.log | head -1)
if [ -z "$BUILD_ID" ]; then
  echo "ERRO: Nao consegui pegar o Build ID"
  exit 1
fi
echo "    Build ID: $BUILD_ID"
echo ""

# 3. Esperar build terminar (se nao esperou)
echo "[3/4] Verificando build..."
STATUS=$(npx eas-cli build:view "$BUILD_ID" 2>&1 | grep "Status" | awk '{print $2}')
if [ "$STATUS" != "finished" ]; then
  echo "    Build ainda em progresso, esperando..."
  sleep 60
fi
echo ""

# 4. Submeter pro TestFlight
echo "[4/4] Enviando pro TestFlight..."
npx eas-cli submit --platform ios --profile production --id "$BUILD_ID" --non-interactive 2>&1

echo ""
echo "========================================"
echo "  Build #$BUILD_NUM enviado!"
echo "  TestFlight em ~10 min"
echo "========================================"
