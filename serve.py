#!/usr/bin/env python3
"""Static file server with HTTP Range support (needed for <video> playback)."""
import os, sys, re
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        rng = self.headers.get('Range')
        if not rng:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
        if not m:
            return super().send_head()

        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        start, end = m.group(1), m.group(2)
        if start == '':                      # suffix range: last N bytes
            start = max(0, size - int(end)); end = size - 1
        else:
            start = int(start)
            end = int(end) if end else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.end_headers(); f.close(); return None

        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        f.seek(start)
        self.remaining = end - start + 1
        return _Limited(f, self.remaining)

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

class _Limited:
    def __init__(self, f, n): self.f, self.n = f, n
    def read(self, amt=-1):
        if self.n <= 0: return b''
        if amt < 0 or amt > self.n: amt = self.n
        data = self.f.read(amt); self.n -= len(data); return data
    def close(self): self.f.close()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    root = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).resolve().parent)
    os.chdir(root)
    print(f'Serving {root} at http://127.0.0.1:{port}/ (Range enabled)', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), RangeHandler).serve_forever()
