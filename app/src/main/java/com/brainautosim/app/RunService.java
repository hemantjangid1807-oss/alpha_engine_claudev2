package com.brainautosim.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Foreground service that only exists while a simulation run is going. Its notification shows
 * progress, and it keeps the CPU awake so the run continues with the screen off or in another
 * app. The simulations themselves run in the page (engine.js).
 */
public class RunService extends Service {
    static final String CHANNEL_RUN = "run_progress";
    static final String CHANNEL_DONE = "run_done";
    static final int ID_RUN = 1;
    static final int ID_DONE = 2;
    private static final String EXTRA_TOTAL = "total";

    /** True while the service is in the foreground (progress updates are allowed). */
    static volatile boolean active = false;
    // Main thread only. Android crashes an app whose foreground service is stopped before it called
    // startForeground(), so a stop that arrives too early waits for onStartCommand.
    private static boolean starting = false;
    private static boolean stopWhenStarted = false;
    private PowerManager.WakeLock wakeLock;

    /** Call on the main thread. */
    static void start(Context c, int total) {
        stopWhenStarted = false;
        Intent i = new Intent(c, RunService.class).putExtra(EXTRA_TOTAL, total);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
            starting = true;
        } catch (RuntimeException e) {
            // Not allowed right now (e.g. app already in the background). The run still works while the app is open.
        }
    }

    static void update(Context c, int done, int total, int good) {
        if (!active) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(ID_RUN, progress(c, done, total, good));
    }

    /** Call on the main thread. */
    static void stop(Context c) {
        active = false;
        if (starting) {
            stopWhenStarted = true;
            return;
        }
        c.stopService(new Intent(c, RunService.class));
    }

    static void notifyFinished(Context c, String title, String text) {
        ensureChannels(c);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL_DONE) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat_sim)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(openApp(c));
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(ID_DONE, b.build());
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels(this);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BrainAutoSim:run");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(12L * 60 * 60 * 1000);   // safety cap: 12 hours
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int total = intent != null ? intent.getIntExtra(EXTRA_TOTAL, 0) : 0;
        Notification n = progress(this, 0, total, 0);
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(ID_RUN, n);
        starting = false;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(ID_DONE);
        if (stopWhenStarted) {   // the run already ended
            stopWhenStarted = false;
            active = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        active = true;
        return START_NOT_STICKY;
    }

    /** Android 15+: data-sync services get about 6 hours a day. The run keeps going while the app is open. */
    public void onTimeout(int startId, int fgsType) {
        active = false;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        active = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------------------------------- //
    private static Notification progress(Context c, int done, int total, int good) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL_RUN) : new Notification.Builder(c);
        String text = done + " of " + total + " finished" + (good > 0 ? " · " + good + " good" : "");
        b.setSmallIcon(R.drawable.ic_stat_sim)
                .setContentTitle(c.getString(R.string.notif_running))
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(openApp(c));
        if (total > 0) b.setProgress(total, Math.min(done, total), false);
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_LOW);
        return b.build();
    }

    private static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel run = new NotificationChannel(CHANNEL_RUN, c.getString(R.string.channel_run), NotificationManager.IMPORTANCE_LOW);
        run.setShowBadge(false);
        nm.createNotificationChannel(run);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_DONE, c.getString(R.string.channel_done), NotificationManager.IMPORTANCE_DEFAULT));
    }
}
