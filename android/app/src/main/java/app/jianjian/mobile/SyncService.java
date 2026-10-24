package app.jianjian.mobile;

import android.app.*;
import android.content.*;
import android.os.*;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

public class SyncService extends Service {
    static volatile String lastClipboard = "";
    static volatile boolean connected = false;
    private volatile boolean running;
    private volatile HttpURLConnection connection;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private String token = "";
    private static final ExecutorService clipboardWorker = Executors.newSingleThreadExecutor();
    static HttpURLConnection open(JSONObject session, String path) throws Exception {
        URL url = new URL(session.getString("server") + "/api" + path);
        if (!url.getProtocol().equals("https")) throw new Exception("手机端请使用 HTTPS 服务器地址");
        HttpURLConnection c = (HttpURLConnection) url.openConnection(); c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15000); c.setReadTimeout(45000); c.setRequestProperty("Authorization", "Bearer " + session.getString("token")); return c;
    }
    static void sendClipboard(Context context, String text) {
        if (text == null || text.trim().isEmpty() || text.length() > 32768 || text.equals(lastClipboard) || !Vault.prefs(context).optBoolean("autoSend")) return;
        JSONObject session = Vault.session(context); if (session == null) return;
        lastClipboard = text;
        clipboardWorker.submit(() -> {
            HttpURLConnection c = null;
            try {
                c = open(session, "/messages"); c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json");
                JSONObject b = new JSONObject().put("kind", "clipboard").put("text", text).put("clientId", java.util.UUID.randomUUID().toString());
                try (OutputStream out = c.getOutputStream()) { out.write(b.toString().getBytes(StandardCharsets.UTF_8)); }
                if (c.getResponseCode() >= 300) throw new Exception("剪贴板发送失败");
            } catch (Exception e) {
                if (lastClipboard.equals(text)) lastClipboard = "";
                MainActivity.emit("error", object("message", "剪贴板未发送，回到应用后重试"));
            } finally { if (c != null) c.disconnect(); }
        });
    }
    static JSONObject object(String key, Object value) { JSONObject o = new JSONObject(); try { o.put(key, value); } catch (Exception ignored) {} return o; }
    @Override public void onCreate() { super.onCreate(); running = true; createChannel(); }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        JSONObject s = Vault.session(this); if (s == null) { stopSelf(); return START_NOT_STICKY; }
        boolean background = Vault.prefs(this).optBoolean("background");
        if (background) startForeground(7, notification("正在连接你的同步空间")); else stopForeground(STOP_FOREGROUND_REMOVE);
        String next = s.optString("token");
        if (!next.equals(token)) {
            token = next; if (connection != null) connection.disconnect();
            worker.submit(() -> listen(next));
        }
        return background ? START_STICKY : START_NOT_STICKY;
    }
    private void createChannel() {
        NotificationChannel channel = new NotificationChannel("sync", "设备同步", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持连接，接收自己其他设备发送的内容"); getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
    private Notification notification(String text) {
        PendingIntent pending = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, "sync").setSmallIcon(app.jianjian.mobile.R.drawable.ic_notification).setContentTitle("剪剪 · 设备同步").setContentText(text).setContentIntent(pending).setOngoing(true).build();
    }
    private void status(boolean online) {
        connected = online; MainActivity.emit("status", object("connected", online));
        if (Vault.prefs(this).optBoolean("background")) getSystemService(NotificationManager.class).notify(7, notification(online ? "已连接 · 点击打开并同步手机剪贴板" : "连接中断 · 正在重连"));
    }
    private void listen(String generationToken) {
        while (running && generationToken.equals(token)) {
            try {
                JSONObject s = Vault.session(this); if (s == null) return;
                connection = open(s, "/events"); int code = connection.getResponseCode();
                if (code == 401) { MainActivity.emit("auth", new JSONObject()); stopSelf(); return; }
                if (code != 200) throw new IOException("Connection failed"); status(true);
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line, type = "", data = "";
                    while (running && generationToken.equals(token) && (line = reader.readLine()) != null) {
                        if (line.startsWith("event: ")) type = line.substring(7);
                        else if (line.startsWith("data: ")) data = line.substring(6);
                        else if (line.isEmpty() && !type.isEmpty()) {
                            JSONObject payload = data.isEmpty() ? new JSONObject() : new JSONObject(data);
                            if (type.equals("message") && !payload.optString("device_id").equals(s.optString("deviceId")) && !payload.optString("kind").equals("file") && Vault.prefs(this).optBoolean("autoWrite")) {
                                String text = payload.optString("text"); lastClipboard = text;
                                new Handler(Looper.getMainLooper()).post(() -> {
                                    try { getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("剪剪", text)); }
                                    catch (Exception e) { MainActivity.emit("error", object("message", "系统阻止自动写入剪贴板，请打开应用手动复制")); }
                                });
                            }
                            MainActivity.emit(type, object("data", payload)); type = ""; data = "";
                        }
                    }
                }
            } catch (Exception ignored) {} finally { if (connection != null) connection.disconnect(); }
            if (!running || !generationToken.equals(token)) break;
            status(false);
            try { Thread.sleep(3000); } catch (InterruptedException e) { break; }
        }
    }
    @Override public void onDestroy() { running = false; connected = false; if (connection != null) connection.disconnect(); worker.shutdownNow(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
