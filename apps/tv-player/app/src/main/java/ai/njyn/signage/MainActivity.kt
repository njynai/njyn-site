package ai.njyn.signage

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout

/**
 * A full-screen WebView showing the signage player page. Everything about what
 * plays lives on the server; this app only keeps the page on screen: awake,
 * full-screen, autoplaying with sound, reloading after errors and starting on boot.
 *
 * Remote control: Back or Menu opens a small menu (change address, reload,
 * allow start on boot, exit).
 */
class MainActivity : Activity() {

    private var web: WebView? = null
    private val handler = Handler(Looper.getMainLooper())
    private val retry = Runnable { web?.reload() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) })

        val url = Prefs.playerUrl(this)
        if (url == null) askForAddress(firstRun = true) else showPlayer(url)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showPlayer(url: String) {
        web?.destroy()
        val view = WebView(this).apply {
            setBackgroundColor(0xFF000000.toInt())
            isFocusable = false // keep D-pad keys for this activity's menu
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // the player saves its token and last schedule
            settings.mediaPlaybackRequiresUserGesture = false // autoplay video with sound
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            webViewClient = PlayerClient()
            webChromeClient = object : WebChromeClient() {
                // Without this the WebView draws a grey play button before each video starts.
                override fun getDefaultVideoPoster(): Bitmap =
                    Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
            }
        }
        web = view
        setContentView(view)
        hideSystemUi()
        view.loadUrl(url)
    }

    private inner class PlayerClient : WebViewClient() {
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            // The player's service worker serves it offline, so a main-frame error
            // means it never loaded at all: try again shortly.
            if (request.isForMainFrame) {
                handler.removeCallbacks(retry)
                handler.postDelayed(retry, RETRY_MS)
            }
        }

        @TargetApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's renderer crashed or was killed for memory: start fresh.
            web = null
            view.destroy()
            recreate()
            return true
        }
    }

    private fun hideSystemUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        }
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        web?.onResume()
    }

    override fun onPause() {
        web?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacks(retry)
        web?.destroy()
        web = null
        super.onDestroy()
    }

    // ---------- remote control menu ----------

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Back opens the menu too, so a stray press doesn't take the TV off the player.
        val menuKey = keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS ||
            keyCode == KeyEvent.KEYCODE_BACK
        if (menuKey && Prefs.playerUrl(this) != null) {
            showMenu()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun showMenu() {
        val actions = listOf<Pair<Int, () -> Unit>>(
            R.string.menu_change_address to { askForAddress(firstRun = false) },
            R.string.menu_reload to { web?.reload() },
            R.string.menu_autostart to { requestAutostart() },
            R.string.menu_exit to { finish() },
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.menu_title)
            .setItems(actions.map { getString(it.first) }.toTypedArray()) { _, which -> actions[which].second() }
            .setNegativeButton(R.string.cancel, null)
            .setOnDismissListener { hideSystemUi() }
            .show()
    }

    private fun askForAddress(firstRun: Boolean) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(Prefs.playerUrl(this@MainActivity) ?: BuildConfig.PLAYER_URL.ifEmpty { "https://" })
            setSelection(text.length)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.setup_title)
            .setMessage(R.string.setup_message)
            .setView(FrameLayout(this).apply {
                val pad = (24 * resources.displayMetrics.density).toInt()
                setPadding(pad, 0, pad, 0)
                addView(input)
            })
            .setPositiveButton(R.string.setup_save, null) // set below so a bad address keeps the dialog open
            .setCancelable(!firstRun)
            .apply { if (!firstRun) setNegativeButton(R.string.cancel, null) }
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val url = Prefs.normalise(input.text.toString())
                if (url == null) {
                    input.error = getString(R.string.setup_invalid)
                } else {
                    Prefs.setPlayerUrl(this, url)
                    dialog.dismiss()
                    showPlayer(url)
                    if (firstRun) requestAutostart()
                }
            }
        }
        dialog.show()
    }

    // Android 10+ blocks apps from opening themselves after boot unless they
    // may draw over other apps. Fire TV hides that setting, hence the adb fallback.
    private fun requestAutostart() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || Settings.canDrawOverlays(this)) return
        try {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        } catch (e: ActivityNotFoundException) {
            AlertDialog.Builder(this)
                .setTitle(R.string.menu_autostart)
                .setMessage(R.string.autostart_adb)
                .setPositiveButton(R.string.ok, null)
                .show()
        }
    }

    private companion object {
        const val RETRY_MS = 15_000L
    }
}
