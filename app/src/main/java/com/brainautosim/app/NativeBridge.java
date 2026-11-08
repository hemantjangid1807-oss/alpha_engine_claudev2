package com.brainautosim.app;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.TextUtils;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Everything the JavaScript side (platform.js) needs from Android. Methods marked
 * {@code @JavascriptInterface} are called from the page on a background thread; results that
 * take time come back through {@code window.__nativeDone(id, json)} / {@code window.__nativeWake(id)}.
 */
public class NativeBridge {
    private static final Pattern SAFE_NAME = Pattern.compile("(results/)?[A-Za-z0-9_.-]{1,120}");

    private final MainActivity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final MemoryCookieJar cookies = new MemoryCookieJar();
    private final OkHttpClient http;
    private volatile boolean destroyed = false;
    private volatile boolean runActive = false;
    private volatile float insetTop = 0f, insetBottom = 0f;
    private long lastProgressUpdate = 0;

    NativeBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.http = new OkHttpClient.Builder()
                .cookieJar(cookies)
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(90, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .followRedirects(true)
                .followSslRedirects(true)
                .retryOnConnectionFailure(true)
                .build();
    }

    // --------------------------------------------------------------------------------------- //
    // HTTP (the page can't call api.worldquantbrain.com directly because of browser CORS rules)
    // --------------------------------------------------------------------------------------- //
    @JavascriptInterface
    public void http(final int id, final String method, final String url, final String headersJson, final String body, final int timeoutMs) {
        pool.execute(() -> deliver(id, doHttp(method, url, headersJson, body, timeoutMs)));
    }

