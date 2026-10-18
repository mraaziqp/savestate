/*
 * SaveState for PS Vita.
 *
 * Sign in to a SaveState host, browse the games a Vita can run (the host's
 * /api/games?for=vita), download one and play it: RetroArch for the retro
 * consoles (launched straight into the game with the right core), Adrenaline
 * for PSP. Everything heavier streams from the host PC through Moonlight.
 *
 *   ux0:data/SaveState/config.json   host, user name, session token
 *   ux0:data/SaveState/library.json  games downloaded to this Vita
 *   ux0:data/SaveState/roms/<console>/   retro games
 *   ux0:pspemu/ISO/                       PSP games (where Adrenaline looks)
 *   ux0:data/SaveState/covers/<id>.jpg     cover cache
 *
 * Saves follow you: a game's RetroArch save (.srm) goes up to the host after
 * playing and comes down before playing when it changed elsewhere (browser,
 * another Vita), through /api/savefile/<game>.
 *
 * Buttons follow the console's own confirm button (cross or circle).
 */
#include <psp2/kernel/processmgr.h>
#include <psp2/kernel/threadmgr.h>
#include <psp2/ctrl.h>
#include <psp2/touch.h>
#include <psp2/apputil.h>
#include <psp2/appmgr.h>
#include <psp2/ime_dialog.h>
#include <psp2/common_dialog.h>
#include <psp2/sysmodule.h>
#include <psp2/system_param.h>
#include <psp2/net/net.h>
#include <psp2/net/netctl.h>
#include <psp2/io/stat.h>
#include <psp2/io/fcntl.h>
#include <psp2/io/dirent.h>
#include <psp2/power.h>
#include <vita2d.h>
#include <curl/curl.h>
#include <jansson.h>
#include <zlib.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>

#define APP_VERSION "1.1"
#define RA_SAVES "ux0:data/retroarch/savefiles"
#define DATA_DIR "ux0:data/SaveState"
#define ROM_DIR DATA_DIR "/roms"
#define COVER_DIR DATA_DIR "/covers"
#define CONFIG_FILE DATA_DIR "/config.json"
#define LIBRARY_FILE DATA_DIR "/library.json"
#define CA_FILE "app0:assets/cacert.pem"
#define SCREEN_W 960
#define SCREEN_H 544

/* ── Colours ───────────────────────────────────────────────────────────── */
#define C_BG RGBA8(9, 11, 20, 255)
#define C_PANEL RGBA8(20, 24, 42, 255)
#define C_ROW RGBA8(28, 33, 58, 255)
#define C_SEL RGBA8(34, 211, 238, 255)
#define C_SELBG RGBA8(18, 64, 84, 255)
#define C_TEXT RGBA8(232, 236, 255, 255)
#define C_DIM RGBA8(150, 160, 190, 255)
#define C_OK RGBA8(74, 222, 128, 255)
#define C_WARN RGBA8(251, 191, 36, 255)
#define C_BAD RGBA8(248, 113, 113, 255)
#define C_ACC2 RGBA8(129, 140, 248, 255)

/* ── Consoles a Vita runs ──────────────────────────────────────────────── */
typedef struct { const char *id; const char *name; const char *cores[3]; } Sys;
static const Sys SYSTEMS[] = {
  {"nes", "NES", {"fceumm_libretro", "nestopia_libretro", NULL}},
  {"snes", "Super Nintendo", {"snes9x2005_libretro", "snes9x2010_libretro", "snes9x2002_libretro"}},
  {"gb", "Game Boy", {"gambatte_libretro", "gearboy_libretro", NULL}},
  {"gbc", "Game Boy Color", {"gambatte_libretro", "gearboy_libretro", NULL}},
  {"gba", "Game Boy Advance", {"gpsp_libretro", "mgba_libretro", "vba_next_libretro"}},
  {"genesis", "Mega Drive", {"genesis_plus_gx_libretro", "picodrive_libretro", NULL}},
  {"megadrive", "Mega Drive", {"genesis_plus_gx_libretro", "picodrive_libretro", NULL}},
  {"mastersystem", "Master System", {"genesis_plus_gx_libretro", "picodrive_libretro", NULL}},
  {"gamegear", "Game Gear", {"genesis_plus_gx_libretro", NULL, NULL}},
  {"segacd", "Sega CD", {"genesis_plus_gx_libretro", "picodrive_libretro", NULL}},
  {"pce", "PC Engine", {"mednafen_pce_fast_libretro", NULL, NULL}},
  {"neogeo", "Neo Geo", {"fbneo_libretro", "fbalpha2012_neogeo_libretro", NULL}},
  {"mame", "Arcade", {"fbneo_libretro", "mame2003_plus_libretro", "mame2003_libretro"}},
  {"arcade", "Arcade", {"fbneo_libretro", "mame2003_plus_libretro", NULL}},
  {"fbneo", "Arcade", {"fbneo_libretro", NULL, NULL}},
  {"atari2600", "Atari 2600", {"stella2014_libretro", "stella_libretro", NULL}},
  {"atari", "Atari", {"stella2014_libretro", "stella_libretro", NULL}},
  {"ps1", "PlayStation", {"pcsx_rearmed_libretro", NULL, NULL}},
  {"psx", "PlayStation", {"pcsx_rearmed_libretro", NULL, NULL}},
  {"psp", "PSP (Adrenaline)", {NULL, NULL, NULL}},
};
#define NSYS (int)(sizeof(SYSTEMS) / sizeof(SYSTEMS[0]))
static int sys_index(const char *id) { for (int i = 0; i < NSYS; i++) if (!strcmp(SYSTEMS[i].id, id)) return i; return -1; }

/* ── State ─────────────────────────────────────────────────────────────── */
typedef struct { char id[48]; char title[128]; char file[200]; short sys; } Game;
static Game *games = NULL;
static int ngames = 0;

static char cfg_host[160] = "https://savestate.co.za";
static char cfg_user[96] = "";
static char cfg_token[1024] = "";
static char net_error[200] = "";

static vita2d_pgf *font;
static int confirm_btn = SCE_CTRL_CROSS, cancel_btn = SCE_CTRL_CIRCLE;
static const char *confirm_label = "X", *cancel_label = "O";

enum { SCR_LOGIN, SCR_HOME };
enum { TAB_GAMES, TAB_LOCAL, TAB_STREAM, TAB_SETTINGS, NTABS };
static const char *TAB_NAMES[NTABS] = {"Games", "On this Vita", "Stream", "Settings"};
static int screen = SCR_LOGIN, tab = TAB_GAMES;
/* Things that draw screens of their own (the keyboard, "Signing in...") or
   block, asked for while a frame is being drawn and run after it. */
enum { D_NONE, D_LOGIN_HOST, D_LOGIN_USER, D_LOGIN_PASS, D_LOGIN_GO, D_SEARCH, D_SET_HOST, D_RELOAD, D_GET_GAME };
static int deferred = D_NONE, deferred_game = -1;

