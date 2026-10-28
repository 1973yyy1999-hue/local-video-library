"""Rasterize the simple geometric brand mark from src/icon.svg for Windows resources.
Uses only Python's standard library. Run when the SVG geometry changes.
"""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

def png(size):
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            colors = []
            for sy in range(4):
                for sx in range(4):
                    x = (px + (sx + .5) / 4) * 128 / size
                    y = (py + (sy + .5) / 4) * 128 / size
                    cx, cy = min(94, max(34, x)), min(94, max(34, y))
                    if (x - cx) ** 2 + (y - cy) ** 2 > 900:
                        continue
                    if x >= 49 and x <= 93 and abs(y - 64) <= 30 * (93 - x) / 44:
                        colors.append((255, 255, 255))
                    else:
                        t = max(0, min(1, (x + y - 8) / 240))
                        colors.append(tuple(round(a + (b - a) * t) for a, b in zip((96,123,244),(159,144,237))))
            rows.extend([round(sum(c[i] for c in colors) / len(colors)) if colors else 0 for i in range(3)])
            rows.append(round(len(colors) / 16 * 255))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size,size,8,6,0,0,0)) + chunk(b'IDAT', zlib.compress(bytes(rows))) + chunk(b'IEND', b'')

sizes = [16,32,48,64,128,256]
images = [png(size) for size in sizes]
offset = 6 + 16 * len(sizes)
entries = bytearray()
for size, image in zip(sizes, images):
    entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(image), offset)
    offset += len(image)
(ROOT / 'build/icon.ico').write_bytes(struct.pack('<HHH', 0,1,len(sizes)) + entries + b''.join(images))
(ROOT / 'src/icon.png').write_bytes(images[-1])
