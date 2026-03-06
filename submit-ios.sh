#!/bin/bash
# Submit OneMundo Mail to App Store for Review
# Run this AFTER configuring App Privacy in App Store Connect

cd /root/webmail-app

ASC_TOKEN=$(python3 -c "
import jwt, time
with open('asc_key.p8', 'r') as f:
    key = f.read()
payload = {'iss': '494360d0-0420-4f1f-a1db-6be19eeb2d89', 'iat': int(time.time()), 'exp': int(time.time()) + 1200, 'aud': 'appstoreconnect-v1'}
print(jwt.encode(payload, key, algorithm='ES256', headers={'kid': 'QSYM3KX73P'}))
")

VERSION_ID="0b2ef0e0-cbb3-464e-ad22-7609ee614af4"

echo "Creating review submission..."
RESP=$(curl -s -X POST -H "Authorization: Bearer $ASC_TOKEN" -H "Content-Type: application/json" \
  "https://api.appstoreconnect.apple.com/v1/reviewSubmissions" \
  -d '{
    "data": {
      "type": "reviewSubmissions",
      "attributes": {"platform": "IOS"},
      "relationships": {
        "app": {"data": {"type": "apps", "id": "6759975575"}}
      }
    }
  }')

SUBMISSION_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
if [ -z "$SUBMISSION_ID" ]; then
  echo "Failed to create submission:"
  echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
  exit 1
fi
echo "Submission ID: $SUBMISSION_ID"

echo "Adding version to submission..."
RESP2=$(curl -s -X POST -H "Authorization: Bearer $ASC_TOKEN" -H "Content-Type: application/json" \
  "https://api.appstoreconnect.apple.com/v1/reviewSubmissionItems" \
  -d '{
    "data": {
      "type": "reviewSubmissionItems",
      "relationships": {
        "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": "'"$SUBMISSION_ID"'"}},
        "appStoreVersion": {"data": {"type": "appStoreVersions", "id": "'"$VERSION_ID"'"}}
      }
    }
  }')

ITEM_ID=$(echo "$RESP2" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
if [ -z "$ITEM_ID" ]; then
  echo "Failed to add version to submission:"
  echo "$RESP2" | python3 -m json.tool 2>/dev/null || echo "$RESP2"
  exit 1
fi
echo "Item added: $ITEM_ID"

echo "Confirming submission for review..."
curl -s -o /tmp/submit_confirm.json -w "%{http_code}" -X PATCH -H "Authorization: Bearer $ASC_TOKEN" -H "Content-Type: application/json" \
  "https://api.appstoreconnect.apple.com/v1/reviewSubmissions/$SUBMISSION_ID" \
  -d '{
    "data": {
      "type": "reviewSubmissions",
      "id": "'"$SUBMISSION_ID"'",
      "attributes": {"submitted": true}
    }
  }'
echo ""
echo "Done! Check App Store Connect for review status."
cat /tmp/submit_confirm.json | python3 -m json.tool 2>/dev/null | head -15
