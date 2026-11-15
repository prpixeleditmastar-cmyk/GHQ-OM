package com.elev8pixel.ghqom;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts the background check after the phone reboots. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (NotifyPlugin.prefs(ctx).getString("name", "").length() > 0) NotifyPlugin.schedule(ctx);
    }
}
