"""Crop trailing uniform-background rows/columns off a Chrome screenshot.

Pure stdlib PNG decode/encode so there is no dependency to install. Chrome
writes 8-bit RGBA, filter method 0, non-interlaced, which is the only shape
this handles — it asserts rather than guessing.
"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    pos, idat, hdr = 8, [], None
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            hdr = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT':
            idat.append(body)
        pos += 12 + ln
    w, h, depth, color, comp, filt, inter = hdr
    assert depth == 8 and inter == 0 and color in (2, 6), f'unsupported PNG {hdr}'
    bpp = 3 if color == 2 else 4
    raw = zlib.decompress(b''.join(idat))
    stride = w * bpp
    out, prev = bytearray(), bytearray(stride)
    p = 0
    for _ in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out += line
        prev = line
    return w, h, bytes(out), bpp


def write_png(path, w, h, px, bpp):
    raw = b''.join(b'\x00' + px[y * w * bpp:(y + 1) * w * bpp] for y in range(h))
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6 if bpp == 4 else 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)


def autocrop(path, pad=0):
    w, h, px, bpp = read_png(path)
    # Trailing background is whatever the bottom-right pixel is.
    bg = px[(h - 1) * w * bpp:(h - 1) * w * bpp + bpp]
    last = 0
    for y in range(h - 1, -1, -1):
        row = px[y * w * bpp:(y + 1) * w * bpp]
        if any(row[x:x + bpp] != bg for x in range(0, len(row), bpp)):
            last = y
            break
    new_h = min(h, last + 1 + pad)
    write_png(path, w, new_h, px[:new_h * w * bpp], bpp)
    return h, new_h


if __name__ == '__main__':
    for f in sys.argv[1:]:
        was, now = autocrop(f, pad=0)
        print(f'{f}: {was} -> {now}')
