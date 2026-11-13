"""Local clipboard relay for the user's PUBG site. Images remain in RAM."""
import ctypes
import base64
import hashlib
import struct
import socket
import time
import io
import posixpath
import urllib.error
import urllib.request
import threading
import tkinter as tk
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit, unquote
from PIL import Image, ImageGrab

SITE = 'https://95.174.95.143'
PORT = 18741
LOCAL_ORIGIN = f'http://127.0.0.1:{PORT}'
MAX_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 20_000_000
state = {'version': '', 'image': None}
lock = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *_args):
        pass

    def allowed(self):
        return self.headers.get('Origin') == LOCAL_ORIGIN and self.headers.get('Host') == f'127.0.0.1:{PORT}'

    def headers_for_browser(self):
        self.send_header('Access-Control-Allow-Origin', LOCAL_ORIGIN)
        self.send_header('Access-Control-Expose-Headers', 'X-Clipboard-Version')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Vary', 'Origin')

    def do_OPTIONS(self):
        if not self.allowed():
            self.send_error(403); return
        self.send_response(204)
        self.headers_for_browser()
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()

    def websocket(self):
        key = self.headers.get('Sec-WebSocket-Key', '')
        try:
            if len(base64.b64decode(key, validate=True)) != 16:
                self.send_error(400); return
        except ValueError:
            self.send_error(400); return
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101, 'Switching Protocols')
        self.send_header('Upgrade', 'websocket'); self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept); self.end_headers()
        self.close_connection = True
        self.connection.settimeout(0.5)
        last = ''
        try:
            while True:
                with lock:
                    version, data = state['version'], state['image']
                if data and version != last:
                    size = len(data)
                    header = bytes([0x82, 127]) + struct.pack('!Q', size) if size > 65535 else bytes([0x82, 126]) + struct.pack('!H', size) if size >= 126 else bytes([0x82, size])
                    self.connection.sendall(header + data); last = version
                try:
                    msg = self.connection.recv(2)
                    if not msg or (msg[0] & 15) == 8:
                        break
                except socket.timeout:
                    pass
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def proxy(self):
        if self.headers.get('Host') != f'127.0.0.1:{PORT}':
            self.send_error(403); return
        parsed = urlsplit(self.path)
        decoded = unquote(parsed.path)
        normalized = posixpath.normpath(decoded)
        if not normalized.startswith('/pubg/') and normalized != '/pubg':
            self.send_error(404); return
        if '\\' in decoded or '/..' in decoded:
            self.send_error(400); return
        if self.command == 'POST' and self.headers.get('Origin') != LOCAL_ORIGIN:
            self.send_error(403); return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > MAX_BYTES:
                self.send_error(413); return
            body = self.rfile.read(length) if self.command == 'POST' else None
            url = SITE + parsed.path + (('?' + parsed.query) if parsed.query else '')
            headers = {'User-Agent':'PUBG-Clipboard/1.0'}
            if body is not None:
                headers['Content-Type'] = self.headers.get('Content-Type', 'application/octet-stream')
            request = urllib.request.Request(url, data=body, headers=headers, method=self.command)
            try:
                upstream = urllib.request.urlopen(request, timeout=120)
            except urllib.error.HTTPError as error:
                upstream = error
            with upstream:
                content = upstream.read(128 * 1024 * 1024 + 1)
                if len(content) > 128 * 1024 * 1024:
                    self.send_error(502); return
                self.send_response(upstream.status)
                self.send_header('Content-Type', upstream.headers.get('Content-Type', 'application/octet-stream'))
                self.send_header('Content-Length', str(len(content)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('X-Frame-Options', 'DENY')
                self.end_headers()
                self.wfile.write(content)
        except (OSError, ValueError, urllib.error.URLError):
            try:
                self.send_error(502, 'PUBG server unavailable')
            except OSError:
                pass

    def do_POST(self):
        self.proxy()

    def do_GET(self):
        path = urlsplit(self.path)
        if path.path.startswith('/pubg'):
            self.proxy(); return
        if not self.allowed() or path.path not in ('/latest', '/events'):
            self.send_error(403); return
        if path.path == '/events':
            if self.headers.get('Upgrade', '').lower() != 'websocket':
                self.send_error(400); return
            self.websocket(); return
        after = parse_qs(path.query).get('after', [''])[0]
        with lock:
            version, image = state['version'], state['image']
        if not image or after == version:
            self.send_response(204); self.headers_for_browser(); self.end_headers(); return
        self.send_response(200)
        self.headers_for_browser()
        self.send_header('Content-Type', 'image/png')
        self.send_header('X-Clipboard-Version', version)
        self.send_header('Content-Length', str(len(image)))
        self.end_headers()
        try:
            self.wfile.write(image)
        except (BrokenPipeError, ConnectionResetError):
            pass

class App:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title('PUBG — автозагрузка скриншотов')
        self.root.geometry('520x240')
        self.root.resizable(True, False)
        self.status = tk.StringVar(value='Ожидаю новый скриншот в буфере обмена.')
        tk.Label(self.root, text='Автозагрузка скриншотов PUBG', font=('Segoe UI', 14, 'bold')).pack(pady=(15, 6))
        tk.Label(self.root, text='Откройте калькулятор кнопкой ниже и скопируйте карту в буфер обмена.', wraplength=480, font=('Segoe UI', 10)).pack(pady=4)
        tk.Label(self.root, textvariable=self.status, wraplength=480, fg='#166b57', font=('Segoe UI', 10)).pack(pady=9)
        buttons = tk.Frame(self.root); buttons.pack(pady=6)
        tk.Button(buttons, text='Открыть калькулятор', command=lambda: webbrowser.open(LOCAL_ORIGIN + '/pubg/#mortar')).pack(side='left', padx=6)
        tk.Button(buttons, text='Завершить', command=self.close).pack(side='left', padx=6)
        tk.Label(self.root, text='Изображение хранится только в памяти до следующего изменения буфера.', font=('Segoe UI', 9)).pack(pady=4)
        self.root.protocol('WM_DELETE_WINDOW', self.close)
        self.previous = ctypes.windll.user32.GetClipboardSequenceNumber()
        self.root.after(500, self.poll)

    def poll(self):
        sequence = ctypes.windll.user32.GetClipboardSequenceNumber()
        if sequence != self.previous:
            self.previous = sequence
            with lock:
                state.update(version='', image=None)
            try:
                image = ImageGrab.grabclipboard()
                if isinstance(image, Image.Image):
                    if image.width * image.height > MAX_PIXELS:
                        self.status.set('Изображение слишком большое: максимум 20 мегапикселей.')
                    else:
                        buffer = io.BytesIO(); image.save(buffer, format='PNG')
                        data = buffer.getvalue()
                        if len(data) > MAX_BYTES:
                            self.status.set('Скриншот превышает 12 МБ. Уменьшите изображение.')
                        else:
                            with lock:
                                state.update(version=str(sequence), image=data)
                            self.status.set('Новый скриншот готов к автоматической загрузке.')
                else:
                    self.status.set('Ожидаю новый скриншот в буфере обмена.')
            except (OSError, ValueError):
                self.status.set('Не удалось прочитать буфер. Попробуйте скопировать скриншот ещё раз.')
        self.root.after(500, self.poll)

    def close(self):
        with lock:
            state.update(version='', image=None)
        self.root.destroy()

if __name__ == '__main__':
    try:
        server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    except OSError:
        from tkinter import messagebox
        root = tk.Tk(); root.withdraw()
        messagebox.showerror('PUBG Clipboard', 'Не удалось открыть локальный порт. Возможно, программа уже запущена.')
        root.destroy()
    else:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            App().root.mainloop()
        finally:
            server.shutdown(); server.server_close()
