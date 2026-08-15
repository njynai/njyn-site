/*
 * Compiles and exercises the parts of the Android app that do not touch the
 * Android framework - the WAV writer and splitter, the PCM drift queue, the
 * transcript stitcher, and the two formatters - on a plain JVM.
 *
 * It builds the real source files out of app/src/main, not copies, so it fails
 * if that code stops working. Run it from apps/android:
 *
 *     ./gradlew -p tools/jvm-selftest run
 *
 * The full app still needs the Android SDK; this is what can be verified
 * without a device.
 */
plugins {
    kotlin("jvm") version "2.0.21"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    // org.json ships inside Android; on the JVM it has to be pulled in.
    implementation("org.json:json:20240303")
}

kotlin {
    // No toolchain pin: this harness runs on whatever JDK is on the machine.
    // The app itself targets 17, which is what AGP needs.
    sourceSets["main"].kotlin {
        setSrcDirs(listOf("../../app/src/main/java", "src/main/kotlin"))
        include(
            "ai/njyn/meetingnotes/record/WavFile.kt",
            "ai/njyn/meetingnotes/record/PcmQueue.kt",
            "ai/njyn/meetingnotes/record/TranscriptStitcher.kt",
            "ai/njyn/meetingnotes/net/Http.kt",
            "ai/njyn/meetingnotes/data/NoteFormat.kt",
            "ai/njyn/meetingnotes/net/SummaryFormat.kt",
            "**/*SelfTest.kt",
        )
    }
}

application {
    mainClass.set("ai.njyn.meetingnotes.selftest.SelfTestKt")
}
