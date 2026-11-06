import base64, http.server, json, os, pathlib, signal, socket, subprocess, threading, time
import pyatspi

version = os.environ.get('LCD_EXPECTED_VERSION', '1.1.0')
root = pathlib.Path(os.environ['LCD_RELEASE_TEST_DIR'])
root.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, DISPLAY=':95', XDG_CURRENT_DESKTOP='X-Cinnamon', GTK_MODULES='atk-bridge', NO_AT_BRIDGE='0')
os.environ.update(env)
processes = []
handles = []

def run(args):
    return subprocess.run(args, env=env, check=True, text=True, capture_output=True).stdout.strip()

def spawn(args, label):
    log = open(root / (label + '.log'), 'w')
    handles.append(log)
    p = subprocess.Popen(args, env=env, stdout=log, stderr=log, start_new_session=True)
    processes.append(p)
    return p

def until(fn, timeout=35):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            result = fn()
            if result:
                return result
        except Exception:
            pass
        time.sleep(.25)
    raise AssertionError('Timed out: ' + str(fn))

def tree():
    stack = [pyatspi.Registry.getDesktop(0)]
    result = []
    while stack:
        obj = stack.pop()
        result.append(obj)
        try:
            stack.extend(obj[i] for i in range(obj.childCount))
        except Exception:
            pass
    return result

def find(text):
    objects = tree()
    named = [a for a in objects if text in (a.name or '')]
    if named:
        return min(named, key=lambda a: len(a.name or ''))
    candidates = []
    for a in objects:
        try:
            content = a.queryText().getText(0, -1)
            if text in content:
                candidates.append((len(content), a))
        except Exception:
            pass
    return min(candidates, key=lambda item: item[0])[1] if candidates else None

def click(obj):
    try:
        action = obj.queryAction()
        if action.nActions:
            if action.doAction(0):
                return
    except NotImplementedError:
        pass
    rect = obj.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    assert rect.width > 0 and rect.height > 0
    run(['xdotool', 'mousemove', '--sync', str(rect.x + rect.width//2), str(rect.y + rect.height//2), 'click', '1'])

password = 'release-smoke-local-only'
method = 'aes-128-gcm'
ss_socket = socket.socket()
ss_socket.bind(('127.0.0.1', 0))
ss_port = ss_socket.getsockname()[1]
ss_socket.close()
userinfo = base64.urlsafe_b64encode(f'{method}:{password}'.encode()).decode().rstrip('=')
subscription = base64.b64encode(f'ss://{userinfo}@127.0.0.1:{ss_port}#Release-{version}-Test'.encode())
body = f'LCD Proxy release {version} end-to-end OK'.encode()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data = subscription if self.path == '/subscription' else body
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass

# The client always connects private addresses directly, so forwarding has to be
# proven with a public address (TEST-NET-2, bound to loopback for this test only).
probe_host = '198.51.100.1'
subprocess.run(['sudo', 'ip', 'addr', 'add', f'{probe_host}/32', 'dev', 'lo'], check=True)
server = http.server.ThreadingHTTPServer(('0.0.0.0', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
http_port = server.server_port
config = {'log': {'level': 'info'}, 'inbounds': [{'type': 'shadowsocks', 'listen': '127.0.0.1', 'listen_port': ss_port, 'method': method, 'password': password}], 'outbounds': [{'type': 'direct'}]}
(root/'upstream.json').write_text(json.dumps(config))
data_dir = pathlib.Path(env['XDG_DATA_HOME'])/'com.lcdproxy.app'

def stored(name):
    return json.loads((data_dir/name).read_text())

def mode():
    return run(['gsettings', 'get', 'org.gnome.system.proxy', 'mode'])

try:
    spawn(['Xvfb', ':95', '-screen', '0', '1024x1000x24', '-nolisten', 'tcp'], 'display')
    until(lambda: pathlib.Path('/tmp/.X11-unix/X95').exists())
    spawn(['openbox'], 'window-manager')
    run(['gsettings', 'set', 'org.gnome.desktop.interface', 'toolkit-accessibility', 'true'])
    run(['gsettings', 'set', 'org.gnome.system.proxy', 'mode', 'auto'])
    assert mode() == "'auto'"
    upstream = spawn(['/usr/bin/lcd-proxy-core', 'run', '-c', str(root/'upstream.json')], 'upstream')
    app_command = [env['LCD_APPIMAGE_PATH'], '--appimage-extract-and-run'] if env.get('LCD_APPIMAGE_PATH') else ['/usr/bin/lcd-proxy']
    app = spawn(app_command, 'client')
    time.sleep(5)
    (root/'accessibility.txt').write_text('\n'.join(a.getRoleName() + ': ' + (a.name or '') for a in tree()))
    click(until(lambda: find('设置页')))
    until(lambda: find(version))
    print(f'PASS: installed GUI reports version {version}', flush=True)
    click(until(lambda: find('订阅页')))
    click(until(lambda: find('订阅链接')))
    run(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'])
    run(['xdotool', 'type', '--clearmodifiers', f'http://127.0.0.1:{http_port}/subscription'])
    run(['xdotool', 'key', '--clearmodifiers', 'Return'])
    until(lambda: any(p['nodeCount'] == 1 for p in stored('profiles.json')['profiles']))
    click(until(lambda: find('节点页')))
    click(until(lambda: find(f'Release-{version}-Test')))
    until(lambda: bool(stored('settings.json').get('selected')))
    print('PASS: real HTTP subscription import and node persistence', flush=True)
    click(until(lambda: find('连接页')))
    click(until(lambda: find('连接代理')))
    until(lambda: mode() == "'manual'")
    for proxy in ['http://127.0.0.1:10808', 'socks5h://127.0.0.1:10808']:
        response = run(['curl', '--fail', '--silent', '--show-error', '--max-time', '15', '--noproxy', '', '--proxy', proxy, f'http://{probe_host}:{http_port}/probe'])
        assert response == body.decode(), response
    upstream_log = (root/'upstream.log').read_text()
    assert 'shadowsocks' in upstream_log and str(http_port) in upstream_log
    print('PASS: actual HTTP/SOCKS5 forwarding via Shadowsocks upstream', flush=True)
    import gi
    gi.require_version('Gdk', '3.0')
    from gi.repository import Gdk
    screen = Gdk.get_default_root_window()
    screenshot = Gdk.pixbuf_get_from_window(screen, 0, 0, screen.get_width(), screen.get_height())
    screenshot.savev(str(root/'desktop-connected.png'), 'png', [], [])
    click(until(lambda: find('断开代理')))
    until(lambda: mode() == "'auto'")
    assert upstream.poll() is None
    print('PASS: stop restores original proxy and preserves unrelated core', flush=True)
    os.killpg(app.pid, signal.SIGTERM)
    assert app.wait(timeout=12) in (0, -signal.SIGTERM)
    assert mode() == "'auto'"
    print('PASS: installed client exits cleanly', flush=True)
finally:
    server.shutdown()
    subprocess.run(['sudo', 'ip', 'addr', 'del', f'{probe_host}/32', 'dev', 'lo'], check=False)
    for p in reversed(processes):
        if p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
                p.wait(timeout=8)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
    for handle in handles:
        handle.close()
