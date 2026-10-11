# [2026-10-11 noise] libchatyyns.so — RNNoise (BSD-3, vendored v0.1.1) for the
# LiveKit capture post-processor (audio/RNNoiseProcessor.kt). The C sources are
# SHARED with iOS and live in ../ios/ChatyyNS (one amalgamated TU,
# chatyy_ns.c, which #includes rnnoise/*.c) — do not add rnnoise/*.c here.
# Pure C, no STL, no deps. 16 KB page aligned (Play requirement).
cmake_minimum_required(VERSION 3.13)
project(chatyyns C)

set(CHATYY_NS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../ios/ChatyyNS)

add_library(chatyyns SHARED
  ${CHATYY_NS_DIR}/chatyy_ns.c
  src/main/cpp/chatyy_ns_jni.c
)
target_include_directories(chatyyns PRIVATE ${CHATYY_NS_DIR})
target_compile_options(chatyyns PRIVATE -O3 -fvisibility=hidden -w)
target_link_libraries(chatyyns m log)
target_link_options(chatyyns PRIVATE "-Wl,-z,max-page-size=16384")
