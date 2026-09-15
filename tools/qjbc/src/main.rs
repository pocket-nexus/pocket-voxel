use std::{env, fs, path::Path};

use libquickjs_sys::*;

const JS_EVAL_FLAG_STRIP: u32 = 16;
const JS_EVAL_FLAG_COMPILE_ONLY: u32 = 32;
const JS_WRITE_OBJ_BYTECODE: i32 = 1;

// The pinned sys crate links these QuickJS APIs but its curated public Rust
// surface omits the serializer. Keep the declarations local to this tiny tool.
extern "C" {
    fn JS_WriteObject(
        ctx: *mut JSContext,
        size: *mut usize,
        value: JSValue,
        flags: i32,
    ) -> *mut u8;
    fn js_free(ctx: *mut JSContext, ptr: *mut core::ffi::c_void);
}

fn main() {
    let mut args = env::args_os().skip(1);
    let input = args.next().expect("usage: voxel-qjbc INPUT.js OUTPUT.qjbc");
    let output = args.next().expect("usage: voxel-qjbc INPUT.js OUTPUT.qjbc");
    assert!(args.next().is_none(), "usage: voxel-qjbc INPUT.js OUTPUT.qjbc");

    let source = fs::read(&input).unwrap_or_else(|e| panic!("could not read {:?}: {e}", input));
    let bytecode = compile(&source);
    fs::write(&output, &bytecode)
        .unwrap_or_else(|e| panic!("could not write {:?}: {e}", output));
    println!(
        "voxel qjbc: {} -> {} ({} bytes)",
        Path::new(&input).display(),
        Path::new(&output).display(),
        bytecode.len()
    );
}

fn compile(source: &[u8]) -> Vec<u8> {
    unsafe {
        let rt = JS_NewRuntime();
        assert!(!rt.is_null(), "JS_NewRuntime failed");
        let ctx = JS_NewContext(rt);
        assert!(!ctx.is_null(), "JS_NewContext failed");

        let compiled = JS_Eval(
            ctx,
            source.as_ptr().cast(),
            source.len(),
            b"voxelmon.js\0".as_ptr().cast(),
            (JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY | JS_EVAL_FLAG_STRIP) as i32,
        );
        assert!(!JS_IsException(compiled), "QuickJS compilation failed");

        let mut len = 0;
        let raw = JS_WriteObject(ctx, &mut len, compiled, JS_WRITE_OBJ_BYTECODE);
        assert!(!raw.is_null(), "JS_WriteObject failed");
        let bytecode = std::slice::from_raw_parts(raw, len).to_vec();

        js_free(ctx, raw.cast());
        JS_FreeValue(ctx, compiled);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        bytecode
    }
}
