package com.elev8pixel.ghqom;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Runs about every 15 minutes (even when the app is closed): looks for checklists waiting for the user, results of the user's own checklists, and new app versions. */
public class PollReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(final Context ctx, Intent intent) {
        final PendingResult pr = goAsync();
        new Thread(new Runnable() {
            public void run() {
                try { poll(ctx); } catch (Throwable t) { /* try again next time */ } finally { pr.finish(); }
            }
        }).start();
    }

    static String http(String url, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(25000); c.setInstanceFollowRedirects(true);
        if (body != null) {
            c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "text/plain;charset=utf-8");
            OutputStream os = c.getOutputStream(); os.write(body.getBytes("UTF-8")); os.close();
        }
        InputStream is = c.getInputStream(); ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] b = new byte[8192]; int n;
        while ((n = is.read(b)) > 0) bo.write(b, 0, n);
        is.close(); c.disconnect();
        return bo.toString("UTF-8");
    }

    static void poll(Context ctx) throws Exception {
        SharedPreferences p = NotifyPlugin.prefs(ctx);
        String api = p.getString("api", ""), name = p.getString("name", ""), pin = p.getString("pin", "");
        if (api.length() == 0 || name.length() == 0) return;

        /* 1. checklists */
        JSONObject req = new JSONObject(); req.put("action", "cl_list"); req.put("name", name); req.put("pin", pin);
        JSONObject r = new JSONObject(http(api, req.toString()));
        if (r.optBoolean("ok")) {
            JSONArray list = r.getJSONArray("list");
            String seenS = p.getString("seen", ""); boolean first = seenS.length() == 0;
            JSONObject seen = first ? new JSONObject() : new JSONObject(seenS);
            int todo = 0; StringBuilder mine = new StringBuilder();
            for (int i = 0; i < list.length(); i++) {
                JSONObject x = list.getJSONObject(i);
                String id = x.optString("id"), st = x.optString("status");
                if (x.optBoolean("can") && !st.equals(seen.optString("a" + id))) { todo++; seen.put("a" + id, st); }
                if (x.optString("by").equals(name)) {
                    String prev = seen.optString("m" + id, null);
                    if (!st.equals(prev) && (st.equals("Approved") || st.equals("Rejected")) && !(first && prev == null)) { if (mine.length() > 0) mine.append(", "); mine.append(x.optString("no")).append(" ").append(st.toLowerCase()); }
                    seen.put("m" + id, st);
                }
            }
            p.edit().putString("seen", seen.toString()).apply();
            if (!first) {
                if (todo > 0) NotifyPlugin.notifyNow(ctx, 101, "Checklist waiting for approval", todo + " checklist" + (todo > 1 ? "s are" : " is") + " waiting for your approval");
                if (mine.length() > 0) NotifyPlugin.notifyNow(ctx, 102, "Your checklist", mine.toString());
            }
        }

        /* 2. new app version */
        String upd = p.getString("upd", ""), have = p.getString("build", "");
        if (upd.length() > 0 && have.length() > 0) {
            JSONObject v = new JSONObject(http(upd + "version.json?t=" + System.currentTimeMillis(), null));
            String nv = v.optString("version", "");
            if (nv.length() > 0 && nv.compareTo(have) > 0 && !nv.equals(p.getString("updNotified", ""))) {
                NotifyPlugin.notifyNow(ctx, 103, "GHQ O&M update", "A new version is ready. Open the app and tap the update bar.");
                p.edit().putString("updNotified", nv).apply();
            }
        }
    }
}
