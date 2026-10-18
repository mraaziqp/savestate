# SaveState for PS Vita. Build with VitaSDK (vitasdk.org), e.g. in WSL:
#   export VITASDK=/usr/local/vitasdk PATH=$VITASDK/bin:$PATH
#   vdpm install libvita2d curl openssl jansson
#   cmake -S vita -B vita/build && cmake --build vita/build
# Produces vita/build/SaveState.vpk (install with VitaShell).
cmake_minimum_required(VERSION 3.16)

if(NOT DEFINED CMAKE_TOOLCHAIN_FILE)
  if(DEFINED ENV{VITASDK})
    set(CMAKE_TOOLCHAIN_FILE "$ENV{VITASDK}/share/vita.toolchain.cmake" CACHE PATH "toolchain file")
  else()
    message(FATAL_ERROR "Set VITASDK to the VitaSDK folder")
  endif()
endif()

project(SaveState C)
include("$ENV{VITASDK}/share/vita.cmake" REQUIRED)

set(VITA_APP_NAME "SaveState")
set(VITA_TITLEID "SVST00001")
set(VITA_VERSION "01.10")

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wno-unused-variable -O2 -std=gnu11")

# jansson is built in (MIT, third_party/jansson, v2.14.1): the SDK's package is
# position-independent, which vita-elf-create refuses ("relocation type 25").
file(GLOB JANSSON_SRC third_party/jansson/*.c)
add_executable(${PROJECT_NAME} src/main.c ${JANSSON_SRC})
target_include_directories(${PROJECT_NAME} BEFORE PRIVATE third_party/jansson)
target_compile_definitions(${PROJECT_NAME} PRIVATE HAVE_CONFIG_H JANSSON_USING_CMAKE)
target_link_libraries(${PROJECT_NAME}
  vita2d curl ssl crypto freetype png jpeg bz2 z zstd m pthread
  SceDisplay_stub SceGxm_stub SceSysmodule_stub SceCtrl_stub SceTouch_stub
  SceCommonDialog_stub SceAppUtil_stub SceAppMgr_stub ScePgf_stub ScePvf_stub
  SceNet_stub SceNetCtl_stub SceIofilemgr_stub ScePower_stub SceRtc_stub SceShellSvc_stub
)

vita_create_self(eboot.bin ${PROJECT_NAME} UNSAFE)
vita_create_vpk(${PROJECT_NAME}.vpk ${VITA_TITLEID} eboot.bin
  VERSION ${VITA_VERSION}
  NAME ${VITA_APP_NAME}
  FILE sce_sys/icon0.png sce_sys/icon0.png
  FILE sce_sys/livearea/contents/bg.png sce_sys/livearea/contents/bg.png
  FILE sce_sys/livearea/contents/startup.png sce_sys/livearea/contents/startup.png
  FILE sce_sys/livearea/contents/template.xml sce_sys/livearea/contents/template.xml
  FILE assets/cacert.pem assets/cacert.pem
)
