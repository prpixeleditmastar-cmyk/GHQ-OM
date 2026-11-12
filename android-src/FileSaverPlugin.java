package com.elev8pixel.ghqom;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/** Saves a file (base64) into the phone's public Downloads/GHQ-OM folder. */
@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("name");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data");
        if (name == null || data == null) {
            call.reject("name and data are required");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            String where;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/GHQ-OM");
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("Could not create the file in Downloads");
                OutputStream os = resolver.openOutputStream(uri);
                if (os == null) throw new IOException("Could not open the file for writing");
                try {
                    os.write(bytes);
                    os.flush();
                } finally {
                    os.close();
                }
                where = "Downloads/GHQ-OM/" + name;
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "GHQ-OM");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("Could not create the GHQ-OM folder");
                File f = new File(dir, name);
                FileOutputStream os = new FileOutputStream(f);
                try {
                    os.write(bytes);
                    os.flush();
                } finally {
                    os.close();
                }
                where = "Downloads/GHQ-OM/" + name;
            }
            JSObject ret = new JSObject();
            ret.put("path", where);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Save failed: " + e.getMessage());
        }
    }
}
