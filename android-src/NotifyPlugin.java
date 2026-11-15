package com.elev8pixel.ghqom;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.Settings;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Tray notifications (checklist waiting / approved / rejected, new app version) + a 15-minute background check. */
@CapacitorPlugin(name = "Notify")
public class NotifyPlugin extends Plugin {
    static final String CH = "ghq_alerts";
    static final String PREF = "ghq_notify";

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREF, Context.MODE_PRIVATE); }

    static void channel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CH) == null) {
                NotificationChannel ch = new NotificationChannel(CH, "GHQ O&M alerts", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Checklist approvals, results and app updates");
                nm.createNotificationChannel(ch);
            }
        }
    }

    static void notifyNow(Context c, int id, String title, String body) {
        try {
            channel(c);
            Intent launch = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
            if (launch != null) launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = launch == null ? null : PendingIntent.getActivity(c, id, launch, fl);
            NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH)
                .setSmallIcon(c.getApplicationInfo().icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true);
            if (pi != null) b.setContentIntent(pi);
            ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(id, b.build());
        } catch (Exception e) { /* notifications blocked: ignore */ }
    }

    static void schedule(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = PendingIntent.getBroadcast(c, 7, new Intent(c, PollReceiver.class), fl);
            am.setInexactRepeating(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 5 * 60 * 1000L, AlarmManager.INTERVAL_FIFTEEN_MINUTES, pi);
        } catch (Exception e) { }
    }

    static void cancel(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT;
            am.cancel(PendingIntent.getBroadcast(c, 7, new Intent(c, PollReceiver.class), fl));
        } catch (Exception e) { }
    }

    @PluginMethod
    public void ask(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 33 && getActivity() != null && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                getActivity().requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4711);
        } catch (Exception e) { }
        channel(getContext());
        call.resolve();
    }

    @PluginMethod
    public void show(PluginCall call) {
        notifyNow(getContext(), call.getInt("id", (int) (System.currentTimeMillis() % 100000)), call.getString("title", "GHQ O&M"), call.getString("body", ""));
        call.resolve();
    }

    /** Saves what the background check needs: server address, login, installed build, already-notified keys. */
    @PluginMethod
    public void config(PluginCall call) {
        SharedPreferences.Editor e = prefs(getContext()).edit();
        e.putString("api", call.getString("api", "")).putString("name", call.getString("name", "")).putString("pin", call.getString("pin", ""))
            .putString("upd", call.getString("upd", "")).putString("build", call.getString("build", ""));
        if (call.getString("seen") != null) e.putString("seen", call.getString("seen"));
        e.apply();
        schedule(getContext());
        call.resolve();
    }

    /** {enabled: true/false} - are notifications allowed for this app right now */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        boolean on = true;
        try { on = androidx.core.app.NotificationManagerCompat.from(getContext()).areNotificationsEnabled(); } catch (Exception e) { }
        o.put("enabled", on);
        call.resolve(o);
    }

    /** Opens this app's notification settings page so the person can switch notifications on by hand. */
    @PluginMethod
    public void settings(PluginCall call) {
        try {
            Intent i = new Intent();
            if (Build.VERSION.SDK_INT >= 26) {
                i.setAction(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            } else {
                i.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) { }
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        prefs(getContext()).edit().clear().apply();
        cancel(getContext());
        call.resolve();
    }
}