/* ── Small helpers ─────────────────────────────────────────────────────── */
static int exists(const char *p) { SceIoStat st; return sceIoGetstat(p, &st) >= 0; }
static void mkdirs(const char *path) {
  char tmp[512]; snprintf(tmp, sizeof tmp, "%s", path);
  for (char *p = strchr(tmp, '/'); p; p = strchr(p + 1, '/')) { *p = 0; sceIoMkdir(tmp, 0777); *p = '/'; }
  sceIoMkdir(tmp, 0777);
}
static void text(int x, int y, unsigned int c, float s, const char *t) { vita2d_pgf_draw_text(font, x, y, c, s, t); }
static int text_w(float s, const char *t) { return vita2d_pgf_text_width(font, s, t); }
/* Draws t cut to fit max_w pixels, with "..." when cut. */
static void text_fit(int x, int y, unsigned int c, float s, const char *t, int max_w) {
  if (text_w(s, t) <= max_w) { text(x, y, c, s, t); return; }
  char buf[256]; snprintf(buf, sizeof buf, "%s", t);
  int n = strlen(buf);
  while (n > 0) { buf[--n] = 0; char tmp[260]; snprintf(tmp, sizeof tmp, "%s...", buf); if (text_w(s, tmp) <= max_w) { text(x, y, c, s, tmp); return; } }
}
/* Word-wraps t into max_w; returns the y after the last line. */
static int text_wrap(int x, int y, unsigned int c, float s, const char *t, int max_w, int line_h) {
  char line[256] = ""; const char *p = t;
  while (*p) {
    const char *sp = strchr(p, ' '); int wl = sp ? (int)(sp - p) : (int)strlen(p);
    char cand[256]; snprintf(cand, sizeof cand, "%s%s%.*s", line, *line ? " " : "", wl, p);
    if (*line && text_w(s, cand) > max_w) { text(x, y, c, s, line); y += line_h; snprintf(line, sizeof line, "%.*s", wl, p); }
    else snprintf(line, sizeof line, "%s", cand);
    p += wl; while (*p == ' ') p++;
  }
  if (*line) { text(x, y, c, s, line); y += line_h; }
  return y;
}
static void safe_name(char *out, size_t n, const char *in) {
  size_t j = 0;
  for (size_t i = 0; in[i] && j + 1 < n; i++) { char ch = in[i]; out[j++] = (ch == '&' || ch == '?' || ch == '#' || ch == '%' || ch == ':' || ch == '"' || ch == '<' || ch == '>' || ch == '|' || ch == '*') ? '_' : ch; }
  out[j] = 0;
}
static const char *ext_of(const char *f) { const char *d = strrchr(f, '.'); return d ? d : ""; }

/* Where a game lives on this Vita. */
static void local_path(const Game *g, char *out, size_t n) {
  char safe[200]; safe_name(safe, sizeof safe, g->file);
  if (!strcmp(SYSTEMS[g->sys].id, "psp")) {
    if (!strcasecmp(ext_of(safe), ".pbp")) {
      char base[200]; snprintf(base, sizeof base, "%s", safe); char *d = strrchr(base, '.'); if (d) *d = 0;
      snprintf(out, n, "ux0:pspemu/PSP/GAME/%s/EBOOT.PBP", base);
    } else snprintf(out, n, "ux0:pspemu/ISO/%s", safe);
  } else snprintf(out, n, ROM_DIR "/%s/%s", SYSTEMS[g->sys].id, safe);
}

/* ── Config and library files ──────────────────────────────────────────── */
static void save_config(void) {
  json_t *o = json_pack("{s:s,s:s,s:s}", "host", cfg_host, "user", cfg_user, "token", cfg_token);
  mkdirs(DATA_DIR); json_dump_file(o, CONFIG_FILE, JSON_INDENT(2)); json_decref(o);
}
static void load_config(void) {
  json_t *o = json_load_file(CONFIG_FILE, 0, NULL);
  if (!o) return;
  const char *h = json_string_value(json_object_get(o, "host")), *u = json_string_value(json_object_get(o, "user")), *t = json_string_value(json_object_get(o, "token"));
  if (h && *h) snprintf(cfg_host, sizeof cfg_host, "%s", h);
  if (u) snprintf(cfg_user, sizeof cfg_user, "%s", u);
  if (t) snprintf(cfg_token, sizeof cfg_token, "%s", t);
  json_decref(o);
}
static json_t *library = NULL; /* { id: { title, sys, path } } */
static void load_library(void) { library = json_load_file(LIBRARY_FILE, 0, NULL); if (!json_is_object(library)) { if (library) json_decref(library); library = json_object(); } }
static void save_library(void) { mkdirs(DATA_DIR); json_dump_file(library, LIBRARY_FILE, JSON_INDENT(1)); }
static void library_add(const Game *g, const char *path) {
  json_t *old = json_object_get(library, g->id);
  json_int_t crc = old ? json_integer_value(json_object_get(old, "crc")) : 0;
  json_object_set_new(library, g->id, json_pack("{s:s,s:s,s:s,s:s,s:I}", "title", g->title, "sys", SYSTEMS[g->sys].id, "path", path, "file", g->file, "crc", crc));
  save_library();
}

/* ── Network ───────────────────────────────────────────────────────────── */
typedef struct { char *data; size_t len; } Buf;
static size_t buf_write(void *p, size_t s, size_t n, void *u) {
  Buf *b = u; size_t add = s * n; char *d = realloc(b->data, b->len + add + 1);
  if (!d) return 0; b->data = d; memcpy(b->data + b->len, p, add); b->len += add; b->data[b->len] = 0; return add;
}
static CURL *curl_for(const char *url, struct curl_slist **hdrs) {
  CURL *c = curl_easy_init();
  curl_easy_setopt(c, CURLOPT_URL, url);
  curl_easy_setopt(c, CURLOPT_CAINFO, CA_FILE);
  curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(c, CURLOPT_USERAGENT, "SaveState-Vita/" APP_VERSION);
  curl_easy_setopt(c, CURLOPT_ACCEPT_ENCODING, "");
  curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 15L);
  curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
  if (*cfg_token) { char h[1100]; snprintf(h, sizeof h, "Authorization: Bearer %s", cfg_token); *hdrs = curl_slist_append(*hdrs, h); }
  return c;
}
static const char *status_words(long code) {
  return code == 401 ? "Signed out. Sign in again." : code == 403 ? "No access to this host's games yet (ask the host)." : code == 404 ? "Not found on the host." :
    code == 409 ? "The host is still downloading this game." : code == 429 ? "Too many tries; wait a minute." : code >= 500 ? "The host had a problem; try again." : "The host said no.";
}
/* GET or POST (body != NULL) a JSON answer; NULL on failure with net_error set. */
static json_t *api(const char *path, const char *body, long *code_out) {
  char url[512]; snprintf(url, sizeof url, "%s%s", cfg_host, path);
  struct curl_slist *h = NULL; CURL *c = curl_for(url, &h);
  Buf b = {0};
  if (body) { h = curl_slist_append(h, "Content-Type: application/json"); curl_easy_setopt(c, CURLOPT_POSTFIELDS, body); }
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, buf_write);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &b);
  curl_easy_setopt(c, CURLOPT_TIMEOUT, 90L);
  CURLcode rc = curl_easy_perform(c);
  long code = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
  curl_easy_cleanup(c); curl_slist_free_all(h);
  if (code_out) *code_out = code;
  json_t *j = NULL;
  if (rc != CURLE_OK) snprintf(net_error, sizeof net_error, "Can't reach %s (%s). Check Wi-Fi.", cfg_host, curl_easy_strerror(rc));
  else if (code >= 400) {
    json_t *e = b.data ? json_loads(b.data, 0, NULL) : NULL;
    const char *msg = e ? json_string_value(json_object_get(e, "error")) : NULL;
    snprintf(net_error, sizeof net_error, "%s", msg && code != 401 ? msg : status_words(code));
    if (e) json_decref(e);
  } else if (b.data) { j = json_loads(b.data, 0, NULL); if (!j) snprintf(net_error, sizeof net_error, "The host's answer wasn't readable."); }
  free(b.data);
  return j;
}

