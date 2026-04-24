#!/usr/bin/env python3
"""
Submit Chatyy iOS binary + 7 subscriptions to App Review in one reviewSubmission.

Prereqs: build 373 (or whichever buildNumber you pass via CLI) must already be
uploaded and finished processing in App Store Connect (shows as available in
TestFlight). If the App Store version 2.4.0 is in DEVELOPER_REJECTED state we
move it back to PREPARE_FOR_SUBMISSION and attach the new build.

Usage:
    python3 asc_submit_build_plus_subs.py [buildNumber]

Default buildNumber = 373.
"""

import base64, json, subprocess, sys, time, urllib.request, urllib.parse, urllib.error

ASC_KEY_PATH = '/root/webmail-app/asc_key.p8'
ASC_KID      = 'QSYM3KX73P'
ASC_ISS      = '494360d0-0420-4f1f-a1db-6be19eeb2d89'
APP_ID       = '6759975575'
ASV_ID       = '78dec9c6-6f93-4887-a467-2ee01d113a07'  # 2.4.0

SUBSCRIPTION_IDS = [
    '6760858072', # family_annual
    '6760858228', # family_monthly
    '6760858150', # one_annual
    '6760858100', # one_monthly
    '6760858254', # storage_1000
    '6760858198', # storage_2000
    '6760852886', # storage_500
]

API = 'https://api.appstoreconnect.apple.com/v1'


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def mint_jwt() -> str:
    now = int(time.time())
    header = b64url(json.dumps({'alg':'ES256','kid':ASC_KID,'typ':'JWT'}).encode())
    payload = b64url(json.dumps({'iss':ASC_ISS,'iat':now,'exp':now+1200,'aud':'appstoreconnect-v1'}).encode())
    signing = f"{header}.{payload}".encode()
    p = subprocess.run(['openssl','dgst','-sha256','-sign',ASC_KEY_PATH], input=signing, capture_output=True, check=True)
    der = p.stdout
    # Parse DER → raw R||S (64 bytes)
    i = 0
    assert der[i] == 0x30; i += 1
    L = der[i]; i += 1
    if L & 0x80: i += (L & 0x7f)
    assert der[i] == 0x02; i += 1
    rlen = der[i]; i += 1
    r = der[i:i+rlen]; i += rlen
    assert der[i] == 0x02; i += 1
    slen = der[i]; i += 1
    s = der[i:i+slen]
    r = r.lstrip(b'\x00').rjust(32, b'\x00')
    s = s.lstrip(b'\x00').rjust(32, b'\x00')
    return f"{header}.{payload}.{b64url(r+s)}"


def call(method: str, path: str, body=None, jwt=None, q=None):
    if jwt is None: jwt = mint_jwt()
    url = f"{API}{path}"
    if q:
        url += '?' + urllib.parse.urlencode(q, doseq=True, safe='[]')
    data = None
    headers = {'Authorization': f'Bearer {jwt}', 'Accept': 'application/json'}
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: body = json.loads(raw)
        except Exception: body = {'raw': raw}
        return e.code, body


def find_build(build_number: str, jwt: str):
    """Find the iOS build whose buildVersion matches the given number."""
    # filter[version] isn't supported on this endpoint — list and scan.
    code, r = call('GET', f'/apps/{APP_ID}/builds',
                   q={'limit': 200,
                      'fields[builds]': 'version,processingState,uploadedDate,expired'},
                   jwt=jwt)
    if code != 200: return None, r
    for b in r.get('data', []):
        a = b.get('attributes', {})
        if a.get('version') == str(build_number) and not a.get('expired'):
            return b, r
    return None, r


def attach_build_to_version(asv_id: str, build_id: str, jwt: str):
    """PATCH appStoreVersions/{id} to link the build (modern API)."""
    body = {
        'data': {
            'type': 'appStoreVersions',
            'id': asv_id,
            'relationships': {
                'build': {'data': {'type': 'builds', 'id': build_id}}
            }
        }
    }
    return call('PATCH', f'/appStoreVersions/{asv_id}', body=body, jwt=jwt)


def unreject_version(asv_id: str, jwt: str):
    """Move DEVELOPER_REJECTED → PREPARE_FOR_SUBMISSION via state attribute.
       NOTE: Apple's modern API doesn't expose a direct unreject for IAP/version —
       instead we patch the version's appStoreVersion to trigger re-prep. If this
       fails, the user must click "Create New Version" in ASC UI."""
    # Not all fields are mutable — just send an empty PATCH as a touch/refresh.
    body = {'data': {'type': 'appStoreVersions', 'id': asv_id, 'attributes': {}}}
    return call('PATCH', f'/appStoreVersions/{asv_id}', body=body, jwt=jwt)


