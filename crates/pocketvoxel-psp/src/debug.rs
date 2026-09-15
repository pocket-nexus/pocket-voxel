//! Select diagnostics. Samples once per second and never changes guest UI state.
use alloc::{format, string::String, vec::Vec};
use core::ffi::CStr;
use libquickjs_sys::*;
use pocketjs_psp::arena;
use pocketvoxel_core::{draw::Item, pak::Pak, scene::{Scene, UiOverlayItem, UiOverlayLabel, UiOverlayRect}, spec, ui};
use psp::sys;
use crate::pak_file::{AtlasCache, MapGeometry};

#[derive(Clone, Copy)]
pub struct Memory {
    kernel: usize,
    kernel_largest: usize,
    heap: usize,
    heap_largest: usize,
}
impl Memory {
    pub unsafe fn read() -> Self {
        let (heap, heap_largest) = arena::debug_free();
        Self { kernel: sys::sceKernelTotalFreeMemSize(), kernel_largest: sys::sceKernelMaxFreeMemSize(), heap, heap_largest }
    }
}

pub struct DebugPanel {
    visible: bool,
    held: bool,
    refresh: bool,
    sampled: u32,
    model: Option<i32>,
    lines: Vec<UiOverlayItem>,
    rects: Vec<UiOverlayRect>,
    reloads: u32,
    cleanup: Option<(Memory, Memory, &'static str)>,
}
impl DebugPanel {
    pub fn new() -> Self {
        Self { visible: false, held: false, refresh: true, sampled: 0, model: None, lines: Vec::new(), rects: Vec::new(), reloads: 0, cleanup: None }
    }
    pub fn record_cleanup(&mut self, before: Memory, after: Memory, reason: &'static str, reload: bool) {
        self.cleanup = Some((before, after, reason));
        if reload { self.reloads = self.reloads.wrapping_add(1); }
        self.refresh = true;
    }
    pub fn buttons(&mut self, mask: u32) -> u32 {
        let down = mask & spec::btn::SELECT != 0;
        if down && !self.held { self.visible = !self.visible; self.refresh = true; }
        self.held = down;
        mask & !spec::btn::SELECT
    }
    fn line(&mut self, text: String) {
        let y = 18 + self.lines.len() as i32 * 14;
        self.lines.push(UiOverlayItem::Label(UiOverlayLabel { x: 16, y, scale: 1, abgr: 0xffe8ffe8, text }));
    }
    pub unsafe fn update(&mut self, frame: u32, ctx: *mut JSContext, global: JSValue, scene: &Scene, pak: &Pak<'_>, geometry: &MapGeometry, atlases: &AtlasCache) {
        if !self.visible { return; }
        if self.refresh || frame.wrapping_sub(self.sampled) >= 60 {
            // Sample before allocating label strings, so the panel does not
            // count its own rebuild as newly reclaimed game memory.
            let mem = Memory::read();
            self.sampled = frame;
            self.refresh = false;
            self.lines.clear();
            self.line(String::from("DEBUG                         SELECT: CLOSE"));
            let model = *self.model.get_or_insert_with(|| crate::model::get());
            let name = match model {
                0 => "PSP-1000", 1 => "PSP-2000", 2 | 3 | 6 | 8 => "PSP-3000",
                4 => "PSP GO", 10 => "PSP STREET", _ => "UNKNOWN",
            };
            self.line(format!("PSP MODEL: {} (ID {})", name, model));
            self.line(format!("FREE RAM KERNEL: {} KB", mem.kernel / 1024));
            self.line(format!("LARGEST KERNEL FREE BLOCK: {} KB", mem.kernel_largest / 1024));
            self.line(format!("GAME HEAP FREE: {} KB  LARGEST: {} KB", mem.heap / 1024, mem.heap_largest / 1024));
            let callback = JS_GetPropertyStr(ctx, global, b"debugWorld\0".as_ptr().cast());
            let value = JS_Call(ctx, callback, global, 0, core::ptr::null_mut());
            if JS_ValueGetTag(value) != JS_TAG_EXCEPTION {
                let text = JS_ToCStringLen2(ctx, core::ptr::null_mut(), value, 0);
                if !text.is_null() {
                    self.line(CStr::from_ptr(text).to_string_lossy().into_owned());
                    JS_FreeCString(ctx, text);
                }
            } else {
                let error = JS_GetException(ctx);
                JS_FreeValue(ctx, error);
                self.line(String::from("MAP / POKEMON: UNAVAILABLE"));
            }
            JS_FreeValue(ctx, value);
            JS_FreeValue(ctx, callback);
            self.line(format!("CURRENT MAP ID: {}  SHOWN MAPS: {}", scene.maps[0].map_id, scene.maps.iter().filter(|m| m.shown).count()));
            self.line(format!("MAP GEOMETRY: {} KB  RESERVED: {} KB", geometry.resident_bytes() / 1024, geometry.allocated_bytes() / 1024));
            self.line(format!("ATLAS LOADED: {} PAGES  RESERVED: {} KB", atlases.page_count(), atlases.allocated_bytes() / 1024));
            self.line(format!("SPRITES: {} SHOWN  {} ATLAS PAGES LOADED", scene.ents.iter().filter(|e| e.shown).count(), atlases.kind_count(pak, spec::atlas_kind::SPRITES)));
            let pics = atlases.kind_count(pak, spec::atlas_kind::PICS);
            self.line(format!("BATTLE ART LOADED: {}  PAGES: {}", if pics > 0 { "YES" } else { "NO" }, pics));
            self.line(format!("BATTLE ACTIVE: {}", if scene.battle.active { "YES" } else { "NO" }));
            self.line(format!("MUSIC: {}  LEVEL: {}  SFX: {}", if scene.audio.music_playing() { "PLAYING" } else { "STOPPED" }, scene.audio.level(), if scene.audio.effect_playing() { "ON" } else { "OFF" }));
            if let Some((before, after, reason)) = self.cleanup {
                self.line(format!("CLEANUP: {}  RELOADS: {} (BEFORE / AFTER KB)", reason, self.reloads));
                self.line(format!("HEAP: {} / {}  GAIN: {} KB", before.heap / 1024, after.heap / 1024, (after.heap as i64 - before.heap as i64) / 1024));
                self.line(format!("KERNEL: {} / {}", before.kernel / 1024, after.kernel / 1024));
            } else {
                self.line(String::from("CLEANUP RAM BEFORE / AFTER: NOT RUN YET"));
            }
            self.rects.clear();
            self.rects.push(UiOverlayRect { x: 8, y: 8, w: 464, h: 252, abgr: 0xf0181818 });
            let mut scratch = Vec::new();
            for line in &self.lines {
                scratch.clear();
                ui::append_overlay_commands(core::slice::from_ref(line), &mut scratch);
                for item in &scratch {
                    if let Item::OverlayRect { x, y, w, h, abgr } = *item {
                        self.rects.push(UiOverlayRect { x, y, w, h, abgr });
                    }
                }
            }
        }
    }

    pub fn rects(&self) -> &[UiOverlayRect] {
        if self.visible { &self.rects } else { &[] }
    }
}