/* A download running on its own thread; the screen shows its progress. */
typedef struct {
  volatile int active, done, failed, cancel;
  volatile double now, total;
  char url[600], path[512], error[200];
  int game; /* index in games, or -1 */
  int launch_after;
} Job;
static Job job;
static int xfer(void *u, curl_off_t dt, curl_off_t dn, curl_off_t ut, curl_off_t un) {
  (void)u; (void)ut; (void)un; job.total = (double)dt; job.now = (double)dn; return job.cancel ? 1 : 0;
}
static void *download_thread(void *arg) {
  (void)arg;
  char tmp[530]; snprintf(tmp, sizeof tmp, "%s.part", job.path);
  char dir[512]; snprintf(dir, sizeof dir, "%s", job.path); char *sl = strrchr(dir, '/'); if (sl) { *sl = 0; mkdirs(dir); }
  FILE *f = fopen(tmp, "wb");
  if (!f) { snprintf(job.error, sizeof job.error, "Can't write to the memory card."); job.failed = 1; job.active = 0; return NULL; }
  static char fbuf[512 * 1024]; setvbuf(f, fbuf, _IOFBF, sizeof fbuf);
  struct curl_slist *h = NULL; CURL *c = curl_for(job.url, &h);
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, f);
  curl_easy_setopt(c, CURLOPT_BUFFERSIZE, 512L * 1024L);
  curl_easy_setopt(c, CURLOPT_NOPROGRESS, 0L);
  curl_easy_setopt(c, CURLOPT_XFERINFOFUNCTION, xfer);
  curl_easy_setopt(c, CURLOPT_FAILONERROR, 1L);
  curl_easy_setopt(c, CURLOPT_LOW_SPEED_LIMIT, 1L);
  curl_easy_setopt(c, CURLOPT_LOW_SPEED_TIME, 60L);
  CURLcode rc = curl_easy_perform(c);
  long code = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
  curl_easy_cleanup(c); curl_slist_free_all(h); fclose(f);
  if (rc == CURLE_OK) { sceIoRemove(job.path); if (sceIoRename(tmp, job.path) < 0) { snprintf(job.error, sizeof job.error, "Couldn't save the game file."); job.failed = 1; } else job.done = 1; }
  else {
    sceIoRemove(tmp);
    if (job.cancel) snprintf(job.error, sizeof job.error, "Cancelled.");
    else if (code >= 400) snprintf(job.error, sizeof job.error, "%s", status_words(code));
    else if (rc == CURLE_WRITE_ERROR) snprintf(job.error, sizeof job.error, "The memory card is full.");
    else snprintf(job.error, sizeof job.error, "Download stopped: %s", curl_easy_strerror(rc));
    job.failed = 1;
  }
  job.active = 0;
  return NULL;
}
static void start_download(const char *url, const char *path, int game, int launch_after) {
  memset(&job, 0, sizeof job);
  snprintf(job.url, sizeof job.url, "%s", url); snprintf(job.path, sizeof job.path, "%s", path);
  job.game = game; job.launch_after = launch_after; job.active = 1;
  pthread_t t; pthread_attr_t a; pthread_attr_init(&a); pthread_attr_setstacksize(&a, 256 * 1024);
  pthread_create(&t, &a, download_thread, NULL); pthread_detach(t);
}

/* Covers: fetched on a second thread, loaded into textures on the main one. */
#define NCOVERS 24
typedef struct { char id[48]; vita2d_texture *tex; int state; /* 0 empty 1 want 2 fetching 3 on card 4 failed */ unsigned int used; } Cover;
static Cover covers[NCOVERS];
static unsigned int cover_clock = 0;
static vita2d_texture *to_free[NCOVERS];  /* freed after the frame that stopped using them */
static int nfree = 0;
static pthread_mutex_t cover_lock = PTHREAD_MUTEX_INITIALIZER;
static void *cover_thread(void *arg) {
  (void)arg;
  for (;;) {
    int pick = -1; char id[48] = "";
    pthread_mutex_lock(&cover_lock);
    for (int i = 0; i < NCOVERS; i++) if (covers[i].state == 1) { pick = i; covers[i].state = 2; snprintf(id, sizeof id, "%s", covers[i].id); break; }
    pthread_mutex_unlock(&cover_lock);
    if (pick < 0) { sceKernelDelayThread(100 * 1000); continue; }
    char path[256]; snprintf(path, sizeof path, COVER_DIR "/%s.jpg", id);
    int ok = exists(path);
    if (!ok) {
      char url[512], tmp[270]; snprintf(url, sizeof url, "%s/api/art/%s?w=160&fmt=jpg", cfg_host, id); snprintf(tmp, sizeof tmp, "%s.part", path);
      FILE *f = fopen(tmp, "wb");
      if (f) {
        struct curl_slist *h = NULL; CURL *c = curl_for(url, &h);
        curl_easy_setopt(c, CURLOPT_HTTPHEADER, h); curl_easy_setopt(c, CURLOPT_WRITEDATA, f);
        curl_easy_setopt(c, CURLOPT_FAILONERROR, 1L); curl_easy_setopt(c, CURLOPT_TIMEOUT, 30L);
        CURLcode rc = curl_easy_perform(c); long code = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
        char ctype[64] = ""; char *ct = NULL; curl_easy_getinfo(c, CURLINFO_CONTENT_TYPE, &ct); if (ct) snprintf(ctype, sizeof ctype, "%s", ct);
        curl_easy_cleanup(c); curl_slist_free_all(h); fclose(f);
        if (rc == CURLE_OK && strstr(ctype, "jpeg")) { sceIoRename(tmp, path); ok = 1; } else sceIoRemove(tmp);
      }
    }
    pthread_mutex_lock(&cover_lock);
    if (!strcmp(covers[pick].id, id)) covers[pick].state = ok ? 3 : 4;
    pthread_mutex_unlock(&cover_lock);
  }
  return NULL;
}
static vita2d_texture *cover_for(const char *id) {
  cover_clock++;
  pthread_mutex_lock(&cover_lock);
  int slot = -1, oldest = 0;
  for (int i = 0; i < NCOVERS; i++) {
    if (covers[i].state && !strcmp(covers[i].id, id)) { slot = i; break; }
    if (covers[i].state != 2 && covers[i].used < covers[oldest].used) oldest = i;
  }
  if (slot < 0) {
    slot = oldest;
    if (covers[slot].tex) { if (nfree < NCOVERS) to_free[nfree++] = covers[slot].tex; covers[slot].tex = NULL; }
    snprintf(covers[slot].id, sizeof covers[slot].id, "%s", id); covers[slot].state = 1;
  }
  covers[slot].used = cover_clock;
  if (covers[slot].state == 3 && !covers[slot].tex) {
    char path[256]; snprintf(path, sizeof path, COVER_DIR "/%s.jpg", id);
    covers[slot].tex = vita2d_load_JPEG_file(path);
    if (!covers[slot].tex) { covers[slot].state = 4; sceIoRemove(path); }
  }
  vita2d_texture *t = covers[slot].tex;
  pthread_mutex_unlock(&cover_lock);
  return t;
}

/* ── Text entry (the Vita's own keyboard) ──────────────────────────────── */
static int ime_input(const char *title, char *out, size_t n, int password) {
  static uint16_t title16[64], init16[256], buf16[256];
  size_t i;
  for (i = 0; title[i] && i < 63; i++) title16[i] = (uint8_t)title[i]; title16[i] = 0;
  for (i = 0; out[i] && i < 255 && !password; i++) init16[i] = (uint8_t)out[i]; init16[password ? 0 : i] = 0;
  memset(buf16, 0, sizeof buf16);
  SceImeDialogParam p; sceImeDialogParamInit(&p);
  p.supportedLanguages = 0x0001FFFF; p.languagesForced = SCE_TRUE;
  p.type = password ? SCE_IME_TYPE_DEFAULT : SCE_IME_TYPE_BASIC_LATIN;
  p.option = 0; p.textBoxMode = password ? SCE_IME_DIALOG_TEXTBOX_MODE_PASSWORD : SCE_IME_DIALOG_TEXTBOX_MODE_DEFAULT;
  p.title = title16; p.maxTextLength = (n - 1) < 255 ? (n - 1) : 255; p.initialText = init16; p.inputTextBuffer = buf16;
  if (sceImeDialogInit(&p) < 0) return 0;
  int changed = 0;
  for (;;) {
    vita2d_start_drawing(); vita2d_clear_screen(); vita2d_end_drawing();
    vita2d_common_dialog_update(); vita2d_swap_buffers();
    SceCommonDialogStatus st = sceImeDialogGetStatus();
    if (st == SCE_COMMON_DIALOG_STATUS_FINISHED) {
      SceImeDialogResult r; memset(&r, 0, sizeof r); sceImeDialogGetResult(&r);
      if (r.button == SCE_IME_DIALOG_BUTTON_ENTER) {
        for (i = 0; buf16[i] && i < n - 1; i++) out[i] = buf16[i] < 128 ? (char)buf16[i] : '?';
        out[i] = 0; changed = 1;
      }
      sceImeDialogTerm(); break;
    }
  }
  return changed;
}

