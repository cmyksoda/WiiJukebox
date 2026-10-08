#!/bin/sh
# Builds the debug APK and copies it to packaging/dist/.
# Needs a JDK (17 or newer) and the Android SDK with platform 37 and build-tools 36.
set -eu
cd "$(dirname "$0")"
: "${ANDROID_HOME:=$HOME/Android/Sdk}"
export ANDROID_HOME
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug --no-daemon "$@"
mkdir -p ../dist
cp app/build/outputs/apk/debug/app-debug.apk ../dist/WiiJukebox-android-debug.apk
echo "APK: packaging/dist/WiiJukebox-android-debug.apk"
