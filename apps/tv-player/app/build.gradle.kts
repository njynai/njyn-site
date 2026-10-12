plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// The player URL baked into the build, e.g. -PplayerUrl=https://signage.example.com/player/
// Leave it out and the app asks for the address on first launch instead.
val playerUrl = (project.findProperty("playerUrl") as String?).orEmpty()

android {
    namespace = "ai.njyn.signage"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.njyn.signage"
        // API 25 is Fire OS 6 (Fire TV Stick 2nd gen and later) and Android TV 7.1:
        // the oldest whose updatable WebView runs the player's modern JavaScript.
        minSdk = 25
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "PLAYER_URL", "\"${playerUrl.replace("\"", "")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the debug key so CI can produce an installable APK
            // without secrets. Swap in a real signing config before publishing
            // to an app store.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}