/* ── Other apps on this Vita ───────────────────────────────────────────── */
static const char *retroarch_id(void) {
  if (exists("ux0:app/RETROVITA/eboot.bin")) return "RETROVITA";
  if (exists("ux0:app/RETROARCH/eboot.bin")) return "RETROARCH";
  return NULL;
}
static int has_adrenaline(void) { return exists("ux0:app/PSPEMUCFW/eboot.bin"); }
static int has_moonlight(void) { return exists("ux0:app/XYZZ00002/eboot.bin"); }
static const char *core_for(int sys, const char *ra) {
  static char path[128];
  for (int i = 0; i < 3 && SYSTEMS[sys].cores[i]; i++) {
    snprintf(path, sizeof path, "ux0:app/%s/%s.self", ra, SYSTEMS[sys].cores[i]);
    if (exists(path)) { snprintf(path, sizeof path, "app0:/%s.self", SYSTEMS[sys].cores[i]); return path; }
  }
  return NULL;
}
static char message[300] = "";
static unsigned int message_color = C_TEXT;
static void say(unsigned int color, const char *m) { snprintf(message, sizeof message, "%s", m); message_color = color; }

static void launch_uri(const char *uri) {
  sceAppMgrLaunchAppByUri(0xFFFFF, uri);
  sceKernelDelayThread(500 * 1000);
  sceKernelExitProcess(0);
}
/* ── Saves ─────────────────────────────────────────────────────────────── */
static unsigned char *read_all(const char *path, long *len) {
  FILE *f = fopen(path, "rb"); if (!f) return NULL;
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  if (n <= 0 || n > 8 * 1024 * 1024) { fclose(f); return NULL; }
  unsigned char *b = malloc(n); if (!b) { fclose(f); return NULL; }
  if (fread(b, 1, n, f) != (size_t)n) { free(b); fclose(f); return NULL; }
  fclose(f); *len = n; return b;
}
/* Where RetroArch keeps this game's save: savefiles/<name>.srm, or a
   per-core folder inside it, or next to the game. 1 if found; out is the
   default place to write one either way. */
static int save_path_for(const char *rom, char *out, size_t n) {
  const char *slash = strrchr(rom, '/'); const char *name = slash ? slash + 1 : rom;
  char base[200]; snprintf(base, sizeof base, "%s", name); char *dot = strrchr(base, '.'); if (dot) *dot = 0;
  snprintf(out, n, RA_SAVES "/%s.srm", base);
  if (exists(out)) return 1;
  SceUID d = sceIoDopen(RA_SAVES);
  if (d >= 0) {
    SceIoDirent e; char cand[512];
    while (sceIoDread(d, &e) > 0) {
      if (!SCE_S_ISDIR(e.d_stat.st_mode)) continue;
      snprintf(cand, sizeof cand, RA_SAVES "/%s/%s.srm", e.d_name, base);
      if (exists(cand)) { sceIoDclose(d); snprintf(out, n, "%s", cand); return 1; }
    }
    sceIoDclose(d);
  }
  char beside[512]; snprintf(beside, sizeof beside, "%.*s/%s.srm", slash ? (int)(slash - rom) : 0, rom, base);
  if (exists(beside)) { snprintf(out, n, "%s", beside); return 1; }
  return 0;
}
static double entry_crc(const char *id) { json_t *e = json_object_get(library, id); return e ? json_number_value(json_object_get(e, "crc")) : 0; }
static void set_entry_crc(const char *id, unsigned long crc) { json_t *e = json_object_get(library, id); if (e) { json_object_set_new(e, "crc", json_integer((json_int_t)crc)); save_library(); } }
/* Sends the bytes as this game's save; 1 on success. */
static int put_save(const char *id, const unsigned char *data, long len) {
  char url[512]; snprintf(url, sizeof url, "%s/api/savefile/%s", cfg_host, id);
  struct curl_slist *h = NULL; CURL *c = curl_for(url, &h);
  h = curl_slist_append(h, "Content-Type: application/octet-stream");
  h = curl_slist_append(h, "X-Device: PS Vita");
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
  curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, "PUT");
  curl_easy_setopt(c, CURLOPT_POSTFIELDS, data);
  curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, len);
  curl_easy_setopt(c, CURLOPT_TIMEOUT, 30L);
  Buf b = {0}; curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, buf_write); curl_easy_setopt(c, CURLOPT_WRITEDATA, &b);
  CURLcode rc = curl_easy_perform(c); long code = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
  curl_easy_cleanup(c); curl_slist_free_all(h); free(b.data);
  return rc == CURLE_OK && code == 200;
}
/* Saves changed on this Vita since the last sync go up. Returns how many. */
static int sync_up(void) {
  int sent = 0; const char *key; json_t *v;
  json_object_foreach(library, key, v) {
    const char *sys = json_string_value(json_object_get(v, "sys")), *rom = json_string_value(json_object_get(v, "path"));
    if (!sys || !rom || !strcmp(sys, "psp")) continue;
    char sp[512]; if (!save_path_for(rom, sp, sizeof sp)) continue;
    long len = 0; unsigned char *b = read_all(sp, &len); if (!b) continue;
    unsigned long crc = crc32(0L, b, len);
    if ((double)crc != entry_crc(key) && put_save(key, b, len)) { set_entry_crc(key, crc); sent++; }
    free(b);
  }
  return sent;
}
/* Before playing: the host's save, when it changed elsewhere and this Vita's didn't. */
static void sync_down(const char *id, const char *rom) {
  if (!json_object_get(library, id)) return;
  char url[512]; snprintf(url, sizeof url, "%s/api/savefile/%s", cfg_host, id);
  struct curl_slist *h = NULL; CURL *c = curl_for(url, &h);
  Buf b = {0};
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h); curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, buf_write); curl_easy_setopt(c, CURLOPT_WRITEDATA, &b);
  curl_easy_setopt(c, CURLOPT_TIMEOUT, 20L);
  CURLcode rc = curl_easy_perform(c); long code = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
  curl_easy_cleanup(c); curl_slist_free_all(h);
  if (rc != CURLE_OK || code != 200 || !b.len) { free(b.data); return; }
  unsigned long remote = crc32(0L, (unsigned char *)b.data, b.len);
  double synced = entry_crc(id);
  char sp[512]; int have = save_path_for(rom, sp, sizeof sp);
  unsigned long local = 0;
  if (have) { long len = 0; unsigned char *lb = read_all(sp, &len); if (lb) { local = crc32(0L, lb, len); free(lb); } }
  if (remote != local && (!have || (double)local == synced)) {
    char dir[512]; snprintf(dir, sizeof dir, "%s", sp); char *sl = strrchr(dir, '/'); if (sl) { *sl = 0; mkdirs(dir); }
    char tmp[520]; snprintf(tmp, sizeof tmp, "%s.part", sp);
    FILE *f = fopen(tmp, "wb");
    if (f && fwrite(b.data, 1, b.len, f) == b.len) { fclose(f); sceIoRemove(sp); sceIoRename(tmp, sp); set_entry_crc(id, remote); }
    else { if (f) fclose(f); sceIoRemove(tmp); }
  } else if (remote == local) set_entry_crc(id, local);
  free(b.data);
}

