package ai.njyn.meetingnotes.data

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Where notes live on the phone.
 *
 * Files are published into Documents/MeetingNotes through MediaStore, so they
 * show up in the Files app and in any editor, survive uninstalling this app,
 * and need no storage permission. One meeting produces two files side by side:
 *
 *   Documents/MeetingNotes/2026-08-15-1430.md
 *   Documents/MeetingNotes/2026-08-15-1430.wav
 */
class NoteStore(private val context: Context) {

    data class Note(val name: String, val uri: Uri)

    private val resolver get() = context.contentResolver
    private val collection: Uri
        get() = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

    /** Working directory for the in-progress recording, private to this app. */
    fun scratchDir(): File = File(context.filesDir, "recordings").apply { mkdirs() }

    /**
     * Pick a stamp that is not already taken, so two meetings started in the
     * same minute do not overwrite each other.
     */
    fun reserveStamp(now: Date = Date()): String {
        val base = STAMP_FORMAT.format(now)
        val taken = existingNames()

        if ("$base.md" !in taken && "$base.wav" !in taken) return base
        var n = 2
        while ("$base-$n.md" in taken || "$base-$n.wav" in taken) n++
        return "$base-$n"
    }

    private fun existingNames(): Set<String> {
        val names = mutableSetOf<String>()
        runCatching {
            resolver.query(
                collection,
                arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
                "${MediaStore.MediaColumns.RELATIVE_PATH}=?",
                arrayOf("$RELATIVE_PATH/"),
                null,
            )?.use { cursor ->
                val column = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                while (cursor.moveToNext()) names += cursor.getString(column)
            }
        }
        return names
    }

    /** Write text into Documents/MeetingNotes and return its uri. */
    fun publishText(name: String, text: String): Uri? =
        publish(name, "text/markdown") { it.write(text.toByteArray(Charsets.UTF_8)) }
            ?: publish(name, "text/plain") { it.write(text.toByteArray(Charsets.UTF_8)) }

    /** Move a finished recording out of app storage and into Documents. */
    fun publishAudio(name: String, source: File): Uri? =
        publish(name, "audio/x-wav") { out -> source.inputStream().use { it.copyTo(out) } }

    private fun publish(
        name: String,
        mimeType: String,
        write: (java.io.OutputStream) -> Unit,
    ): Uri? = runCatching {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_PATH)
            // Hide the file from other apps until it is completely written.
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }

        val uri = resolver.insert(collection, values) ?: return@runCatching null
        resolver.openOutputStream(uri)?.use(write) ?: return@runCatching null

        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        uri
    }.getOrNull()

    /** The most recent notes, newest first. */
    fun recentNotes(limit: Int = 20): List<Note> = runCatching {
        val notes = mutableListOf<Note>()
        resolver.query(
            collection,
            arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME),
            "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?",
            arrayOf("$RELATIVE_PATH/", "%.md"),
            "${MediaStore.MediaColumns.DISPLAY_NAME} DESC",
        )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            while (cursor.moveToNext() && notes.size < limit) {
                notes += Note(
                    name = cursor.getString(nameColumn),
                    uri = android.content.ContentUris.withAppendedId(
                        collection,
                        cursor.getLong(idColumn),
                    ),
                )
            }
        }
        notes
    }.getOrDefault(emptyList())

    private companion object {
        val RELATIVE_PATH = "${Environment.DIRECTORY_DOCUMENTS}/MeetingNotes"
        val STAMP_FORMAT = SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US)
    }
}
