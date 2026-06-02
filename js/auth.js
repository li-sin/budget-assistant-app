const Auth = (() => {
  let _token = null;
  let _email = null;
  let _tokenClient = null;
  let _onLogin = null;

  function getToken() { return _token; }
  function getEmail() { return _email; }

  async function _verifyToken(token) {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`
    );
    if (!res.ok) throw new Error('token_expired');
    const data = await res.json();
    if (!CONFIG.EMAIL_WHITELIST.includes(data.email)) {
      throw new Error(`帳號 ${data.email} 未在授權名單內`);
    }
    return data.email;
  }

  function _saveSession(token, email) {
    _token = token;
    _email = email;
    sessionStorage.setItem('ba_token', token);
    sessionStorage.setItem('ba_email', email);
    _onLogin(email);
  }

  function init(onLogin) {
    _onLogin = onLogin;

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = () => {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPES,
        callback: async (resp) => {
          if (resp.error) {
            _showError('登入失敗：' + resp.error);
            return;
          }
          try {
            const email = await _verifyToken(resp.access_token);
            _saveSession(resp.access_token, email);
          } catch (e) {
            _showError(e.message);
          }
        },
      });

      // 自動恢復 session（token 仍有效時跳過登入畫面）
      const saved = sessionStorage.getItem('ba_token');
      if (saved) {
        _verifyToken(saved)
          .then(email => _saveSession(saved, email))
          .catch(() => {
            // token 過期屬正常情況，靜默清除，不顯示錯誤
            sessionStorage.removeItem('ba_token');
            sessionStorage.removeItem('ba_email');
          });
      }
    };
    document.head.appendChild(script);

    document.getElementById('btn-login').addEventListener('click', () => {
      if (_tokenClient) _tokenClient.requestAccessToken();
    });
  }

  function logout() {
    const t = _token;
    sessionStorage.removeItem('ba_token');
    sessionStorage.removeItem('ba_email');
    _token = null;
    _email = null;
    if (t && window.google) google.accounts.oauth2.revoke(t, () => {});
    location.reload();
  }

  async function clearCache() {
    sessionStorage.clear();
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    location.reload();
  }

  function _showError(msg) {
    const el = document.getElementById('login-error');
    if (el) { el.textContent = msg; el.hidden = false; }
  }

  // 在不登出的情況下重新授權（取得含新 scope 的 token）
  function updateAuth() {
    if (!_tokenClient) return Promise.reject(new Error('auth_not_ready'));
    return new Promise((resolve, reject) => {
      _tokenClient.requestAccessToken({
        prompt: '',
        callback: (resp) => {
          if (resp.error) { reject(new Error('auth_cancelled')); return; }
          _token = resp.access_token;
          sessionStorage.setItem('ba_token', resp.access_token);
          resolve();
        },
        error_callback: () => reject(new Error('auth_cancelled')),
      });
    });
  }

  return { init, getToken, getEmail, logout, clearCache, updateAuth };
})();
