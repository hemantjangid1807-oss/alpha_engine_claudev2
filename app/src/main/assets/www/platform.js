/*
 * Brain AutoSim - platform layer.
 *
 * Inside the Android app, `window.AndroidBridge` (Java, see NativeBridge.java) does the things a
 * web page cannot: HTTP calls to the BRAIN API without browser CORS limits, timers that keep
 * ticking while the screen is off, private files, sharing, clipboard and the progress
 * notification. In a normal browser (or Node, for tests) everything falls back to web APIs.
 */
(function (G) {
  "use strict";
  const N = G.AndroidBridge || null;
  const isAndroid = !!N;
  let seq = 0;
  const httpWait = new Map();
  const sleepWait = new Map();

  class NetError extends Error {
    constructor(message) { super(message); this.name = "NetError"; }
  }

  // Called by Java when a request finishes / a timer fires.
  G.__nativeDone = function (id, json) {
    const done = httpWait.get(id);
    if (!done) return;
    httpWait.delete(id);
    let r;
    try { r = JSON.parse(json); } catch (e) { r = { error: "Unreadable reply from the app" }; }
    done(r);
  };
  G.__nativeWake = function (id) {
    const done = sleepWait.get(id);
    if (done) { sleepWait.delete(id); done(); }
  };

  function lowerKeys(h) {
    const o = {};
    for (const k in (h || {})) o[k.toLowerCase()] = h[k];
    return o;
  }

  /** HTTP request. Resolves to {status, headers (lower-case keys), body (text), url}. */
  async function http(method, url, opts) {
    const o = opts || {};
    const headers = o.headers || {};
    const body = o.body == null ? null : String(o.body);
    const timeout = o.timeout || 60000;
    if (isAndroid) {
      const r = await new Promise(function (resolve) {
        const id = ++seq;
        httpWait.set(id, resolve);
        try { N.http(id, method, url, JSON.stringify(headers), body, timeout | 0); }
        catch (e) { httpWait.delete(id); resolve({ error: String(e && e.message || e) }); }
      });
      if (r.error) throw new NetError(r.error);
      return { status: r.status, headers: lowerKeys(r.headers), body: r.body || "", url: r.url || url };
    }
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout) : null;
    try {
      const resp = await fetch(url, { method: method, headers: headers, body: body, signal: ctrl ? ctrl.signal : undefined });
      const hh = {};
      resp.headers.forEach(function (v, k) { hh[k.toLowerCase()] = v; });
      return { status: resp.status, headers: hh, body: await resp.text(), url: resp.url || url };
    } catch (e) {
      throw new NetError(e && e.name === "AbortError" ? "Timeout" : (e && e.message) || "Network error");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  http.reset = function () { if (isAndroid) { try { N.clearCookies(); } catch (e) { /* ignore */ } } };

  /** Wait `ms` milliseconds. On Android the timer runs natively so it isn't throttled in the background. */
  function sleep(ms) {
    ms = Math.max(0, Math.round(ms));
    if (isAndroid) {
      return new Promise(function (resolve) {
        const id = ++seq;
        sleepWait.set(id, resolve);
        try { N.sleep(id, ms); } catch (e) { sleepWait.delete(id); setTimeout(resolve, ms); }
      });
    }
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ---- small private files (config.json, history.json, results/run_*.csv ...) -----------------
  const mem = {};
  const hasLS = (function () { try { return typeof localStorage !== "undefined" && !!localStorage; } catch (e) { return false; } })();
  const files = {
    read: function (name) {
      if (isAndroid) { const v = N.readFile(name); return v == null ? null : String(v); }
      if (hasLS) { try { return localStorage.getItem("bas:" + name); } catch (e) { return null; } }
      return Object.prototype.hasOwnProperty.call(mem, name) ? mem[name] : null;
    },
    write: function (name, text) {
      if (isAndroid) return !!N.writeFile(name, String(text));
      if (hasLS) { try { localStorage.setItem("bas:" + name, String(text)); return true; } catch (e) { return false; } }
      mem[name] = String(text); return true;
    },
    append: function (name, text) {
      if (isAndroid) return !!N.appendFile(name, String(text));
      const cur = files.read(name) || "";
      return files.write(name, cur + String(text));
    },
    path: function (name) {
      if (isAndroid) { try { return String(N.filePath(name) || name); } catch (e) { return name; } }
      return name;
    },
  };

  function browserDownload(name, mime, text) {
    if (typeof document === "undefined" || typeof Blob === "undefined") return false;
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    return true;
  }

  function parseResult(s) { try { return JSON.parse(s); } catch (e) { return { ok: false, error: String(s) }; } }

  const Platform = {
    isAndroid: isAndroid,
    NetError: NetError,
    http: http,
    sleep: sleep,
    files: files,
    /** Save a file into Downloads/BrainAutoSim. Returns {ok, path} or {ok:false, error}. */
    saveDownload: function (name, mime, text) {
      if (isAndroid) return parseResult(N.saveToDownloads(name, mime, text));
      return browserDownload(name, mime, text) ? { ok: true, path: "your Downloads folder" } : { ok: false, error: "unsupported" };
    },
    /** Open the Android share sheet for a file. */
    shareFile: function (name, mime, text) {
      if (isAndroid) return !!N.shareFile(name, mime, text);
      return browserDownload(name, mime, text);
    },
    copyText: function (text) {
      if (isAndroid) { try { N.copyText(String(text)); return true; } catch (e) { return false; } }
      return false;
    },
    openUrl: function (url) {
      if (isAndroid) { N.openUrl(String(url)); return; }
      if (typeof window !== "undefined" && window.open) window.open(url, "_blank", "noopener");
    },
    canSaveToDownloads: function () {
      if (!isAndroid) return true;
      try { return !!N.canSaveToDownloads(); } catch (e) { return false; }
    },
    openBatterySettings: function () { if (isAndroid) N.openBatterySettings(); },
    insets: function () {
      if (!isAndroid) return [0, 0];
      try { return String(N.insets()).split(",").map(Number); } catch (e) { return [0, 0]; }
    },
    // ---- run notification (keeps the app working with the screen off) ----
    runStarted: function (total) { if (isAndroid) { try { N.runStarted(total | 0); } catch (e) { /* ignore */ } } },
    runProgress: function (done, total, good) { if (isAndroid) { try { N.runProgress(done | 0, total | 0, good | 0); } catch (e) { /* ignore */ } } },
    runEnded: function (title, text) { if (isAndroid) { try { N.runEnded(String(title), String(text)); } catch (e) { /* ignore */ } } },
  };

  G.Platform = Platform;
})(typeof window !== "undefined" ? window : globalThis);
