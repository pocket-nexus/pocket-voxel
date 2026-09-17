//! Pocket Voxel native extension for the shared PocketJS E7 host.
#![no_std]
#![allow(static_mut_refs)]
extern crate alloc;
mod gles2_compat;
mod quickjs;
#[path = "../../pocketvoxel-iphone4s/src/gles1.rs"]
mod renderer;
use alloc::vec::Vec;
use core::ffi::{c_char, c_void};
use pocketjs_symbian_core::extension::{self, ExtensionV1, GraphicsExtensionV1};
use pocketvoxel_core::{
    pak::{self, Pak},
    scene::Scene,
    spec::{op, quality_tier},
};
use quickjs::*;
#[used]
static CORE: extern "C" fn(u32) = pocketjs_symbian_core::ui_init;

struct State {
    pak: Pak<'static>,
    scene: Scene,
    renderer: renderer::Renderer,
    storage: Vec<u64>,
    buttons: u32,
    keys: u32,
    ready: bool,
}
static mut STATE: Option<State> = None;
unsafe extern "C" {
    fn fopen(path: *const u8, mode: *const u8) -> *mut c_void;
    fn fseek(file: *mut c_void, offset: i32, whence: i32) -> i32;
    fn ftell(file: *mut c_void) -> i32;
    fn fread(out: *mut u8, size: usize, n: usize, file: *mut c_void) -> usize;
    fn fclose(file: *mut c_void) -> i32;
    fn JS_NewStringLen(ctx: *mut JSContext, text: *const c_char, len: usize) -> JSValue;
    fn JS_NewArrayBufferCopy(ctx: *mut JSContext, data: *const u8, len: usize) -> JSValue;
}
unsafe fn load() -> Option<(Vec<u64>, &'static [u8])> {
    let file = fopen(
        b"E:/private/e9a45cd9/data/voxelmon.vxpak\0".as_ptr(),
        b"rb\0".as_ptr(),
    );
    if file.is_null() {
        return None;
    }
    if fseek(file, 0, 2) != 0 {
        fclose(file);
        return None;
    }
    let len = ftell(file);
    if len <= 0 || len > 40 * 1024 * 1024 || fseek(file, 0, 0) != 0 {
        fclose(file);
        return None;
    }
    let mut storage = Vec::new();
    let words = (len as usize + 23) / 8;
    if storage.try_reserve_exact(words).is_err() {
        fclose(file);
        return None;
    }
    storage.resize(words, 0u64);
    let base = storage.as_mut_ptr().cast::<u8>();
    let offset = base.align_offset(16);
    let data = base.add(offset);
    let read = fread(data, 1, len as usize, file);
    fclose(file);
    if read != len as usize {
        return None;
    }
    Some((storage, core::slice::from_raw_parts(data, len as usize)))
}
unsafe extern "C" fn dispatch(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
    code: i32,
) -> JSValue {
    let Some(state) = STATE.as_mut() else {
        return JS_UNDEFINED;
    };
    if code == op::GAMEDATA as i32 {
        return JS_NewStringLen(ctx, state.pak.game.as_ptr().cast(), state.pak.game.len());
    }
    if code == op::AUDIODATA as i32 {
        return JS_NewArrayBufferCopy(ctx, state.pak.audio.as_ptr(), state.pak.audio.len());
    }
    if code == 1000 {
        return JS_NewInt32(ctx, state.keys as i32);
    }
    let mut args = [0i32; 7];
    let mut count = argc.clamp(0, 7) as usize;
    let string_index = if code == op::UI_TEXT as i32 {
        Some(2)
    } else if code == op::UI_LABEL as i32 {
        Some(4)
    } else {
        None
    };
    if let Some(index) = string_index {
        count = count.min(index);
    }
    for i in 0..count {
        if JS_ToInt32(ctx, &mut args[i], *argv.add(i)) < 0 {
            return (JS_TAG_EXCEPTION as u64) << 32;
        }
    }
    if code == 1001 {
        state.buttons = args[0] as u32;
        return JS_UNDEFINED;
    }
    let mut len = 0;
    let mut text = core::ptr::null();
    if let Some(index) = string_index {
        if argc > index as i32 {
            text = JS_ToCStringLen2(ctx, &mut len, *argv.add(index), 0);
            if text.is_null() {
                return (JS_TAG_EXCEPTION as u64) << 32;
            }
        }
    }
    let string = if text.is_null() {
        None
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(text.cast(), len)).ok()
    };
    state.scene.op(code as u32, &args[..count], string);
    if !text.is_null() {
        JS_FreeCString(ctx, text);
    }
    JS_UNDEFINED
}
unsafe extern "C" fn boot(ctx: *mut c_void, _pak: *const u8, _len: usize, _w: i32, _h: i32) -> i32 {
    let Some((storage, bytes)) = load() else {
        return 0;
    };
    let Ok(pak) = pak::read(bytes) else { return 0 };
    let mut scene = Scene::new();
    scene.op(op::QUALITY, &[quality_tier::PSP as i32], None);
    STATE = Some(State {
        pak,
        scene,
        renderer: renderer::Renderer::new(),
        storage,
        buttons: 0,
        keys: 0,
        ready: false,
    });
    let ctx = ctx.cast::<JSContext>();
    let global = JS_GetGlobalObject(ctx);
    let object = JS_NewObject(ctx);
    let functions: &[(&[u8], u32, i32)] = &[
        (b"gamedata\0", op::GAMEDATA, 0),
        (b"audiodata\0", op::AUDIODATA, 0),
        (b"stats\0", op::STATS, 0),
        (b"reset\0", op::RESET, 0),
        (b"mapShow\0", op::MAP_SHOW, 4),
        (b"mapHide\0", op::MAP_HIDE, 1),
        (b"cam\0", op::CAM, 2),
        (b"pitch\0", op::PITCH, 1),
        (b"tint\0", op::TINT, 1),
        (b"sky\0", op::SKY, 1),
        (b"stamp\0", op::STAMP, 4),
        (b"palette\0", op::PALETTE, 1),
        (b"ent\0", op::ENT, 7),
        (b"entHide\0", op::ENT_HIDE, 1),
        (b"emote\0", op::EMOTE, 2),
        (b"uiTile\0", op::UI_TILE, 3),
        (b"uiFill\0", op::UI_FILL, 5),
        (b"uiText\0", op::UI_TEXT, 3),
        (b"uiReveal\0", op::UI_REVEAL, 1),
        (b"uiClear\0", op::UI_CLEAR, 0),
        (b"uiRect\0", op::UI_RECT, 5),
        (b"uiLabel\0", op::UI_LABEL, 5),
        (b"uiOverlayClear\0", op::UI_OVERLAY_CLEAR, 0),
        (b"remotePlane\0", op::REMOTE_PLANE, 4),
        (b"arena\0", op::ARENA, 5),
        (b"card\0", op::CARD, 4),
        (b"cardHide\0", op::CARD_HIDE, 1),
        (b"battleCam\0", op::BATTLE_CAM, 3),
        (b"arenaEnd\0", op::ARENA_END, 0),
        (b"nativeButtons\0", 1000, 0),
        (b"buttons\0", 1001, 1),
    ];
    // QuickJS's generic_magic callback has one additional integer argument.
    let callback = core::mem::transmute::<
        unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue, i32) -> JSValue,
        unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue,
    >(dispatch);
    for &(name, code, arity) in functions {
        let fun = JS_NewCFunction2(
            ctx,
            Some(callback),
            name.as_ptr().cast(),
            arity,
            1,
            code as i32,
        );
        JS_SetPropertyStr(ctx, object, name.as_ptr().cast(), fun);
    }
    JS_SetPropertyStr(ctx, global, b"voxel\0".as_ptr().cast(), object);
    JS_FreeValue(ctx, global);
    1
}
unsafe extern "C" fn before(_ctx: *mut c_void, buttons: u32, _analog: u32, keys: u32) -> i32 {
    if let Some(s) = STATE.as_mut() {
        s.keys = 0;
        for (mask, bit) in [
            (0x10, 1),
            (0x40, 2),
            (0x80, 4),
            (0x20, 8),
            (0x2000, 16),
            (0x4000, 32),
            (8, 64),
            (1, 128),
        ] {
            if buttons & mask != 0 {
                s.keys |= bit;
            }
        }
        for (mask, bit) in [
            (extension::KEY_MOVE_FORWARD, 1),
            (extension::KEY_MOVE_BACK, 2),
            (extension::KEY_MOVE_LEFT, 4),
            (extension::KEY_MOVE_RIGHT, 8),
            (extension::KEY_FIRE, 16),
            (extension::KEY_JUMP, 16),
        ] {
            if keys & mask != 0 {
                s.keys |= bit;
            }
        }
    }
    1
}
unsafe extern "C" fn after(_ctx: *mut c_void) -> i32 {
    if let Some(s) = STATE.as_mut() {
        s.scene.tick();
    }
    1
}
unsafe extern "C" fn render(x: i32, y: i32, w: i32, h: i32, _ww: i32, wh: i32) -> i32 {
    let Some(s) = STATE.as_mut() else { return 0 };
    if !s.ready {
        if !gles2_compat::initialize() || s.renderer.initialize(640, 960) == 0 {
            return 0;
        }
        s.ready = true;
    }
    let scale = (w as f32 / 640.).min(h as f32 / 960.);
    let rw = (640. * scale) as i32;
    let rh = (960. * scale) as i32;
    gles2_compat::target(x + (w - rw) / 2, wh - y - h + (h - rh) / 2, rw, rh);
    let list = pocketvoxel_core::draw::build(&s.scene, &s.pak);
    s.renderer.render(&list, &s.pak, 640, 960, s.buttons)
}
unsafe extern "C" fn shutdown(live: i32) {
    if let Some(mut s) = STATE.take() {
        if live == 0 {
            s.renderer.abandon();
        } else {
            s.renderer.shutdown();
        }
        drop(s);
    }
    gles2_compat::shutdown(live != 0);
}
unsafe extern "C" fn release_graphics(live: i32) {
    if let Some(s) = STATE.as_mut() {
        if live == 0 {
            s.renderer.abandon();
        } else {
            s.renderer.shutdown();
        }
        s.ready = false;
    }
    gles2_compat::shutdown(live != 0);
}
static EXTENSION: GraphicsExtensionV1 = GraphicsExtensionV1 {
    base: ExtensionV1 {
        abi_version: extension::ABI_V1,
        struct_size: core::mem::size_of::<GraphicsExtensionV1>() as u32,
        flags: extension::FLAG_DEPTH_BUFFER,
        boot: Some(boot),
        shutdown: Some(shutdown),
        before_guest: Some(before),
        after_guest: Some(after),
        resize: None,
        render: Some(render),
    },
    release_graphics: Some(release_graphics),
};
#[no_mangle]
pub extern "C" fn pocketjs_symbian_extension_v1() -> *const ExtensionV1 {
    &EXTENSION.base
}
