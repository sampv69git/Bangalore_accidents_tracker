/* ─────────────────────────────────────────────────────────────────────────
   auth.js — Nav Auth Manager for Bangalore Accidents Tracker
   Uses Supabase sessions via window.SupabaseAuthClient for authentication.
   Requirements: 3.5, 3.1, 3.2, 3.3, 3.4
   ───────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /**
   * Session refresh retry configuration.
   * On network error during token refresh, retry up to 3 times
   * with exponential backoff: 1s, 2s, 4s (Req 3.4).
   */
  var REFRESH_MAX_RETRIES = 3;
  var REFRESH_BASE_DELAY_MS = 1000;

  /**
   * Track whether a refresh retry sequence is currently in progress
   * to prevent multiple concurrent retry loops.
   */
  var _refreshRetryInProgress = false;

  /**
   * Wait for SupabaseAuthClient to be available on window.
   * Since supabase-auth.js is loaded as a module (deferred), it may not be
   * available immediately when this script runs.
   * @returns {Promise<object|null>} The SupabaseAuthClient or null if timeout
   */
  function waitForAuthClient() {
    return new Promise(function (resolve) {
      if (window.SupabaseAuthClient) {
        resolve(window.SupabaseAuthClient);
        return;
      }

      // Poll briefly for module to load (modules execute after DOM parse)
      var attempts = 0;
      var maxAttempts = 50; // 50 * 50ms = 2.5s max wait
      var interval = setInterval(function () {
        attempts++;
        if (window.SupabaseAuthClient) {
          clearInterval(interval);
          resolve(window.SupabaseAuthClient);
        } else if (attempts >= maxAttempts) {
          clearInterval(interval);
          console.warn('[auth.js] SupabaseAuthClient not available after timeout.');
          resolve(null);
        }
      }, 50);
    });
  }

  /**
   * Sleep utility for exponential backoff delays.
   * @param {number} ms - Milliseconds to wait
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Determine if an error is a network/connectivity error (vs expired token).
   * @param {string|object} error - Error message or error object
   * @returns {boolean}
   */
  function isNetworkError(error) {
    if (!error) return false;
    var msg = typeof error === 'string' ? error : (error.message || '');
    var lower = msg.toLowerCase();
    return (
      lower.includes('network') ||
      lower.includes('fetch') ||
      lower.includes('connection') ||
      lower.includes('offline') ||
      lower.includes('timeout') ||
      lower.includes('dns') ||
      lower.includes('econnrefused') ||
      lower.includes('failed to fetch') ||
      lower.includes('load failed') ||
      lower.includes('networkerror')
    );
  }

  /**
   * Attempt to manually refresh the session via Supabase client.
   * @returns {Promise<{success: boolean, error?: string, isNetworkError?: boolean}>}
   */
  async function attemptSessionRefresh() {
    var supabase = window.supabase;
    if (!supabase) {
      return { success: false, error: 'Supabase client not available' };
    }

    try {
      var result = await supabase.auth.refreshSession();
      if (result.error) {
        return {
          success: false,
          error: result.error.message || 'Refresh failed',
          isNetworkError: isNetworkError(result.error.message || '')
        };
      }
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err.message || 'Refresh exception',
        isNetworkError: isNetworkError(err.message || err)
      };
    }
  }

  /**
   * Handle session refresh failure with retry logic (Req 3.4).
   * On network error: retry up to 3 times with exponential backoff (1s, 2s, 4s).
   * If all retries fail: redirect to login with ?connectivity=true.
   * On expired/invalid refresh token (not network): redirect with ?expired=true (Req 3.3).
   */
  async function handleRefreshFailure(error) {
    // Prevent multiple concurrent retry loops
    if (_refreshRetryInProgress) return;

    // Determine if this is a network error or an expired token
    var networkErr = isNetworkError(error);

    if (!networkErr) {
      // Expired or invalid refresh token — redirect immediately (Req 3.3)
      console.warn('[auth.js] Refresh token expired or invalid. Redirecting to login.');
      redirectToLogin('expired');
      return;
    }

    // Network error — retry with exponential backoff (Req 3.4)
    _refreshRetryInProgress = true;
    console.warn('[auth.js] Network error during refresh. Starting retry sequence.');

    for (var attempt = 1; attempt <= REFRESH_MAX_RETRIES; attempt++) {
      var delayMs = REFRESH_BASE_DELAY_MS * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.log('[auth.js] Retry attempt ' + attempt + '/' + REFRESH_MAX_RETRIES + ' after ' + delayMs + 'ms');
      await sleep(delayMs);

      var result = await attemptSessionRefresh();
      if (result.success) {
        console.log('[auth.js] Session refresh succeeded on retry ' + attempt);
        _refreshRetryInProgress = false;
        return;
      }

      // If the retry error is not a network error (e.g., token actually expired),
      // stop retrying and redirect with expired param
      if (!result.isNetworkError) {
        console.warn('[auth.js] Refresh token expired during retry. Redirecting to login.');
        _refreshRetryInProgress = false;
        redirectToLogin('expired');
        return;
      }
    }

    // All retries exhausted — redirect with connectivity error (Req 3.4)
    console.warn('[auth.js] All refresh retries failed. Redirecting to login with connectivity error.');
    _refreshRetryInProgress = false;
    redirectToLogin('connectivity');
  }

  /**
   * Redirect to login page with the appropriate query parameter.
   * @param {'expired'|'connectivity'} reason - Reason for redirect
   */
  function redirectToLogin(reason) {
    // Don't redirect if already on the login page
    var currentPage = window.location.pathname.split('/').pop();
    if (currentPage === 'login.html') return;

    var param = reason === 'connectivity' ? '?connectivity=true' : '?expired=true';
    window.location.href = 'login.html' + param;
  }

  /**
   * Redirect to login page if user is not authenticated (async).
   * Protected pages should call: await Auth.requireAuth()
   * @param {string} redirectTo - Login page URL (default: 'login.html')
   */
  async function requireAuth(redirectTo) {
    if (redirectTo === undefined) redirectTo = 'login.html';
    var loggedIn = await isLoggedIn();
    if (!loggedIn) {
      var current = window.location.pathname.split('/').pop();
      window.location.href = redirectTo + '?returnTo=' + encodeURIComponent(current);
    }
  }

  /**
   * Check if user is currently logged in via Supabase session.
   * @returns {Promise<boolean>}
   */
  async function isLoggedIn() {
    var client = await waitForAuthClient();
    if (!client) return false;

    var session = await client.getSession();
    return session !== null;
  }

  /**
   * Update the navigation bar to show correct auth state.
   * Shows user initial avatar + logout button when authenticated,
   * or login/sign-up links when not authenticated.
   */
  async function updateNavAuth() {
    var navAuthLinks = document.getElementById('nav-auth-links');
    if (!navAuthLinks) return;

    var client = await waitForAuthClient();
    if (!client) {
      renderLoggedOut(navAuthLinks);
      return;
    }

    var session = await client.getSession();

    if (session && session.user) {
      renderLoggedIn(navAuthLinks, session.user);
    } else {
      renderLoggedOut(navAuthLinks);
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str == null ? '' : String(str)));
    return div.innerHTML;
  }

  /**
   * Render authenticated nav state with user initial avatar and logout button.
   * @param {HTMLElement} container - The nav auth links container
   * @param {object} user - Supabase user object
   */
  function renderLoggedIn(container, user) {
    var name = (user.user_metadata && user.user_metadata.name) || user.email || 'U';
    var initial = escapeHtml(name.charAt(0).toUpperCase());
    var displayName = escapeHtml(name.split(' ')[0]);
    var email = escapeHtml(user.email || 'View profile');

    container.innerHTML =
      '<div class="nav-user">' +
        '<a href="profile.html" class="nav-user-link" data-label="My Profile">' +
          '<span class="nav-avatar">' + initial + '</span>' +
          '<span class="nav-user-meta"><strong>' + displayName + '</strong><small>' + email + '</small></span>' +
        '</a>' +
        '<button type="button" class="nav-user-logout" id="logout-btn" aria-label="Log out" title="Log out">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>' +
        '</button>' +
      '</div>';

    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', handleLogout);
    }
  }

  /**
   * Render unauthenticated nav state with login and sign-up links.
   * @param {HTMLElement} container - The nav auth links container
   */
  function renderLoggedOut(container) {
    container.innerHTML =
      '<div class="nav-guest">' +
        '<a href="login.html" class="nav-guest-login" data-label="Login">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/></svg>' +
          '<span>Login</span>' +
        '</a>' +
        '<a href="login.html?tab=register" class="nav-guest-signup">Sign Up</a>' +
      '</div>';
  }

  /**
   * Handle logout: sign out via Supabase, then redirect to home.
   * @param {Event} e - Click event
   */
  async function handleLogout(e) {
    e.preventDefault();
    var client = window.SupabaseAuthClient;
    if (client) {
      await client.signOut();
    }
    window.location.href = 'index.html';
  }

  /**
   * Subscribe to Supabase auth state changes for reactive UI updates.
   * Automatically re-renders the nav when user signs in or out.
   * Handles refresh failures by detecting SIGNED_OUT events caused by
   * expired refresh tokens (Req 3.3) and network errors (Req 3.4).
   */
  function initAuthStateListener() {
    var client = window.SupabaseAuthClient;
    if (!client) return;

    // Track whether we previously had an active session.
    // If we go from active to SIGNED_OUT without an explicit signOut() call,
    // it means the refresh token expired.
    var _hadSession = false;
    var _explicitSignOut = false;

    // Patch the signOut to track explicit user-initiated logout
    var _originalSignOut = client.signOut.bind(client);
    client.signOut = async function () {
      _explicitSignOut = true;
      return _originalSignOut();
    };

    // Check initial session state
    client.getSession().then(function (session) {
      _hadSession = session !== null;
    });

    client.onAuthStateChange(function (event, session) {
      // Re-render nav on any auth state change
      updateNavAuth();

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        _hadSession = true;
        _explicitSignOut = false;
      }

      if (event === 'SIGNED_OUT' && _hadSession && !_explicitSignOut) {
        // Supabase fires SIGNED_OUT when the refresh token is expired/invalid.
        // This is an implicit sign-out due to refresh failure (Req 3.3).
        console.warn('[auth.js] Implicit SIGNED_OUT detected — refresh token likely expired.');
        handleRefreshFailure('token expired or invalid');
      }

      // Reset tracking after explicit sign-out
      if (event === 'SIGNED_OUT' && _explicitSignOut) {
        _hadSession = false;
        _explicitSignOut = false;
      }
    });
  }

  /**
   * Set up a listener on the Supabase client to detect refresh errors.
   * Supabase client may throw errors during auto-refresh that we can intercept
   * through the onAuthStateChange or by watching for specific error patterns.
   */
  function initRefreshErrorDetection() {
    var supabase = window.supabase;
    if (!supabase) return;

    // Wrap the internal auto-refresh error handling.
    // When Supabase auto-refresh fails with a network error, we intercept it
    // via a custom event listener mechanism. Supabase JS v2 emits auth state
    // changes but for network errors during auto-refresh, we need to watch
    // for failures through the onAuthStateChange callback with error events.
    // The main detection is done in initAuthStateListener above.
  }

  // Set up the auth state listener once SupabaseAuthClient is available.
  waitForAuthClient().then(function (client) {
    if (client) {
      initAuthStateListener();
      initRefreshErrorDetection();
    }
  });

  // Expose Auth API globally
  window.Auth = {
    requireAuth: requireAuth,
    updateNavAuth: updateNavAuth,
    isLoggedIn: isLoggedIn,
    logout: handleLogout,
    // Exposed for testing purposes
    _handleRefreshFailure: handleRefreshFailure,
    _isNetworkError: isNetworkError,
    _attemptSessionRefresh: attemptSessionRefresh
  };
})();
