# njyn Signage Player (Android TV / Fire TV)

The app that runs on each TV. It opens your [signage server's](../signage/) player
page full-screen and keeps it there: screen always on, video autoplaying with
sound, reloading after errors, and starting by itself when the box powers on.
Everything about *what* plays is managed from the dashboard.

Works on Fire TV Stick (2nd generation and later), Fire TV Cube, Chromecast with
Google TV, NVIDIA Shield, and Android TV boxes on Android 7.1 or newer.

## Get the APK

Every push that touches `apps/tv-player/` builds it on GitHub:

1. Open the repository's **Actions** tab → **TV player APK** → the latest green run.
2. Download the **njyn-signage-player** artifact (a zip containing `app-release.apk`).

Optional: set a repository variable `SIGNAGE_PLAYER_URL` (Settings → Secrets and
variables → Actions → Variables) to your player address, e.g.
`https://signage.njyn.ai/player/`, and re-run the workflow. TVs installed from
that build skip the address step.

To build it yourself instead: install Android Studio (it brings the Android SDK
and JDK 17), then

```bash
cd apps/tv-player
./gradlew assembleRelease -PplayerUrl=https://signage.njyn.ai/player/
# → app/build/outputs/apk/release/app-release.apk
```

## Install on a TV

**Fire TV** (easiest without a computer):
1. Settings → My Fire TV → Developer options → turn on **Apps from Unknown Sources**
   (on newer models: **Install unknown apps → Downloader → On**). If Developer options is
   missing, go to Settings → My Fire TV → About and click the device name 7 times.
2. Install the free **Downloader** app from the Amazon app store.
3. Put the APK somewhere with a direct link (e.g. your site or Dropbox) and open that link in Downloader.

**Android TV / Google TV**: enable Developer options the same way (About → Build, click 7
times), allow unknown sources for a file manager, and open the APK from a USB stick or the
**Send files to TV** app.

**Any device, from a computer** (with the TV's Developer options → ADB debugging on):
```bash
adb connect <tv-ip-address>
adb install app-release.apk
```

## First launch

1. The app asks for the **player address**. Type `https://<your-worker>/player/`
   (just the domain works too; the app adds `/player/`).
2. The TV shows a 6-character code. In the dashboard, go to **Screens → Add screen** and enter it.
3. Allow **start on boot** when asked (see below).

## Start on boot

Android 10 and newer only let an app open itself at power-on if it may
*display over other apps*. The app asks for this on first setup; you can also open
it any time from the menu → **Allow starting on boot**.

Fire TV doesn't show that setting, so grant it once from a computer:

```bash
adb connect <tv-ip-address>
adb shell appops set ai.njyn.signage SYSTEM_ALERT_WINDOW allow
```

Also turn off the screensaver (Fire TV: Settings → Display & Sounds → Screensaver → Start
Time → Never). The app keeps the screen awake while it's in front, but the system screensaver
may still kick in on some models.

## Remote control

| Button | Does |
|---|---|
| Back or Menu | Opens the menu: change address, reload, allow start on boot, exit |
| Home | Leaves the player (it comes back on the next power-on) |

Pressing Back by accident won't drop out of the player; it opens the menu instead.
