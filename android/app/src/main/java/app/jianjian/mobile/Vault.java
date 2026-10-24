package app.jianjian.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class Vault {
    private static final String ALIAS = "jianjian.session.v1";
    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    static synchronized JSONObject read(Context context) {
        try {
            String encoded = context.getSharedPreferences("vault", 0).getString("data", null);
            if (encoded == null) return new JSONObject();
            String[] parts = encoded.split(":"); Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception e) { return new JSONObject(); }
    }
    static synchronized void write(Context context, JSONObject data) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(data.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!context.getSharedPreferences("vault", 0).edit().putString("data", encoded).commit()) throw new Exception("无法保存登录信息");
    }
    static JSONObject session(Context c) { return read(c).optJSONObject("session"); }
    static JSONObject prefs(Context c) {
        JSONObject all = read(c); JSONObject session = all.optJSONObject("session");
        JSONObject value = session == null ? null : all.optJSONObject("prefs:" + session.optString("server") + ":" + session.optString("username"));
        return value == null ? new JSONObject() : value;
    }
    static void savePrefs(Context c, JSONObject prefs) throws Exception {
        JSONObject all = read(c); JSONObject session = all.optJSONObject("session");
        if (session == null) throw new Exception("请先登录");
        all.put("prefs:" + session.optString("server") + ":" + session.optString("username"), prefs); write(c, all);
    }
}
