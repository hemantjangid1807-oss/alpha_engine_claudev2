/*
 * Brain AutoSim engine - a JavaScript port of brain_autosim.py so the whole simulator runs on
 * the phone. Same behaviour as the desktop app: BRAIN API client (sign-in, biometric step,
 * session refresh, retries, parallel-limit waiting), the multi-worker runner, the demo backend,
 * run state, history ("skip what I already simulated") and CSV output.
 *
 * The UI talks to it through Engine.api(path, body), which mirrors the desktop app's local
 * HTTP routes (/api/login, /api/run, /api/state ...).
 */
(function (G) {
  "use strict";
  const P = G.Platform;

  const API_URL = G.BRAIN_API_URL || "https://api.worldquantbrain.com";
  const PLATFORM_URL = G.BRAIN_URL || "https://platform.worldquantbrain.com";
  const DEMO_URL = "https://demo.brainautosim.local";

  const CSV_COLUMNS = [
    "status", "alpha_id", "type", "expression", "selection", "sharpe", "fitness", "turnover", "returns", "drawdown",
    "margin", "long_count", "short_count", "issues", "error", "region", "universe", "delay",
    "decay", "neutralization", "truncation", "finished", "submission", "link",
  ];

  const NEUTS = ["NONE", "MARKET", "SECTOR", "INDUSTRY", "SUBINDUSTRY"];
  const FALLBACK_OPTIONS = [
    { region: "USA", delay: 1, universes: ["TOP3000", "TOP1000", "TOP500", "TOP200", "ILLIQUID_MINVOL1M"], neutralizations: NEUTS },
    { region: "USA", delay: 0, universes: ["TOP3000", "TOP1000", "TOP500", "TOP200"], neutralizations: NEUTS },
    { region: "EUR", delay: 1, universes: ["TOP2500", "TOP1200", "TOP800", "TOP400", "ILLIQUID_MINVOL1M"], neutralizations: NEUTS },
    { region: "ASI", delay: 1, universes: ["MINVOL1M", "ILLIQUID_MINVOL1M"], neutralizations: NEUTS },
    { region: "GLB", delay: 1, universes: ["TOP3000", "MINVOL1M"], neutralizations: NEUTS },
  ];

  // ------------------------------------------------------------------------------------------ //
  // Errors and small helpers
  // ------------------------------------------------------------------------------------------ //
  class Aborted extends Error { constructor() { super("Cancelled."); this.name = "Aborted"; } }
  class BrainError extends Error { constructor(m) { super(m); this.name = "BrainError"; } }
  class BiometricRequired extends Error {
    constructor(url) { super("BRAIN asks for a biometric check."); this.name = "BiometricRequired"; this.url = url; }
  }

  /** Like threading.Event used for "stop right now": once set, every wait rejects with Aborted. */
  class AbortFlag {
    constructor() {
      this.isSet = false;
      this.promise = new Promise((_, reject) => { this._reject = reject; });
      this.promise.catch(() => {});
    }
    set() { if (!this.isSet) { this.isSet = true; this._reject(new Aborted()); } }
  }

  const nowS = () => Date.now() / 1000;
  const pad2 = x => String(x).padStart(2, "0");
  const hhmmss = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const stamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const ok2xx = r => Math.floor(r.status / 100) === 2;
  const isObj = j => j !== null && typeof j === "object" && !Array.isArray(j);

  function parseJson(text) { try { return JSON.parse(text); } catch (e) { return undefined; } }

  function msgOf(r) {
    const j = parseJson(r.body);
    if (j !== undefined) {
      if (isObj(j)) for (const k of ["message", "detail", "error"]) if (j[k]) return String(j[k]);
      return JSON.stringify(j).slice(0, 300);
    }
    return (r.body || "").trim().slice(0, 300) || `HTTP ${r.status}`;
  }

  function msgJson(j) {
    if (isObj(j)) {
      for (const k of ["message", "detail", "error"]) if (j[k]) return String(j[k]);
      return "Simulation failed: " + JSON.stringify(j).slice(0, 300);
    }
    return String(j).slice(0, 300);
  }

  function retryAfter(r, def) {
    const h = r.headers["retry-after"];
    if (h === undefined) return Math.max(1, def);
    const v = parseFloat(h);
    return isFinite(v) ? Math.max(1, v) : def;
  }

  function readJson(r) {
    const j = parseJson(r.body);
    if (j === undefined) throw new BrainError(`BRAIN sent an unreadable reply (HTTP ${r.status}): ${(r.body || "").trim().slice(0, 120)}`);
    return j;
  }

  function b64(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function stableStringify(v) {
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    if (isObj(v)) return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
    return JSON.stringify(v);
  }

  /** cyrb53: fast, well-mixed 53-bit string hash. */
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  const hashHex = s => cyrb53(s, 1).toString(16).padStart(14, "0") + cyrb53(s, 2).toString(16).padStart(14, "0");
  const hex6 = s => (cyrb53(s, 7) % 0x1000000).toString(16).padStart(6, "0");

  /** Seeded random numbers (mulberry32) with the helpers Python's random.Random offered. */
  function makeRng(seedText) {
    let a = cyrb53(String(seedText)) >>> 0;
    const random = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      random,
      uniform: (lo, hi) => lo + (hi - lo) * random(),
      gauss: (mu, sigma) => {
        let u = 0;
        while (u === 0) u = random();
        return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
      },
      randint: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
    };
  }
  const round = (x, d) => { const f = Math.pow(10, d); return Math.round(x * f) / f; };

  // ------------------------------------------------------------------------------------------ //
  // BRAIN API client
  // ------------------------------------------------------------------------------------------ //
  class BrainClient {
    constructor(apiUrl, log, transport) {
      this.api = apiUrl.replace(/\/+$/, "");
      this.log = log;
      this.transport = transport;
      this.email = null;
      this.password = null;
      this.authHeader = null;
      this.abort = new AbortFlag();
      this._relogin = null;
      this._lastLogin = 0;
      this._lastExpiryCheck = 0;
      this.biometricUrl = null;
    }

    _raw(method, url, opts = {}) {
      const headers = { "Accept": "*/*" };
      if (this.authHeader) headers["Authorization"] = this.authHeader;
      let body = null;
      if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
      const p = this.transport(method, url, { headers, body, timeout: opts.timeout || 60000 });
      return opts.abortable === false ? p : Promise.race([p, this.abort.promise]);
    }

    // ---- auth --------------------------------------------------------------
    async login(email, password) {
      this.email = email;
      this.password = password;
      this.authHeader = "Basic " + b64(email + ":" + password);
      if (this.transport.reset) this.transport.reset();   // fresh session, like requests.Session()
      let r;
      try {
        r = await this._raw("POST", this.api + "/authentication", { timeout: 30000, abortable: false });
      } catch (e) {
        throw new BrainError(`Can't reach the BRAIN server. Check your internet connection. (${e.message || e.name})`);
      }
      if (r.status === 401) {
        if ((r.headers["www-authenticate"] || "") === "persona") {
          this.biometricUrl = new URL(r.headers["location"] || "", r.url).href;
          throw new BiometricRequired(this.biometricUrl);
        }
        throw new BrainError("Incorrect email or password.");
      }
      if (!ok2xx(r)) throw new BrainError(`Sign-in failed (HTTP ${r.status}): ${msgOf(r)}`);
      this._lastLogin = nowS();
    }

    async finishBiometric() {
      for (let i = 0; i < 3; i++) {
        const r = await this._raw("POST", this.biometricUrl, { timeout: 30000, abortable: false });
        if (r.status === 201) { this._lastLogin = nowS(); return true; }
        await P.sleep(1500);
      }
      return false;
    }

    relogin(force = false) {
      if (this._relogin) return this._relogin;
      if (!force && nowS() - this._lastLogin < 20) return Promise.resolve();
      this._relogin = (async () => {
        this.log("info", "Refreshing your BRAIN session...");
        try {
          await this.login(this.email, this.password);
        } catch (e) {
          if (e instanceof BiometricRequired) throw new BrainError("BRAIN asks for biometric confirmation again. Stop, sign in again, then restart.");
          throw e;
        }
      })().finally(() => { this._relogin = null; });
      return this._relogin;
    }

    async secondsLeft() {
      try {
        const r = await this._raw("GET", this.api + "/authentication", { timeout: 30000 });
        return Math.floor(Number(JSON.parse(r.body).token.expiry)) || 0;
      } catch (e) {
        if (e instanceof Aborted) throw e;
        return 0;
      }
    }

    async ensureSession() {
      if (nowS() - this._lastExpiryCheck < 240) return;
      this._lastExpiryCheck = nowS();
      if (await this.secondsLeft() < 1500) await this.relogin(true);
    }

    // ---- plumbing ----------------------------------------------------------
    async sleep(seconds) {
      if (this.abort.isSet) throw new Aborted();
      await Promise.race([P.sleep(seconds * 1000), this.abort.promise]);
    }

    async request(method, path, opts = {}) {
      const retries = opts.retries === undefined ? 3 : opts.retries;
      let url = /^https?:/i.test(path) ? path : this.api + path;
      if (opts.params) {
        const qs = new URLSearchParams();
        for (const k of Object.keys(opts.params)) qs.append(k, String(opts.params[k]));
        url += (url.includes("?") ? "&" : "?") + qs.toString();
      }
      let err = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (this.abort.isSet) throw new Aborted();
        let r;
        try {
          r = await this._raw(method, url, { json: opts.json, timeout: opts.timeout || 60000 });
        } catch (e) {
          if (e instanceof Aborted) throw e;
          err = e;
          this.log("warn", `Network hiccup (${(e.message || e.name || "error").split(":")[0]}). Retrying...`);
          await this.sleep(Math.min(3 * (attempt + 1), 15));
          continue;
        }
        if (r.status === 401 && attempt < retries) { await this.relogin(); continue; }
        return r;
      }
      throw new BrainError(`Network problem: ${err ? err.message : "unknown"}`);
    }

    /** GET that honours Retry-After (BRAIN uses it while it is still computing). */
    async _getJsonWaiting(path, tries = 60) {
      let r = null;
      for (let i = 0; i < tries; i++) {
        r = await this.request("GET", path);
        if ("retry-after" in r.headers) { await this.sleep(Math.min(Math.max(retryAfter(r, 2), 1), 20)); continue; }
        return r;
      }
      return r;
    }

    // ---- simulations -------------------------------------------------------
    async startSimulation(payload) {
      for (let attempt = 0; attempt < 15; attempt++) {
        await this.ensureSession();
        const r = await this.request("POST", "/simulations", { json: payload });
        if (r.status === 429) {
          const wait = retryAfter(r, 8 + attempt * 4);
          this.log("info", `BRAIN is at its parallel-simulation limit. Waiting ${Math.round(wait)}s, then trying again...`);
          await this.sleep(wait);
          continue;
        }
        return r;
      }
      throw new BrainError("Your account stayed at its simulation limit. Lower 'Parallel simulations' in Settings.");
    }

    async poll(location) {
      let errors = 0;
      for (;;) {
        const r = await this.request("GET", location);
        if (!ok2xx(r)) {
          errors++;
          if (errors > 3) throw new BrainError(`BRAIN returned HTTP ${r.status} while waiting: ${msgOf(r)}`);
          await this.sleep(10);
          continue;
        }
        if ("retry-after" in r.headers) { await this.sleep(Math.min(Math.max(retryAfter(r, 2), 1), 20)); continue; }
        return readJson(r);
      }
    }

    async getAlpha(alphaId) {
      const r = await this._getJsonWaiting(`/alphas/${alphaId}`);
      const j = parseJson(r.body);
      if (j === undefined) throw new BrainError(`Could not read alpha ${alphaId}: ${msgOf(r)}`);
      return j;
    }

    async simulateOne(payload) {
      const r = await this.startSimulation(payload);
      if (!ok2xx(r)) return [null, `BRAIN rejected this alpha: ${msgOf(r)}`];
      const loc = r.headers["location"];
      if (!loc) return [null, "BRAIN did not return a progress link."];
      const data = await this.poll(loc);
      const alphaId = data && data.alpha;
      if (["ERROR", "FAIL"].includes(data && data.status) || !alphaId) return [null, msgJson(data)];
      return [await this.getAlpha(alphaId), null];
    }

    async simulateMany(payloads) {
      const n = payloads.length;
      const fill = m => Array.from({ length: n }, () => [null, m]);
      const r = await this.startSimulation(payloads);
      if (!ok2xx(r)) return fill(`BRAIN rejected this batch: ${msgOf(r)}`);
      const loc = r.headers["location"];
      if (!loc) return fill("BRAIN did not return a progress link.");
      const parent = await this.poll(loc);
      const children = (parent && parent.children) || [];
      if (!children.length) return fill(msgJson(parent));
      const out = [];
      for (const cid of children) {
        const c = await this.poll(/^http/i.test(String(cid)) ? String(cid) : `/simulations/${cid}`);
        const aid = c && c.alpha;
        if (["ERROR", "FAIL"].includes(c && c.status) || !aid) out.push([null, msgJson(c)]);
        else out.push([await this.getAlpha(aid), null]);
      }
      return BrainClient.align(payloads, out);
    }

    static align(payloads, results) {
      const n = payloads.length;
      if (results.length !== n) {
        results = results.concat(Array.from({ length: Math.max(0, n - results.length) },
          () => [null, "BRAIN returned fewer results than expected."])).slice(0, n);
      }
      const code = a => { try { return String(((a && a.regular) || {}).code || "").trim(); } catch (e) { return ""; } };
      if (results.every(([a], i) => a === null || code(a) === payloads[i].regular.trim())) return results;
      const pool = results.slice();
      const aligned = new Array(n).fill(null);
      payloads.forEach((p, i) => {
        for (let j = 0; j < pool.length; j++) {
          const a = pool[j][0];
          const st = (a && a.settings) || {};
          if (a !== null && code(a) === p.regular.trim() && st.decay === p.settings.decay && st.neutralization === p.settings.neutralization) {
            aligned[i] = pool.splice(j, 1)[0];
            break;
          }
        }
      });
      for (let i = 0; i < n; i++) if (aligned[i] === null) aligned[i] = pool.length ? pool.shift() : [null, "Result could not be matched."];
      return aligned;
    }

    // ---- submission checks and submitting -----------------------------------
    /** BRAIN's full pre-submission checks (incl. correlation). The first replies are often empty while it computes. */
    async checkAlpha(alphaId, maxTries = 90) {
      for (let i = 0; i < maxTries; i++) {
        const r = await this.request("GET", `/alphas/${alphaId}/check`);
        if ("retry-after" in r.headers) { await this.sleep(Math.min(Math.max(retryAfter(r, 2), 1), 20)); continue; }
        if (r.status === 404) throw new BrainError(`BRAIN doesn't know alpha ${alphaId}.`);
        if (r.status === 429) { await this.sleep(retryAfter(r, 10)); continue; }
        if (!ok2xx(r)) throw new BrainError(`BRAIN couldn't check this alpha: ${msgOf(r)}`);
        const j = (r.body || "").trim() ? parseJson(r.body) : undefined;
        if (j === undefined) { await this.sleep(3); continue; }   // still computing
        return ((j.is || {}).checks) || [];
      }
      throw new BrainError("BRAIN is still computing the checks. Try again in a minute.");
    }

    async checkSubmission(alphaId) {
      try { return await this.checkAlpha(alphaId, 40); } catch (e) { if (e instanceof Aborted) throw e; return null; }
    }

    /**
     * Submit an alpha: POST /alphas/{id}/submit (201 queued, 400 already queued, 403 a check failed),
     * then poll GET on the same address until Retry-After goes away, then confirm the alpha is ACTIVE.
     */
    async submitAlpha(alphaId) {
      const path = `/alphas/${alphaId}/submit`;
      const failed = r => {
        const j = parseJson(r.body);
        const checks = (isObj(j) && isObj(j.is) && j.is.checks) || [];
        const fails = checks.filter(c => c.result === "FAIL").map(c => String(c.name).replace(/_/g, " ").toLowerCase());
        return { ok: false, checks, message: fails.length ? `BRAIN didn't accept it. Failed: ${fails.join(", ")}.` : `BRAIN didn't accept it: ${msgOf(r)}` };
      };
      let r;
      for (let a = 0; a < 6; a++) {
        r = await this.request("POST", path);
        if (r.status !== 429) break;
        await this.sleep(retryAfter(r, 10));
      }
      if (r.status === 403) return failed(r);
      if (!ok2xx(r) && r.status !== 400) return { ok: false, message: `BRAIN refused the submission (HTTP ${r.status}): ${msgOf(r)}` };
      let done = false, checks = [];
      for (let i = 0; i < 240 && !done; i++) {
        await this.sleep("retry-after" in r.headers ? Math.min(Math.max(retryAfter(r, 2), 1), 20) : 2);
        r = await this.request("GET", path);
        if (r.status === 403) return failed(r);
        if (r.status === 429) continue;
        if (!ok2xx(r)) return { ok: false, message: `BRAIN said (HTTP ${r.status}): ${msgOf(r)}` };
        if (!("retry-after" in r.headers)) {
          done = true;
          const j = parseJson(r.body);
          checks = (isObj(j) && isObj(j.is) && j.is.checks) || [];
        }
      }
      if (!done) return { ok: false, pending: true, message: "BRAIN is still processing the submission. Look at the alpha on the BRAIN website in a few minutes." };
      let status = null;
      try { status = (await this.getAlpha(alphaId)).status || null; } catch (e) { if (e instanceof Aborted) throw e; }
      if (status && status !== "ACTIVE") {
        return { ok: false, status, checks, message: `BRAIN finished, but the alpha is ${status}, not ACTIVE. It most likely failed a check such as self-correlation.` };
      }
      return { ok: true, status: status || "ACTIVE", checks, message: "Submitted. The alpha is now ACTIVE on BRAIN." };
    }

    async getPnl(alphaId) {
      const r = await this._getJsonWaiting(`/alphas/${alphaId}/recordsets/pnl`);
      const j = readJson(r);
      const recs = j.records || [];
      const names = ((j.schema || {}).properties || []).map(p => p.name);
      const di = names.includes("date") ? names.indexOf("date") : 0;
      const vi = names.includes("pnl") ? names.indexOf("pnl") : 1;
      return { dates: recs.map(x => String(x[di])), values: recs.map(x => x[vi]) };
    }

    setProperties(alphaId, props) { return this.request("PATCH", `/alphas/${alphaId}`, { json: props }); }

    async _paged(path, params) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const r = await this.request("GET", path, { params });
        if (r.status === 429) { await this.sleep(retryAfter(r, 5 + attempt * 5)); continue; }
        if (!ok2xx(r)) throw new BrainError(`BRAIN said: ${msgOf(r)}`);
        return readJson(r);
      }
      throw new BrainError("BRAIN is rate-limiting requests. Wait a minute and try again.");
    }

    datafields(region, delay, universe, search = "", dataset = "", offset = 0, limit = 50) {
      const p = { instrumentType: "EQUITY", region, delay, universe, limit, offset };
      if (search) p.search = search;
      if (dataset) p["dataset.id"] = dataset;
      return this._paged("/data-fields", p);
    }

    datasets(region, delay, universe, search = "", offset = 0, limit = 50) {
      const p = { instrumentType: "EQUITY", region, delay, universe, limit, offset };
      if (search) p.search = search;
      return this._paged("/data-sets", p);
    }

    async operators() {
      const r = await this.request("GET", "/operators");
      if (!ok2xx(r)) throw new BrainError(`BRAIN said: ${msgOf(r)}`);
      return readJson(r);
    }

    async settingOptions() {
      try {
        const r = await this.request("OPTIONS", "/simulations");
        const ch = JSON.parse(r.body).actions.POST.settings.children;
        const byLabel = {};
        for (const v of Object.values(ch)) if (v && v.type === "choice") byLabel[v.label] = v.choices;
        const regionD = byLabel["Region"].instrumentType.EQUITY;
        const uniD = byLabel["Universe"].instrumentType.EQUITY.region;
        const delayD = byLabel["Delay"].instrumentType.EQUITY.region;
        const neutD = byLabel["Neutralization"].instrumentType.EQUITY.region;
        const rows = [];
        for (const reg of regionD) {
          const rv = reg.value;
          for (const d of delayD[rv]) {
            rows.push({ region: rv, delay: d.value, universes: uniD[rv].map(u => u.value), neutralizations: neutD[rv].map(x => x.value) });
          }
        }
        if (rows.length) return { source: "live", rows };
      } catch (e) {
        this.log("warn", `Couldn't load the live settings list (${e.name || "error"}); using common defaults.`);
      }
      return { source: "fallback", rows: FALLBACK_OPTIONS };
    }
  }

  // ------------------------------------------------------------------------------------------ //
  // Turning BRAIN results into table rows
  // ------------------------------------------------------------------------------------------ //
  function jobKey(payload) {
    const p = JSON.parse(JSON.stringify(payload));
    if (p.settings) delete p.settings.visualization;
    return hashHex(stableStringify(p));
  }

  function recomputeStatus(row, th) {
    const checks = row.checks || [];
    row.fails = checks.filter(c => c.result === "FAIL").map(c => c.name);
    row.warns = checks.filter(c => c.result === "WARNING").map(c => c.name);
    row.pending = checks.filter(c => c.result === "PENDING").map(c => c.name);
    if (row.sharpe === null || row.sharpe === undefined) row.status = "error";
    else if (row.fails.length) row.status = "issues";
    else if ((row.sharpe || 0) >= th.sharpe && (row.fitness || 0) >= th.fitness) row.status = "good";
    else row.status = "passed";
  }

  function makeRow(job, alpha, err, th) {
    const p = job.payload, s = p.settings;
    const isSuper = p.type === "SUPER";
    const row = {
      alpha_id: null, type: isSuper ? "SUPER" : "REGULAR", expression: isSuper ? p.combo : p.regular,
      selection: isSuper ? p.selection : "", submission: "", region: s.region, universe: s.universe,
      delay: s.delay, decay: s.decay, neutralization: s.neutralization, truncation: s.truncation,
      sharpe: null, fitness: null, turnover: null, returns: null, drawdown: null, margin: null,
      long_count: null, short_count: null, checks: [], fails: [], warns: [], pending: [],
      status: "error", error: err || "", finished: hhmmss(), train_sharpe: null,
    };
    if (alpha) {
      const is_ = alpha.is || {};
      if (!Object.keys(is_).length) {
        row.error = "BRAIN finished but returned no results for this alpha.";
      } else {
        const v = x => (x === undefined ? null : x);
        Object.assign(row, {
          alpha_id: v(alpha.id), sharpe: v(is_.sharpe), fitness: v(is_.fitness), turnover: v(is_.turnover),
          returns: v(is_.returns), drawdown: v(is_.drawdown), margin: v(is_.margin),
          long_count: v(is_.longCount), short_count: v(is_.shortCount), checks: is_.checks || [], error: "",
        });
        row.train_sharpe = v((alpha.train || {}).sharpe);
      }
    }
    recomputeStatus(row, th);
    return row;
  }

  function rowToCsv(row) {
    const link = row.alpha_id && !String(row.alpha_id).startsWith("DEMO") ? `${PLATFORM_URL}/alpha/${row.alpha_id}` : "";
    const d = {};
    for (const k of CSV_COLUMNS) d[k] = row[k];
    d.issues = (row.fails || []).join("; ");
    d.link = link;
    return d;
  }

  function csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const csvLine = d => CSV_COLUMNS.map(k => csvCell(d[k])).join(",") + "\r\n";
  const CSV_HEADER = CSV_COLUMNS.join(",") + "\r\n";

  // ------------------------------------------------------------------------------------------ //
  // The runner: many alphas, several at a time
  // ------------------------------------------------------------------------------------------ //
  class Runner {
    constructor(client, jobs, opts, emitRow, emitLog, onFinish) {
      this.client = client;
      this.opts = opts;
      this.emitRow = emitRow;
      this.emitLog = emitLog;
      this.onFinish = onFinish;
      this.th = { sharpe: Number(opts.minSharpe), fitness: Number(opts.minFitness) };
      const anySuper = jobs.some(j => j.payload.type === "SUPER");   // multi-simulation is for regular alphas only
      const size = opts.multi && !anySuper ? Number(opts.batch) : 1;
      this.q = [];
      for (let i = 0; i < jobs.length; i += size) this.q.push(jobs.slice(i, i + size));
      this.stopFlag = false;
      this.paused = false;
      this._resumeWaiters = [];
      client.abort = new AbortFlag();
    }

    start() {
      const workers = [];
      for (let i = 0; i < Number(this.opts.workers); i++) {
        workers.push(this._worker().catch(e => this.emitLog("error", `Problem: ${e && e.message}`)));
      }
      Promise.all(workers).then(() => this.onFinish(this.stopFlag || this.client.abort.isSet));
    }

    pause() { this.paused = true; }
    unpause() { this.paused = false; const w = this._resumeWaiters.splice(0); w.forEach(f => f()); }
    stop() { this.stopFlag = true; this.unpause(); }
    abortNow() { this.stop(); this.client.abort.set(); }

    async _worker() {
      for (;;) {
        while (this.paused) {
          if (this.stopFlag) return;
          await new Promise(resolve => this._resumeWaiters.push(resolve));
        }
        if (this.stopFlag) return;
        const batch = this.q.shift();
        if (!batch) return;
        try {
          await this._runBatch(batch);
        } catch (e) {
          if (e instanceof Aborted) return;
          const m = (e && e.message) || String(e);
          this.emitLog("error", `Problem: ${m}`);
          for (const job of batch) this.emitRow(makeRow(job, null, m, this.th), job);
        }
      }
    }

    async _runBatch(batch) {
      const payloads = batch.map(j => j.payload);
      const results = batch.length === 1 ? [await this.client.simulateOne(payloads[0])] : await this.client.simulateMany(payloads);
      for (let i = 0; i < batch.length; i++) {
        const job = batch[i];
        const [alpha, err] = results[i] || [null, "No result."];
        const row = makeRow(job, alpha, err, this.th);
        if (row.alpha_id) {
          try {
            await this._after(row);
          } catch (e) {
            if (e instanceof Aborted) throw e;
            this.emitLog("warn", `Extra steps for ${row.alpha_id} failed: ${e && e.message}`);
          }
        }
        this.emitRow(row, job);
      }
    }

    async _after(row) {
      if (this.opts.deepChecks && (row.status === "good" || row.status === "passed")) {
        const checks = await this.client.checkSubmission(row.alpha_id);
        if (checks && checks.length) { row.checks = checks; recomputeStatus(row, this.th); }
      }
      if (this.opts.colorTag) {
        if (row.status === "good") await this.client.setProperties(row.alpha_id, { color: "GREEN" });
        else if (row.status === "issues" && (row.train_sharpe || row.sharpe || 0) > 0.7) await this.client.setProperties(row.alpha_id, { color: "YELLOW" });
      }
    }
  }

  // ------------------------------------------------------------------------------------------ //
  // Demo backend (fake BRAIN) so beginners can try the app without an account
  // ------------------------------------------------------------------------------------------ //
  const MOCK_FIELDS = [
    ["close", "Daily close price", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["open", "Daily open price", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["high", "Daily high price", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["low", "Daily low price", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["volume", "Daily trading volume", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["vwap", "Daily volume weighted average price", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["returns", "Daily close-to-close return", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["cap", "Daily market capitalisation", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["adv20", "Average daily volume over 20 days", "pv1", "Price Volume Data for Equity", "MATRIX", 0.99],
    ["assets", "Total assets", "fundamental6", "Company Fundamental Data for Equity", "MATRIX", 0.93],
    ["sales", "Net sales / revenue", "fundamental6", "Company Fundamental Data for Equity", "MATRIX", 0.93],
    ["ebitda", "Earnings before interest, taxes, depreciation and amortisation", "fundamental6", "Company Fundamental Data for Equity", "MATRIX", 0.9],
    ["liabilities", "Total liabilities", "fundamental6", "Company Fundamental Data for Equity", "MATRIX", 0.93],
    ["net_income", "Net income", "fundamental6", "Company Fundamental Data for Equity", "MATRIX", 0.93],
    ["nws18_acb", "News: average sentiment (demo vector field)", "news18", "Ravenpack News Data", "VECTOR", 0.55],
    ["nws18_bee", "News: event relevance (demo vector field)", "news18", "Ravenpack News Data", "VECTOR", 0.55],
    ["industry", "Industry classification", "pv1", "Price Volume Data for Equity", "GROUP", 1.0],
    ["sector", "Sector classification", "pv1", "Price Volume Data for Equity", "GROUP", 1.0],
    ["subindustry", "Sub-industry classification", "pv1", "Price Volume Data for Equity", "GROUP", 1.0],
    ["equity", "Total shareholder equity", "fundamental6", "Company Fundamental Data for Equity", "MATRIX", 0.92],
    ["cashflow_op", "Operating cash flow", "fundamental6", "Company Fundamental Data for Equity", "MATRIX", 0.9],
    ["debt", "Total debt", "fundamental6", "Company Fundamental Data for Equity", "MATRIX", 0.88],
    ["anl4_eps_mean", "Analyst EPS estimate, mean of all analysts", "analyst4", "Analyst Estimate Data for Equity", "MATRIX", 0.86],
    ["anl4_eps_std", "Spread of analyst EPS estimates", "analyst4", "Analyst Estimate Data for Equity", "MATRIX", 0.8],
    ["anl4_rev_mean", "Analyst revenue estimate, mean", "analyst4", "Analyst Estimate Data for Equity", "MATRIX", 0.85],
    ["anl4_rec_mean", "Average analyst recommendation (1 = strong buy)", "analyst4", "Analyst Estimate Data for Equity", "MATRIX", 0.78],
    ["anl4_eps_rev", "Upward minus downward EPS revisions", "analyst4", "Analyst Estimate Data for Equity", "MATRIX", 0.74],
    ["anl4_target_px", "Analyst target prices (demo vector field)", "analyst4", "Analyst Estimate Data for Equity", "VECTOR", 0.6],
    ["mdl16_value", "Value score", "model16", "Fundamental Scores (demo model data)", "MATRIX", 0.9],
    ["mdl16_growth", "Growth score", "model16", "Fundamental Scores (demo model data)", "MATRIX", 0.9],
    ["mdl16_quality", "Quality score", "model16", "Fundamental Scores (demo model data)", "MATRIX", 0.88],
    ["mdl16_momentum", "Momentum score", "model16", "Fundamental Scores (demo model data)", "MATRIX", 0.9],
    ["mdl16_risk", "Risk score", "model16", "Fundamental Scores (demo model data)", "MATRIX", 0.85],
  ];
  const MOCK_CATEGORIES = { pv1: ["pv", "Price Volume"], fundamental6: ["fundamental", "Fundamental"], analyst4: ["analyst", "Analyst"], model16: ["model", "Model"], news18: ["news", "News"] };
  const MOCK_OPERATORS = [
    ["abs(x)", "Arithmetic", "abs(x)", "Absolute value of x"],
    ["log(x)", "Arithmetic", "log(x)", "Natural logarithm"],
    ["sign(x)", "Arithmetic", "sign(x)", "+1, 0 or -1 depending on the sign of x"],
    ["rank", "Cross Sectional", "rank(x, rate=2)", "Ranks the input among all stocks, scaled to 0..1"],
    ["zscore", "Cross Sectional", "zscore(x)", "Cross-sectional z-score"],
    ["scale", "Cross Sectional", "scale(x, scale=1)", "Scale so absolute values sum to 1"],
    ["ts_delta", "Time Series", "ts_delta(x, d)", "x today minus x d days ago"],
    ["ts_delay", "Time Series", "ts_delay(x, d)", "Value of x d days ago"],
    ["ts_mean", "Time Series", "ts_mean(x, d)", "Average of x over the last d days"],
    ["ts_std_dev", "Time Series", "ts_std_dev(x, d)", "Standard deviation of x over d days"],
    ["ts_zscore", "Time Series", "ts_zscore(x, d)", "Z-score of x within its own last d days"],
    ["ts_rank", "Time Series", "ts_rank(x, d)", "Rank of today's x among its last d days"],
    ["ts_corr", "Time Series", "ts_corr(x, y, d)", "Correlation of x and y over d days"],
    ["ts_sum", "Time Series", "ts_sum(x, d)", "Sum of x over d days"],
    ["ts_decay_linear", "Time Series", "ts_decay_linear(x, d)", "Linearly decaying weighted average"],
    ["group_rank", "Group", "group_rank(x, group)", "Rank within each group (industry, sector...)"],
    ["group_neutralize", "Group", "group_neutralize(x, group)", "Subtract the group mean"],
    ["vec_avg", "Vector", "vec_avg(x)", "Average of a vector field (turns it into a normal field)"],
    ["vec_sum", "Vector", "vec_sum(x)", "Sum of a vector field"],
    ["winsorize", "Cross Sectional", "winsorize(x, std=4)", "Clip outliers"],
    ["if_else", "Logical", "if_else(cond, a, b)", "a where cond is true, else b"],
    ["add", "Arithmetic", "add(x, y)", "x + y"],
    ["subtract", "Arithmetic", "subtract(x, y)", "x - y"],
    ["multiply", "Arithmetic", "multiply(x, y)", "x * y"],
    ["divide", "Arithmetic", "divide(x, y)", "x / y"],
    ["group_zscore", "Group", "group_zscore(x, group)", "Z-score within each group"],
    ["vec_max", "Vector", "vec_max(x)", "Largest value of a vector field"],
    ["vec_min", "Vector", "vec_min(x)", "Smallest value of a vector field"],
    ["ts_backfill", "Time Series", "ts_backfill(x, d)", "Fill missing values with the last value within d days"],
    ["reverse", "Arithmetic", "reverse(x)", "-x"],
    ["power", "Arithmetic", "power(x, y)", "x to the power y"],
  ];
  const MOCK_GROUPS = new Set(["industry", "sector", "subindustry", "market", "country", "exchange", "true", "false", "nan"]);

  class MockBrain {
    constructor(cap = 6) {
      this.sims = {};
      this.cap = cap;
      this.counter = 0;
      this.checkCalls = {};
      this.submits = {};
      this.submitted = {};
      this.url = DEMO_URL;
      this.transport = (method, url, opts) => this.handle(method, url, opts || {});
    }

    async handle(method, url, opts) {
      await P.sleep(30 + Math.random() * 70);   // a little network-like latency
      const u = new URL(url);
      const send = (status, obj, headers) => {
        const h = { "content-type": "application/json" };
        for (const k in (headers || {})) h[k.toLowerCase()] = headers[k];
        return { status, headers: h, body: JSON.stringify(obj === undefined ? {} : obj), url };
      };
      const body = opts.body ? parseJson(opts.body) : null;
      if (method === "OPTIONS") return send(200, this._options());
      if (method === "PATCH") return send(200, { ok: true });
      if (method === "POST") return this._post(u.pathname, body, send);
      if (method === "GET") return this._get(u.pathname, u.searchParams, send);
      return send(404, { detail: "not found" });
    }

    _validate(expr) {
      if ((expr.match(/\(/g) || []).length !== (expr.match(/\)/g) || []).length) {
        return "Unbalanced parentheses: check that every ( has a matching ).";
      }
      const ops = new Set(MOCK_OPERATORS.map(o => o[0].split("(")[0]));
      const names = new Set(MOCK_FIELDS.map(f => f[0]));
      const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(\(|=)?/g;
      let m;
      while ((m = re.exec(expr))) {
        const word = m[1], nxt = m[2];
        if (nxt === "(") { if (!ops.has(word)) return `Attempted to use unknown operator "${word}".`; }
        else if (nxt === "=") continue;
        else if (!names.has(word) && !MOCK_GROUPS.has(word)) return `Attempted to use unknown variable "${word}".`;
      }
      return null;
    }

    _validateSuper(p) {
      const sel = String(p.selection || "").trim(), combo = String(p.combo || "").trim();
      if (!sel || !combo) return "A super alpha needs both a selection and a combo expression.";
      for (const [what, e] of [["selection", sel], ["combo", combo]]) {
        if ((e.match(/\(/g) || []).length !== (e.match(/\)/g) || []).length) return `Unbalanced parentheses in the ${what} expression.`;
      }
      if (!(p.settings && p.settings.selectionLimit > 0)) return "selectionLimit must be above 0.";
      return null;
    }

    _makeAlpha(payload, aid) {
      const rng = makeRng(stableStringify(payload));
      const st = payload.settings;
      const isSuper = payload.type === "SUPER";
      const dec = Math.min(st.decay || 0, 20);
      let sharpe = rng.gauss(0.85, 0.8) + dec * 0.015 + (isSuper ? 0.6 : 0);
      if (st.neutralization === "INDUSTRY" || st.neutralization === "SUBINDUSTRY") sharpe += 0.2;
      const turnover = Math.max(0.02, Math.min(0.9, rng.gauss(0.28, 0.18) - dec * 0.008));
      const returns = sharpe * rng.uniform(0.02, 0.04);
      const fitness = sharpe * Math.sqrt(Math.abs(returns) / Math.max(turnover, 0.125));
      const checks = [
        { name: "LOW_SHARPE", result: sharpe >= 1.25 ? "PASS" : "FAIL", limit: 1.25, value: round(sharpe, 2) },
        { name: "LOW_FITNESS", result: fitness >= 1.0 ? "PASS" : "FAIL", limit: 1.0, value: round(fitness, 2) },
        { name: "LOW_TURNOVER", result: turnover >= 0.01 ? "PASS" : "FAIL", limit: 0.01, value: round(turnover, 4) },
        { name: "HIGH_TURNOVER", result: turnover <= 0.7 ? "PASS" : "FAIL", limit: 0.7, value: round(turnover, 4) },
        { name: "CONCENTRATED_WEIGHT", result: rng.random() > 0.05 ? "PASS" : "FAIL" },
        { name: "LOW_SUB_UNIVERSE_SHARPE", result: rng.random() > 0.07 ? "PASS" : "FAIL", limit: 0.5, value: round(rng.uniform(0.3, 1.5), 2) },
        { name: "SELF_CORRELATION", result: "PENDING" },
      ];
      return {
        id: aid, type: isSuper ? "SUPER" : "REGULAR", settings: st, status: this.submitted[aid] ? "ACTIVE" : "UNSUBMITTED",
        ...(isSuper ? { combo: { code: payload.combo }, selection: { code: payload.selection } } : { regular: { code: payload.regular } }),
        is: {
          sharpe: round(sharpe, 2), fitness: round(fitness, 2), turnover: round(turnover, 4),
          returns: round(returns, 4), drawdown: round(rng.uniform(0.02, 0.2), 4),
          margin: round(returns / Math.max(turnover, 0.02) / 250 * 8, 5),
          longCount: rng.randint(900, 1600), shortCount: rng.randint(900, 1600), checks,
        },
        train: { sharpe: round(sharpe + rng.uniform(-0.2, 0.2), 2) }, test: { sharpe: 0 },
      };
    }

    _fullChecks(aid) {
      const a = this._makeAlpha(this._payloadFor(aid), aid);
      const rng = makeRng(aid);
      for (const c of a.is.checks) {
        if (c.name === "SELF_CORRELATION") {
          c.result = rng.random() > 0.25 ? "PASS" : "FAIL";
          c.limit = 0.7;
          c.value = round(c.result === "PASS" ? rng.uniform(0.1, 0.65) : rng.uniform(0.72, 0.95), 2);
        }
      }
      a.is.checks.push({ name: "PROD_CORRELATION", result: "PASS", limit: 0.7, value: round(rng.uniform(0.1, 0.6), 2) });
      return a.is.checks;
    }

    _payloadFor(aid) {
      let payload = null;
      for (const s of Object.values(this.sims)) if (s.alpha === aid) payload = s.payload;
      return payload;
    }

    _options() {
      const choice = (label, choices) => ({ label, type: "choice", choices });
      const per = items => ({ instrumentType: { EQUITY: { region: { USA: items.USA, EUR: items.EUR } } } });
      const vals = a => a.map(value => ({ value }));
      return {
        actions: { POST: { settings: { children: {
          instrumentType: { label: "Instrument type", type: "choice", choices: [{ value: "EQUITY" }] },
          region: choice("Region", { instrumentType: { EQUITY: vals(["USA", "EUR"]) } }),
          universe: choice("Universe", per({ USA: vals(["TOP3000", "TOP1000", "TOP500", "TOP200"]), EUR: vals(["TOP1200", "TOP800", "TOP400"]) })),
          delay: choice("Delay", per({ USA: vals([1, 0]), EUR: vals([1]) })),
          neutralization: choice("Neutralization", per({ USA: vals(["NONE", "MARKET", "SECTOR", "INDUSTRY", "SUBINDUSTRY"]), EUR: vals(["NONE", "MARKET", "SECTOR", "INDUSTRY"]) })),
        } } } },
      };
    }

    _post(path, body, send) {
      if (path === "/authentication") return send(201, { token: { expiry: 14400 } });
      if (path === "/simulations") {
        const t = nowS();
        const running = Object.values(this.sims).filter(s => !s.child_of && s.ready > t).length;
        if (running >= this.cap) return send(429, { detail: "SIMULATION_LIMIT_EXCEEDED" }, { "Retry-After": "3" });
        this.counter++;
        let sid = "sim" + String(this.counter).padStart(5, "0");
        const isList = Array.isArray(body);
        const payloads = isList ? body : [body];
        const ready = t + 2 + Math.random() * 2 + (isList ? 0.4 * payloads.length : 0);
        const kids = [];
        for (const p of payloads) {
          this.counter++;
          const cid = "sim" + String(this.counter).padStart(5, "0");
          const err = p && p.type === "SUPER" ? this._validateSuper(p) : this._validate((p && p.regular) || "");
          const aid = "DEMO" + hex6(stableStringify(p));
          this.sims[cid] = { ready, payload: p, err, alpha: aid, child_of: isList ? sid : null };
          kids.push(cid);
        }
        if (isList) this.sims[sid] = { ready, children: kids };
        else sid = kids[0];
        return send(201, { id: sid }, { "Location": `${this.url}/simulations/${sid}` });
      }
      const m = path.match(/^\/alphas\/(\w+)\/submit$/);
      if (m) {
        if (!this._payloadFor(m[1])) return send(404, { detail: "Not found." });
        if (this.submitted[m[1]]) return send(400, { detail: "Alpha is already submitted." });
        this.submits[m[1]] = { ready: nowS() + 2 + Math.random() * 2 };
        return send(201, {}, { "Retry-After": "1" });
      }
      return send(404, { detail: "not found" });
    }

    async _get(path, qs, send) {
      if (path === "/authentication") return send(200, { token: { expiry: 14000 } });
      let m = path.match(/^\/simulations\/(\w+)$/);
      if (m) {
        const s = this.sims[m[1]];
        if (!s) return send(404, { detail: "unknown" });
        if (nowS() < s.ready) return send(200, { id: m[1], status: "RUNNING" }, { "Retry-After": "1" });
        if (s.children) return send(200, { id: m[1], status: "COMPLETE", children: s.children });
        if (s.err) return send(200, { id: m[1], status: "ERROR", message: s.err });
        return send(200, { id: m[1], status: "COMPLETE", alpha: s.alpha });
      }
      m = path.match(/^\/alphas\/(\w+)$/);
      if (m) {
        const payload = this._payloadFor(m[1]);
        if (!payload) return send(404, { detail: "unknown alpha" });
        return send(200, this._makeAlpha(payload, m[1]));
      }
      m = path.match(/^\/alphas\/(\w+)\/check$/);
      if (m) {
        await P.sleep(400);
        if (!this._payloadFor(m[1])) return send(404, { detail: "unknown alpha" });
        // Like BRAIN: the first call usually comes back empty while the checks are computed.
        const n = this.checkCalls[m[1]] = (this.checkCalls[m[1]] || 0) + 1;
        if (n === 1) return { status: 200, headers: {}, body: "", url: DEMO_URL + path };
        return send(200, { is: { checks: this._fullChecks(m[1]) } });
      }
      m = path.match(/^\/alphas\/(\w+)\/submit$/);
      if (m) {
        const sub = this.submits[m[1]];
        if (!sub) return send(404, { detail: "No submission in progress." });
        if (nowS() < sub.ready) return { status: 200, headers: { "retry-after": "1" }, body: "", url: DEMO_URL + path };
        const checks = this._fullChecks(m[1]);
        if (checks.some(c => c.result === "FAIL")) return send(403, { is: { checks } });
        this.submitted[m[1]] = true;
        return send(200, { is: { checks } });
      }
      m = path.match(/^\/alphas\/(\w+)\/recordsets\/pnl$/);
      if (m) {
        const payload = this._payloadFor(m[1]);
        if (!payload) return send(404, { detail: "unknown alpha" });
        const a = this._makeAlpha(payload, m[1]);
        const rng = makeRng(m[1] + "pnl");
        const drift = a.is.sharpe * 11000 / Math.sqrt(252);   // daily mean that matches the Sharpe
        const recs = [];
        let v = 0;
        const end = Date.UTC(2024, 11, 31);
        for (let d = Date.UTC(2018, 0, 2); d < end; d += 86400000) {
          const wd = new Date(d).getUTCDay();
          if (wd === 0 || wd === 6) continue;
          v += rng.gauss(drift, 11000);
          recs.push([new Date(d).toISOString().slice(0, 10), round(v, 2)]);
        }
        return send(200, { schema: { properties: [{ name: "date" }, { name: "pnl" }] }, records: recs });
      }
      if (path === "/data-fields" || path === "/data-sets") {
        const q = (qs.get("search") || "").toLowerCase();
        const ds = qs.get("dataset.id") || "";
        const offset = parseInt(qs.get("offset") || "0", 10) || 0;
        const limit = Math.min(50, parseInt(qs.get("limit") || "50", 10) || 50);
        const cat = id => ({ id: (MOCK_CATEGORIES[id] || ["other"])[0], name: (MOCK_CATEGORIES[id] || ["", "Other"])[1] });
        let items;
        if (path === "/data-fields") {
          items = MOCK_FIELDS.filter(f => (!q || f[0].toLowerCase().includes(q) || f[1].toLowerCase().includes(q)) && (!ds || ds === f[2]))
            .map(f => ({ id: f[0], description: f[1], dataset: { id: f[2], name: f[3] }, type: f[4], coverage: f[5],
              alphaCount: cyrb53(f[0]) % 5000, userCount: cyrb53(f[1]) % 800, category: cat(f[2]) }));
        } else {
          const seen = {};
          for (const f of MOCK_FIELDS) {
            const e = seen[f[2]] || (seen[f[2]] = { id: f[2], name: f[3], category: cat(f[2]), fieldCount: 0, coverage: f[5], alphaCount: 0, userCount: 0 });
            e.fieldCount++;
          }
          items = Object.values(seen).filter(v => !q || v.name.toLowerCase().includes(q) || v.id.includes(q));
        }
        return send(200, { count: items.length, results: items.slice(offset, offset + limit) });
      }
      if (path === "/operators") {
        return send(200, MOCK_OPERATORS.map(o => ({ name: o[0], category: o[1], definition: o[2], description: o[3], scope: ["REGULAR"] })));
      }
      return send(404, { detail: "not found" });
    }
  }

  // ------------------------------------------------------------------------------------------ //
  // Saved files (inside the app on Android)
  // ------------------------------------------------------------------------------------------ //
  const CONFIG_FILE = "config.json";
  const HISTORY_FILE = "history.json";
  const LAST_RUN_FILE = "last_run.json";

  function loadJson(name, def) {
    try { const t = P.files.read(name); return t ? JSON.parse(t) : def; } catch (e) { return def; }
  }
  function saveJson(name, data) { try { return P.files.write(name, JSON.stringify(data)); } catch (e) { return false; } }

  // ------------------------------------------------------------------------------------------ //
  // App state (what the desktop app's web server kept)
  // ------------------------------------------------------------------------------------------ //
  class AppState {
    constructor() {
      this.client = null;
      this.pending = null;
      this.email = "";
      this.demo = false;
      this.mock = null;
      this.options = null;
      this.rows = [];
      this.logs = [];
      this.runId = 0;
      this.runner = null;
      this.status = "idle";   // idle running paused stopping finished stopped
      this.total = 0;
      this.skipped = 0;
      this.started = 0;
      this.ended = 0;
      this.csvName = "";
      this.exported = "";
      this.history = loadJson(HISTORY_FILE, {});
      this.th = { sharpe: 1.25, fitness: 1.0 };
      this._historyTimer = null;
      this._lastRunSaved = 0;
      this._restoreLastRun();
    }

    log(level, msg) {
      this.logs.push({ t: hhmmss(), level, msg });
      if (this.logs.length > 3000) this.logs.splice(0, 500);
    }

    // -- session
    startDemo() {
      if (!this.mock) this.mock = new MockBrain();
      return this.mock;
    }

    logout() {
      this.client = null;
      this.pending = null;
      this.email = "";
      this.options = null;
      this.demo = false;
    }

    // -- running
    counts() {
      const c = { good: 0, passed: 0, issues: 0, error: 0 };
      for (const r of this.rows) c[r.status] = (c[r.status] || 0) + 1;
      return c;
    }

    busy() { return ["running", "paused", "stopping"].includes(this.status); }

    /**
     * kind "regular": `items` are expressions. kind "super": `items` are {selection, combo} pairs and
     * settings also carry selectionHandling / selectionLimit.
     */
    startRun(items, settings, opts, kind = "regular") {
      if (this.busy()) throw new BrainError("A run is already in progress.");
      if (!this.client) throw new BrainError("Please sign in first.");
      const truncation = Number(settings.truncation);
      if (settings.truncation === "" || !isFinite(truncation)) throw new BrainError("Truncation must be a number, for example 0.08.");
      const isSuper = kind === "super";
      const selectionLimit = parseInt(settings.selectionLimit, 10);
      if (isSuper && !(selectionLimit > 0)) throw new BrainError("Selection limit must be a whole number above 0.");
      const jobs = [], seen = new Set();
      let skipped = 0;
      const neuts = (settings.neutralizations && settings.neutralizations.length) ? settings.neutralizations : ["INDUSTRY"];
      const decays = (settings.decays && settings.decays.length) ? settings.decays : [0];
      for (const item of items) {
        const expr = isSuper ? "" : String(item).trim();
        const sel = isSuper ? String((item && item.selection) || "").trim() : "";
        const combo = isSuper ? String((item && item.combo) || "").trim() : "";
        if (isSuper ? !(sel && combo) : !expr) continue;
        for (const neut of neuts) {
          for (const decay of decays) {
            const st = {
              instrumentType: "EQUITY", region: settings.region, universe: settings.universe,
              delay: parseInt(settings.delay, 10), decay: parseInt(decay, 10), neutralization: neut,
              truncation, pasteurization: settings.pasteurization,
              testPeriod: settings.testPeriod, unitHandling: settings.unitHandling,
              nanHandling: settings.nanHandling, maxTrade: settings.maxTrade,
              language: "FASTEXPR", visualization: false,
            };
            let payload;
            if (isSuper) {
              st.selectionHandling = settings.selectionHandling || "POSITIVE";
              st.selectionLimit = selectionLimit;
              payload = { type: "SUPER", settings: st, combo, selection: sel };
            } else {
              payload = { type: "REGULAR", settings: st, regular: expr };
            }
            const k = jobKey(payload);
            if (seen.has(k)) continue;
            seen.add(k);
            if (opts.skipDone && Object.prototype.hasOwnProperty.call(this.history, k)) { skipped++; continue; }
            jobs.push({ key: k, payload });
          }
        }
      }
      if (!jobs.length) {
        throw new BrainError("Nothing new to simulate. (Everything is empty, duplicated or already done - " +
          "turn off 'Skip alphas I already simulated' to repeat them.)");
      }
      this.runId++;
      this.rows = [];
      this.logs = [];
      this.total = jobs.length;
      this.skipped = skipped;
      this.started = nowS();
      this.ended = 0;
      this.status = "running";
      this.exported = "";
      this.th = { sharpe: Number(opts.minSharpe), fitness: Number(opts.minFitness) };
      this.csvName = `run_${stamp()}.csv`;
      P.files.write("results/" + this.csvName, CSV_HEADER);
      this.runner = new Runner(this.client, jobs, opts, (r, j) => this._emitRow(r, j), (l, m) => this.log(l, m), s => this._finished(s));
      this.log("info", `Starting ${jobs.length} simulations (${opts.workers} at a time)` + (skipped ? `; skipped ${skipped} already done.` : "."));
      P.runStarted(jobs.length);
      this.runner.start();
      this._saveLastRun(true);
      return { total: jobs.length, skipped };
    }

    _emitRow(row, job) {
      row.n = this.rows.length + 1;
      this.rows.push(row);
      if (row.alpha_id) { this.history[job.key] = row.alpha_id; this._saveHistorySoon(); }
      try { P.files.append("results/" + this.csvName, csvLine(rowToCsv(row))); } catch (e) { /* keep going */ }
      if (row.status === "error") {
        this.log("error", `Failed: ${row.expression.slice(0, 70)} - ${row.error}`);
      } else {
        this.log(row.status === "good" ? "ok" : "info", `${row.status.toUpperCase()}: Sharpe ${row.sharpe}, Fitness ${row.fitness} - ${row.expression.slice(0, 60)}`);
      }
      P.runProgress(this.rows.length, this.total, this.counts().good);
      this._saveLastRun(false);
    }

    _finished(stopped) {
      this.status = stopped ? "stopped" : "finished";
      this.ended = nowS();
      if (this.client) this.client.abort = new AbortFlag();   // so Data explorer / charts work again after "stop now"
      const c = this.counts();
      const summary = `${c.good} good, ${c.passed} passed, ${c.issues} with issues, ${c.error} errors.`;
      this.log("info", (stopped ? "Stopped. " : "All done. ") + summary);
      this._flushHistory();
      if (this.rows.length && P.isAndroid && P.canSaveToDownloads()) {
        const res = P.saveDownload(this.csvName, "text/csv", "﻿" + this.csvText());
        if (res && res.ok) { this.exported = res.path; this.log("info", `Results saved to ${res.path}`); }
        else this.log("warn", "Couldn't copy the results to Downloads. Use Save CSV or Share.");
      }
      P.runEnded(stopped ? "Run stopped" : "All simulations finished", summary);
      this._saveLastRun(true);
    }

    csvText() {
      return CSV_HEADER + this.rows.map(r => csvLine(rowToCsv(r))).join("");
    }

    _saveHistorySoon() {
      if (this._historyTimer) return;
      this._historyTimer = setTimeout(() => this._flushHistory(), 1500);
    }
    _flushHistory() {
      if (this._historyTimer) { clearTimeout(this._historyTimer); this._historyTimer = null; }
      saveJson(HISTORY_FILE, this.history);
    }

    _saveLastRun(force) {
      const t = Date.now();
      if (!force && t - this._lastRunSaved < 10000) return;
      this._lastRunSaved = t;
      saveJson(LAST_RUN_FILE, {
        v: 1, status: this.status, total: this.total, skipped: this.skipped, started: this.started,
        ended: this.ended, savedAt: nowS(), csvName: this.csvName, exported: this.exported, rows: this.rows,
      });
    }

    _restoreLastRun() {
      const d = loadJson(LAST_RUN_FILE, null);
      if (!d || !Array.isArray(d.rows) || !d.rows.length) return;
      this.rows = d.rows;
      this.total = d.total || d.rows.length;
      this.skipped = d.skipped || 0;
      this.started = d.started || 0;
      this.csvName = d.csvName || "";
      this.exported = d.exported || "";
      const interrupted = ["running", "paused", "stopping"].includes(d.status);
      this.status = interrupted ? "stopped" : (d.status || "finished");
      this.ended = d.ended || d.savedAt || nowS();
      const when = this.started ? new Date(this.started * 1000).toLocaleString() : "earlier";
      this.log("info", interrupted
        ? `The app was closed while a run was going (started ${when}). Results that came back are shown.`
        : `Showing your last run (started ${when}).`);
    }

    snapshot(rid, rowCursor, logCursor) {
      const reset = rid !== this.runId;
      if (reset) { rowCursor = 0; logCursor = 0; }
      const done = this.rows.length;
      const end = this.ended || nowS();
      const elapsed = this.started ? end - this.started : 0;
      let eta = null;
      if ((this.status === "running" || this.status === "paused") && done > 0) eta = elapsed / done * (this.total - done);
      return {
        rid: this.runId, reset, status: this.status, total: this.total, done, skipped: this.skipped,
        counts: this.counts(), elapsed, eta, rows: this.rows.slice(rowCursor), next_row: done,
        logs: this.logs.slice(logCursor), next_log: this.logs.length,
        csv: this.csvName, exported: this.exported, results_dir: P.files.path("results"),
      };
    }
  }

  const STATE = new AppState();

  // ------------------------------------------------------------------------------------------ //
  // Data catalog: download BRAIN's datasets / data fields once, keep them on the phone
  // ------------------------------------------------------------------------------------------ //
  const CACHE_DAYS = 7;
  const safeId = s => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");
  const ctxKey = c => [c.region, c.universe, c.delay].map(safeId).join("_");
  const cachePrefix = () => (STATE.demo ? "demo_" : "");
  const fresh = c => c && Array.isArray(c.items) && Date.now() - (c.at || 0) < CACHE_DAYS * 86400000;
  let opsCache = null;

  function normCtx(ctx) {
    return { region: String(ctx.region || "USA"), universe: String(ctx.universe || "TOP3000"), delay: parseInt(ctx.delay, 10) || 0 };
  }

  /** Every dataset for a market, with its category. Cached for 7 days. */
  async function catalogDatasets(ctx, force) {
    ctx = normCtx(ctx);
    const client = needClient();
    const file = `ds_${cachePrefix()}${ctxKey(ctx)}.json`;
    const cached = loadJson(file, null);
    if (!force && fresh(cached)) return cached.items;
    const items = [];
    let offset = 0, count = Infinity;
    while (offset < count) {
      const r = await client.datasets(ctx.region, ctx.delay, ctx.universe, "", offset, 50);
      const res = r.results || [];
      count = typeof r.count === "number" ? r.count : res.length;
      for (const d of res) {
        const c = d.category || {};
        items.push({ id: d.id, name: d.name || d.id, category: c.name || c.id || "Other", fieldCount: d.fieldCount == null ? null : d.fieldCount, coverage: d.coverage == null ? null : d.coverage });
      }
      if (!res.length) break;
      offset += res.length;
    }
    saveJson(file, { at: Date.now(), items });
    return items;
  }

  /** All fields of the given datasets (each dataset cached separately for 7 days). */
  async function catalogFields(ctx, ids, opts = {}) {
    ctx = normCtx(ctx);
    const client = needClient();
    const all = [];
    let n = 0;
    for (const id of ids) {
      const file = `df_${cachePrefix()}${ctxKey(ctx)}_${safeId(id)}.json`;
      const cached = loadJson(file, null);
      if (!opts.force && fresh(cached)) {
        all.push(...cached.items);
        n++;
        if (opts.onProgress) opts.onProgress({ dataset: id, done: n, total: ids.length, fields: all.length, cached: true });
        continue;
      }
      const items = [];
      let offset = 0, count = Infinity;
      while (offset < count) {
        if (opts.token && opts.token.cancelled) throw new Aborted();
        const r = await client.datafields(ctx.region, ctx.delay, ctx.universe, "", id, offset, 50);
        const res = r.results || [];
        count = typeof r.count === "number" ? r.count : res.length;
        for (const f of res) {
          items.push({ id: f.id, type: f.type || "MATRIX", description: String(f.description || "").slice(0, 160),
            coverage: f.coverage == null ? null : f.coverage, alphaCount: f.alphaCount || 0, userCount: f.userCount || 0, dataset: id });
        }
        if (!res.length) break;
        offset += res.length;
        if (opts.onProgress) opts.onProgress({ dataset: id, done: n, total: ids.length, fields: all.length + items.length, page: offset, of: count });
      }
      saveJson(file, { at: Date.now(), items });
      all.push(...items);
      n++;
    }
    return all;
  }

  /** Filter / sort / limit fields the way a "spec" says. */
  function pickFields(fields, spec = {}) {
    const types = new Set(spec.types && spec.types.length ? spec.types : ["MATRIX", "VECTOR"]);
    const minCov = Number(spec.minCoverage || 0);
    const q = String(spec.search || "").trim().toLowerCase();
    const seenIds = new Set();
    let list = fields.filter(f => {
      if (seenIds.has(f.id)) return false;
      seenIds.add(f.id);
      return types.has(f.type) && (f.coverage == null || f.coverage >= minCov) &&
        (!q || f.id.toLowerCase().includes(q) || String(f.description || "").toLowerCase().includes(q));
    });
    const sort = spec.sort || "popular";
    if (sort === "popular") list.sort((a, b) => (b.alphaCount - a.alphaCount) || (b.userCount - a.userCount) || a.id.localeCompare(b.id));
    else if (sort === "coverage") list.sort((a, b) => ((b.coverage || 0) - (a.coverage || 0)) || a.id.localeCompare(b.id));
    else if (sort === "name") list.sort((a, b) => a.id.localeCompare(b.id));
    else if (sort === "random") for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    const max = parseInt(spec.max, 10) || 0;
    if (max > 0) list = list.slice(0, max);
    return list;
  }

  const fieldValue = (f, vecOp) => (f.type === "VECTOR" ? `${vecOp || "vec_avg"}(${f.id})` : f.id);

  /**
   * Turn a data "spec" ({category, datasets, types, minCoverage, sort, max, vecOp, search}) into field
   * values for a market. Dataset ids that don't exist in this market fall back to the whole category.
   */
  async function resolveSpec(spec, ctx, opts = {}) {
    ctx = normCtx(ctx);
    const ds = await catalogDatasets(ctx, opts.force);
    let ids = (spec.datasets || []).filter(id => ds.some(d => d.id === id));
    if (!ids.length && spec.category) ids = ds.filter(d => d.category === spec.category).map(d => d.id);
    if (!ids.length) {
      throw new BrainError(`No ${spec.category ? `"${spec.category}" ` : ""}data found for ${ctx.region} ${ctx.universe} delay ${ctx.delay}. Pick other data.`);
    }
    const all = await catalogFields(ctx, ids, opts);
    const picked = pickFields(all, spec);
    return { datasets: ids, all, picked, values: picked.map(f => fieldValue(f, spec.vecOp)) };
  }

  async function getOperators() {
    if (opsCache && opsCache.client === STATE.client) return opsCache.list;
    const list = await needClient().operators();
    opsCache = { client: STATE.client, list: Array.isArray(list) ? list : [] };
    return opsCache.list;
  }

  // ------------------------------------------------------------------------------------------ //
  // AI expression generator (bring your own API key)
  // ------------------------------------------------------------------------------------------ //
  const AI_PROVIDERS = {
    openai: { label: "OpenAI", base: "https://api.openai.com/v1", models: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano"] },
    anthropic: { label: "Anthropic (Claude)", base: "https://api.anthropic.com", models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"] },
    gemini: { label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"] },
    compatible: { label: "Other (OpenAI-compatible)", base: "https://openrouter.ai/api/v1", models: [] },
  };
  const AI_COMPAT_PRESETS = [
    ["OpenRouter", "https://openrouter.ai/api/v1"], ["Groq", "https://api.groq.com/openai/v1"],
    ["DeepSeek", "https://api.deepseek.com/v1"], ["Mistral", "https://api.mistral.ai/v1"],
    ["xAI (Grok)", "https://api.x.ai/v1"], ["Together", "https://api.together.xyz/v1"],
  ];
  const AI_KEYWORDS = new Set(["industry", "sector", "subindustry", "market", "country", "exchange", "true", "false", "nan", "inf"]);

  function aiErrorText(r) {
    const j = parseJson(r.body);
    let m = "";
    const pick = o => (isObj(o) ? (isObj(o.error) ? (o.error.message || o.error.type) : (o.error || o.message || o.detail)) : "");
    if (Array.isArray(j)) m = pick(j[0]);
    else m = pick(j);
    return String(m || (r.body || "").trim().slice(0, 200) || `HTTP ${r.status}`);
  }

  function aiEndpoint(cfg) {
    const p = AI_PROVIDERS[cfg.provider] ? cfg.provider : "openai";
    const base = String(cfg.base || AI_PROVIDERS[p].base).trim().replace(/\/+$/, "");
    if (!/^https:\/\//i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base)) {
      throw new BrainError("The AI address must start with https://");
    }
    return { p, base, label: AI_PROVIDERS[p].label };
  }

  async function aiRequest(method, url, headers, body, label) {
    let r;
    try {
      r = await P.http(method, url, { headers, body: body === undefined ? null : JSON.stringify(body), timeout: 180000 });
    } catch (e) {
      throw new BrainError(`Can't reach ${label}. Check the address and your internet connection. (${e.message})`);
    }
    if (!ok2xx(r)) {
      const hint = r.status === 401 || r.status === 403 ? " Check your API key." : r.status === 404 ? " Check the model name and address." : "";
      const e = new BrainError(`${label} said: ${aiErrorText(r)} (HTTP ${r.status}).${hint}`);
      e.status = r.status;
      e.retryAfter = r.headers["retry-after"];
      throw e;
    }
    const j = parseJson(r.body);
    if (j === undefined) throw new BrainError(`${label} sent an unreadable reply.`);
    return j;
  }

  /** One chat request. Returns the reply text. */
  async function aiChat(cfg, system, user) {
    const { p, base, label } = aiEndpoint(cfg);
    const key = String(cfg.key || "").trim();
    const model = String(cfg.model || "").trim();
    if (!key && p !== "compatible") throw new BrainError("Add your API key first.");
    if (!model) throw new BrainError("Choose a model first.");
    const headers = { "Content-Type": "application/json" };
    let j;
    if (p === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      j = await aiRequest("POST", `${base}/v1/messages`, headers, { model, max_tokens: 8000, system, messages: [{ role: "user", content: user }] }, label);
      return (j.content || []).filter(b => b && b.type === "text").map(b => b.text).join("\n");
    }
    if (p === "gemini") {
      headers["x-goog-api-key"] = key;
      j = await aiRequest("POST", `${base}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`, headers,
        { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }] }, label);
      const cand = (j.candidates || [])[0];
      if (!cand && j.promptFeedback && j.promptFeedback.blockReason) throw new BrainError(`${label} blocked the request (${j.promptFeedback.blockReason}).`);
      return ((cand && cand.content && cand.content.parts) || []).map(x => x.text || "").join("");
    }
    if (key) headers["Authorization"] = "Bearer " + key;
    const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    if (p === "compatible") body.temperature = 0.9;
    j = await aiRequest("POST", `${base}/chat/completions`, headers, body, label);
    const msg = ((j.choices || [])[0] || {}).message || {};
    return Array.isArray(msg.content) ? msg.content.map(x => (x && (x.text || x.content)) || "").join("") : String(msg.content || "");
  }

  async function aiListModels(cfg) {
    const { p, base, label } = aiEndpoint(cfg);
    const key = String(cfg.key || "").trim();
    if (!key && p !== "compatible") throw new BrainError("Add your API key first.");
    let ids;
    if (p === "anthropic") {
      const j = await aiRequest("GET", `${base}/v1/models?limit=100`, { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, undefined, label);
      ids = (j.data || []).map(m => m.id);
    } else if (p === "gemini") {
      const j = await aiRequest("GET", `${base}/models?pageSize=200`, { "x-goog-api-key": key }, undefined, label);
      ids = (j.models || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
        .map(m => String(m.name || "").replace(/^models\//, ""));
    } else {
      const j = await aiRequest("GET", `${base}/models`, key ? { "Authorization": "Bearer " + key } : {}, undefined, label);
      ids = (j.data || []).map(m => m.id);
      if (p === "openai") ids = ids.filter(id => !/embed|whisper|tts|dall-e|image|audio|moderation|transcribe|realtime|search|sora|davinci|babbage/i.test(id));
    }
    return [...new Set(ids.filter(Boolean))].sort();
  }

  /** Pull expressions out of a model reply: one per line, without numbering, bullets or code fences. */
  function parseAiExpressions(text) {
    const out = [];
    for (let line of String(text || "").split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("```") || line.startsWith("#")) continue;
      line = line.replace(/^(?:[*•]\s*|-\s+|\d+\s*[.):]\s+)/, "")   // bullets / "1." (but keep a leading minus sign)
        .replace(/^`+|`+$/g, "").replace(/^"(.*)"$/, "$1").replace(/;\s*$/, "").trim();
      if (!line || !line.includes("(")) continue;
      if (/^(here|note|these|sure|okay|the following|below)\b/i.test(line)) continue;
      out.push(line);
    }
    return out;
  }

  /** null if the expression looks usable, otherwise a short reason. `known` = {fields:Set, ops:Set|null} or null. */
  function checkExpression(expr, known) {
    if (expr.length > 2000) return "too long";
    let depth = 0;
    for (const ch of expr) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth < 0) return "unbalanced brackets";
    }
    if (depth) return "unbalanced brackets";
    if (/[{}\[\]`]/.test(expr)) return "odd characters";
    if (!known) return null;
    const text = expr.replace(/"[^"]*"|'[^']*'/g, '""');
    const local = new Set();
    for (const m of text.matchAll(/([A-Za-z_]\w*)\s*=(?!=)/g)) local.add(m[1]);
    const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(\()?/g;
    let m;
    while ((m = re.exec(text))) {
      const w = m[1];
      const prev = text[m.index - 1];
      if (prev && /[0-9.]/.test(prev)) continue;   // e.g. the "e" in 1e-5
      if (m[2]) {
        if (known.ops && !known.ops.has(w)) return `unknown operator ${w}`;
      } else if (local.has(w) || /^\s*=(?!=)/.test(text.slice(re.lastIndex))) {
        continue;   // variable or named argument
      } else if (!known.fields.has(w) && !AI_KEYWORDS.has(w.toLowerCase())) {
        return `unknown field ${w}`;
      }
    }
    return null;
  }

  const AI_SYSTEM = [
    "You write alpha expressions for the WorldQuant BRAIN platform in its FASTEXPR language.",
    "Reply with expressions ONLY: one complete expression per line, no numbering, no bullets, no comments, no code fences, no explanations.",
    "Use only the data fields and operators the user lists. Wrap VECTOR fields in a vector operator such as vec_avg() before using them.",
    "Use sensible lookback windows (for example 5, 10, 20, 60, 120, 250 days) and make every expression a genuinely different idea, not just different numbers.",
    "Every expression must have balanced parentheses and fit on one line.",
  ].join("\n");

  function aiPrompt(o, k, fieldSlice, opsText, avoid) {
    const fields = fieldSlice.map(f => `${f.id} | ${f.type}${f.description ? " | " + f.description : ""}`).join("\n");
    return [
      `Market: region ${o.ctx.region}, universe ${o.ctx.universe}, delay ${o.ctx.delay}.`,
      `Research idea: ${String(o.idea || "").trim() || "your choice - mix momentum, reversal, value, quality, sentiment and other ideas that suit this data"}.`,
      `Write exactly ${k} new alpha expressions.`,
      "",
      "Data fields you may use (id | type | description):",
      fields,
      "",
      "Operators you may use:",
      opsText,
      avoid.length ? "\nDo not repeat any of these:\n" + avoid.join("\n") : "",
    ].join("\n");
  }

  /**
   * Generate `count` expressions in batches. onProgress gets {phase, msg, done, total, rejected, added}.
   * token.cancelled stops after the current request.
   */
  async function aiGenerate(o, onProgress = () => {}, token = {}) {
    const N = Math.max(1, Math.min(100000, parseInt(o.count, 10) || 10));
    const B = Math.max(5, Math.min(50, parseInt(o.batchSize, 10) || 20));
    onProgress({ phase: "data", msg: "Getting data fields from BRAIN..." });
    const data = await resolveSpec(o.spec || {}, o.ctx, {
      token, onProgress: p => onProgress({ phase: "data", msg: `Syncing ${p.dataset}: ${p.fields} fields...` }),
    });
    if (!data.picked.length) throw new BrainError("No data fields match those filters. Loosen them a little.");
    let ops = null;
    try { ops = await getOperators(); } catch (e) { if (e instanceof Aborted) throw e; }
    const opsList = ops ? ops.filter(x => !Array.isArray(x.scope) || x.scope.includes("REGULAR")) : null;
    const opsText = opsList && opsList.length
      ? opsList.map(x => `${x.name}: ${String(x.definition || "").slice(0, 120)}`).join("\n")
      : "Standard BRAIN FASTEXPR operators (rank, ts_mean, ts_rank, ts_delta, ts_zscore, ts_std_dev, group_rank, group_neutralize, vec_avg ...).";
    const known = o.strict ? { fields: new Set(data.all.map(f => f.id)), ops: opsList && opsList.length ? new Set(opsList.map(x => x.name)) : null } : null;
    const seen = new Set((o.existing || []).map(s => String(s).trim()));
    const out = [];
    const pool = data.picked;
    const win = Math.min(pool.length, 80);
    let rejected = 0, emptyRounds = 0, batch = 0;
    const reasons = {};
    while (out.length < N && !token.cancelled) {
      batch++;
      const k = Math.min(B, N - out.length);
      const start = ((batch - 1) * win) % pool.length;
      const slice = pool.slice(start, start + win);
      if (slice.length < win) slice.push(...pool.slice(0, win - slice.length));
      const avoid = out.slice(-30);
      onProgress({ phase: "ai", msg: `Asking the AI (request ${batch})...`, done: out.length, total: N, rejected });
      let text;
      for (let attempt = 0; ; attempt++) {
        try {
          text = await aiChat(o.cfg, AI_SYSTEM, aiPrompt(o, k, slice, opsText, avoid));
          break;
        } catch (e) {
          const retryable = e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503 || e.status === 529;
          if (!retryable || attempt >= 3 || token.cancelled) throw e;
          const wait = Math.min(60, Math.max(2, parseFloat(e.retryAfter) || 5 * (attempt + 1)));
          onProgress({ phase: "ai", msg: `The AI is busy. Trying again in ${Math.round(wait)}s...`, done: out.length, total: N, rejected });
          await P.sleep(wait * 1000);
        }
      }
      if (token.cancelled) break;
      let added = 0;
      for (const ex of parseAiExpressions(text)) {
        if (seen.has(ex)) continue;
        const why = checkExpression(ex, known);
        if (why) { rejected++; const key = why.split(" ").slice(0, 2).join(" "); reasons[key] = (reasons[key] || 0) + 1; continue; }
        seen.add(ex);
        out.push(ex);
        added++;
        if (out.length >= N) break;
      }
      onProgress({ phase: "ai", msg: `${out.length} of ${N} ready`, done: out.length, total: N, rejected, added, items: out.slice(out.length - added) });
      if (!added) { if (++emptyRounds >= 3) break; } else emptyRounds = 0;
    }
    return { expressions: out, rejected, reasons, batches: batch, cancelled: !!token.cancelled, fields: pool.length, datasets: data.datasets };
  }

  /** Errors from engine functions, turned into messages for the screen (same as Engine.api does). */
  function friendlyError(e) {
    if (e instanceof Aborted) return new Error("Cancelled.");
    if (e instanceof BrainError) return new Error(e.message);
    if (e && e.name === "NetError") return new Error(`Can't reach BRAIN right now. Check your internet connection. (${e.message})`);
    if (typeof console !== "undefined") console.error(e);
    return new Error(`Unexpected problem: ${e && e.message}`);
  }
  const wrap = fn => async (...args) => { try { return await fn(...args); } catch (e) { throw friendlyError(e); } };

  // ------------------------------------------------------------------------------------------ //
  // Routes (same names as the desktop app's local web server)
  // ------------------------------------------------------------------------------------------ //
  function needClient() {
    if (!STATE.client) throw new BrainError("Please sign in first.");
    return STATE.client;
  }

  function afterLogin(client, email, password, b, cfg) {
    STATE.client = client; STATE.email = email; STATE.demo = false; STATE.options = null; STATE.pending = null;
    cfg.email = email;
    if (b.remember_password) cfg.password = password;
    else if ("password" in cfg && !b.use_saved) delete cfg.password;
    saveJson(CONFIG_FILE, cfg);
    STATE.log("info", `Signed in as ${email}.`);
  }

  const ROUTES = {
    "GET /api/session": () => ({ logged_in: !!STATE.client, email: STATE.email, demo: STATE.demo, platform: PLATFORM_URL }),

    "GET /api/config": () => {
      const c = loadJson(CONFIG_FILE, {});
      c.has_password = !!c.password;
      delete c.password;
      return c;
    },

    "POST /api/config": (q, b) => {
      const c = loadJson(CONFIG_FILE, {});
      for (const k of Object.keys(b)) if (["settings", "runopts", "alphas", "template", "email", "mode", "super", "ai", "lists"].includes(k)) c[k] = b[k];
      saveJson(CONFIG_FILE, c);
      return { ok: true };
    },

    "POST /api/login": async (q, b) => {
      if (b.demo) {
        const mock = STATE.startDemo();
        const client = new BrainClient(mock.url, (l, m) => STATE.log(l, m), mock.transport);
        await client.login("demo@example.com", "demo");
        STATE.client = client; STATE.email = "demo@example.com"; STATE.demo = true; STATE.options = null;
        STATE.log("info", "Demo mode: numbers are made up. Nothing is sent to WorldQuant.");
        return { ok: true };
      }
      const email = String(b.email || "").trim();
      let password = b.password || "";
      const cfg = loadJson(CONFIG_FILE, {});
      if (!password && b.use_saved) password = cfg.password || "";
      if (!email || !password) throw new BrainError("Enter your BRAIN email and password.");
      const client = new BrainClient(API_URL, (l, m) => STATE.log(l, m), P.http);
      try {
        await client.login(email, password);
      } catch (e) {
        if (e instanceof BiometricRequired) STATE.pending = client;
        throw e;
      }
      afterLogin(client, email, password, b, cfg);
      return { ok: true };
    },

    "POST /api/biometric": async (q, b) => {
      const c = STATE.pending;
      if (!c) throw new BrainError("No sign-in is waiting for biometric confirmation.");
      if (!(await c.finishBiometric())) {
        throw new BrainError("BRAIN hasn't confirmed it yet. Finish the face/ID check in your browser, then tap again.");
      }
      afterLogin(c, c.email, c.password, b, loadJson(CONFIG_FILE, {}));
      return { ok: true };
    },

    "POST /api/logout": () => { STATE.logout(); return { ok: true }; },

    "GET /api/options": async () => {
      const c = needClient();
      if (STATE.options === null) STATE.options = await c.settingOptions();
      return STATE.options;
    },

    "GET /api/datasets": q => needClient().datasets(q.region || "USA", q.delay || 1, q.universe || "TOP3000", q.search || "", parseInt(q.offset || 0, 10) || 0),

    "GET /api/datafields": q => needClient().datafields(q.region || "USA", q.delay || 1, q.universe || "TOP3000", q.search || "", q.dataset || "", parseInt(q.offset || 0, 10) || 0),

    "GET /api/operators": () => needClient().operators(),

    "GET /api/pnl": q => {
      if (!q.id) throw new BrainError("Missing alpha id.");
      return needClient().getPnl(q.id);
    },

    "GET /api/state": q => STATE.snapshot(parseInt(q.rid === undefined ? -1 : q.rid, 10), parseInt(q.rows || 0, 10) || 0, parseInt(q.logs || 0, 10) || 0),

    "POST /api/run": (q, b) => {
      const kind = b.kind === "super" ? "super" : "regular";
      const items = kind === "super" ? b.supers : b.expressions;
      if (!Array.isArray(items) || !b.settings || !b.opts) throw new BrainError("Missing run details.");
      const s = Object.assign({}, b.settings);
      const o = Object.assign({}, b.opts);
      o.workers = Math.max(1, Math.min(8, parseInt(o.workers === undefined ? 3 : o.workers, 10) || 3));
      o.batch = Math.max(2, Math.min(10, parseInt(o.batch === undefined ? 10 : o.batch, 10) || 10));
      s.decays = (s.decays && s.decays.length ? s.decays : [0]).map(x => parseInt(x, 10));
      return STATE.startRun(kind === "super" ? items : items.map(String), s, o, kind);
    },

    // Full submission checks for one alpha (includes self / production correlation).
    "POST /api/check": async (q, b) => {
      const id = String(b.id || "");
      if (!id) throw new BrainError("Missing alpha id.");
      const checks = await needClient().checkAlpha(id);
      const rows = STATE.rows.filter(r => r.alpha_id === id);
      for (const r of rows) { r.checks = checks; recomputeStatus(r, STATE.th); r.checked = true; }
      STATE.log("info", `Checked ${id}: ` + (checks.filter(c => c.result === "FAIL").length ? "some checks failed." : "all checks passed."));
      STATE._saveLastRun(true);
      const fails = checks.filter(c => c.result === "FAIL").map(c => c.name);
      const pending = checks.filter(c => c.result === "PENDING").map(c => c.name);
      return { checks, fails, pending, status: rows[0] ? rows[0].status : null };
    },

    // Submit one alpha to BRAIN (irreversible; the screen asks first).
    "POST /api/submit": async (q, b) => {
      const id = String(b.id || "");
      if (!id) throw new BrainError("Missing alpha id.");
      STATE.log("info", `Submitting ${id}...`);
      const res = await needClient().submitAlpha(id);
      for (const r of STATE.rows.filter(x => x.alpha_id === id)) {
        r.submission = res.ok ? "ACTIVE" : res.pending ? "PENDING" : "FAILED";
        if (res.checks && res.checks.length) { r.checks = res.checks; recomputeStatus(r, STATE.th); }
      }
      STATE.log(res.ok ? "ok" : "warn", `${id}: ${res.message}`);
      STATE._saveLastRun(true);
      return res;
    },

    "POST /api/pause": () => {
      if (STATE.runner && STATE.status === "running") {
        STATE.runner.pause();
        STATE.status = "paused";
        STATE.log("info", "Paused. Simulations already sent will still finish.");
      }
      return { ok: true };
    },

    "POST /api/resume": () => {
      if (STATE.runner && STATE.status === "paused") {
        STATE.runner.unpause();
        STATE.status = "running";
        STATE.log("info", "Resumed.");
      }
      return { ok: true };
    },

    "POST /api/stop": () => {
      if (STATE.runner && (STATE.status === "running" || STATE.status === "paused")) {
        STATE.status = "stopping";
        STATE.runner.stop();
        STATE.log("info", "Stopping after the current simulations finish...");
      }
      return { ok: true };
    },

    "POST /api/abort": () => {
      if (STATE.runner && STATE.busy()) {
        STATE.runner.abortNow();
        STATE.log("info", "Stopped immediately.");
      }
      return { ok: true };
    },

    "POST /api/save_csv": () => {
      if (!STATE.rows.length) throw new BrainError("There are no results to save yet.");
      const name = STATE.csvName || `brain_results_${stamp()}.csv`;
      const text = "﻿" + STATE.csvText();
      if (P.canSaveToDownloads()) {
        const r = P.saveDownload(name, "text/csv", text);
        if (r && r.ok) return { ok: true, path: r.path };
      }
      if (P.shareFile(name, "text/csv", text)) return { ok: true, shared: true };
      throw new BrainError("Couldn't save the file on this phone.");
    },

    "POST /api/share_csv": () => {
      if (!STATE.rows.length) throw new BrainError("There are no results to share yet.");
      const name = STATE.csvName || `brain_results_${stamp()}.csv`;
      if (!P.shareFile(name, "text/csv", "﻿" + STATE.csvText())) throw new BrainError("Couldn't open the share menu.");
      return { ok: true };
    },

    "POST /api/forget_history": () => {
      STATE.history = {};
      STATE._flushHistory();
      return { ok: true };
    },
  };

  /** Mirror of the desktop app's fetch("/api/...") calls. Resolves with JSON, rejects with Error(message). */
  async function api(path, body) {
    const method = body === undefined ? "GET" : "POST";
    const u = new URL(path, "http://app.local");
    const q = {};
    u.searchParams.forEach((v, k) => { q[k] = v; });
    const fn = ROUTES[method + " " + u.pathname];
    if (!fn) throw new Error("Unknown action");
    try {
      return await fn(q, body || {});
    } catch (e) {
      if (e instanceof BiometricRequired) return { biometric_url: e.url };
      if (e instanceof Aborted) throw new Error("Cancelled.");
      if (e instanceof BrainError) throw new Error(e.message);
      if (e && e.name === "NetError") throw new Error(`Can't reach BRAIN right now. Check your internet connection. (${e.message})`);
      STATE.log("error", `Internal error: ${e && e.message}`);
      if (typeof console !== "undefined") console.error(e);
      throw new Error(`Unexpected problem: ${e && e.message}`);
    }
  }

  G.Engine = {
    api,
    state: STATE,
    catalog: {
      datasets: wrap((ctx, force) => catalogDatasets(ctx, force)),
      resolve: wrap((spec, ctx, opts) => resolveSpec(spec, ctx, opts || {})),
      pick: pickFields,
    },
    ai: {
      providers: AI_PROVIDERS,
      presets: AI_COMPAT_PRESETS,
      listModels: wrap(aiListModels),
      generate: wrap(aiGenerate),
      chat: wrap(aiChat),
    },
    _internals: { BrainClient, Runner, MockBrain, AppState, AbortFlag, Aborted, BrainError, BiometricRequired, makeRow, jobKey, rowToCsv, csvLine, CSV_HEADER, stableStringify, hashHex, parseAiExpressions, checkExpression, pickFields },
  };
})(typeof window !== "undefined" ? window : globalThis);
