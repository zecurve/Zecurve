import hashlib, os

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
path = os.path.expanduser("~/workspaces/Zecurve/seller.wif") if False else "seller.wif"

s = open(path).read().strip()
print("Length:", len(s))
print("First char:", s[0] if s else "(empty)")

num = 0
ok = True
for c in s:
    if c not in ALPHABET:
        print("INVALID - bad character:", repr(c))
        ok = False
        break
    num = num * 58 + ALPHABET.index(c)

if ok:
    b = num.to_bytes((num.bit_length() + 7) // 8, 'big')
    b = b'\x00' * (len(s) - len(s.lstrip('1'))) + b
    data, chk = b[:-4], b[-4:]
    h = hashlib.sha256(hashlib.sha256(data).digest()).digest()
    print("VALID" if h[:4] == chk else "INVALID - checksum mismatch, re-export needed")
