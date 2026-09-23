#!/usr/bin/env python3
"""End-to-end check: the BUILT-IN OAuth client id lights the button for real.

Runs `tagent auth --web` with a clean HOME (no stored credentials → no
short-circuit), then against the live loopback page checks:
  1. the page renders the "Connect with GitHub" CTA
  2. the PAT form starts hidden (OAuth is the default path)
  3. GET oauth/authorize → 302 to github.com/login/device?user_code=<REAL code>
  4. that GitHub URL actually responds 200
  5. GET oauth/poll → {"status":"pending","user_code":<same code>}
"""
import os, re, signal, subprocess, sys, time, urllib.request, urllib.error, json

REPO = "/home/z/my-project"
HOME = "/tmp/tagent-e2e-home"
os.makedirs(HOME, exist_ok=True)
for f in os.listdir(HOME):
    os.remove(os.path.join(HOME, f)) if os.path.isfile(os.path.join(HOME, f)) else None

env = {**os.environ, "HOME": HOME, "TAGENT_GH_CLIENT_ID": ""}
env.pop("TAGENT_GH_CLIENT_ID", None)

proc = subprocess.Popen(
    ["bun", "packages/cli/src/index.ts", "auth", "--web"],
    cwd=REPO, env=env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
)

url = None
deadline = time.time() + 60
while time.time() < deadline:
    line = proc.stdout.readline()
    if not line:
        break
    print(f"[cli] {line.rstrip()}")
    m = re.search(r"(http://127\.0\.0\.1:\d+/[A-Za-z0-9_-]+/)", line)
    if m:
        url = m.group(1)
        break

if not url:
    proc.kill()
    sys.exit("FAIL: the login URL never appeared")

print(f"\npage: {url}\n")
fails = []

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

noredir = urllib.request.build_opener(NoRedirect)

def get(u, **kw):
    return urllib.request.urlopen(u, timeout=20, **kw)

# 1 + 2: the page
page = get(url).read().decode()
("Connect with GitHub" in page) or fails.append("1: no Connect with GitHub CTA on the page")
('id="form" class="hidden"' in page) or fails.append("2: PAT form not hidden (OAuth should be the default)")

# 3: authorize → 302 to GitHub with a real user_code
req = urllib.request.Request(url + "oauth/authorize", method="GET")
try:
    resp = noredir.open(req, timeout=30)
    loc, code_http = resp.headers.get("Location", ""), resp.status
except urllib.error.HTTPError as e:
    loc, code_http = e.headers.get("Location", ""), e.code
print(f"authorize → HTTP {code_http}: {loc}")
if code_http != 302:
    fails.append(f"3: authorize returned HTTP {code_http}, not 302")
else:
    m = re.match(r"https://github\.com/login/device\?user_code=([A-Z0-9]{4}-[A-Z0-9]{4})$", loc)
    if not m:
        fails.append(f"3: unexpected redirect target: {loc}")
    else:
        code = m.group(1)
        # 4: the GitHub side answers
        gh = get(loc)
        gh.status == 200 or fails.append(f"4: GitHub answered {gh.status}")
        print(f"github: HTTP {gh.status}")
        # 5: poll → pending with the same code
        poll = json.loads(get(url + "oauth/poll").read().decode())
        print(f"poll: {poll}")
        (poll.get("status") == "pending") or fails.append("5: poll not pending")
        (poll.get("user_code") == code) or fails.append(f"5: poll code {poll.get('user_code')} != {code}")

proc.send_signal(signal.SIGINT)
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()

print()
if fails:
    print("FAIL:"); [print(f"  ✗ {f}") for f in fails]
    sys.exit(1)
print("PASS: built-in OAuth button renders, authorize → GitHub (real user_code), poll pending")
