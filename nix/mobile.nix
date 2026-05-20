# Mobile dev tooling. iOS toolchain is macOS-only; Android Studio /
# Xcode are GUI tools nixpkgs doesn't ship; we cover the CLI surface
# (NDK, watchman, flutter, RN+Expo via JS deps).
{ pkgs, lib }:

with pkgs; [
  # Native helpers.
  watchman

  # Cross-platform frameworks.
  flutter

  # JDK for Android Gradle builds.
  jdk21
  gradle

  # Misc.
  scrcpy
]
