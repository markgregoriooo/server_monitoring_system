# Reverse-engineering helper for the UNKNOWN 64-bit AC protocol.
# Uses the already-decoded LSB-first bytes from the 10 captures.

frames = {
"POWER_ON":  [0x14,0x11,0xB2,0x03,0x00,0x81,0xE0,0x10],
"POWER_OFF": [0x14,0x11,0xB2,0x93,0x1D,0x83,0xE0,0x10],
"TEMP_DOWN": [0x14,0xE1,0xB2,0x95,0x2D,0x8C,0xE0,0x10],
"TEMP_UP":   [0x14,0x11,0xB2,0x95,0x2D,0x84,0xE0,0x10],
"MODE_FAN":  [0x14,0xE2,0xB2,0x92,0x15,0x85,0xE0,0x10],
"MODE_DRY":  [0x14,0xC2,0xB2,0x94,0x25,0x82,0xE0,0x10],
"MODE_COOL": [0x14,0xC2,0xB2,0x90,0x05,0x85,0xE0,0x10],
"TURBO":     [0x14,0x62,0x32,0x97,0x39,0x8F,0xE0,0x10],
"FAN_LVL1":  [0x14,0x62,0x32,0x93,0x19,0x8A,0xE0,0x10],
"FAN_LVL2":  [0x14,0x66,0x32,0x95,0x29,0x89,0x80,0x70],  # footer anomaly -> suspect
}

def nibs(byte): return [(byte >> 4) & 0xF, byte & 0xF]

def low_nib(b): return b & 0xF

# Treat FAN_LVL2 as suspect; crack against the other 9.
good = {k:v for k,v in frames.items() if k != "FAN_LVL2"}

print("=== which byte positions are CONSTANT across the 9 good frames? ===")
for i in range(8):
    vals = {v[i] for v in good.values()}
    tag = "CONST" if len(vals)==1 else "varies"
    print(f"  byte[{i}]: {tag:6s} {{{' '.join(f'{x:02X}' for x in sorted(vals))}}}")

print("\n=== checksum search: does byte[c] == f(other bytes) for ALL 9 frames? ===")
def test_algo(c, fn):
    return all(fn(v) == v[c] for v in good.values())

def test_algo_lownib(c, fn):
    return all((fn(v) & 0xF) == low_nib(v[c]) for v in good.values())

ranges = {
    "all-except-c": lambda v,c: [v[i] for i in range(8) if i!=c],
    "bytes[0..c)":  lambda v,c: v[:c],
    "bytes(c..7]":  lambda v,c: v[c+1:],
    "vary[1..4]":   lambda v,c: [v[1],v[2],v[3],v[4]],
    "payload[3,4]": lambda v,c: [v[3],v[4]],
    "payload[1..5x]": lambda v,c: [v[1],v[2],v[3],v[4]],
}

algos = {
    "sum&FF":        lambda data: sum(data) & 0xFF,
    "(-sum)&FF":     lambda data: (-sum(data)) & 0xFF,
    "xor":           lambda data: __import__("functools").reduce(lambda a,b:a^b, data, 0),
    "sumNib&FF":     lambda data: sum(n for b in data for n in nibs(b)) & 0xFF,
    "sumNib&0F":     lambda data: sum(n for b in data for n in nibs(b)) & 0x0F,
    "xorNib":        lambda data: __import__("functools").reduce(lambda a,b:a^b,[n for b in data for n in nibs(b)],0),
    "sum&FF+const":  None,  # handled below
}

found = False
for c in range(8):
    for rname, rfn in ranges.items():
        for aname, afn in algos.items():
            if afn is None: continue
            # full-byte match
            try:
                if all(afn(rfn(v,c)) == v[c] for v in good.values()):
                    print(f"  FULL  byte[{c}] == {aname}({rname})"); found=True
            except Exception: pass
            # low-nibble match
            try:
                if all((afn(rfn(v,c)) & 0xF) == low_nib(v[c]) for v in good.values()):
                    print(f"  NIBBLE byte[{c}].low == {aname}({rname}).low"); found=True
            except Exception: pass

# try sum + constant offset (full byte), checksum at byte 5
for c in range(8):
    for rname, rfn in ranges.items():
        try:
            offs = {(v[c] - (sum(rfn(v,c)) & 0xFF)) & 0xFF for v in good.values()}
            if len(offs)==1:
                print(f"  FULL  byte[{c}] == sum({rname}) + 0x{list(offs)[0]:02X}"); found=True
            offs2 = {(v[c] - (sum(n for b in rfn(v,c) for n in nibs(b)) & 0xFF)) & 0xFF for v in good.values()}
            if len(offs2)==1:
                print(f"  FULL  byte[{c}] == sumNib({rname}) + 0x{list(offs2)[0]:02X}"); found=True
        except Exception: pass

if not found:
    print("  (no trivial single-scheme match across all 9 — likely needs the temp sweep)")

print("\n=== field guess: align varying bytes (high nibble | low nibble) ===")
hdr = f"{'name':10s} b1hi b1lo | b2 | b3hi b3lo | b4hi b4lo | b5(cksum)"
print(hdr)
for k,v in frames.items():
    print(f"{k:10s}  {(v[1]>>4):X}    {(v[1]&0xF):X}  | {v[2]:02X} | {(v[3]>>4):X}    {(v[3]&0xF):X}  | {(v[4]>>4):X}    {(v[4]&0xF):X}  | {v[5]:02X}")
