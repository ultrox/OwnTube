package com.ultrox.owntube;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Device credentials stay in no-backup storage, encrypted with a non-exportable Android Keystore key. */
final class DeviceCredentials {
    static final class Pair {
        final String deviceId, key, label, person;
        Pair(String deviceId, String key, String label, String person) {
            this.deviceId = deviceId; this.key = key; this.label = label; this.person = person;
        }
    }
    private static final String ALIAS = "owntube.ytdash.device.v1";
    private final AtomicFile file;
    DeviceCredentials(Context context) {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "ytdash-device.enc"));
    }

    synchronized Pair load() throws Exception {
        if (!file.getBaseFile().exists()) return null;
        byte[] bytes = file.readFully();
        if (bytes.length < 29) throw new IllegalStateException("Invalid saved pairing");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secret(), new GCMParameterSpec(128, Arrays.copyOf(bytes, 12)));
        JSONObject value = new JSONObject(new String(cipher.doFinal(Arrays.copyOfRange(bytes, 12, bytes.length)), StandardCharsets.UTF_8));
        if (!YtdashApi.ORIGIN.equals(value.getString("origin"))) throw new IllegalStateException("Pairing origin mismatch");
        return new Pair(value.getString("deviceId"), value.getString("key"), value.optString("label"), value.optString("person"));
    }

    synchronized void save(Pair pair) throws Exception {
        JSONObject value = new JSONObject().put("origin", YtdashApi.ORIGIN).put("deviceId", pair.deviceId)
                .put("key", pair.key).put("label", pair.label).put("person", pair.person);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secret());
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        FileOutputStream stream = file.startWrite();
        try {
            stream.write(cipher.getIV());
            stream.write(encrypted);
            file.finishWrite(stream);
        } catch (Exception e) {
            file.failWrite(stream);
            throw e;
        }
    }

    private SecretKey secret() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
