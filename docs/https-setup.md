# HTTPS Setup for Passkey Authentication

WebAuthn (passkeys) requires a "secure context". While `localhost` is special-cased and works with HTTP, accessing Eve Workspace from other devices on your LAN requires HTTPS.

## Quick Start

```bash
# Install mkcert
brew install mkcert

# Install the local CA
mkcert -install

# Generate certificates (replace with your hostname/IP)
mkcert -cert-file ./certs/server.pem -key-file ./certs/server-key.pem localhost 127.0.0.1 192.168.1.100

# Start server with HTTPS
HTTPS_CERT=./certs/server.pem HTTPS_KEY=./certs/server-key.pem npm start
```

## Detailed Setup

### 1. Install mkcert

**macOS:**
```bash
brew install mkcert
```

**Linux:**
```bash
# Debian/Ubuntu
sudo apt install libnss3-tools
brew install mkcert  # or download from releases

# Arch
sudo pacman -S mkcert
```

**Windows:**
```powershell
choco install mkcert
# or
scoop install mkcert
```

### 2. Install the Local CA

Run once to install the CA in your system trust store:

```bash
mkcert -install
```

This creates a root CA that your system will trust. The CA is stored in:
- macOS: `~/Library/Application Support/mkcert`
- Linux: `~/.local/share/mkcert`
- Windows: `%LOCALAPPDATA%\mkcert`

### 3. Generate Certificates

Create a `certs` directory in the Eve Workspace root:

```bash
mkdir -p certs
```

Generate certificates for all hostnames/IPs you'll use:

```bash
# Basic - localhost only
mkcert -cert-file ./certs/server.pem -key-file ./certs/server-key.pem localhost

# With LAN IP (check your IP with `ifconfig` or `ip addr`)
mkcert -cert-file ./certs/server.pem -key-file ./certs/server-key.pem localhost 127.0.0.1 192.168.1.100

# With hostname
mkcert -cert-file ./certs/server.pem -key-file ./certs/server-key.pem localhost eve.local 192.168.1.100
```

### 4. Configure Environment

Set environment variables before starting the server:

```bash
export HTTPS_KEY=./certs/server-key.pem
export HTTPS_CERT=./certs/server.pem
npm start
```

Or create a `.env` file (if using dotenv):

```
HTTPS_KEY=./certs/server-key.pem
HTTPS_CERT=./certs/server.pem
```

## Mobile Device Setup (iPhone/iPad)

### Installing the CA on iOS

1. **Get the CA certificate:**
   ```bash
   # Show the CA location
   mkcert -CAROOT
   # Example: /Users/yourname/Library/Application Support/mkcert
   ```

2. **Transfer `rootCA.pem` to your device:**
   - AirDrop the file to your iPhone
   - Or email it to yourself
   - Or host it temporarily: `python3 -m http.server 8000`

3. **Install the profile:**
   - Open the file on your iPhone
   - Go to Settings > General > VPN & Device Management
   - Tap the mkcert profile
   - Tap "Install" and enter your passcode

4. **Enable full trust:**
   - Go to Settings > General > About > Certificate Trust Settings
   - Enable full trust for the mkcert certificate
   - Confirm when prompted

5. **Verify:**
   - Navigate to `https://192.168.1.100:3000` (your server's IP)
   - Should load without certificate warnings
   - Passkey enrollment should work with Face ID/Touch ID

## Troubleshooting

### "Certificate not trusted" on macOS

```bash
# Reinstall the CA
mkcert -uninstall
mkcert -install
```

### "NET::ERR_CERT_AUTHORITY_INVALID" in Chrome

- Check that `mkcert -install` was run
- Restart Chrome after installing the CA
- Verify the certificate includes the hostname you're using

### "Certificate doesn't include IP"

Regenerate certificates with the correct IP:

```bash
mkcert -cert-file ./certs/server.pem -key-file ./certs/server-key.pem localhost YOUR_IP
```

### iPhone still shows certificate warning

1. Verify the profile is installed: Settings > General > VPN & Device Management
2. Verify trust is enabled: Settings > General > About > Certificate Trust Settings
3. Make sure you're using the correct IP/hostname that's in the certificate

### Server won't start with HTTPS

Check file paths are correct:

```bash
ls -la ./certs/
# Should show server.pem and server-key.pem
```

Check file permissions:

```bash
chmod 600 ./certs/server-key.pem
chmod 644 ./certs/server.pem
```

## Security Notes

- The mkcert CA is only for development - never use it in production
- Keep the CA private key secure (`rootCA-key.pem`)
- Add `certs/` to `.gitignore` to avoid committing certificates
- Generated certificates are valid for ~2 years by default