/* Plays a downloaded game: RetroArch straight into it, or Adrenaline for PSP. */
static void play(const char *id, int sys, const char *path) {
  if (!strcmp(SYSTEMS[sys].id, "psp")) {
    if (!has_adrenaline()) { say(C_WARN, "PSP games need Adrenaline. Install it, then start the game from its XMB (Memory Stick > Game)."); return; }
    say(C_OK, "Opening Adrenaline: the game is under Game > Memory Stick.");
    launch_uri("psgm:play?titleid=PSPEMUCFW");
    return;
  }
  const char *ra = retroarch_id();
  if (!ra) { say(C_WARN, "Install RetroArch for PS Vita first (retroarch.com > Download > PlayStation Vita)."); return; }
  const char *core = core_for(sys, ra);
  if (!core) { char m[200]; snprintf(m, sizeof m, "RetroArch has no core for %s. Reinstall RetroArch with all cores.", SYSTEMS[sys].name); say(C_WARN, m); return; }
  if (id) sync_down(id, path);
  char uri[700]; snprintf(uri, sizeof uri, "psgm:play?titleid=%s&param=%s&param2=%s", ra, core, path);
  launch_uri(uri);
}

/* ── Games list ────────────────────────────────────────────────────────── */
static int sys_count[NSYS];
static int sys_order[NSYS], nsys_shown = 0;   /* consoles with games, in table order */
static int *filtered = NULL, nfiltered = 0;
static char search[64] = "";
static int sel_sys = 0, sel_game = 0, focus_games = 0, scroll_game = 0, scroll_sys = 0;

static int contains_ci(const char *hay, const char *needle) {
  if (!*needle) return 1;
  size_t n = strlen(needle);
  for (; *hay; hay++) if (!strncasecmp(hay, needle, n)) return 1;
  return 0;
}
static void refilter(void) {
  free(filtered); filtered = malloc(sizeof(int) * (ngames + 1)); nfiltered = 0;
  if (nsys_shown == 0) return;
  int s = sys_order[sel_sys];
  for (int i = 0; i < ngames; i++) {
    int same = games[i].sys == s || !strcmp(SYSTEMS[games[i].sys].name, SYSTEMS[s].name);
    if ((*search ? 1 : same) && contains_ci(games[i].title, search)) filtered[nfiltered++] = i;
  }
  if (sel_game >= nfiltered) sel_game = nfiltered ? nfiltered - 1 : 0;
  if (sel_game < 0) sel_game = 0;
}
static int load_games(void) {
  long code = 0;
  json_t *arr = api("/api/games?for=vita", NULL, &code);
  if (!arr) { if (code == 401) { *cfg_token = 0; save_config(); screen = SCR_LOGIN; } return 0; }
  if (!json_is_array(arr)) { json_decref(arr); snprintf(net_error, sizeof net_error, "This host is too old for SaveState for PS Vita. Update it."); return 0; }
  size_t n = json_array_size(arr);
  free(games); games = calloc(n + 1, sizeof(Game)); ngames = 0;
  memset(sys_count, 0, sizeof sys_count);
  for (size_t i = 0; i < n; i++) {
    json_t *g = json_array_get(arr, i);
    const char *id = json_string_value(json_object_get(g, "i")), *t = json_string_value(json_object_get(g, "t")),
      *p = json_string_value(json_object_get(g, "p")), *f = json_string_value(json_object_get(g, "f"));
    int s = p ? sys_index(p) : -1;
    if (!id || !t || !f || s < 0) continue;
    Game *G = &games[ngames++];
    snprintf(G->id, sizeof G->id, "%s", id); snprintf(G->title, sizeof G->title, "%s", t); snprintf(G->file, sizeof G->file, "%s", f); G->sys = s;
    sys_count[s]++;
  }
  json_decref(arr);
  /* One row per console name (Mega Drive = genesis + megadrive). */
  nsys_shown = 0;
  for (int i = 0; i < NSYS; i++) {
    if (!sys_count[i]) continue;
    int dup = 0;
    for (int k = 0; k < nsys_shown; k++) if (!strcmp(SYSTEMS[sys_order[k]].name, SYSTEMS[i].name)) { sys_count[sys_order[k]] += sys_count[i]; dup = 1; }
    if (!dup) sys_order[nsys_shown++] = i;
  }
  sel_sys = 0; sel_game = 0; scroll_game = 0; scroll_sys = 0;
  refilter();
  return 1;
}

/* ── Session ───────────────────────────────────────────────────────────── */
static int sign_in(const char *user, const char *pass) {
  json_t *body = json_pack("{s:s,s:s}", "username", user, "password", pass);
  char *b = json_dumps(body, JSON_COMPACT); json_decref(body);
  *cfg_token = 0;
  long code = 0; json_t *r = api("/api/auth/login", b, &code); free(b);
  if (!r) { if (code == 401) snprintf(net_error, sizeof net_error, "That user name and password didn't match."); return 0; }
  const char *t = json_string_value(json_object_get(r, "token"));
  if (!t) { json_decref(r); snprintf(net_error, sizeof net_error, "The host didn't sign you in."); return 0; }
  snprintf(cfg_token, sizeof cfg_token, "%s", t); if (user != cfg_user) snprintf(cfg_user, sizeof cfg_user, "%s", user);
  json_decref(r); save_config();
  return 1;
}
/* A fresh session token each start, so the Vita stays signed in. */
static int renew(void) {
  long code = 0; json_t *r = api("/api/auth/refresh", "{}", &code);
  if (!r) return code != 401 && code != 403;
  const char *t = json_string_value(json_object_get(r, "token"));
  if (t) { snprintf(cfg_token, sizeof cfg_token, "%s", t); save_config(); }
  json_decref(r); return 1;
}

/* ── Drawing ───────────────────────────────────────────────────────────── */
static void draw_header(void) {
  vita2d_draw_rectangle(0, 0, SCREEN_W, 64, C_PANEL);
  text(24, 42, C_SEL, 1.3f, "SaveState");
  int x = 210;
  for (int i = 0; i < NTABS; i++) {
    int w = text_w(1.0f, TAB_NAMES[i]) + 32;
    if (screen == SCR_HOME && i == tab) { vita2d_draw_rectangle(x, 14, w, 38, C_SELBG); vita2d_draw_rectangle(x, 50, w, 3, C_SEL); }
    text(x + 16, 41, screen == SCR_HOME && i == tab ? C_TEXT : C_DIM, 1.0f, TAB_NAMES[i]);
    x += w + 6;
  }
  text(SCREEN_W - 92, 41, C_DIM, 0.8f, "L / R");
}
static void draw_footer(const char *hints) {
  vita2d_draw_rectangle(0, SCREEN_H - 34, SCREEN_W, 34, C_PANEL);
  text(20, SCREEN_H - 11, C_DIM, 0.85f, hints);
}
static void draw_message(void) {
  if (!*message) return;
  vita2d_draw_rectangle(20, SCREEN_H - 84, SCREEN_W - 40, 44, RGBA8(16, 20, 36, 240));
  text_fit(34, SCREEN_H - 55, message_color, 0.9f, message, SCREEN_W - 68);
}
static void human(double b, char *out, size_t n) {
  if (b >= 1073741824.0) snprintf(out, n, "%.2f GB", b / 1073741824.0); else snprintf(out, n, "%.0f MB", b / 1048576.0);
}
static void draw_job(void) {
  vita2d_draw_rectangle(180, 170, 600, 200, C_PANEL);
  vita2d_draw_rectangle(180, 170, 600, 4, C_SEL);
  const char *title = job.game >= 0 ? games[job.game].title : "Downloading";
  text_fit(204, 214, C_TEXT, 1.05f, title, 552);
  double pct = job.total > 0 ? job.now / job.total : 0;
  vita2d_draw_rectangle(204, 250, 552, 16, C_ROW);
  vita2d_draw_rectangle(204, 250, (int)(552 * pct), 16, C_SEL);
  char a[32], b[32], line[120]; human(job.now, a, sizeof a); human(job.total, b, sizeof b);
  if (job.total > 0) snprintf(line, sizeof line, "%s of %s  (%d%%)", a, b, (int)(pct * 100)); else snprintf(line, sizeof line, "Starting...");
  text(204, 300, C_DIM, 0.95f, line);
  char hint[80]; snprintf(hint, sizeof hint, "%s  Cancel     Keep the Vita awake until it finishes", cancel_label);
  text(204, 344, C_DIM, 0.8f, hint);
}

