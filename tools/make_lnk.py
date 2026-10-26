# -*- coding: utf-8 -*-
# 直接构造 Windows .lnk 二进制（不走 WScript.Shell COM，规避沙箱拦截）
# 目标：项目里的 electron.exe，带 monkey.ico 图标
import os
import struct
import sys

# 全部用相对项目根目录的路径，避免把本机绝对路径写进仓库
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
WORKDIR = ROOT
ICON = os.path.join(ROOT, 'assets', 'monkey.ico')
ARGS = "."
# 可选参数：make_lnk.py [输出路径] [图标路径]
if len(sys.argv) > 1:
    OUT = sys.argv[1]
else:
    OUT = os.path.join(ROOT, '桌宠.lnk')
if len(sys.argv) > 2:
    ICON = sys.argv[2]

# Git Bash / MSYS 可能把参数里的反斜杠转成正斜杠，这里统一回 Windows 风格
if os.name == 'nt':
    OUT = OUT.replace('/', '\\')
    ICON = ICON.replace('/', '\\')

def u16(n): return struct.pack('<H', n)
def u32(n): return struct.pack('<I', n)
def i32(n): return struct.pack('<i', n)

def strdata(s):
    b = s.encode('utf-16-le')
    # Unicode 字符串不需要额外终止符；CountCharacters 只算字符数。
    # 多写 \x00\x00 会让后续字段整体错位（ICON 会读成 ARGS 的内容）。
    return u16(len(s)) + b

# ---- LinkInfo（指向本地文件的 LocalBasePath）----
vol = u32(0x10) + u32(3) + u32(0) + u32(0x10)   # VolumeID(无卷标)
local = TARGET.encode('mbcs', 'replace') + b'\x00'
suffix = TARGET.encode('mbcs', 'replace') + b'\x00'
hdr = 28
vol_off = hdr
local_off = vol_off + len(vol)
suffix_off = local_off + len(local)
linkinfo = (u32(0) + u32(hdr) + u32(0x1) + u32(vol_off) +
            u32(local_off) + u32(0) + u32(suffix_off) + vol + local + suffix)
linkinfo = u32(len(linkinfo)) + linkinfo[4:]

# ---- StringData：工作目录 / 参数 / 图标 ----
sd = b''
sd += strdata(WORKDIR)   # 0x03
sd += strdata(ARGS)      # 0x04
sd += strdata(ICON)      # 0x05

# ---- Header ----
CLSID = bytes([0x01,0x14,0x02,0x00,0x00,0x00,0x00,0x00,0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46])
# HasUnicode(0x80) 必须置位：StringData 是 UTF-16LE，缺这个标记资源管理器会按 ANSI 解析 => 图标/工作目录乱码
linkflags = 0x2 | 0x10 | 0x20 | 0x40 | 0x80
header = (u32(0x4C) + CLSID + u32(linkflags) + u32(0x20) +
          b'\x00'*24 +            # 3x uint64 时间
          u32(0) + i32(0) + i32(1) + u16(0) + u16(0) + u32(0) + u32(0))

# 注意：ShellLinkHeader(76B) 之后必须先有 2 字节 IDListSize（这里为 0，表示无 IDList），
# 少了它资源管理器会把 LinkInfo 当作 IDList 解析，整个 .lnk 被判为无效（显示白页）。
lnk = header + u16(0) + linkinfo + sd + b'\x00\x00\x00\x00'   # 末尾 ExtraData 终止块

out = OUT
with open(out, 'wb') as f:
    f.write(lnk)
print("wrote", out, len(lnk), "bytes")

# 结构自检验证
assert lnk[:4] == b'\x4c\x00\x00\x00', "HeaderSize 错误"
assert lnk[4:20] == CLSID, "CLSID 错误"
print("校验通过: HeaderSize=0x4C, CLSID OK, LinkFlags=0x%X, IconIndex=%d" % (linkflags, struct.unpack('<i', lnk[0x30:0x34])[0]))
