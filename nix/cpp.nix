# C++ toolchain - clang/LLVM with debugger + sanitizer + profilers +
# the common modern build tools.
{ pkgs, lib }:

with pkgs; [
  # Compilers / drivers.
  clang
  clang-tools
  llvm
  llvmPackages.libcxx
  llvmPackages.libcxxClang
  gcc

  # Debuggers.
  gdb
  lldb

  # Build systems.
  cmake
  ninja
  meson
  bazel
  scons

  # Profile / sanity.
  valgrind
  perf-tools
  gbenchmark

  # Static analysis.
  cppcheck
  include-what-you-use
  bear

  # Common library surface for blueprint sandbox runtimes.
  abseil-cpp
  boost
  catch2
  gtest
  protobuf
]