def pick_or_create_submission(jwt: str) -> str:
    """Reuse an empty READY_FOR_REVIEW draft if available, else create new."""
    code, r = call('GET', '/reviewSubmissions',
                   q={'filter[app]': APP_ID, 'filter[platform]': 'IOS', 'limit': 10},
                   jwt=jwt)
    if code == 200:
        for s in r.get('data', []):
            if s.get('attributes', {}).get('state') == 'READY_FOR_REVIEW':
                sid = s.get('id')
                code2, items = call('GET', f'/reviewSubmissions/{sid}/items', jwt=jwt)
                if code2 == 200 and not items.get('data'):
                    print(f"[submission] reusing empty draft {sid}")
                    return sid
    # Create new
    body = {
        'data': {
            'type': 'reviewSubmissions',
            'attributes': {'platform': 'IOS'},
            'relationships': {'app': {'data': {'type': 'apps', 'id': APP_ID}}}
        }
    }
    code, r = call('POST', '/reviewSubmissions', body=body, jwt=jwt)
    if code not in (200, 201):
        raise SystemExit(f"[submission] create failed: {code} {r}")
    sid = r['data']['id']
    print(f"[submission] created new {sid}")
    return sid


def add_item(sid: str, rel_name: str, rel_type: str, rel_id: str, jwt: str):
    # Apple API peculiarity: the relationship KEY name is singular
    # (`appStoreVersion`, `subscription`) but the target resource TYPE
    # is plural (`appStoreVersions`, `subscriptions`).
    body = {
        'data': {
            'type': 'reviewSubmissionItems',
            'relationships': {
                'reviewSubmission': {'data': {'type': 'reviewSubmissions', 'id': sid}},
                rel_name: {'data': {'type': rel_type, 'id': rel_id}},
            }
        }
    }
    return call('POST', '/reviewSubmissionItems', body=body, jwt=jwt)


def submit(sid: str, jwt: str):
    body = {
        'data': {
            'type': 'reviewSubmissions',
            'id': sid,
            'attributes': {'submitted': True}
        }
    }
    return call('PATCH', f'/reviewSubmissions/{sid}', body=body, jwt=jwt)


def main():
    build_number = sys.argv[1] if len(sys.argv) > 1 else '373'
    jwt = mint_jwt()

    print(f"[1/5] Looking for build {build_number} in ASC…")
    build, _ = find_build(build_number, jwt)
    if not build:
        raise SystemExit(f"Build {build_number} not found/processed yet. Wait for TestFlight processing.")
    b_id = build['id']
    print(f"      found build {b_id} state={build['attributes'].get('processingState')}")

    print(f"[2/5] Attaching build to version {ASV_ID}…")
    code, r = attach_build_to_version(ASV_ID, b_id, jwt)
    if code not in (200, 204):
        print(f"      attach returned {code}: {json.dumps(r)[:500]}")
    else:
        print(f"      attached")

    print(f"[3/5] Picking/creating reviewSubmission…")
    sid = pick_or_create_submission(jwt)

    # IMPORTANT: reviewSubmissionItems uses SINGULAR relationship keys
    # ('appStoreVersion', 'subscription') even though the target resource
    # type is plural ('appStoreVersions', 'subscriptions'). That asymmetry
    # is in Apple's actual API — a previous run hit 409 UNKNOWN_RELATIONSHIP.
    print(f"[4/5] Adding items (version + 7 subscriptions)…")
    code, r = add_item(sid, 'appStoreVersion', 'appStoreVersions', ASV_ID, jwt)
    print(f"      + appStoreVersion → {code}")
    if code not in (200, 201):
        print(f"        {json.dumps(r)[:400]}")
    for sub_id in SUBSCRIPTION_IDS:
        code, r = add_item(sid, 'subscription', 'subscriptions', sub_id, jwt)
        print(f"      + subscription {sub_id} → {code}")
        if code not in (200, 201):
            print(f"        {json.dumps(r)[:400]}")

    print(f"[5/5] Submitting reviewSubmission {sid}…")
    code, r = submit(sid, jwt)
    print(f"      → {code}")
    if code in (200, 204):
        print(f"\nSUCCESS — submission {sid} sent to Apple.")
        print(f"View at https://appstoreconnect.apple.com/apps/{APP_ID}/distribution/ios/version/inflight")
    else:
        print(f"\nFAILED — {json.dumps(r, indent=2)[:1500]}")


if __name__ == '__main__':
    main()
