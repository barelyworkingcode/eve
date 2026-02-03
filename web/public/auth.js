// WebAuthn authentication client

class AuthClient {
  constructor() {
    this.elements = null;
    this.challengeId = null;
  }

  init() {
    this.elements = {
      screen: document.getElementById('authScreen'),
      title: document.getElementById('authTitle'),
      message: document.getElementById('authMessage'),
      action: document.getElementById('authAction'),
      error: document.getElementById('authError')
    };

    this.elements.action.addEventListener('click', () => this.handleAction());
  }

  async checkStatus() {
    try {
      const token = localStorage.getItem('eve_session');
      const headers = token ? { 'X-Session-Token': token } : {};

      const res = await fetch('/api/auth/status', { headers });
      const status = await res.json();

      if (!status.enrolled) {
        this.showEnrollScreen();
        return false;
      }

      if (status.authenticated) {
        this.hide();
        return true;
      }

      this.showLoginScreen();
      return false;
    } catch (err) {
      console.error('Auth status check failed:', err);
      this.showError('Failed to check authentication status');
      return false;
    }
  }

  showEnrollScreen() {
    this.elements.title.textContent = 'Set Up Passkey';
    this.elements.message.textContent = 'Secure your Eve Workspace with a passkey.';
    this.elements.action.textContent = 'Create Passkey';
    this.elements.action.dataset.mode = 'enroll';
    this.show();
  }

  showLoginScreen() {
    this.elements.title.textContent = 'Sign In';
    this.elements.message.textContent = 'Use your passkey to continue.';
    this.elements.action.textContent = 'Sign In';
    this.elements.action.dataset.mode = 'login';
    this.show();
  }

  show() {
    this.elements.screen.classList.remove('hidden');
    this.hideError();
  }

  hide() {
    this.elements.screen.classList.add('hidden');
  }

  showError(message) {
    this.elements.error.textContent = message;
    this.elements.error.classList.remove('hidden');
  }

  hideError() {
    this.elements.error.classList.add('hidden');
  }

  async handleAction() {
    const mode = this.elements.action.dataset.mode;
    this.elements.action.disabled = true;
    this.hideError();

    try {
      if (mode === 'enroll') {
        await this.enroll();
      } else {
        await this.login();
      }
    } catch (err) {
      console.error('Auth action failed:', err);
      this.showError(err.message || 'Authentication failed');
    } finally {
      this.elements.action.disabled = false;
    }
  }

  async enroll() {
    // Get registration options from server
    const startRes = await fetch('/api/auth/enroll/start', { method: 'POST' });
    if (!startRes.ok) {
      const error = await startRes.json();
      throw new Error(error.error || 'Failed to start enrollment');
    }
    const { options, challengeId } = await startRes.json();

    // Create credential with browser API
    const credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: base64urlToBuffer(options.challenge),
        user: {
          ...options.user,
          id: base64urlToBuffer(options.user.id)
        },
        excludeCredentials: (options.excludeCredentials || []).map(cred => ({
          ...cred,
          id: base64urlToBuffer(cred.id)
        }))
      }
    });

    // Send credential to server for verification
    const response = {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        attestationObject: bufferToBase64url(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : ['internal']
      },
      clientExtensionResults: credential.getClientExtensionResults()
    };

    const finishRes = await fetch('/api/auth/enroll/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response, challengeId })
    });

    if (!finishRes.ok) {
      const error = await finishRes.json();
      throw new Error(error.error || 'Failed to complete enrollment');
    }

    const { token } = await finishRes.json();
    localStorage.setItem('eve_session', token);

    this.hide();
    window.dispatchEvent(new CustomEvent('auth:success'));
  }

  async login() {
    // Get authentication options from server
    const startRes = await fetch('/api/auth/login/start', { method: 'POST' });
    if (!startRes.ok) {
      const error = await startRes.json();
      throw new Error(error.error || 'Failed to start login');
    }
    const { options, challengeId } = await startRes.json();

    console.log('[Auth] Login options from server:', {
      rpId: options.rpId,
      allowCredentials: options.allowCredentials,
      challenge: options.challenge?.substring(0, 20) + '...'
    });

    // Get credential with browser API
    const credential = await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: base64urlToBuffer(options.challenge),
        allowCredentials: (options.allowCredentials || []).map(cred => ({
          ...cred,
          id: base64urlToBuffer(cred.id)
        }))
      }
    });

    // Send assertion to server for verification
    const response = {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        authenticatorData: bufferToBase64url(credential.response.authenticatorData),
        signature: bufferToBase64url(credential.response.signature),
        userHandle: credential.response.userHandle ? bufferToBase64url(credential.response.userHandle) : null
      },
      clientExtensionResults: credential.getClientExtensionResults()
    };

    const finishRes = await fetch('/api/auth/login/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response, challengeId })
    });

    if (!finishRes.ok) {
      const error = await finishRes.json();
      throw new Error(error.error || 'Failed to complete login');
    }

    const { token } = await finishRes.json();
    localStorage.setItem('eve_session', token);

    this.hide();
    window.dispatchEvent(new CustomEvent('auth:success'));
  }
}

// Base64url helpers
function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Export for use in app.js
window.AuthClient = AuthClient;
