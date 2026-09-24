#!/usr/bin/env python3
"""drive `tagent auth` inside a pty: the picker appears, Enter picks Web
connect (first item), the one-time URL prints; the parent then plays the
browser: fetches the page and POSTs a token, expecting ok:false (the fake
parent has no valid GitHub token) with the server still alive."""
import os, pty, re, sys, time, json, tempfile, urllib.request, select as sel

REPO = '/home/z/my-project'
HOME = tempfile.mkdtemp(prefix='tagent-webauth-pty-')
WS = tempfile.mkdtemp(prefix='tagent-webauth-ws-')

pid, fd = pty.fork()
if pid == 0:
    os.chdir(WS)
    os.environ['HOME'] = HOME
    os.environ['TERM'] = 'xterm-256color'
    os.execvp('bun', ['bun', f'{REPO}/packages/cli/src/index.ts', 'auth'])

os.set_blocking(fd, False)
out = b''
start = time.time()
sent_enter = False
url = None
posted = False
post_result = None
deadline = start + 40
while time.time() < deadline:
    r, _, _ = sel.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            out += chunk
        except OSError:
            break
    text = out.decode('utf8', 'replace')

    # 1) picker rendered → press Enter (first item = Web connect)
    if not sent_enter and 'pick a method' in text and time.time() - start > 1.0:
        os.write(fd, b'\r')
        sent_enter = True

    # 2) URL printed → play the browser: GET page, POST a bogus token
    m = re.search(r'(http://127\.0\.0\.1:\d+/[A-Za-z0-9_-]+/)', text)
    if m and not posted:
        url = m.group(1)
        posted = True
        parts = url.split('/')
        origin = f'{parts[0]}//{parts[2]}'  # scheme + host + port — the path is NOT part of Origin
        try:
            page = urllib.request.urlopen(url, timeout=5)
            page_ok = page.status == 200 and b'Connect GitHub' in page.read()
            req = urllib.request.Request(
                url + 'submit',
                data=json.dumps({'token': 'definitely-not-a-real-token'}).encode(),
                headers={'content-type': 'application/json', 'origin': origin},
                method='POST')
            resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
            post_result = (page_ok, resp)
        except Exception as e:
            post_result = ('ERR', repr(e))
        # done — kill the CLI (no real token to finish the login with)
        time.sleep(0.5)
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        break

text = out.decode('utf8', 'replace')

checks = {
    'picker shown (pick a method)': 'pick a method' in text,
    'Web connect first item': 'Web connect' in text,
    'web connect banner': 'GitHub login' in text and 'web connect' in text.lower(),
    'one-time URL printed': url is not None,
}
if isinstance(post_result, tuple) and len(post_result) == 2 and post_result[0] is True:
    checks['page GET 200 + Connect GitHub'] = True
    body = post_result[1]
    checks['POST bogus token → ok:false + reason'] = (
        isinstance(body, dict) and body.get('ok') is False and bool(body.get('error')))
else:
    checks['page GET 200 + Connect GitHub'] = False
    checks['POST bogus token → ok:false + reason'] = False
    print('post_result:', post_result)

fails = 0
for k, v in checks.items():
    print(('✓' if v else '✗'), k)
    fails += 0 if v else 1
print('URL:', url)
sys.exit(1 if fails else 0)
