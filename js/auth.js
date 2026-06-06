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

  function _initDevMode(onLogin) {
    // localhost：自動恢復已存的 dev token，或顯示「貼上 Token」入口
    const saved = localStorage.getItem('ba_dev_token');
    if (saved) {
      _verifyToken(saved)
        .then(email => _saveSession(saved, email))
        .catch(() => {
          localStorage.removeItem('ba_dev_token');
          _initDevMode(onLogin); // token 過期，重新顯示貼上入口
        });
      return;
    }
    // 顯示 dev token 輸入框（inline，不用 prompt）
    const loginBtn = document.getElementById('btn-login');
    if (loginBtn) {
      loginBtn.insertAdjacentHTML('afterend', `
        <div id="dev-token-area" style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
          <textarea id="dev-token-input" rows="3"
            placeholder="貼上 ba_token（正式 App DevTools → 工作階段儲存空間 → ba_token）"
            style="width:100%;padding:8px;border-radius:8px;border:1px solid #555;background:#1e1e1e;color:#fff;font-size:12px;resize:none"></textarea>
          <button id="dev-token-submit" style="padding:10px;border-radius:8px;background:#4caf8a;color:#000;font-weight:bold;border:none;cursor:pointer">確認登入</button>
          <div id="dev-token-error" style="color:#f87;font-size:12px;display:none"></div>
        </div>`);
      loginBtn.hidden = true;
      document.getElementById('dev-token-submit').onclick = async () => {
        const token = document.getElementById('dev-token-input').value.trim();
        const errEl = document.getElementById('dev-token-error');
        errEl.style.display = 'none';
        if (!token) return;
        try {
          const email = await _verifyToken(token);
          localStorage.setItem('ba_dev_token', token);
          _saveSession(token, email);
        } catch (e) {
          errEl.textContent = 'Token 無效或已過期：' + e.message;
          errEl.style.display = 'block';
        }
      };
    }
  }

  function init(onLogin) {
    _onLogin = onLogin;

    if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
      _initDevMode(onLogin);
      return;
    }

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
