#!/usr/bin/env bash
# Submit a fresh App Store review WITH all 7 subscriptions attached.
#
# Apple's "Review Submission" workflow (introduced 2023) requires you to add
# IAP items to the submission ALONGSIDE the appStoreVersion. The legacy "add
# IAP to version" flow doesn't surface them to reviewers anymore. The 2026-04
# rejection happened because build 410 was submitted with ZERO IAP items.
#
# Run AFTER:
#   1. Build is uploaded to App Store Connect (TestFlight)
#   2. App version 2.4.2 in ASC has the new build attached
#   3. User has confirmed IAP works in TestFlight with a sandbox tester
#   4. Paid Apps Agreement is "Active" in ASC → Business
#
# Usage:  bash scripts/asc-submit-review-with-iaps.sh
set -euo pipefail

KEY_FILE="${KEY_FILE:-./asc_key.p8}"
KEY_ID="${KEY_ID:-QSYM3KX73P}"
ISSUER_ID="${ISSUER_ID:-494360d0-0420-4f1f-a1db-6be19eeb2d89}"
APP_ID="${APP_ID:-6759975575}"
VERSION_STRING="${VERSION_STRING:-2.4.2}"
SUBSCRIPTION_IDS="${SUBSCRIPTION_IDS:-6760858072 6760858228 6760858150 6760858100 6760858254 6760858198 6760852886}"

# 1. Mint JWT
TOKEN=$(python3 - <<PY
import jwt, time
with open("$KEY_FILE") as f: key = f.read()
print(jwt.encode(
    {"iss":"$ISSUER_ID","iat":int(time.time()),"exp":int(time.time())+1200,"aud":"appstoreconnect-v1"},
    key, algorithm="ES256", headers={"kid":"$KEY_ID","typ":"JWT"}))
PY
)
echo "✓ Token minted"

# 2. Resolve appStoreVersion id for VERSION_STRING
VID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.appstoreconnect.apple.com/v1/apps/$APP_ID/appStoreVersions?filter%5BversionString%5D=$VERSION_STRING" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("data",[{}])[0].get("id",""))')
[ -z "$VID" ] && { echo "❌ Could not find version $VERSION_STRING"; exit 1; }
echo "✓ Version $VERSION_STRING → id=$VID"

# 3. Create new reviewSubmission (platform IOS)
RS_RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"data\":{\"type\":\"reviewSubmissions\",\"attributes\":{\"platform\":\"IOS\"},\"relationships\":{\"app\":{\"data\":{\"type\":\"apps\",\"id\":\"$APP_ID\"}}}}}" \
  "https://api.appstoreconnect.apple.com/v1/reviewSubmissions")

RSID=$(echo "$RS_RESP" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("data",{}).get("id",""))')
[ -z "$RSID" ] && { echo "❌ Failed to create reviewSubmission. Response: $RS_RESP"; exit 1; }
echo "✓ reviewSubmission created: $RSID"

# 4. Attach appStoreVersion to the submission
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"data\":{\"type\":\"reviewSubmissionItems\",\"relationships\":{\"reviewSubmission\":{\"data\":{\"type\":\"reviewSubmissions\",\"id\":\"$RSID\"}},\"appStoreVersion\":{\"data\":{\"type\":\"appStoreVersions\",\"id\":\"$VID\"}}}}}" \
  "https://api.appstoreconnect.apple.com/v1/reviewSubmissionItems" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);
if "errors" in d: print("⚠ appStoreVersion attach error:", d["errors"][0].get("detail",""))
else: print("✓ appStoreVersion attached")'

# 5. Attach each subscription
for SID in $SUBSCRIPTION_IDS; do
  RESP=$(curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"data\":{\"type\":\"reviewSubmissionItems\",\"relationships\":{\"reviewSubmission\":{\"data\":{\"type\":\"reviewSubmissions\",\"id\":\"$RSID\"}},\"subscription\":{\"data\":{\"type\":\"subscriptions\",\"id\":\"$SID\"}}}}}" \
    "https://api.appstoreconnect.apple.com/v1/reviewSubmissionItems")
  echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin)
if 'errors' in d: print('⚠ subscription $SID:', d['errors'][0].get('detail',''))
else: print('✓ subscription $SID attached')"
done

# 6. Submit the review submission for review
PATCH_RESP=$(curl -s -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"data\":{\"type\":\"reviewSubmissions\",\"id\":\"$RSID\",\"attributes\":{\"submitted\":true}}}" \
  "https://api.appstoreconnect.apple.com/v1/reviewSubmissions/$RSID")
echo "$PATCH_RESP" | python3 -c 'import json,sys;d=json.load(sys.stdin)
if "errors" in d: print("❌ Submit failed:", d["errors"][0].get("detail",""))
else: print("✓ Submitted for review!  state=", d.get("data",{}).get("attributes",{}).get("state","?"))'

echo
echo "Done. Apple will email a status update within 24-48h."
echo "View at: https://appstoreconnect.apple.com/apps/$APP_ID/distribution"
