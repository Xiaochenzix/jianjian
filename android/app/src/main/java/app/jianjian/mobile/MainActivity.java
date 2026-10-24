package app.jianjian.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.webkit.*;
import android.graphics.Color;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import org.json.JSONObject;
import org.json.JSONArray;
import android.database.Cursor;
import android.provider.OpenableColumns;
import java.util.concurrent.ConcurrentHashMap;
import java.util.ArrayList;
import java.util.UUID;
import java.io.*;
import java.lang.ref.WeakReference;
import java.net.URI;
import java.util.Set;

public class MainActivity extends Activity {
    private static WeakReference<MainActivity> active = new WeakReference<>(null);
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private JSONObject pendingShare;
    private final ConcurrentHashMap<String, Uri> sharedFiles = new ConcurrentHashMap<>();
    private WebView web;
    private FrameLayout webContainer;
    private OnBackInvokedCallback backCallback;
    private ValueCallback<Uri[]> fileCallback;
    private ClipboardManager clipboard;
    private final ClipboardManager.OnPrimaryClipChangedListener clipListener = this::checkClipboard;
    private boolean foreground = false;
    private boolean keyboardVisible = false;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); active = new WeakReference<>(this);
        configureWindow();
        webContainer = new FrameLayout(this); webContainer.setBackgroundColor(Color.rgb(237, 237, 237));
        web = new WebView(this); web.setBackgroundColor(Color.rgb(237, 237, 237));
        webContainer.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(webContainer);
        if (Build.VERSION.SDK_INT >= 30) {
            // PhoneWindow.getInsetsController() dereferences its DecorView on Android 16.
            // setContentView must create the decor before this call; a null check alone is too late.
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(lightBars, lightBars);
            }
            webContainer.setOnApplyWindowInsetsListener((view, insets) -> {
                // Resize the WebView itself: WebView padding does not reliably resize its CSS viewport.
                // The native container owns every inset, so the web UI must not apply them again.
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                boolean visible = insets.isVisible(WindowInsets.Type.ime());
                if (visible != keyboardVisible) {
                    keyboardVisible = visible;
                    emit("viewport", SyncService.object("keyboardVisible", keyboardVisible));
                }
                return WindowInsets.CONSUMED;
            });
            webContainer.requestApplyInsets();
        }
        // Android 10 keeps the platform-fitted content area and adjustResize for the keyboard.
        // It must not also receive the edge-to-edge padding used on Android 11 and later.
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(true);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(false);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !request.getUrl().toString().equals(ORIGIN + "/index.html"); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"appassets.androidplatform.net".equals(uri.getHost())) return null;
                if (uri.getPath() != null && uri.getPath().startsWith("/shared/")) {
                    Uri content = sharedFiles.remove(uri.getLastPathSegment());
                    try {
                        if (content == null) throw new IOException("Missing share");
                        return new WebResourceResponse("application/octet-stream", null, getContentResolver().openInputStream(content));
                    } catch (Exception e) { return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0])); }
                }
                String name = uri.getPath() == null ? "" : uri.getPath().substring(1);
                if (!Set.of("index.html", "styles.css", "app.js", "icon.svg").contains(name)) return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                try { return new WebResourceResponse(name.endsWith("html") ? "text/html" : name.endsWith("css") ? "text/css" : name.endsWith("svg") ? "image/svg+xml" : "text/javascript", "UTF-8", getAssets().open(name)); }
                catch (IOException e) { return null; }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null); fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.setType("*/*"); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(intent, 10); return true;
            }
        });
        clipboard = getSystemService(ClipboardManager.class); clipboard.addPrimaryClipChangedListener(clipListener);
        acceptShare(getIntent());
        web.loadUrl(ORIGIN + "/index.html");
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); acceptShare(intent);
        if (pendingShare != null) emit("share", new JSONObject());
    }
    @SuppressWarnings("deprecation")
    private void acceptShare(Intent intent) {
        if (intent == null || !(Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))) return;
        try {
            ArrayList<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
                ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (streams != null) uris.addAll(streams);
            } else {
                Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (stream != null) uris.add(stream);
            }
            if (intent.getClipData() != null) for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                Uri uri = intent.getClipData().getItemAt(i).getUri(); if (uri != null && !uris.contains(uri)) uris.add(uri);
            }
            JSONArray files = new JSONArray(); sharedFiles.clear();
            for (Uri uri : uris) {
                if (files.length() >= 20) break;
                if (!"content".equals(uri.getScheme())) continue;
                String name = "shared-file";
                try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
                }
                String id = UUID.randomUUID().toString(); sharedFiles.put(id, uri);
                String mime = getContentResolver().getType(uri);
                files.put(new JSONObject().put("name", name == null ? "shared-file" : name).put("mime", mime == null ? "application/octet-stream" : mime).put("url", ORIGIN + "/shared/" + id));
            }
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            pendingShare = new JSONObject().put("text", text == null ? "" : text.toString()).put("files", files);
            intent.setAction(null); intent.removeExtra(Intent.EXTRA_STREAM); intent.removeExtra(Intent.EXTRA_TEXT); intent.setClipData(null);
        } catch (Exception e) { new AlertDialog.Builder(this).setMessage("无法读取分享内容：" + e.getMessage()).setPositiveButton("确定", null).show(); }
    }
    @SuppressWarnings("deprecation")
    private void configureWindow() {
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarContrastEnforced(false);
        getWindow().setNavigationBarContrastEnforced(false);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            getWindow().setAttributes(attributes);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
        } else {
            getWindow().setStatusBarColor(Color.rgb(237, 237, 237));
            getWindow().setNavigationBarColor(Color.rgb(237, 237, 237));
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }
    private void startSync() {
        if (Vault.session(this) == null) return;
        Intent intent = new Intent(this, SyncService.class);
        if (Vault.prefs(this).optBoolean("background")) startForegroundService(intent); else startService(intent);
    }
    @Override protected void onResume() { super.onResume(); foreground = true; startSync(); if (web != null) emit("status", SyncService.object("connected", SyncService.connected)); }
    @Override protected void onStop() { foreground = false; if (!Vault.prefs(this).optBoolean("background")) stopService(new Intent(this, SyncService.class)); super.onStop(); }
    @Override public void onWindowFocusChanged(boolean focus) { super.onWindowFocusChanged(focus); if (focus) checkClipboard(); }
    private String readClipboard() {
        if (!hasWindowFocus() || !foreground || !clipboard.hasPrimaryClip()) return "";
        ClipData data = clipboard.getPrimaryClip(); if (data == null || data.getItemCount() == 0) return "";
        CharSequence text = data.getItemAt(0).getText(); return text == null ? "" : text.toString();
    }
    private void checkClipboard() { if (clipboard != null) SyncService.sendClipboard(this, readClipboard()); }
    static void emit(String type, JSONObject data) {
        MainActivity activity = active.get(); if (activity == null || activity.web == null) return;
        try { data.put("type", type); } catch (Exception ignored) {}
        activity.runOnUiThread(() -> { if (activity.web != null) activity.web.evaluateJavascript("window.__nativeEvent && window.__nativeEvent(" + data + ")", null); });
    }
    private class Bridge {
        @JavascriptInterface public void postMessage(String input) {
            runOnUiThread(() -> {
                int id = 0;
                try {
                    if (web == null || !web.getUrl().equals(ORIGIN + "/index.html")) throw new Exception("无效页面");
                    JSONObject request = new JSONObject(input); id = request.getInt("id"); String method = request.getString("method"); Object value = request.opt("value"); Object result;
                    switch (method) {
                        case "takeShare": result = pendingShare == null ? JSONObject.NULL : pendingShare; pendingShare = null; break;
                        case "getState": {
                            JSONObject info = new JSONObject().put("platform", "Android").put("name", Build.MANUFACTURER + " " + Build.MODEL).put("clipboard", true).put("background", true).put("insetsHandled", true)
                                .put("capability", "Android " + Build.VERSION.RELEASE + " · 系统限制后台读取剪贴板。开启自动发送后，回到剪剪会同步当前文字；后台保持连接用于接收消息，不会解除读取限制。自动写入受系统策略影响。后台连接需启用下方开关。");
                            // Android 10 has no reliable typed IME insets; omit this key so JS uses its viewport fallback.
                            if (Build.VERSION.SDK_INT >= 30) info.put("keyboardVisible", keyboardVisible);
                            result = new JSONObject().put("session", Vault.session(MainActivity.this) == null ? JSONObject.NULL : Vault.session(MainActivity.this)).put("prefs", Vault.prefs(MainActivity.this)).put("info", info); break;
                        }
                        case "saveSession": {
                            JSONObject s = (JSONObject) value; URI uri = new URI(s.getString("server"));
                            if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null || !s.getString("token").matches("[A-Za-z0-9_-]{43}")) throw new Exception("手机端需使用 HTTPS 服务器");
                            stopService(new Intent(MainActivity.this, SyncService.class)); SyncService.lastClipboard = "";
                            JSONObject vault = Vault.read(MainActivity.this); vault.put("session", s); Vault.write(MainActivity.this, vault); result = true; break;
                        }
                        case "connect": startSync(); result = true; break;
                        case "prefs": {
                            JSONObject source = (JSONObject) value, p = new JSONObject();
                            for (String k : new String[]{"autoSend", "autoWrite", "background"}) p.put(k, source.optBoolean(k));
                            Vault.savePrefs(MainActivity.this, p);
                            if (p.optBoolean("background") && Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 20);
                            startSync(); checkClipboard(); result = p; break;
                        }
                        case "copy": {
                            String text = (String) value; if (text.length() > 32768) throw new Exception("文字过长");
                            SyncService.lastClipboard = text; clipboard.setPrimaryClip(ClipData.newPlainText("剪剪", text)); result = true; break;
                        }
                        case "readClipboard": result = readClipboard(); break;
                        case "download": {
                            JSONObject s = Vault.session(MainActivity.this); JSONObject file = (JSONObject) value;
                            if (s == null || !file.getString("id").matches("[0-9a-f-]{36}")) throw new Exception("文件标识无效");
                            String name = file.getString("filename").replaceAll("[\\\\/\\x00-\\x1f]", "_");
                            DownloadManager.Request download = new DownloadManager.Request(Uri.parse(s.getString("server") + "/api/files/" + file.getString("id")));
                            download.addRequestHeader("Authorization", "Bearer " + s.getString("token")); download.setTitle(name); download.setMimeType("application/octet-stream");
                            download.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                            download.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, System.currentTimeMillis() + "-" + name);
                            getSystemService(DownloadManager.class).enqueue(download); result = true; break;
                        }
                        case "logout": {
                            stopService(new Intent(MainActivity.this, SyncService.class)); JSONObject all = Vault.read(MainActivity.this); all.remove("session"); Vault.write(MainActivity.this, all); SyncService.lastClipboard = ""; result = true; break;
                        }
                        default: throw new Exception("不支持的操作");
                    }
                    String encoded = result instanceof String ? JSONObject.quote((String) result) : String.valueOf(result);
                    web.evaluateJavascript("window.__nativeResult(" + id + "," + encoded + ",null)", null);
                } catch (Exception e) { if (web != null) web.evaluateJavascript("window.__nativeResult(" + id + ",null," + JSONObject.quote(e.getMessage() == null ? "操作失败" : e.getMessage()) + ")", null); }
            });
        }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 10 && fileCallback != null) {
            Uri[] uris = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) { uris = new Uri[data.getClipData().getItemCount()]; for (int i = 0; i < uris.length; i++) uris[i] = data.getClipData().getItemAt(i).getUri(); }
                else if (data.getData() != null) uris = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(uris); fileCallback = null;
        }
    }
    private void handleBack() {
        // The system IME gets the first back action. If an OEM dispatches it here instead,
        // dismiss the keyboard before closing a dialog or moving the activity to the background.
        if (Build.VERSION.SDK_INT >= 30 && webContainer != null) {
            WindowInsets insets = webContainer.getRootWindowInsets();
            if (insets != null && insets.isVisible(WindowInsets.Type.ime())) {
                WindowInsetsController controller = getWindow().getInsetsController();
                if (controller != null) { controller.hide(WindowInsets.Type.ime()); return; }
            }
        }
        if (web == null) { moveTaskToBack(true); return; }
        web.evaluateJavascript("(() => { if (typeof window.__handleNativeBack === 'function') return !!window.__handleNativeBack(); const dialog = document.querySelector('dialog[open]'); if (dialog) { const event = new Event('cancel', { cancelable: true }); if (dialog.dispatchEvent(event)) dialog.close(); return true; } return false; })()", result -> { if (!isFinishing() && !isDestroyed() && !"true".equals(result)) moveTaskToBack(true); });
    }
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { handleBack(); }
    @Override protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        if (clipboard != null) clipboard.removePrimaryClipChangedListener(clipListener);
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (active.get() == this) active.clear();
        if (web != null) { web.removeJavascriptInterface("AndroidBridge"); webContainer.removeView(web); web.destroy(); web = null; }
        webContainer = null;
        super.onDestroy();
    }
}
