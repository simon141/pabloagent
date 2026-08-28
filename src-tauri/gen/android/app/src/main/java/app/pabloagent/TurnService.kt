package app.pabloagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class TurnService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(
          CHANNEL_ID,
          "Turn in progress",
          // Low: an ongoing "still working" row in the tray, never a ping.
          NotificationManager.IMPORTANCE_LOW,
        )
      )
    }
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val notification =
      (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID)
       else @Suppress("DEPRECATION") Notification.Builder(this))
        .setContentTitle("A turn is running")
        // Not `applicationInfo.icon`: a small icon is drawn from its alpha
        // channel alone, and the opaque launcher icon renders as a featureless
        // square. `ic_stat_pablo` is the same cow as a silhouette.
        .setSmallIcon(R.drawable.ic_stat_pablo)
        .setContentIntent(open)
        .setOngoing(true)
        .build()
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(ID, notification)
    }
    // If the process is killed anyway there is no state worth restarting for:
    // the turn lives on the server, and the next launch reads it back.
    return START_NOT_STICKY
  }

  // Android 15 gives dataSync services a daily time budget; when it runs out
  // the system calls this, and crashes the app unless the service stops.
  // Recorded before stopping so Rust learns on the next resume that its
  // watches lost their protection, Kotlin cannot call into Rust here, but
  // Rust can ask (over JNI, through [consumeTimeout]) from a lifecycle state
  // where it is allowed to raise the service again.
  override fun onTimeout(startId: Int, fgsType: Int) {
    timedOut = true
    stopSelf()
  }

  companion object {
    private const val CHANNEL_ID = "turn"

    private const val ID = 41

    @Volatile private var timedOut = false

    @JvmStatic
    fun consumeTimeout(): Boolean {
      val was = timedOut
      timedOut = false
      return was
    }

    @JvmStatic
    fun setActive(context: Context, active: Boolean) {
      val intent = Intent(context, TurnService::class.java)
      if (active) {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
        else context.startService(intent)
      } else {
        context.stopService(intent)
      }
    }
  }
}
