package ai.njyn.signage

import android.content.Context
import android.net.Uri

/** The one setting this app keeps: where the player page lives. */
object Prefs {
    private const val FILE = "player"
    private const val KEY_URL = "url"

    /** The saved address, else the one baked into the build, else null. */
    fun playerUrl(context: Context): String? =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_URL, null)
            ?: BuildConfig.PLAYER_URL.takeIf { it.isNotEmpty() }

    fun setPlayerUrl(context: Context, url: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY_URL, url).apply()
    }

    /**
     * Accepts "signage.example.com", "https://signage.example.com" or the full
     * player URL, and returns the player page's address, or null if it isn't
     * an https address.
     */
    fun normalise(input: String): String? {
        var s = input.trim()
        if (s.isEmpty() || s == "https://") return null
        if (!s.contains("://")) s = "https://$s"
        val uri = Uri.parse(s)
        if (uri.scheme != "https") return null // the app refuses cleartext traffic
        if (uri.host.isNullOrEmpty()) return null
        val path = uri.path.orEmpty()
        val playerPath = if (path.isEmpty() || path == "/") "/player/" else if (path.endsWith("/")) path else "$path/"
        return uri.buildUpon().path(playerPath).build().toString()
    }
}
