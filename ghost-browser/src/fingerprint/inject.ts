import { generateFingerprint, FingerprintConfig } from './generator';

/**
 * Build a complete fingerprint injection payload for Playwright's page.addInitScript().
 *
 * Returns a self-contained JavaScript IIFE string that spoofs 18 fingerprint vectors.
 * Same seed always produces the same fingerprint.
 */
export function buildFingerprintPayload(
  seed: number,
  profile?: { userAgent?: string; timezone?: string; locale?: string }
): string {
  const config = generateFingerprint(seed, profile?.userAgent);

  if (profile?.timezone) {
    config.timezone = profile.timezone;
  }
  if (profile?.locale) {
    config.locale = profile.locale;
  }

  const configJSON = JSON.stringify(config);

  return `(function(C) {
"use strict";

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 1: Function.prototype.toString masking (MUST BE FIRST)
// ═══════════════════════════════════════════════════════════════════════
var _nativeRegistry = new WeakMap();
var _origToString = Function.prototype.toString;

function _registerNative(fn, name) {
  _nativeRegistry.set(fn, "function " + (name || fn.name || "") + "() { [native code] }");
}

var _maskedToString = function toString() {
  if (_nativeRegistry.has(this)) {
    return _nativeRegistry.get(this);
  }
  return _origToString.call(this);
};

Object.defineProperty(Function.prototype, "toString", {
  value: _maskedToString,
  writable: true,
  configurable: true
});
_registerNative(_maskedToString, "toString");

// Helper: define a property with toString masking
function _defProp(obj, prop, desc, nativeName) {
  if (desc.get) _registerNative(desc.get, nativeName || "get " + prop);
  if (desc.set) _registerNative(desc.set, nativeName || "set " + prop);
  if (typeof desc.value === "function") _registerNative(desc.value, nativeName || prop);
  Object.defineProperty(obj, prop, desc);
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 2: Navigator properties
// ═══════════════════════════════════════════════════════════════════════
var navProps = {
  hardwareConcurrency: { get: function() { return C.hardwareConcurrency; }, configurable: true, enumerable: true },
  deviceMemory:        { get: function() { return C.deviceMemory; }, configurable: true, enumerable: true },
  platform:            { get: function() { return C.platform; }, configurable: true, enumerable: true },
  vendor:              { get: function() { return C.vendor; }, configurable: true, enumerable: true },
  maxTouchPoints:      { get: function() { return C.maxTouchPoints; }, configurable: true, enumerable: true },
  webdriver:           { get: function() { return false; }, configurable: true, enumerable: true },
  pdfViewerEnabled:    { get: function() { return true; }, configurable: true, enumerable: true },
  userAgent:           { get: function() { return C.userAgent; }, configurable: true, enumerable: true },
  appVersion:          { get: function() { return C.userAgent.replace("Mozilla/", ""); }, configurable: true, enumerable: true }
};

for (var navKey in navProps) {
  if (navProps.hasOwnProperty(navKey)) {
    _defProp(Navigator.prototype, navKey, navProps[navKey], navKey);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 3: Screen dimensions
// ═══════════════════════════════════════════════════════════════════════
var screenProps = {
  width:       { get: function() { return C.screenWidth; }, configurable: true, enumerable: true },
  height:      { get: function() { return C.screenHeight; }, configurable: true, enumerable: true },
  availWidth:  { get: function() { return C.availWidth; }, configurable: true, enumerable: true },
  availHeight: { get: function() { return C.availHeight; }, configurable: true, enumerable: true },
  colorDepth:  { get: function() { return C.colorDepth; }, configurable: true, enumerable: true },
  pixelDepth:  { get: function() { return C.colorDepth; }, configurable: true, enumerable: true }
};

for (var scrKey in screenProps) {
  if (screenProps.hasOwnProperty(scrKey)) {
    _defProp(Screen.prototype, scrKey, screenProps[scrKey], scrKey);
  }
}

_defProp(window, "devicePixelRatio", {
  get: function() { return C.devicePixelRatio; },
  set: function() {},
  configurable: true,
  enumerable: true
}, "devicePixelRatio");

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 4: Canvas 2D fingerprint noise
// ═══════════════════════════════════════════════════════════════════════
var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
var _origToBlob = HTMLCanvasElement.prototype.toBlob;

function _applyCanvasNoise(canvas) {
  try {
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var w = canvas.width;
    var h = canvas.height;
    if (w === 0 || h === 0) return;
    var imageData = ctx.getImageData(0, 0, w, h);
    var data = imageData.data;
    var len = data.length;
    var s0 = C.canvasNoise[0];
    var s1 = C.canvasNoise[1];
    var s2 = C.canvasNoise[2];
    var s3 = C.canvasNoise[3];
    // Simple hash-based noise using the 4 seeds
    for (var i = 0; i < len; i += 4) {
      // Apply noise to ~13% of pixels
      var hash = ((i * 2654435761 + (s0 * 4294967296)) >>> 0) / 4294967296;
      if (hash < 0.13) {
        var noise = ((((i + 1) * 2246822519 + (s1 * 4294967296)) >>> 0) % 5) - 2;
        data[i]     = Math.max(0, Math.min(255, data[i] + noise));     // R
        noise = ((((i + 2) * 3266489917 + (s2 * 4294967296)) >>> 0) % 5) - 2;
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise)); // G
        noise = ((((i + 3) * 668265263 + (s3 * 4294967296)) >>> 0) % 5) - 2;
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise)); // B
      }
    }
    ctx.putImageData(imageData, 0, 0);
  } catch(e) {
    // Canvas tainted or other error — skip silently
  }
}

var _spoofedToDataURL = function toDataURL() {
  _applyCanvasNoise(this);
  return _origToDataURL.apply(this, arguments);
};
_registerNative(_spoofedToDataURL, "toDataURL");
HTMLCanvasElement.prototype.toDataURL = _spoofedToDataURL;

var _spoofedToBlob = function toBlob(callback) {
  _applyCanvasNoise(this);
  return _origToBlob.apply(this, arguments);
};
_registerNative(_spoofedToBlob, "toBlob");
HTMLCanvasElement.prototype.toBlob = _spoofedToBlob;

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 5: WebGL parameter spoofing
// ═══════════════════════════════════════════════════════════════════════
var UNMASKED_VENDOR  = 0x9245;
var UNMASKED_RENDERER = 0x9246;

function _patchWebGL(proto) {
  if (!proto) return;
  var _origGetParam = proto.getParameter;
  var _spoofedGetParam = function getParameter(pname) {
    if (pname === UNMASKED_VENDOR) return C.glVendor;
    if (pname === UNMASKED_RENDERER) return C.glRenderer;
    return _origGetParam.call(this, pname);
  };
  _registerNative(_spoofedGetParam, "getParameter");
  proto.getParameter = _spoofedGetParam;
}

if (typeof WebGLRenderingContext !== "undefined") {
  _patchWebGL(WebGLRenderingContext.prototype);
}
if (typeof WebGL2RenderingContext !== "undefined") {
  _patchWebGL(WebGL2RenderingContext.prototype);
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 6: AudioContext fingerprint noise (lazy)
// ═══════════════════════════════════════════════════════════════════════
var _audioPatched = false;

function _patchAudioBuffer() {
  if (_audioPatched) return;
  _audioPatched = true;
  var _origGetChannelData = AudioBuffer.prototype.getChannelData;
  var _spoofedGetChannelData = function getChannelData(channel) {
    var data = _origGetChannelData.call(this, channel);
    // Add tiny noise based on config seed
    var gain = C.audioNoiseGain;
    var seed = C.audioNoiseSeed;
    for (var i = 0; i < data.length; i += 100) {
      var noise = ((((i + 1) * 2654435761 + (seed * 4294967296)) >>> 0) / 4294967296 - 0.5) * gain;
      data[i] += noise;
    }
    return data;
  };
  _registerNative(_spoofedGetChannelData, "getChannelData");
  AudioBuffer.prototype.getChannelData = _spoofedGetChannelData;
}

if (typeof OfflineAudioContext !== "undefined") {
  var _OrigOfflineAudioCtx = OfflineAudioContext;
  var _SpoofedOfflineAudioCtx = function OfflineAudioContext() {
    _patchAudioBuffer();
    return new (Function.prototype.bind.apply(_OrigOfflineAudioCtx, [null].concat(Array.prototype.slice.call(arguments))))();
  };
  _SpoofedOfflineAudioCtx.prototype = _OrigOfflineAudioCtx.prototype;
  _registerNative(_SpoofedOfflineAudioCtx, "OfflineAudioContext");
  window.OfflineAudioContext = _SpoofedOfflineAudioCtx;
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 7: WebRTC leak prevention
// ═══════════════════════════════════════════════════════════════════════
if (typeof RTCPeerConnection !== "undefined") {
  var _OrigRTC = RTCPeerConnection;
  var _SpoofedRTC = function RTCPeerConnection(config, constraints) {
    if (config && config.iceServers) {
      config = Object.assign({}, config, { iceServers: [] });
    }
    if (arguments.length > 1) {
      return new _OrigRTC(config, constraints);
    }
    return new _OrigRTC(config);
  };
  _SpoofedRTC.prototype = _OrigRTC.prototype;
  _SpoofedRTC.generateCertificate = _OrigRTC.generateCertificate;
  _registerNative(_SpoofedRTC, "RTCPeerConnection");
  window.RTCPeerConnection = _SpoofedRTC;
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 8: getBoundingClientRect / getClientRects noise
// ═══════════════════════════════════════════════════════════════════════
var _skipRectTags = { SELECT: 1, OPTION: 1, DATALIST: 1 };
var _rectOffset = C.rectOffset;

var _origGetBCR = Element.prototype.getBoundingClientRect;
var _spoofedGetBCR = function getBoundingClientRect() {
  var rect = _origGetBCR.call(this);
  if (_skipRectTags[this.tagName]) return rect;
  return new DOMRect(
    rect.x + _rectOffset,
    rect.y + _rectOffset,
    rect.width + _rectOffset,
    rect.height + _rectOffset
  );
};
_registerNative(_spoofedGetBCR, "getBoundingClientRect");
Element.prototype.getBoundingClientRect = _spoofedGetBCR;

var _origGetCR = Element.prototype.getClientRects;
var _spoofedGetCR = function getClientRects() {
  var rects = _origGetCR.call(this);
  if (_skipRectTags[this.tagName]) return rects;
  var result = [];
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i];
    result.push(new DOMRect(
      r.x + _rectOffset,
      r.y + _rectOffset,
      r.width + _rectOffset,
      r.height + _rectOffset
    ));
  }
  // Return a DOMRectList-like object
  result.item = function(index) { return result[index] || null; };
  return result;
};
_registerNative(_spoofedGetCR, "getClientRects");
Element.prototype.getClientRects = _spoofedGetCR;

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 9: Battery API
// ═══════════════════════════════════════════════════════════════════════
var _batteryManager = {
  charging: C.batteryCharging,
  chargingTime: C.batteryCharging ? C.batteryChargingTime : Infinity,
  dischargingTime: C.batteryCharging ? Infinity : C.batteryDischargingTime,
  level: C.batteryLevel,
  addEventListener: function() {},
  removeEventListener: function() {},
  dispatchEvent: function() { return true; },
  onchargingchange: null,
  onchargingtimechange: null,
  ondischargingtimechange: null,
  onlevelchange: null
};

if (navigator.getBattery || true) {
  var _spoofedGetBattery = function getBattery() {
    return Promise.resolve(_batteryManager);
  };
  _registerNative(_spoofedGetBattery, "getBattery");
  _defProp(Navigator.prototype, "getBattery", {
    value: _spoofedGetBattery,
    writable: true,
    configurable: true
  }, "getBattery");
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 10: Plugins & MIME types
// ═══════════════════════════════════════════════════════════════════════
function _makePluginArray(plugins) {
  var arr = [];
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    var plugin = {
      name: p.name,
      description: p.description,
      filename: p.filename,
      length: p.mimeTypes ? p.mimeTypes.length : 0
    };
    if (p.mimeTypes) {
      for (var j = 0; j < p.mimeTypes.length; j++) {
        plugin[j] = p.mimeTypes[j];
      }
    }
    arr.push(plugin);
  }
  arr.item = function(i) { return arr[i] || null; };
  arr.namedItem = function(name) {
    for (var k = 0; k < arr.length; k++) {
      if (arr[k].name === name) return arr[k];
    }
    return null;
  };
  arr.refresh = function() {};
  return arr;
}

var _chromePlugins = [
  {
    name: "PDF Viewer",
    description: "Portable Document Format",
    filename: "internal-pdf-viewer",
    mimeTypes: [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null }
    ]
  },
  {
    name: "Chrome PDF Viewer",
    description: "Portable Document Format",
    filename: "internal-pdf-viewer",
    mimeTypes: [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null }
    ]
  },
  {
    name: "Chromium PDF Viewer",
    description: "Portable Document Format",
    filename: "internal-pdf-viewer",
    mimeTypes: [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null }
    ]
  },
  {
    name: "Microsoft Edge PDF Viewer",
    description: "Portable Document Format",
    filename: "internal-pdf-viewer",
    mimeTypes: [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null }
    ]
  },
  {
    name: "WebKit built-in PDF",
    description: "Portable Document Format",
    filename: "internal-pdf-viewer",
    mimeTypes: [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null }
    ]
  }
];

var _pluginArray = _makePluginArray(_chromePlugins);

_defProp(Navigator.prototype, "plugins", {
  get: function() { return _pluginArray; },
  configurable: true,
  enumerable: true
}, "plugins");

// Build mimeTypes from plugins
var _mimeArr = [];
for (var _pi = 0; _pi < _chromePlugins.length; _pi++) {
  var _pl = _chromePlugins[_pi];
  if (_pl.mimeTypes) {
    for (var _mi = 0; _mi < _pl.mimeTypes.length; _mi++) {
      _mimeArr.push(_pl.mimeTypes[_mi]);
    }
  }
}
_mimeArr.item = function(i) { return _mimeArr[i] || null; };
_mimeArr.namedItem = function(type) {
  for (var k = 0; k < _mimeArr.length; k++) {
    if (_mimeArr[k].type === type) return _mimeArr[k];
  }
  return null;
};

_defProp(Navigator.prototype, "mimeTypes", {
  get: function() { return _mimeArr; },
  configurable: true,
  enumerable: true
}, "mimeTypes");

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 11: window.chrome object
// ═══════════════════════════════════════════════════════════════════════
if (!window.chrome) {
  window.chrome = {};
}
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    connect: function() { return { onMessage: { addListener: function(){} }, postMessage: function(){} }; },
    sendMessage: function() {},
    onMessage: { addListener: function(){}, removeListener: function(){} },
    id: undefined
  };
}
if (!window.chrome.app) {
  window.chrome.app = {
    isInstalled: false,
    InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
    RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
    getDetails: function() { return null; },
    getIsInstalled: function() { return false; }
  };
}
if (!window.chrome.csi) {
  window.chrome.csi = function() {
    return {
      startE: Date.now(),
      onloadT: Date.now(),
      pageT: performance.now(),
      tran: 15
    };
  };
  _registerNative(window.chrome.csi, "csi");
}
if (!window.chrome.loadTimes) {
  window.chrome.loadTimes = function() {
    return {
      commitLoadTime: Date.now() / 1000,
      connectionInfo: "h2",
      finishDocumentLoadTime: Date.now() / 1000,
      finishLoadTime: Date.now() / 1000,
      firstPaintAfterLoadTime: 0,
      firstPaintTime: Date.now() / 1000,
      navigationType: "Other",
      npnNegotiatedProtocol: "h2",
      requestTime: Date.now() / 1000,
      startLoadTime: Date.now() / 1000,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true
    };
  };
  _registerNative(window.chrome.loadTimes, "loadTimes");
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 12: navigator.connection (NetworkInformation)
// ═══════════════════════════════════════════════════════════════════════
var _connectionObj = {
  effectiveType: C.connectionEffectiveType,
  downlink: C.connectionDownlink,
  rtt: C.connectionRtt,
  saveData: false,
  addEventListener: function() {},
  removeEventListener: function() {},
  dispatchEvent: function() { return true; },
  onchange: null
};

_defProp(Navigator.prototype, "connection", {
  get: function() { return _connectionObj; },
  configurable: true,
  enumerable: true
}, "connection");

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 13: navigator.storage (StorageManager)
// ═══════════════════════════════════════════════════════════════════════
var _storageManager = {
  estimate: function estimate() {
    return Promise.resolve({
      quota: C.storageQuota,
      usage: C.storageUsage
    });
  },
  persist: function persist() { return Promise.resolve(false); },
  persisted: function persisted() { return Promise.resolve(false); }
};
_registerNative(_storageManager.estimate, "estimate");
_registerNative(_storageManager.persist, "persist");
_registerNative(_storageManager.persisted, "persisted");

_defProp(Navigator.prototype, "storage", {
  get: function() { return _storageManager; },
  configurable: true,
  enumerable: true
}, "storage");

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 14: Error.captureStackTrace (V8 polyfill)
// ═══════════════════════════════════════════════════════════════════════
if (!Error.captureStackTrace) {
  Error.captureStackTrace = function captureStackTrace(targetObject, constructorOpt) {
    var stack = new Error().stack;
    if (stack) {
      Object.defineProperty(targetObject, "stack", {
        value: stack,
        writable: true,
        configurable: true
      });
    }
  };
  _registerNative(Error.captureStackTrace, "captureStackTrace");
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 15: navigator.userAgentData (Client Hints)
// ═══════════════════════════════════════════════════════════════════════
var _uaData = {
  brands: C.uaBrands.map(function(b) { return Object.freeze({ brand: b.brand, version: b.version }); }),
  mobile: C.uaMobile,
  platform: C.uaPlatform,
  getHighEntropyValues: function getHighEntropyValues(hints) {
    var result = {
      brands: C.uaBrands,
      mobile: C.uaMobile,
      platform: C.uaPlatform
    };
    if (hints.indexOf("platformVersion") !== -1) result.platformVersion = C.uaPlatformVersion;
    if (hints.indexOf("architecture") !== -1) result.architecture = C.uaArchitecture;
    if (hints.indexOf("bitness") !== -1) result.bitness = C.uaBitness;
    if (hints.indexOf("model") !== -1) result.model = C.uaModel;
    if (hints.indexOf("fullVersionList") !== -1) result.fullVersionList = C.uaFullVersionList;
    return Promise.resolve(result);
  },
  toJSON: function toJSON() {
    return { brands: C.uaBrands, mobile: C.uaMobile, platform: C.uaPlatform };
  }
};
_registerNative(_uaData.getHighEntropyValues, "getHighEntropyValues");
_registerNative(_uaData.toJSON, "toJSON");

_defProp(Navigator.prototype, "userAgentData", {
  get: function() { return _uaData; },
  configurable: true,
  enumerable: true
}, "userAgentData");

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 16: Permissions & Notifications
// ═══════════════════════════════════════════════════════════════════════
if (navigator.permissions) {
  var _origPermQuery = navigator.permissions.query;
  var _spoofedPermQuery = function query(desc) {
    return Promise.resolve({
      state: "prompt",
      status: "prompt",
      onchange: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; }
    });
  };
  _registerNative(_spoofedPermQuery, "query");
  navigator.permissions.query = _spoofedPermQuery;
}

if (typeof Notification !== "undefined") {
  _defProp(Notification, "permission", {
    get: function() { return "default"; },
    configurable: true,
    enumerable: true
  }, "permission");
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 17: Timezone override
// ═══════════════════════════════════════════════════════════════════════
if (C.timezone) {
  var _OrigDateTimeFormat = Intl.DateTimeFormat;
  var _SpoofedDateTimeFormat = function DateTimeFormat(locales, options) {
    var opts = Object.assign({}, options || {});
    if (!opts.timeZone) {
      opts.timeZone = C.timezone;
    }
    if (this instanceof _SpoofedDateTimeFormat) {
      return new _OrigDateTimeFormat(locales, opts);
    }
    return _OrigDateTimeFormat(locales, opts);
  };
  _SpoofedDateTimeFormat.prototype = _OrigDateTimeFormat.prototype;
  _SpoofedDateTimeFormat.supportedLocalesOf = _OrigDateTimeFormat.supportedLocalesOf;
  _registerNative(_SpoofedDateTimeFormat, "DateTimeFormat");
  Intl.DateTimeFormat = _SpoofedDateTimeFormat;

  if (C.timezoneOffset !== undefined && C.timezoneOffset !== null) {
    var _origGetTZOffset = Date.prototype.getTimezoneOffset;
    var _spoofedGetTZOffset = function getTimezoneOffset() {
      return C.timezoneOffset;
    };
    _registerNative(_spoofedGetTZOffset, "getTimezoneOffset");
    Date.prototype.getTimezoneOffset = _spoofedGetTZOffset;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VECTOR 18: CSS Media Queries (pointer/hover)
// ═══════════════════════════════════════════════════════════════════════
var _origMatchMedia = window.matchMedia;
if (_origMatchMedia) {
  var _mediaOverrides = {
    "(pointer: fine)": true,
    "(pointer: coarse)": false,
    "(pointer: none)": false,
    "(hover: hover)": true,
    "(hover: none)": false,
    "(any-pointer: fine)": true,
    "(any-pointer: coarse)": false,
    "(any-hover: hover)": true,
    "(any-hover: none)": false
  };

  var _spoofedMatchMedia = function matchMedia(query) {
    var q = query.replace(/\\s+/g, " ").trim();
    if (q in _mediaOverrides) {
      return {
        matches: _mediaOverrides[q],
        media: query,
        onchange: null,
        addEventListener: function() {},
        removeEventListener: function() {},
        addListener: function() {},
        removeListener: function() {},
        dispatchEvent: function() { return true; }
      };
    }
    return _origMatchMedia.call(window, query);
  };
  _registerNative(_spoofedMatchMedia, "matchMedia");
  window.matchMedia = _spoofedMatchMedia;
}

})(${configJSON});`;
}
