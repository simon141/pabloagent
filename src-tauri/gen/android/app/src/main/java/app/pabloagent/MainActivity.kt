package app.pabloagent

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  @Volatile
  private var pendingSharedText: String? = null

  private var backCallback: OnBackPressedCallback? = null

  @Volatile
  private var insetsJson: String? = null

  @Volatile
  private var pendingSaveSource: java.io.File? = null

  private val saveLauncher =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val source = pendingSaveSource
      pendingSaveSource = null
      val uri = result.data?.data
      if (source == null || result.resultCode != RESULT_OK || uri == null) {
        // Backing out of the picker is a decision, not a failure to report.
        return@registerForActivityResult
      }
      Thread {
        val problem =
          try {
            val out = contentResolver.openOutputStream(uri)
              ?: throw java.io.IOException("the chosen location refused a stream")
            out.use { stream -> source.inputStream().use { it.copyTo(stream) } }
            null
          } catch (e: Exception) {
            "Could not save the file: ${e.message ?: e.javaClass.simpleName}"
          }
        runOnUiThread { notifyPage(problem ?: "Saved ${source.name}") }
      }.start()
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    pendingSharedText = sharedTextFrom(intent) ?: pendingSharedText
    interceptBackPress()
  }

  private fun interceptBackPress() {
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = webView
        if (view == null) {
          closeAsUsual()
          return
        }
        // Asking costs a round trip to the WebView's JS thread, so the answer
        // arrives in a callback rather than as a return value. Anything other
        // than a plain "true", no handler yet, a page still booting, a script
        // that threw, counts as "the page did not handle it".
        view.evaluateJavascript(BACK_SCRIPT) { handled ->
          if (handled != "true") closeAsUsual()
        }
      }
    }
    backCallback = callback
    onBackPressedDispatcher.addCallback(this, callback)
  }

  private fun closeAsUsual() {
    val callback = backCallback
    if (callback == null) {
      finish()
      return
    }
    // Disabling the callback for one dispatch is what lets the framework's own
    // handling run, so this keeps whatever the default is rather than assuming
    // it stays `finish()`.
    callback.isEnabled = false
    onBackPressedDispatcher.onBackPressed()
    callback.isEnabled = true
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val text = sharedTextFrom(intent) ?: return
    pendingSharedText = text
    // The page is already running (launchMode is singleTask), so ping it; a
    // page still booting collects the text itself via the interface below.
    webView?.post {
      webView?.evaluateJavascript(
        "window.__pabloSharedText && window.__pabloSharedText();",
        null,
      )
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(SharedTextBridge(), "PabloShare")
    webView.addJavascriptInterface(ExternalOpenBridge(), "PabloOpen")
    webView.addJavascriptInterface(SystemBarsBridge(), "PabloSystemBars")
    reportInsets(webView)
  }

  private fun reportInsets(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val chrome = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val bars = insets.getInsets(chrome)
      val density = view.resources.displayMetrics.density.let { if (it > 0f) it else 1f }
      val json =
        "{\"top\":${cssPx(bars.top, density)}," +
          "\"right\":${cssPx(bars.right, density)}," +
          "\"bottom\":${cssPx(bottomInset(insets, chrome), density)}," +
          "\"left\":${cssPx(bars.left, density)}}"
      if (json != insetsJson) {
        insetsJson = json
        // The listener runs on the UI thread, which is where evaluate belongs.
        webView.evaluateJavascript("window.__pabloInsets && window.__pabloInsets($json);", null)
      }
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    // The window may well have settled before the WebView existed, in which
    // case nothing would dispatch on its own.
    ViewCompat.requestApplyInsets(webView)
  }

  private fun bottomInset(insets: WindowInsetsCompat, chrome: Int): Int {
    val bars = insets.getInsets(chrome).bottom
    val stable = insets.getInsetsIgnoringVisibility(chrome).bottom
    val ime = maxOf(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom, bars - stable)
    return maxOf(0, minOf(bars, stable) - ime)
  }

  private fun cssPx(pixels: Int, density: Float): String =
    String.format(java.util.Locale.US, "%.2f", pixels / density)

  private inner class SystemBarsBridge {
    @JavascriptInterface
    fun setScheme(scheme: String) {
      val light = scheme == "light"
      // A JavaScript interface call arrives on a binder thread; the window
      // belongs to the UI thread.
      runOnUiThread {
        WindowCompat.getInsetsController(window, window.decorView).apply {
          isAppearanceLightStatusBars = light
          isAppearanceLightNavigationBars = light
        }
      }
    }

    @JavascriptInterface
    fun insets(): String = insetsJson ?: ""
  }

  private inner class ExternalOpenBridge {
    @JavascriptInterface
    fun open(url: String): String {
      val uri =
        try {
          Uri.parse(url)
        } catch (e: Exception) {
          return "That path could not be turned into a link."
        }
      // A JavaScript interface call arrives on a binder thread, and starting
      // an activity belongs to the UI thread.
      runOnUiThread {
        try {
          startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
          notifyPage("No app on this phone opens ${uri.scheme}:// links.")
        } catch (e: SecurityException) {
          notifyPage("This phone refused to open that link.")
        }
      }
      return ""
    }

    @JavascriptInterface
    fun openFile(path: String): String {
      val file = java.io.File(path)
      if (!file.isFile) return "The downloaded file is no longer on this device."
      // Confined to the download directory: this bridge is reachable from the
      // page, and it must not become a way to publish an arbitrary file out of
      // the app's private storage to whatever asks.
      val downloads = java.io.File(cacheDir, "downloads").canonicalFile
      val canonical =
        try {
          file.canonicalFile
        } catch (e: java.io.IOException) {
          return "That file could not be read."
        }
      // One level down: every download lives in its own downloads/<token>/.
      if (canonical.parentFile?.parentFile != downloads) {
        return "Only a downloaded file can be opened this way."
      }

      val uri =
        try {
          androidx.core.content.FileProvider.getUriForFile(
            this@MainActivity,
            "$packageName.fileprovider",
            canonical,
          )
        } catch (e: IllegalArgumentException) {
          return "This phone would not share the downloaded file with another app."
        }
      val type =
        android.webkit.MimeTypeMap.getSingleton()
          .getMimeTypeFromExtension(canonical.extension.lowercase())
          ?: "*/*"

      runOnUiThread {
        val intent =
          Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, type)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
          startActivity(intent)
        } catch (e: ActivityNotFoundException) {
          notifyPage("No app on this phone opens ${canonical.extension} files.")
        } catch (e: SecurityException) {
          notifyPage("This phone refused to open the downloaded file.")
        }
      }
      return ""
    }

    @JavascriptInterface
    fun saveFile(path: String, name: String): String {
      val file = java.io.File(path)
      if (!file.isFile) return "The downloaded file is no longer on this device."
      val downloads = java.io.File(cacheDir, "downloads").canonicalFile
      val canonical =
        try {
          file.canonicalFile
        } catch (e: java.io.IOException) {
          return "That file could not be read."
        }
      // One level down: every download lives in its own downloads/<token>/.
      if (canonical.parentFile?.parentFile != downloads) {
        return "Only a downloaded file can be saved this way."
      }
      val type =
        android.webkit.MimeTypeMap.getSingleton()
          .getMimeTypeFromExtension(canonical.extension.lowercase())
          ?: "application/octet-stream"

      pendingSaveSource = canonical
      val intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT)
          .addCategory(Intent.CATEGORY_OPENABLE)
          .setType(type)
          .putExtra(Intent.EXTRA_TITLE, name.ifBlank { canonical.name })
      runOnUiThread {
        try {
          saveLauncher.launch(intent)
        } catch (e: ActivityNotFoundException) {
          pendingSaveSource = null
          notifyPage("This phone has no file picker to save with.")
        }
      }
      return ""
    }
  }

  private fun notifyPage(message: String) {
    val encoded = org.json.JSONObject.quote(message)
    webView?.evaluateJavascript(
      "window.__pabloOpenFailed && window.__pabloOpenFailed($encoded);",
      null,
    )
  }

  private inner class SharedTextBridge {
    @JavascriptInterface
    fun consume(): String? {
      val text = pendingSharedText
      pendingSharedText = null
      return text
    }
  }

  private fun sharedTextFrom(intent: Intent?): String? {
    val text = when (intent?.action) {
      Intent.ACTION_PROCESS_TEXT ->
        intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
      Intent.ACTION_SEND ->
        if (intent.type?.startsWith("text/plain") == true) {
          intent.getStringExtra(Intent.EXTRA_TEXT)
        } else {
          null
        }
      else -> null
    }
    // Selections drag whitespace and newlines along with them; a prompt
    // should start at the text.
    return text?.trim()?.takeIf { it.isNotEmpty() }
  }

  private companion object {

    const val BACK_SCRIPT =
      "(function(){try{" +
        "return !!(window.__pabloBack && window.__pabloBack())" +
        "}catch(e){return false}})()"
  }
}