/* ── Screens ───────────────────────────────────────────────────────────── */
static int login_field = 0;
static char login_pass[96] = "";
static void login_screen(SceCtrlData *pad, unsigned int pressed) {
  (void)pad;
  vita2d_draw_rectangle(0, 0, SCREEN_W, 64, C_PANEL);
  text(24, 42, C_SEL, 1.3f, "SaveState");
  text(210, 41, C_DIM, 1.0f, "for PS Vita");
  text(80, 120, C_TEXT, 1.2f, "Sign in to your SaveState host");
  text(80, 152, C_DIM, 0.9f, "The same account you use on savestate.co.za.");
  const char *labels[4] = {"Host address", "User name or email", "Password", "Sign in"};
  for (int i = 0; i < 4; i++) {
    int y = 190 + i * 66;
    unsigned int bg = i == login_field ? C_SELBG : C_ROW;
    vita2d_draw_rectangle(80, y, 800, 54, bg);
    if (i == login_field) vita2d_draw_rectangle(80, y, 5, 54, C_SEL);
    if (i < 3) {
      text(100, y + 22, C_DIM, 0.8f, labels[i]);
      char stars[96]; size_t k; for (k = 0; login_pass[k] && k < sizeof stars - 1; k++) stars[k] = '*'; stars[k] = 0;
      const char *v = i == 0 ? cfg_host : i == 1 ? cfg_user : stars;
      text_fit(100, y + 45, *v ? C_TEXT : C_DIM, 1.0f, *v ? v : "(press to type)", 760);
    } else text(440 - text_w(1.1f, labels[3]) / 2 + 40, y + 36, C_TEXT, 1.1f, labels[3]);
  }
  if (*net_error) text_fit(80, 470, C_BAD, 0.9f, net_error, 800);
  char hints[120]; snprintf(hints, sizeof hints, "Up/Down  Choose     %s  Type / Sign in     START  Quit", confirm_label);
  draw_footer(hints);
  if (pressed & SCE_CTRL_UP) login_field = (login_field + 3) % 4;
  if (pressed & SCE_CTRL_DOWN) login_field = (login_field + 1) % 4;
  if (pressed & confirm_btn) deferred = login_field == 0 ? D_LOGIN_HOST : login_field == 1 ? D_LOGIN_USER : login_field == 2 ? D_LOGIN_PASS : D_LOGIN_GO;
}

static int games_visible_rows = 9;
static void games_tab(unsigned int pressed) {
  if (!games) {
    text(40, 120, C_TEXT, 1.1f, "No games loaded.");
    text_fit(40, 156, C_BAD, 0.9f, *net_error ? net_error : "", 880);
    char m[80]; snprintf(m, sizeof m, "Press %s to try again.", confirm_label); text(40, 196, C_DIM, 0.9f, m);
    if (pressed & confirm_btn) load_games();
    return;
  }
  /* Consoles */
  vita2d_draw_rectangle(0, 64, 230, SCREEN_H - 98, C_PANEL);
  int sys_rows = 11;
  if (sel_sys < scroll_sys) scroll_sys = sel_sys;
  if (sel_sys >= scroll_sys + sys_rows) scroll_sys = sel_sys - sys_rows + 1;
  for (int r = 0; r < sys_rows && scroll_sys + r < nsys_shown; r++) {
    int k = scroll_sys + r, s = sys_order[k], y = 74 + r * 38;
    if (k == sel_sys) vita2d_draw_rectangle(0, y, 230, 36, focus_games ? C_ROW : C_SELBG);
    if (k == sel_sys && !focus_games) vita2d_draw_rectangle(0, y, 4, 36, C_SEL);
    text_fit(14, y + 25, k == sel_sys ? C_TEXT : C_DIM, 0.9f, SYSTEMS[s].name, 160);
    char c[16]; snprintf(c, sizeof c, "%d", sys_count[s]); text(216 - text_w(0.8f, c), y + 25, C_DIM, 0.8f, c);
  }
  if (nsys_shown == 0) text(14, 100, C_DIM, 0.9f, "No games for Vita");
  /* Games */
  int x0 = 244, w = 470;
  if (*search) { char s[100]; snprintf(s, sizeof s, "Search: \"%s\"  (all consoles)", search); text(x0, 92, C_ACC2, 0.85f, s); }
  int top = *search ? 102 : 74;
  games_visible_rows = (SCREEN_H - 40 - top) / 40;
  if (sel_game < scroll_game) scroll_game = sel_game;
  if (sel_game >= scroll_game + games_visible_rows) scroll_game = sel_game - games_visible_rows + 1;
  for (int r = 0; r < games_visible_rows && scroll_game + r < nfiltered; r++) {
    int k = scroll_game + r; Game *g = &games[filtered[k]]; int y = top + r * 40;
    vita2d_draw_rectangle(x0, y, w, 37, k == sel_game && focus_games ? C_SELBG : C_ROW);
    if (k == sel_game && focus_games) vita2d_draw_rectangle(x0, y, 4, 37, C_SEL);
    char lp[512]; local_path(g, lp, sizeof lp);
    int here = r == sel_game - scroll_game && exists(lp);
    text_fit(x0 + 14, y + 26, C_TEXT, 0.9f, g->title, w - (here ? 110 : 28));
    if (here) text(x0 + w - 96, y + 26, C_OK, 0.75f, "On Vita");
  }
  if (!nfiltered) text(x0, top + 30, C_DIM, 0.9f, *search ? "Nothing matches." : "No games here.");
  /* Details of the selected game */
  int dx = 728;
  vita2d_draw_rectangle(dx, 64, SCREEN_W - dx, SCREEN_H - 98, C_PANEL);
  if (nfiltered) {
    Game *g = &games[filtered[sel_game]];
    vita2d_texture *tex = cover_for(g->id);
    if (tex) {
      float tw = vita2d_texture_get_width(tex), th = vita2d_texture_get_height(tex);
      float sc = 200.0f / tw; if (th * sc > 250) sc = 250.0f / th;
      vita2d_draw_texture_scale(tex, dx + (SCREEN_W - dx - tw * sc) / 2, 76, sc, sc);
    } else vita2d_draw_rectangle(dx + 16, 76, 200, 250, C_ROW);
    int y = text_wrap(dx + 12, 352, C_TEXT, 0.85f, g->title, SCREEN_W - dx - 24, 22);
    text(dx + 12, y + 4, C_DIM, 0.8f, SYSTEMS[g->sys].name);
    char lp[512]; local_path(g, lp, sizeof lp);
    char act[64]; snprintf(act, sizeof act, "%s  %s", confirm_label, exists(lp) ? "Play" : "Download & play");
    text(dx + 12, SCREEN_H - 50, C_SEL, 0.9f, act);
  }
  char hints[200];
  snprintf(hints, sizeof hints, "Left/Right  Consoles / games     %s  Play     TRIANGLE  Search     SQUARE  Remove from Vita     SELECT  Refresh", confirm_label);
  draw_footer(hints);

  /* Input */
  if (pressed & SCE_CTRL_LEFT) focus_games = 0;
  if (pressed & SCE_CTRL_RIGHT) focus_games = 1;
  int step = 0;
  if (pressed & SCE_CTRL_UP) step = -1;
  if (pressed & SCE_CTRL_DOWN) step = 1;
  if (pressed & SCE_CTRL_LTRIGGER && 0) step = 0;
  if (step) {
    if (focus_games) { sel_game += step; if (sel_game < 0) sel_game = 0; if (sel_game >= nfiltered) sel_game = nfiltered ? nfiltered - 1 : 0; }
    else if (nsys_shown) { sel_sys = (sel_sys + step + nsys_shown) % nsys_shown; sel_game = 0; scroll_game = 0; *search = 0; refilter(); }
  }
  if (pressed & SCE_CTRL_TRIANGLE) deferred = D_SEARCH;
  if (pressed & SCE_CTRL_SELECT) { *message = 0; deferred = D_RELOAD; }
  if ((pressed & confirm_btn) && !focus_games) focus_games = 1;
  else if ((pressed & confirm_btn) && nfiltered) {
    Game *g = &games[filtered[sel_game]];
    char lp[512]; local_path(g, lp, sizeof lp);
    if (exists(lp)) { library_add(g, lp); play(g->id, g->sys, lp); }
    else { deferred = D_GET_GAME; deferred_game = filtered[sel_game]; }
  }
  if ((pressed & SCE_CTRL_SQUARE) && nfiltered && focus_games) {
    Game *g = &games[filtered[sel_game]];
    char lp[512]; local_path(g, lp, sizeof lp);
    if (exists(lp)) { sceIoRemove(lp); json_object_del(library, g->id); save_library(); say(C_OK, "Removed from this Vita."); }
  }
}

