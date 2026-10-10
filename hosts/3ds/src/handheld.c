#include "handheld.h"
#include "pocketvoxel_3ds.h"
#include <3ds.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BOTTOM_BYTES (320 * 240 * 3)
#define BUFFER_COUNT 4
#define BUFFER_FRAMES 735
#define BUFFER_BYTES (BUFFER_FRAMES * 2 * sizeof(int16_t))
#define STATUS_DIR "sdmc:/pocketvoxel-3ds"

static uint8_t *bottom;
static ndspWaveBuf waves[BUFFER_COUNT];
static bool audio_ready, hook_registered;
static Result audio_result;
static aptHookCookie lifecycle;
static uint32_t last_status_tick;
static uint32_t audio_buffers, audio_nonzero, audio_peak, buttons_seen, actions, previous_buttons;

static void lifecycle_hook(APT_HookType hook, void *unused) {
  (void)unused;
  if (!audio_ready) return;
  if (hook == APTHOOK_ONSUSPEND || hook == APTHOOK_ONSLEEP) ndspChnSetPaused(0, true);
  if (hook == APTHOOK_ONRESTORE || hook == APTHOOK_ONWAKEUP) ndspChnSetPaused(0, false);
}

bool handheld_init(void) {
  bottom = malloc(BOTTOM_BYTES);
  FILE *file = fopen("romfs:/bottom.bgr", "rb");
  if (!bottom || !file) { if (file) fclose(file); return false; }
  size_t count = fread(bottom, 1, BOTTOM_BYTES, file);
  fclose(file);
  if (count != BOTTOM_BYTES) return false;
  // consoleInit switches the panel to RGB565; restore the plate format.
  gfxSetScreenFormat(GFX_BOTTOM, GSP_BGR8_OES);
  gfxSetDoubleBuffering(GFX_BOTTOM, false);
#ifndef PV3DS_CAPTURE
  audio_result = ndspInit();
  if (R_SUCCEEDED(audio_result)) {
    audio_ready = true;
    ndspSetOutputMode(NDSP_OUTPUT_STEREO);
    ndspChnReset(0);
    ndspChnSetInterp(0, NDSP_INTERP_LINEAR);
    ndspChnSetRate(0, 11025.0f);
    ndspChnSetFormat(0, NDSP_FORMAT_STEREO_PCM16);
    float mix[12] = {1.0f, 1.0f};
    ndspChnSetMix(0, mix);
    for (unsigned i = 0; i < BUFFER_COUNT; i++) {
      waves[i].data_vaddr = linearAlloc(BUFFER_BYTES);
      waves[i].nsamples = BUFFER_FRAMES;
      if (!waves[i].data_vaddr) { handheld_shutdown(); return false; }
    }
    aptHook(&lifecycle, lifecycle_hook, NULL);
    hook_registered = true;
    handheld_audio_pump();
  }
#endif
  return true;
}

void handheld_bottom(void) {
  if (!bottom) return;
  uint16_t width, height;
  uint8_t *frame = gfxGetFramebuffer(GFX_BOTTOM, GFX_LEFT, &width, &height);
  if (width != 240 || height != 320 || gfxGetScreenFormat(GFX_BOTTOM) != GSP_BGR8_OES) return;
  memcpy(frame, bottom, BOTTOM_BYTES);
  GSPGPU_FlushDataCache(frame, BOTTOM_BYTES);
  // C3D owns only the upper target; commit the lower panel configuration here.
  gfxScreenSwapBuffers(GFX_BOTTOM, false);
}

void handheld_audio_pump(void) {
  if (!audio_ready) return;
  for (unsigned i = 0; i < BUFFER_COUNT; i++) {
    if (waves[i].status != NDSP_WBUF_FREE && waves[i].status != NDSP_WBUF_DONE) continue;
    int16_t *samples = (int16_t *)waves[i].data_vaddr;
    if (pv3ds_audio_render(samples, BUFFER_FRAMES) != BUFFER_FRAMES) {
      memset(samples, 0, BUFFER_BYTES);
    }
    uint32_t peak = 0;
    for (unsigned j = 0; j < BUFFER_FRAMES * 2; j++) {
      int value = samples[j];
      uint32_t magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
    }
    if (peak) audio_nonzero++;
    if (peak > audio_peak) audio_peak = peak;
    DSP_FlushDataCache(samples, BUFFER_BYTES);
    ndspChnWaveBufAdd(0, &waves[i]);
    audio_buffers++;
  }
}

void handheld_status(uint32_t tick, uint32_t buttons, const char *state) {
  buttons_seen |= buttons;
  if (previous_buttons && !buttons) actions++;
  previous_buttons = buttons;
  if (tick - last_status_tick < 60 && !strcmp(state, "running")) return;
  last_status_tick = tick;
  FILE *file = fopen(STATUS_DIR "/status.new", "w");
  if (!file) return;
  PvVox3dsStats stats;
  pv3ds_stats(&stats);
  fprintf(file, "state=%s\nbuild_id=%s\nrenderer=pica200\nprimary=400x240\n"
    "viewport=400x226+0+7\nauxiliary=320x240\nframes=%lu\npresents=%lu\n"
    "buttons_seen=%lu\ncompleted_actions=%lu\naudio_state=%s\naudio_result=%ld\n"
    "audio_rate=11025\naudio_channels=2\naudio_buffers=%lu\naudio_nonzero=%lu\naudio_peak=%lu\n",
    state, PV3DS_BUILD_ID, (unsigned long)tick, (unsigned long)stats.presents,
    (unsigned long)buttons_seen, (unsigned long)actions, audio_ready ? "running" : "unavailable",
    (long)audio_result, (unsigned long)audio_buffers, (unsigned long)audio_nonzero, (unsigned long)audio_peak);
  int flushed = fflush(file);
  int closed = fclose(file);
  if (!flushed && !closed) rename(STATUS_DIR "/status.new", STATUS_DIR "/status.txt");
}

void handheld_shutdown(void) {
  if (audio_ready) {
    if (hook_registered) aptUnhook(&lifecycle);
    hook_registered = false;
    ndspChnWaveBufClear(0);
    ndspChnReset(0);
    ndspExit();
    audio_ready = false;
  }
  for (unsigned i = 0; i < BUFFER_COUNT; i++) {
    if (waves[i].data_vaddr) linearFree((void *)waves[i].data_vaddr);
    waves[i].data_vaddr = NULL;
  }
  free(bottom);
  bottom = NULL;
}

void handheld_capture_bottom(void) {
#ifdef PV3DS_CAPTURE
  uint8_t *frame = gfxGetFramebuffer(GFX_BOTTOM, GFX_LEFT, NULL, NULL);
  FILE *file = fopen(STATUS_DIR "/bottom.bgr", "wb");
  if (file) {
    if (gfxGetScreenFormat(GFX_BOTTOM) == GSP_BGR8_OES) fwrite(frame, 1, BOTTOM_BYTES, file);
    fclose(file);
  }
#endif
}
