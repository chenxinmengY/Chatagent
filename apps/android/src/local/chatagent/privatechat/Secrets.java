package local.chatagent.privatechat;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class Secrets {
  private static SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
    if (!store.containsAlias("chatagent-device")) {
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(new KeyGenParameterSpec.Builder("chatagent-device", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); generator.generateKey();
    }
    return (SecretKey) store.getKey("chatagent-device", null);
  }
  static synchronized void save(Context context, JSONObject value) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
    String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(value.toString().getBytes("UTF-8")), Base64.NO_WRAP);
    if (!context.getSharedPreferences("device", 0).edit().putString("encrypted", encoded).commit()) throw new Exception("DEVICE_SAVE_FAILED");
  }
  static synchronized JSONObject load(Context context) throws Exception {
    String encoded = context.getSharedPreferences("device", 0).getString("encrypted", null); if (encoded == null) return null;
    String[] parts = encoded.split(":", 2);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
    return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), "UTF-8")).put("chatId",LocalStore.selected(context));
  }
}