static int sel_local = 0;
static void local_tab(unsigned int pressed) {
  const char *key; json_t *v; int n = 0;
  const char *ids[512]; json_t *items[512];
  json_object_foreach(library, key, v) {
    const char *p = json_string_value(json_object_get(v, "path"));
    if (p && exists(p) && n < 512) { ids[n] = key; items[n] = v; n++; }
  }
  text(40, 100, C_TEXT, 1.05f, "Games on this Vita");
  if (!n) text(40, 140, C_DIM, 0.9f, "Nothing yet. Download a game from the Games tab; it plays offline after that.");
  if (sel_local >= n) sel_local = n ? n - 1 : 0;
  int rows = 9, scroll = sel_local >= rows ? sel_local - rows + 1 : 0;
  for (int r = 0; r < rows && scroll + r < n; r++) {
    int k = scroll + r, y = 120 + r * 40;
    vita2d_draw_rectangle(40, y, 880, 37, k == sel_local ? C_SELBG : C_ROW);
    if (k == sel_local) vita2d_draw_rectangle(40, y, 4, 37, C_SEL);
    const char *t = json_string_value(json_object_get(items[k], "title")), *s = json_string_value(json_object_get(items[k], "sys"));
    text_fit(56, y + 26, C_TEXT, 0.9f, t ? t : ids[k], 640);
    int si = s ? sys_index(s) : -1; if (si >= 0) text(720, y + 26, C_DIM, 0.8f, SYSTEMS[si].name);
  }
  char hints[120]; snprintf(hints, sizeof hints, "%s  Play     SQUARE  Remove from Vita", confirm_label); draw_footer(hints);
  if (pressed & SCE_CTRL_UP && sel_local > 0) sel_local--;
  if (pressed & SCE_CTRL_DOWN && sel_local < n - 1) sel_local++;
  if (n && (pressed & confirm_btn)) {
    const char *s = json_string_value(json_object_get(items[sel_local], "sys")), *p = json_string_value(json_object_get(items[sel_local], "path"));
    int si = s ? sys_index(s) : -1; if (si >= 0 && p) play(ids[sel_local], si, p);
  }
  if (n && (pressed & SCE_CTRL_SQUARE)) {
    const char *p = json_string_value(json_object_get(items[sel_local], "path"));
    if (p) sceIoRemove(p);
    json_object_del(library, ids[sel_local]); save_library(); say(C_OK, "Removed from this Vita.");
  }
}

static void stream_tab(unsigned int pressed) {
  text(40, 110, C_TEXT, 1.15f, "Play anything from your PC");
  int y = text_wrap(40, 148, C_DIM, 0.9f, "PS2, GameCube, PS3, Switch and PC games are too big for a Vita: they run on the host PC and stream here with Moonlight, with the Vita's own buttons. The host PC must be on, with SaveState's Sunshine set up (it is on the main host).", 860, 26);
  y += 16;
  if (has_moonlight()) {
    vita2d_draw_rectangle(40, y, 420, 56, C_SELBG); vita2d_draw_rectangle(40, y, 5, 56, C_SEL);
    char b[80]; snprintf(b, sizeof b, "%s  Open Moonlight", confirm_label); text(64, y + 36, C_TEXT, 1.05f, b);
    y += 90;
    text_wrap(40, y, C_DIM, 0.85f, "First time: in Moonlight add the PC (it finds it on home Wi-Fi), pair with the PIN it shows in Sunshine on the PC, then pick Desktop or a game. Away from home it needs the PC's internet address.", 860, 24);
    if (pressed & confirm_btn) launch_uri("psgm:play?titleid=XYZZ00002");
  } else {
    text(40, y + 20, C_WARN, 1.0f, "Moonlight isn't installed on this Vita yet.");
    text_wrap(40, y + 56, C_DIM, 0.9f, "Get the Moonlight VPK for PS Vita from github.com/xyzz/vita-moonlight (Releases) and install it with VitaShell, then come back here.", 860, 26);
  }
}

static int sel_setting = 0;
static void settings_tab(unsigned int pressed) {
  char line[260];
  const char *ra = retroarch_id();
  const char *rows[5] = {"Host address", "Signed in as", "RetroArch", "Adrenaline (PSP)", "Moonlight (streaming)"};
  for (int i = 0; i < 5; i++) {
    int y = 90 + i * 62;
    vita2d_draw_rectangle(40, y, 880, 54, i == sel_setting ? C_SELBG : C_ROW);
    if (i == sel_setting) vita2d_draw_rectangle(40, y, 4, 54, C_SEL);
    text(60, y + 22, C_DIM, 0.8f, rows[i]);
    unsigned int c = C_TEXT;
    if (i == 0) snprintf(line, sizeof line, "%s", cfg_host);
    else if (i == 1) snprintf(line, sizeof line, "%s   (%s  Sign out)", cfg_user, confirm_label);
    else if (i == 2) { snprintf(line, sizeof line, "%s", ra ? "Installed: retro games start straight in it" : "Not installed: retroarch.com > Download > PlayStation Vita"); c = ra ? C_OK : C_WARN; }
    else if (i == 3) { snprintf(line, sizeof line, "%s", has_adrenaline() ? "Installed: PSP games go to ux0:pspemu/ISO" : "Not installed: needed for PSP games"); c = has_adrenaline() ? C_OK : C_WARN; }
    else { snprintf(line, sizeof line, "%s", has_moonlight() ? "Installed" : "Not installed: see the Stream tab"); c = has_moonlight() ? C_OK : C_WARN; }
    text_fit(60, y + 45, c, 0.95f, line, 840);
  }
  text_wrap(40, 420, C_DIM, 0.8f, "Tip: at home, set the host address to the host's home-network address (for example http://192.168.31.201:3000): games download much faster than over the internet.", 880, 22);
  char v[80]; snprintf(v, sizeof v, "SaveState for PS Vita %s", APP_VERSION); text(40, 488, C_DIM, 0.75f, v);
  char hints[120]; snprintf(hints, sizeof hints, "%s  Change     Up/Down  Choose", confirm_label); draw_footer(hints);
  if (pressed & SCE_CTRL_UP) sel_setting = (sel_setting + 4) % 5;
  if (pressed & SCE_CTRL_DOWN) sel_setting = (sel_setting + 1) % 5;
  if (pressed & confirm_btn) {
    if (sel_setting == 0) deferred = D_SET_HOST;
    else if (sel_setting == 1) { *cfg_token = 0; save_config(); free(games); games = NULL; ngames = 0; screen = SCR_LOGIN; login_field = 1; }
  }
}

