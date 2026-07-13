/* ═══════════════════════════════════════════
   KEOU AGENCY — Client-side Auth Manager
   Handles tokens, auto-refresh, protected fetch
   ═══════════════════════════════════════════ */

/* ── Dark mode only — no theme switching ── */

/** Escape HTML special characters to prevent XSS */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const Auth = (() => {
  let accessToken = null;
  let user = null;
  let refreshing = null;
  let mustChangePassword = false;
  let edition = 'enterprise';
  let billingMode = 'quota';

  function getToken() { return accessToken; }
  function getUser() { return user; }
  function isLoggedIn() { return !!accessToken; }
  function isAdmin() { return user?.role === 'admin'; }
  function needsPasswordChange() { return mustChangePassword; }
  function getEdition() { return edition; }
  function isOpensource() { return edition === 'opensource'; }
  function isCommunity() { return edition === 'community'; }
  // BYOK editions: the visitor's own provider key rides every request.
  function isByok() { return edition === 'opensource' || edition === 'community'; }
  function getBillingMode() { return billingMode; }
  function isCreditsMode() { return billingMode === 'credits'; }

  // Opensource BYOK — the visitor's own provider key, kept in this browser
  // only and sent per-request. Never stored server-side.
  const PROVIDER_KEY_STORAGE = 'keou.providerKey';
  function getProviderKey() { try { return localStorage.getItem(PROVIDER_KEY_STORAGE) || ''; } catch { return ''; } }
  function setProviderKey(k) { try { k ? localStorage.setItem(PROVIDER_KEY_STORAGE, k.trim()) : localStorage.removeItem(PROVIDER_KEY_STORAGE); } catch {} }

  function setAuth(data) {
    accessToken = data.accessToken;
    user = data.user;
    mustChangePassword = data.mustChangePassword || false;
    if (data.edition) edition = data.edition;
    if (data.billingMode) billingMode = data.billingMode;
  }

  function clearAuth() {
    accessToken = null;
    user = null;
    mustChangePassword = false;
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) { clearAuth(); return false; }
        const data = await res.json();
        setAuth(data);
        return true;
      } catch { clearAuth(); return false; }
      finally { refreshing = null; }
    })();
    return refreshing;
  }

  async function authFetch(url, options = {}) {
    if (!accessToken) {
      const ok = await refresh();
      if (!ok) { redirectToLogin(); throw new Error('Not authenticated'); }
    }

    function buildHeaders() {
      const headers = { ...options.headers };
      if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
      headers['Authorization'] = `Bearer ${accessToken}`;
      if (isByok()) {
        const pk = getProviderKey();
        if (pk) headers['X-Provider-Key'] = pk;
      }
      return headers;
    }

    let res = await fetch(url, { ...options, headers: buildHeaders(), credentials: 'same-origin' });

    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      if (body.code === 'TOKEN_EXPIRED' || body.code === 'INVALID_TOKEN') {
        const ok = await refresh();
        if (ok) {
          // Re-build headers with fresh token (avoids stale token in closure)
          res = await fetch(url, { ...options, headers: buildHeaders(), credentials: 'same-origin' });
        } else { redirectToLogin(); throw new Error('Session expired'); }
      } else { redirectToLogin(); throw new Error('Not authenticated'); }
    }
    return res;
  }

  async function register(email, password, name) {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    setAuth(data);
    return data;
  }

  async function login(email, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setAuth(data);
    return data;
  }

  async function changePassword(currentPassword, newPassword) {
    const res = await authFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to change password');
    mustChangePassword = false;
    return data;
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    clearAuth();
    window.location.href = '/';
  }

  function redirectToLogin() {
    if (window.location.pathname !== '/login.html' && window.location.pathname !== '/' && window.location.pathname !== '/index.html') {
      window.location.href = '/login.html';
    }
  }

  async function init() { return await refresh(); }

  async function guard() {
    let ok = await init();
    // Retry once on failure — handles transient network issues on page refresh
    if (!ok) {
      await new Promise(r => setTimeout(r, 500));
      ok = await refresh();
    }
    if (!ok) { redirectToLogin(); return false; }
    // If must change password, redirect to login (has change-password form)
    if (mustChangePassword && window.location.pathname !== '/login.html') {
      window.location.href = '/login.html?change=1';
      return false;
    }
    return true;
  }

  async function adminGuard() {
    const ok = await guard();
    if (!ok) return false;
    if (!isAdmin()) { window.location.href = '/studio.html'; return false; }
    return true;
  }

  async function publicGuard() {
    const ok = await refresh();
    if (ok && !mustChangePassword) {
      window.location.href = '/studio.html';
      return false;
    }
    return true;
  }

  return {
    getToken, getUser, isLoggedIn, isAdmin, needsPasswordChange,
    getEdition, isOpensource, isCommunity, isByok, getBillingMode, isCreditsMode, getProviderKey, setProviderKey,
    setAuth, clearAuth, refresh,
    authFetch, login, register, changePassword, logout,
    init, guard, adminGuard, publicGuard,
  };
})();

window.Auth = Auth;