    private String doHttp(String method, String url, String headersJson, String body, int timeoutMs) {
        JSONObject out = new JSONObject();
        try {
            String m = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
            Request.Builder rb = new Request.Builder().url(url);
            String contentType = null;
            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject h = new JSONObject(headersJson);
                Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    String v = h.optString(k, "");
                    if (k.equalsIgnoreCase("Content-Type")) contentType = v;
                    rb.header(k, v);
                }
            }
            RequestBody requestBody = null;
            boolean needsBody = m.equals("POST") || m.equals("PUT") || m.equals("PATCH");
            if (body != null && !m.equals("GET") && !m.equals("HEAD")) {
                requestBody = RequestBody.create(body.getBytes(StandardCharsets.UTF_8), contentType == null ? null : MediaType.parse(contentType));
            } else if (needsBody) {
                requestBody = RequestBody.create(new byte[0], (MediaType) null);
            }
            rb.method(m, requestBody);
            long t = Math.max(timeoutMs, 1000);
            // AI models can think for a couple of minutes before the first byte, so the read timeout follows the call timeout.
            OkHttpClient client = http.newBuilder()
                    .callTimeout(t, TimeUnit.MILLISECONDS)
                    .readTimeout(t, TimeUnit.MILLISECONDS)
                    .build();
            try (Response resp = client.newCall(rb.build()).execute()) {
                out.put("status", resp.code());
                JSONObject hh = new JSONObject();
                Headers headers = resp.headers();
                for (String name : headers.names()) {
                    hh.put(name.toLowerCase(Locale.ROOT), TextUtils.join(", ", headers.values(name)));
                }
                out.put("headers", hh);
                ResponseBody rbody = resp.body();
                out.put("body", rbody == null ? "" : rbody.string());
                out.put("url", resp.request().url().toString());
            }
        } catch (Exception e) {
            String msg = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
            out = new JSONObject();
            try { out.put("error", msg); } catch (JSONException ignored) { /* cannot happen */ }
        }
        return out.toString();
    }

    @JavascriptInterface
    public void clearCookies() {
        cookies.clear();
    }

    private void deliver(final int id, final String json) {
        final String js = "window.__nativeDone&&window.__nativeDone(" + id + "," + jsString(json) + ")";
        main.post(() -> { if (!destroyed) webView.evaluateJavascript(js, null); });
    }

    private static String jsString(String s) {
        return JSONObject.quote(s).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    // --------------------------------------------------------------------------------------- //
    // Timers that keep working with the screen off (page timers get throttled in the background)
    // --------------------------------------------------------------------------------------- //
    @JavascriptInterface
    public void sleep(final int id, final int ms) {
        main.postDelayed(() -> {
            if (!destroyed) webView.evaluateJavascript("window.__nativeWake&&window.__nativeWake(" + id + ")", null);
        }, Math.max(0, ms));
    }

    // --------------------------------------------------------------------------------------- //
    // Private files: config.json, history.json, last_run.json, results/run_*.csv
    // --------------------------------------------------------------------------------------- //
    private File resolve(String name) {
        if (name == null || name.contains("..") || !SAFE_NAME.matcher(name).matches()) return null;
        if (name.startsWith("results/")) {
            File base = activity.getExternalFilesDir(null);
            if (base == null) base = activity.getFilesDir();
            return new File(base, name);
        }
        return new File(activity.getFilesDir(), name);
    }

    @JavascriptInterface
    public String readFile(String name) {
        File f = resolve(name);
        if (f == null || !f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    @JavascriptInterface
    public boolean writeFile(String name, String content) {
        File f = resolve(name);
        if (f == null) return false;
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return false;
        File tmp = new File(f.getPath() + ".tmp");
        try (OutputStream os = new FileOutputStream(tmp)) {
            os.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            return false;
        }
        return tmp.renameTo(f) || (f.delete() && tmp.renameTo(f));
    }

    @JavascriptInterface
    public boolean appendFile(String name, String content) {
        File f = resolve(name);
        if (f == null) return false;
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return false;
        try (OutputStream os = new FileOutputStream(f, true)) {
            os.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    @JavascriptInterface
    public String filePath(String name) {
        File f = resolve(name);
        return f == null ? name : f.getAbsolutePath();
    }

    // --------------------------------------------------------------------------------------- //
    // Results out of the app: Downloads folder and the share sheet
    // --------------------------------------------------------------------------------------- //
    @JavascriptInterface
    public boolean canSaveToDownloads() {
        return Build.VERSION.SDK_INT >= 29;
    }

    /** Writes Downloads/BrainAutoSim/&lt;name&gt; (Android 10+). Returns {"ok":true,"path":...} or {"ok":false,"error":...}. */
    @JavascriptInterface
    public String saveToDownloads(String name, String mime, String content) {
        JSONObject out = new JSONObject();
        try {
            if (Build.VERSION.SDK_INT < 29) {
                out.put("ok", false);
                out.put("error", "Saving to Downloads needs Android 10 or newer. Use Share instead.");
                return out.toString();
            }
            String safe = safeFileName(name);
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime == null ? "text/csv" : mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/BrainAutoSim");
            ContentResolver cr = activity.getContentResolver();
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("Android refused to create the file");
            try (OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) throw new IOException("Android refused to open the file");
                os.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
            }
            out.put("ok", true);
            out.put("path", "Downloads/BrainAutoSim/" + safe);
        } catch (Exception e) {
            try {
                out.put("ok", false);
                out.put("error", String.valueOf(e.getMessage()));
            } catch (JSONException ignored) { /* cannot happen */ }
        }
        return out.toString();
    }

    @JavascriptInterface
    public boolean shareFile(String name, final String mime, String content) {
        File dir = new File(activity.getCacheDir(), ShareProvider.DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) return false;
        final File f = new File(dir, safeFileName(name));
        try (OutputStream os = new FileOutputStream(f)) {
            os.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            return false;
        }
        final Uri uri = ShareProvider.uriFor(activity, f);
        main.post(() -> {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime == null ? "text/csv" : mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, f.getName());
            send.setClipData(ClipData.newRawUri(f.getName(), uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, activity.getString(R.string.share_results));
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                activity.startActivity(chooser);
            } catch (ActivityNotFoundException e) {
                Toast.makeText(activity, R.string.no_share_app, Toast.LENGTH_LONG).show();
            }
        });
        return true;
    }

    private static String safeFileName(String name) {
        String s = name == null ? "results.csv" : name.replaceAll("[^A-Za-z0-9_.-]", "_");
        if (s.isEmpty() || s.startsWith(".")) s = "results" + s;
        return s.length() > 120 ? s.substring(s.length() - 120) : s;
    }

    // --------------------------------------------------------------------------------------- //
    // Small helpers
    // --------------------------------------------------------------------------------------- //
    @JavascriptInterface
    public void copyText(final String text) {
        main.post(() -> {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Brain AutoSim", text == null ? "" : text));
        });
    }

    @JavascriptInterface
    public void openUrl(final String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
        main.post(() -> openExternal(url));
    }

    void openExternal(String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, R.string.no_browser, Toast.LENGTH_LONG).show();
        }
    }

    @JavascriptInterface
    public void openBatterySettings() {
        main.post(() -> {
            try {
                activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception e) {
                try {
                    Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.getPackageName()));
                    activity.startActivity(details);
                } catch (Exception ignored) { /* nothing else to try */ }
            }
        });
    }

    // --------------------------------------------------------------------------------------- //
    // System bar sizes, so the page can pad its header and bottom navigation
    // --------------------------------------------------------------------------------------- //
    void setInsets(float top, float bottom) {
        insetTop = top;
        insetBottom = bottom;
        pushInsets();
    }

    void pushInsets() {
        if (destroyed) return;
        webView.evaluateJavascript("window.__setInsets&&window.__setInsets(" + insetTop + "," + insetBottom + ")", null);
    }

    @JavascriptInterface
    public String insets() {
        return insetTop + "," + insetBottom;
    }

    // --------------------------------------------------------------------------------------- //
    // Background runs: a foreground-service notification keeps the app alive with the screen off
    // --------------------------------------------------------------------------------------- //
    @JavascriptInterface
    public void runStarted(final int total) {
        runActive = true;
        lastProgressUpdate = 0;
        main.post(() -> {
            if (Build.VERSION.SDK_INT >= 33
                    && activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 7);
            }
            RunService.start(activity, total);
        });
    }

    @JavascriptInterface
    public void runProgress(int done, int total, int good) {
        long now = SystemClock.uptimeMillis();
        if (now - lastProgressUpdate < 1000 && done < total) return;   // Android drops rapid updates anyway
        lastProgressUpdate = now;
        RunService.update(activity, done, total, good);
    }

    @JavascriptInterface
    public void runEnded(final String title, final String text) {
        runActive = false;
        main.post(() -> {
            RunService.stop(activity);
            if (!activity.isInForeground()) RunService.notifyFinished(activity, title, text);
        });
    }

    boolean isRunActive() {
        return runActive;
    }

    /** Call on the main thread. */
    void stopRunService() {
        runActive = false;
        RunService.stop(activity);
    }

    void destroy() {
        destroyed = true;
        main.removeCallbacksAndMessages(null);
        pool.shutdownNow();
    }

    // --------------------------------------------------------------------------------------- //
    /** Keeps BRAIN's session cookie in memory, like the desktop app's requests.Session(). */
    static final class MemoryCookieJar implements CookieJar {
        private final List<Cookie> store = new ArrayList<>();

        @Override
        public synchronized void saveFromResponse(HttpUrl url, List<Cookie> cookies) {
            long now = System.currentTimeMillis();
            for (Cookie c : cookies) {
                Iterator<Cookie> it = store.iterator();
                while (it.hasNext()) {
                    Cookie old = it.next();
                    if (old.name().equals(c.name()) && old.domain().equals(c.domain()) && old.path().equals(c.path())) it.remove();
                }
                if (c.expiresAt() > now) store.add(c);
            }
        }

        @Override
        public synchronized List<Cookie> loadForRequest(HttpUrl url) {
            long now = System.currentTimeMillis();
            List<Cookie> out = new ArrayList<>();
            Iterator<Cookie> it = store.iterator();
            while (it.hasNext()) {
                Cookie c = it.next();
                if (c.expiresAt() <= now) it.remove();
                else if (c.matches(url)) out.add(c);
            }
            return out;
        }

        synchronized void clear() {
            store.clear();
        }
    }
}