/* One frame with a single line on it, for work that blocks (between frames only). */
static void busy(const char *what) {
  vita2d_start_drawing(); vita2d_clear_screen();
  vita2d_draw_rectangle(0, 0, SCREEN_W, 64, C_PANEL); text(24, 42, C_SEL, 1.3f, "SaveState");
  text(80, 290, C_TEXT, 1.1f, what);
  vita2d_end_drawing(); vita2d_swap_buffers();
}
static void trim_host(void) { size_t n = strlen(cfg_host); while (n && cfg_host[n - 1] == '/') cfg_host[--n] = 0; }
static void run_deferred(void) {
  int d = deferred; deferred = D_NONE;
  switch (d) {
  case D_LOGIN_HOST: if (ime_input("Host address (https://savestate.co.za, or http://<home IP>:3000)", cfg_host, sizeof cfg_host, 0)) { trim_host(); save_config(); } break;
  case D_LOGIN_USER: if (ime_input("User name or email", cfg_user, sizeof cfg_user, 0)) login_field = 2; break;
  case D_LOGIN_PASS: if (ime_input("Password", login_pass, sizeof login_pass, 1)) login_field = 3; break;
  case D_LOGIN_GO:
    *net_error = 0;
    if (!*cfg_user || !*login_pass) { snprintf(net_error, sizeof net_error, "Type your user name and password first."); break; }
    busy("Signing in...");
    if (sign_in(cfg_user, login_pass)) {
      memset(login_pass, 0, sizeof login_pass);
      busy("Getting your games...");
      load_games(); screen = SCR_HOME; tab = TAB_GAMES;
    }
    break;
  case D_SEARCH: if (ime_input("Search games", search, sizeof search, 0)) { sel_game = 0; scroll_game = 0; focus_games = 1; refilter(); } break;
  case D_SET_HOST: if (ime_input("Host address", cfg_host, sizeof cfg_host, 0)) { trim_host(); save_config(); busy("Getting your games..."); load_games(); } break;
  case D_RELOAD: busy("Getting your games..."); load_games(); break;
  case D_GET_GAME: {
    if (deferred_game < 0 || deferred_game >= ngames) break;
    Game *g = &games[deferred_game];
    char lp[512]; local_path(g, lp, sizeof lp);
    if (strcmp(SYSTEMS[g->sys].id, "psp") && !retroarch_id()) say(C_WARN, "Downloading. Install RetroArch for PS Vita to play it (retroarch.com).");
    /* Neo Geo and arcade sets need the BIOS set (neogeo.zip) next to them. */
    if (!strcmp(SYSTEMS[g->sys].name, "Neo Geo") || !strcmp(SYSTEMS[g->sys].name, "Arcade")) {
      char bios[512]; snprintf(bios, sizeof bios, ROM_DIR "/%s/neogeo.zip", SYSTEMS[g->sys].id);
      if (!exists(bios)) {
        busy("Getting the Neo Geo BIOS from your host...");
        char url[600]; snprintf(url, sizeof url, "%s/api/emulator/bios/serve/neogeo.zip", cfg_host);
        start_download(url, bios, -1, 0);
        while (job.active) sceKernelDelayThread(100 * 1000);
        memset(&job, 0, sizeof job);
      }
    }
    char url[600]; snprintf(url, sizeof url, "%s/api/games/%s/download", cfg_host, g->id);
    start_download(url, lp, deferred_game, 1);
    break;
  }
  default: break;
  }
}

/* ── Main ──────────────────────────────────────────────────────────────── */
int main(void) {
  sceSysmoduleLoadModule(SCE_SYSMODULE_NET);
  static char net_mem[1024 * 1024];
  SceNetInitParam np = { net_mem, sizeof net_mem, 0 };
  sceNetInit(&np); sceNetCtlInit();
  curl_global_init(CURL_GLOBAL_ALL);

  SceAppUtilInitParam ip; SceAppUtilBootParam bp; memset(&ip, 0, sizeof ip); memset(&bp, 0, sizeof bp);
  sceAppUtilInit(&ip, &bp);
  SceCommonDialogConfigParam cp; sceCommonDialogConfigParamInit(&cp);
  int lang = 0, enter = 1;
  sceAppUtilSystemParamGetInt(SCE_SYSTEM_PARAM_ID_LANG, &lang);
  sceAppUtilSystemParamGetInt(SCE_SYSTEM_PARAM_ID_ENTER_BUTTON, &enter);
  cp.language = lang; cp.enterButtonAssign = enter; sceCommonDialogSetConfigParam(&cp);
  if (enter == SCE_SYSTEM_PARAM_ENTER_BUTTON_CIRCLE) { confirm_btn = SCE_CTRL_CIRCLE; cancel_btn = SCE_CTRL_CROSS; confirm_label = "O"; cancel_label = "X"; }

  vita2d_init();
  vita2d_set_clear_color(C_BG);
  font = vita2d_load_default_pgf();
  sceCtrlSetSamplingMode(SCE_CTRL_MODE_ANALOG);
  mkdirs(DATA_DIR); mkdirs(ROM_DIR); mkdirs(COVER_DIR);
  load_config(); load_library();

  pthread_t ct; pthread_attr_t ca; pthread_attr_init(&ca); pthread_attr_setstacksize(&ca, 256 * 1024);
  pthread_create(&ct, &ca, cover_thread, NULL); pthread_detach(ct);

  if (*cfg_token) {
    busy("Connecting to your SaveState host...");
    if (renew() && *cfg_token) {
      load_games(); screen = SCR_HOME;
      busy("Syncing your saves...");
      int up = sync_up();
      if (up) { char m[80]; snprintf(m, sizeof m, "%d save%s sent to your host.", up, up == 1 ? "" : "s"); say(C_OK, m); }
    }
  }

  unsigned int old = 0; int hold = 0;
  for (;;) {
    SceCtrlData pad; sceCtrlPeekBufferPositive(0, &pad, 1);
    /* Analogue stick as the d-pad. */
    if (pad.ly < 40) pad.buttons |= SCE_CTRL_UP; else if (pad.ly > 215) pad.buttons |= SCE_CTRL_DOWN;
    if (pad.lx < 40) pad.buttons |= SCE_CTRL_LEFT; else if (pad.lx > 215) pad.buttons |= SCE_CTRL_RIGHT;
    unsigned int pressed = pad.buttons & ~old;
    /* Holding up/down repeats. */
    unsigned int dirs = pad.buttons & (SCE_CTRL_UP | SCE_CTRL_DOWN);
    if (dirs && dirs == (old & (SCE_CTRL_UP | SCE_CTRL_DOWN))) { if (++hold > 18 && hold % 3 == 0) pressed |= dirs; } else hold = 0;
    old = pad.buttons;

    if (job.active) sceKernelPowerTick(SCE_KERNEL_POWER_TICK_DISABLE_AUTO_SUSPEND);

    vita2d_start_drawing(); vita2d_clear_screen();
    if (job.active) {
      if (screen == SCR_HOME) draw_header();
      draw_job();
      if (pressed & cancel_btn) job.cancel = 1;
      pressed = 0;
    } else if (job.done || job.failed) {
      int g = job.game, done = job.done, launch = job.launch_after;
      char path[512]; snprintf(path, sizeof path, "%s", job.path);
      if (job.failed) say(C_BAD, job.error);
      memset(&job, 0, sizeof job);
      if (done && g >= 0) {
        library_add(&games[g], path);
        if (launch) { vita2d_end_drawing(); vita2d_swap_buffers(); play(games[g].id, games[g].sys, path); continue; }
      }
    }
    if (screen == SCR_LOGIN) login_screen(&pad, job.active ? 0 : pressed);
    else if (!job.active) {
      draw_header();
      if (pressed & SCE_CTRL_LTRIGGER) { tab = (tab + NTABS - 1) % NTABS; *message = 0; }
      if (pressed & SCE_CTRL_RTRIGGER) { tab = (tab + 1) % NTABS; *message = 0; }
      if (tab == TAB_GAMES) games_tab(pressed);
      else if (tab == TAB_LOCAL) local_tab(pressed);
      else if (tab == TAB_STREAM) stream_tab(pressed);
      else settings_tab(pressed);
      draw_message();
    }
    if (pressed & SCE_CTRL_START && screen == SCR_LOGIN) break;
    vita2d_end_drawing();
    vita2d_swap_buffers();
    if (nfree) { vita2d_wait_rendering_done(); for (int i = 0; i < nfree; i++) vita2d_free_texture(to_free[i]); nfree = 0; }
    if (deferred) run_deferred();
  }
  vita2d_fini(); vita2d_free_pgf(font);
  curl_global_cleanup(); sceNetCtlTerm(); sceNetTerm();
  sceKernelExitProcess(0);
  return 0;
}
