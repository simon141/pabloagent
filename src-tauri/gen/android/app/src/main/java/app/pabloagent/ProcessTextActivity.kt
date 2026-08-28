package app.pabloagent

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class ProcessTextActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val forward = Intent(this, MainActivity::class.java).apply {
      action = intent?.action
      type = intent?.type
      intent?.extras?.let(::putExtras)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    startActivity(forward)
    finish()
  }
}
