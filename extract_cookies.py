import sqlite3
import subprocess
import os
import hashlib

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.backends import default_backend
    HAS_CRYPTO = True
except ImportError as e:
    print(f"Import error: {e}")
    HAS_CRYPTO = False

def decrypt_cookie(encrypted_value, password):
    if len(encrypted_value) < 3:
        return None
    version = encrypted_value[:3]
    if version != b'v10' and version != b'v11':
        return None

    salt = b'saltysalt'
    iterations = 1  # Chrome 127+ on macOS uses 1 iteration
    key_length = 16

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA1(),
        length=key_length,
        salt=salt,
        iterations=iterations,
        backend=default_backend()
    )
    key = kdf.derive(password)

    iv = b' ' * 16
    ciphertext = encrypted_value[3:]

    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    plaintext = decryptor.update(ciphertext) + decryptor.finalize()

    pad_len = plaintext[-1]
    if pad_len > 0 and pad_len <= 16:
        plaintext = plaintext[:-pad_len]

    return plaintext.decode('utf-8', errors='replace')

def main():
    if not HAS_CRYPTO:
        print("cryptography package not available, installing...")
        subprocess.run(['pip3', 'install', 'cryptography'], capture_output=True)
        print("Please run the script again")
        return

    # Get Chrome encryption key
    result = subprocess.run(['security', 'find-generic-password', '-wa', 'Chrome'], capture_output=True, text=True)
    password = result.stdout.strip().encode('utf-8')

    cookie_db = os.path.expanduser('~/Library/Application Support/Google/Chrome/Default/Cookies')
    conn = sqlite3.connect(cookie_db)

    rows = conn.execute(
        "SELECT host_key, name, encrypted_value FROM cookies "
        "WHERE host_key IN ('ones.sankuai.com', '.ones.sankuai.com', '.sankuai.com', 'ssosv.sankuai.com', '.mws.sankuai.com')"
    ).fetchall()

    ones_cookies = []
    for host, name, encrypted_value in rows:
        decrypted = decrypt_cookie(encrypted_value, password)
        if decrypted:
            print(f"  {host}: {name} = {decrypted[:60]}{'...' if len(decrypted) > 60 else ''}")
            ones_cookies.append(f"{name}={decrypted}")

    cookie_str = '; '.join(ones_cookies)

    target_dir = os.path.expanduser('~/shenxiaolong.claude-learning')
    cookie_file = os.path.join(target_dir, '.ones-cookie')
    with open(cookie_file, 'w') as f:
        f.write(cookie_str)

    print(f"\nSaved {len(ones_cookies)} cookies to {cookie_file}")
    print(f"First 200 chars: {cookie_str[:200]}...")

    conn.close()

if __name__ == '__main__':
    main()
