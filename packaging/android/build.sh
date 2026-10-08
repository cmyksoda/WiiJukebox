#!/bin/sh
# Builds the debug APK, or with "release" the signed release APK, into packaging/dist/.
# Needs a JDK (17 or newer) and the Android SDK with platform 37 and build-tools 36.
set -eu
cd "$(dirname "$0")"
: "${ANDROID_HOME:=$HOME/Android/Sdk}"
export ANDROID_HOME
echo "sdk.dir=$ANDROID_HOME" > local.properties
mkdir -p ../dist
if [ "${1:-}" = release ]; then
    shift
    ./gradlew assembleRelease --no-daemon "$@"
    cp app/build/outputs/apk/release/app-release.apk ../dist/WiiJukebox-android.apk
    echo "APK: packaging/dist/WiiJukebox-android.apk"
else
    ./gradlew assembleDebug --no-daemon "$@"
    cp app/build/outputs/apk/debug/app-debug.apk ../dist/WiiJukebox-android-debug.apk
    echo "APK: packaging/dist/WiiJukebox-android-debug.apk"
fi
