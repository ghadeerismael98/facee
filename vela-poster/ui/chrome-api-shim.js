/**
 * Chrome API Shim — intercepts chrome.* calls from the popup bundle
 * and routes them to the Node.js server via HTTP.
 *
 * Profile-aware: detects which Vela profile this tab belongs to
 * and sends X-Vela-Profile header on all requests for isolated storage.
 */
(function () {
  var SERVER = window.location.origin;
  var VELA_API = 'http://127.0.0.1:1306';
  var PROFILE_ID = 'default'; // Will be resolved async

  // ── Block IndexedDB ────────────────────────────────────────────
  // The popup bundle uses IndexedDB (Zustand persist) as primary storage,
  // but our data lives on the server via chrome.storage shim.
  // If IndexedDB is available, the popup reads stale/empty data from it
  // and ignores our server data. Block it so the popup falls back to
  // chrome.storage.local exclusively (which our shim handles).
  try {
    var _origIDBOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = function (name) {
      // Allow non-popup databases (e.g. browser internals)
      if (name && (name.indexOf('PostStore') !== -1 || name.indexOf('keyval') !== -1 || name.indexOf('idb') !== -1)) {
        console.log('[Shim] Blocking IndexedDB:', name, '— using chrome.storage instead');
        // Return a fake request that immediately fires an error
        // so the Zustand persist falls back to chrome.storage
        var fakeReq = { error: new DOMException('Blocked by shim', 'NotAllowedError') };
        setTimeout(function () {
          if (fakeReq.onerror) fakeReq.onerror({ target: fakeReq });
        }, 0);
        return fakeReq;
      }
      return _origIDBOpen.apply(indexedDB, arguments);
    };
  } catch (e) {
    console.warn('[Shim] Could not block IndexedDB:', e);
  }

  // ── Premium overrides ──────────────────────────────────────────
  var PREMIUM_OVERRIDES = {
    isPremium: true,
    postsRemaining: 999999,
    user: { email: 'local@vela-poster', name: 'Vela User', uid: 'vela-local-user' },
  };

  // ── Profile Detection ──────────────────────────────────────────
  // Priority 1: URL param ?profile=xxx (used by dashboard iframes)
  // Priority 2: Vela API title-nonce trick (used when opened directly in Vela)
  var _urlParams = new URLSearchParams(window.location.search);
  var _urlProfile = _urlParams.get('profile');

  // No browser cache overrides — each port has its own origin = isolated storage

  var _profileReady = (function detectProfile() {
    if (_urlProfile) {
      PROFILE_ID = _urlProfile;
      console.log('[Shim] Profile set via URL param:', PROFILE_ID);
      return Promise.resolve();
    }

    var nonce = 'vp_' + Math.random().toString(36).slice(2);
    var originalTitle = document.title;
    document.title = nonce;

    return fetch(VELA_API + '/api/tabs', { headers: { 'X-API-Key': window.__velaApiKey || '' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var tabs = data.tabs || data || [];
        for (var i = 0; i < tabs.length; i++) {
          if (tabs[i].title === nonce) {
            PROFILE_ID = tabs[i].profileId || 'default';
            console.log('[Shim] Detected Vela profile:', PROFILE_ID);
            break;
          }
        }
        document.title = originalTitle || 'Facebook Groups Bulk Poster (Vela)';
      })
      .catch(function () {
        document.title = originalTitle || 'Facebook Groups Bulk Poster (Vela)';
        console.log('[Shim] Could not detect profile, using default');
      });
  })();

  // ── Helpers (profile-aware) ────────────────────────────────────
  function post(path, body) {
    return fetch(SERVER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vela-Profile': PROFILE_ID },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  function get(path) {
    return fetch(SERVER + path, {
      headers: { 'X-Vela-Profile': PROFILE_ID },
    }).then(function (r) { return r.json(); });
  }

  function del(path, body) {
    return fetch(SERVER + path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Vela-Profile': PROFILE_ID },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  // ── Apply premium overrides to storage results ─────────────────
  function applyOverrides(data) {
    if (!data || typeof data !== 'object') data = {};
    data.isPremium = true;
    data.postsRemaining = 999999;
    if (!data.user || !data.user.email) {
      data.user = PREMIUM_OVERRIDES.user;
    }
    return data;
  }

  // ── Storage shim factory ───────────────────────────────────────
  function createStorageArea(area) {
    return {
      get: function (keys, callback) {
        var keyParam = '';
        if (typeof keys === 'string') keyParam = '?keys=' + encodeURIComponent(keys);
        else if (Array.isArray(keys)) keyParam = '?keys=' + encodeURIComponent(keys.join(','));

        var promise = get('/api/storage/' + area + keyParam)
          .catch(function () { return {}; })
          .then(function (data) { return applyOverrides(data); });

        if (typeof callback === 'function') { promise.then(callback); }
        return promise;
      },
      set: function (items, callback) {
        if (items && items.isPremium === false) items.isPremium = true;
        if (items && typeof items.postsRemaining === 'number' && items.postsRemaining < 999999) items.postsRemaining = 999999;

        // Protect group lists from being overwritten with empty data on hydration.
        // The popup reads from IndexedDB (empty on new origin), then saves that empty
        // state to chrome.storage.local — wiping the server data.
        if (items && items['fb-group-lists']) {
          var gl = items['fb-group-lists'];
          var lists = (gl && gl.state && gl.state.groupLists) || [];
          if (lists.length === 0) {
            // Don't save empty group lists — check server first
            var checkPromise = get('/api/storage/' + area + '?keys=fb-group-lists').then(function (serverData) {
              var serverLists = serverData && serverData['fb-group-lists'] &&
                serverData['fb-group-lists'].state && serverData['fb-group-lists'].state.groupLists;
              if (serverLists && serverLists.length > 0) {
                // Server has data, don't overwrite with empty
                console.log('[Shim] Blocked empty group lists overwrite — server has', serverLists.length, 'lists');
                delete items['fb-group-lists'];
              }
              if (Object.keys(items).length === 0) return {};
              return post('/api/storage/' + area, items).catch(function () { return {}; });
            });
            if (typeof callback === 'function') { checkPromise.then(callback); }
            return checkPromise;
          }
        }

        var promise = post('/api/storage/' + area, items).catch(function () { return {}; });
        if (typeof callback === 'function') { promise.then(callback); }
        return promise;
      },
      remove: function (keys, callback) {
        var keyList = typeof keys === 'string' ? [keys] : keys;
        keyList = keyList.filter(function (k) { return k !== 'isPremium' && k !== 'postsRemaining'; });
        if (keyList.length === 0) {
          var p = Promise.resolve({});
          if (typeof callback === 'function') p.then(callback);
          return p;
        }
        var promise = del('/api/storage/' + area, { keys: keyList }).catch(function () { return {}; });
        if (typeof callback === 'function') { promise.then(callback); }
        return promise;
      },
    };
  }

  // ── Message listeners & polling ────────────────────────────────
  var messageListeners = [];
  var storageListeners = [];

  var pollInterval = null;
  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(function () {
      get('/api/extension/events').then(function (events) {
        if (events && events.length) {
          events.forEach(function (msg) {
            if (msg.type === 'storage_changed' && msg.changes) {
              storageListeners.forEach(function (listener) {
                try { listener(msg.changes, msg.area || 'local'); } catch (e) {}
              });
              return;
            }
            messageListeners.forEach(function (listener) {
              listener(msg, {}, function () {});
            });
          });
        }
      }).catch(function () {});
    }, 1000);
  }

  // ── Build the chrome global ──────────────────────────────────────
  window.chrome = {
    runtime: {
      sendMessage: function (message, callback) {
        if (message && message.action === 'checkCredits') {
          var cr = { credits: 999999, postsRemaining: 999999, success: true };
          if (typeof callback === 'function') callback(cr);
          return Promise.resolve(cr);
        }
        if (message && (message.action === 'checkPremium' || message.action === 'checkSubscription')) {
          var pr = { isPremium: true, subscription: { status: 'active' }, success: true };
          if (typeof callback === 'function') callback(pr);
          return Promise.resolve(pr);
        }

        var promise = post('/api/extension/message', message).then(function (response) {
          window.chrome.runtime.lastError = null;
          if (typeof callback === 'function') callback(response);
          return response;
        }).catch(function (err) {
          window.chrome.runtime.lastError = { message: err.message };
          if (typeof callback === 'function') callback(undefined);
          return undefined;
        });
        return promise;
      },
      onMessage: {
        addListener: function (fn) { messageListeners.push(fn); startPolling(); },
        removeListener: function (fn) { messageListeners = messageListeners.filter(function (l) { return l !== fn; }); },
      },
      getManifest: function () { return { version: '2.0.0', name: 'Facebook Groups Bulk Poster (Vela)' }; },
      id: 'vela-poster-shim',
      lastError: null,
    },

    storage: {
      local: createStorageArea('local'),
      sync: createStorageArea('sync'),
      session: createStorageArea('session'),
      onChanged: {
        addListener: function (fn) { storageListeners.push(fn); },
        removeListener: function (fn) { storageListeners = storageListeners.filter(function (l) { return l !== fn; }); },
      },
    },

    tabs: {
      create: function (opts) {
        post('/api/extension/message', { action: 'openTab', url: opts.url }).catch(function () {
          window.open(opts.url, '_blank');
        });
      },
    },

    downloads: {
      download: function (opts) {
        var a = document.createElement('a');
        a.href = opts.url;
        a.download = opts.filename || '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      },
    },
  };

  // ── Intercept fetch calls to external services ─────────────────
  function fakeJson(data) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  }

  var _originalFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    try {
      var urlStr = typeof url === 'string' ? url : (url && url.url ? url.url : String(url));

      if (urlStr.indexOf('fbgroupbulkposter.com') !== -1) {
        console.log('[Shim] Intercepted →', urlStr);
        if (urlStr.indexOf('subscription') !== -1) {
          return fakeJson({ status: 'success', subscription: { status: 'active', subscription_id: 'vela-unlimited', plan: 'premium', payment_method: 'lifetime' }, isPremium: true });
        }
        if (urlStr.indexOf('credit') !== -1) {
          return fakeJson({ credits: 999999, postsRemaining: 999999, success: true });
        }
        if (urlStr.indexOf('user') !== -1) {
          return fakeJson({ success: true, loggedIn: true, user: { email: 'local@vela-poster', name: 'Vela User', uid: 'vela-local-user' } });
        }
        if (urlStr.indexOf('cancel') !== -1) {
          return fakeJson({ success: false, message: 'Cannot cancel unlimited subscription' });
        }
        return fakeJson({ success: true, status: 'success' });
      }
      if (urlStr.indexOf('sentry.io') !== -1) return fakeJson({});
      if (urlStr.indexOf('mixpanel.com') !== -1) return Promise.resolve(new Response('1', { status: 200 }));
    } catch (e) {
      console.warn('[Shim] Fetch intercept error:', e);
    }
    return _originalFetch(url, opts);
  };

  // localStorage isolation moved to top of IIFE (before module loads)

  // ── Seed data after profile is detected ────────────────────────
  _profileReady.then(function () {
    var seedData = {
      isPremium: true,
      postsRemaining: 999999,
      user: { email: 'local@vela-poster', name: 'Vela User', uid: 'vela-local-user' },
    };
    post('/api/storage/sync', seedData).catch(function () {});
    post('/api/storage/local', seedData).catch(function () {});

    // Pre-fetch group lists and scheduler data so Zustand hydration finds them
    // This triggers chrome.storage.onChanged which forces the React app to re-render
    get('/api/storage/local?keys=fb-group-lists,fb-post-scheduler').then(function (data) {
      if (!data) return;
      var changes = {};
      if (data['fb-group-lists']) {
        changes['fb-group-lists'] = { newValue: data['fb-group-lists'] };
      }
      if (data['fb-post-scheduler']) {
        changes['fb-post-scheduler'] = { newValue: data['fb-post-scheduler'] };
      }
      if (Object.keys(changes).length > 0) {
        // Fire onChanged to force Zustand to pick up the server data
        setTimeout(function () {
          console.log('[Shim] Pre-seeding group/scheduler data from server');
          storageListeners.forEach(function (fn) {
            try { fn(changes, 'local'); } catch (e) {}
          });
        }, 500);
      }
    }).catch(function () {});

    startPolling();

    // ── Re-sync on focus ──────────────────────────────────────────
    // When user switches to this tab/iframe, re-read Zustand keys from server
    // and fire chrome.storage.onChanged so the React app updates.
    var _lastSyncData = {};
    function resyncFromServer() {
      get('/api/storage/local').then(function (data) {
        if (!data) return;
        var changes = {};
        var hasChanges = false;
        var keysToCheck = ['fb-group-lists', 'fb-post-scheduler'];
        for (var i = 0; i < keysToCheck.length; i++) {
          var key = keysToCheck[i];
          var newVal = JSON.stringify(data[key] || null);
          var oldVal = JSON.stringify(_lastSyncData[key] || null);
          if (newVal !== oldVal) {
            changes[key] = { oldValue: _lastSyncData[key], newValue: data[key] };
            _lastSyncData[key] = data[key];
            hasChanges = true;
          }
        }
        if (hasChanges) {
          console.log('[Shim] Re-synced from server, firing onChanged');
          storageListeners.forEach(function (fn) {
            try { fn(changes, 'local'); } catch (e) {}
          });
        }
      }).catch(function () {});
    }

    // Sync when page gets focus
    window.addEventListener('focus', resyncFromServer);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') resyncFromServer();
    });

    console.log('[Shim] Chrome API shim loaded — profile:', PROFILE_ID);
    console.log('[Shim] Premium UNLOCKED — all features enabled, unlimited posts');
  });
})();
