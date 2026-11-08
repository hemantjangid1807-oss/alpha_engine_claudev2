package com.brainautosim.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Hosts the Brain AutoSim web UI (app/src/main/assets/www) in a WebView. The simulator engine
 * itself is JavaScript (engine.js); NativeBridge gives it network access, files, sharing and
 * the background-run notification.
 */
public class MainActivity extends Activity {
    static final String START_URL = "file:///android_asset/www/index.html";
    private static final int REQ_PICK_FILE = 41;

    private FrameLayout root;
    private WebView webView;
    private NativeBridge bridge;
    private ValueCallback<Uri[]> fileCallback;
    private boolean resumed;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.bg));
        setContentView(root);
        buildWebView();

        // Draw behind the system bars on Android 11+ (Android 15 does this anyway) and tell the
        // page how much space the status bar / navigation bar take, so it can pad its own bars.
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int left, top, right, bottom, ime = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                left = bars.left; top = bars.top; right = bars.right; bottom = bars.bottom; ime = keyboard.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            boolean keyboardOpen = ime > bottom;
            v.setPadding(left, 0, right, keyboardOpen ? ime : 0);
            float density = getResources().getDisplayMetrics().density;
            if (bridge != null) bridge.setInsets(top / density, keyboardOpen ? 0 : bottom / density);
            return insets;
        });
        root.requestApplyInsets();
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.bg));
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);          // assets are still readable; nothing else on disk is
        s.setAllowContentAccess(true);        // lets "Import file" read the picked document
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        if (Build.VERSION.SDK_INT >= 26) {
            // Keep the page's process important while a run continues with the screen off.
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        bridge = new NativeBridge(this, webView);
        webView.addJavascriptInterface(bridge, "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("file:///android_asset/")) return false;
                bridge.openExternal(url);   // BRAIN links etc. open in the phone's browser
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bridge.pushInsets();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's process died (rare; usually low memory). Start over instead of crashing.
                if (view == webView) {
                    bridge.stopRunService();
                    bridge.destroy();
                    root.removeView(webView);
                    webView.destroy();
                    webView = null;
                    buildWebView();   // fresh page; settings, history and the last run are on disk
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"text/*", "application/csv", "application/vnd.ms-excel", "application/octet-stream"});
                try {
                    startActivityForResult(Intent.createChooser(pick, getString(R.string.import_alphas)), REQ_PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.app_name)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.app_name)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.confirm())
                        .show();
                return true;
            }
        });

        if (root.isAttachedToWindow()) root.requestApplyInsets();
        if (webView.getUrl() == null) webView.loadUrl(START_URL);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView == null) { finish(); return; }
        // Let the page close its panel / go back a screen first.
        webView.evaluateJavascript("window.__onBack ? window.__onBack() : false", value -> {
            if ("true".equals(value)) return;
            if (bridge.isRunActive()) moveTaskToBack(true);   // keep the run going
            else finish();
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
    }

    @Override
    protected void onPause() {
        resumed = false;
        super.onPause();
    }

    boolean isInForeground() {
        return resumed;
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) {
            if (isFinishing()) bridge.stopRunService();
            bridge.destroy();
        }
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
