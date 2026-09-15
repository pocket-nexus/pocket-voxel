//! Compiles the game bundle to QuickJS bytecode and bakes it into the EBOOT.
//!
//! `VOXELMON_QJBC` (set by tools/voxel.ts psp) is the bytecode produced on the
//! PC by tools/qjbc from `dist/voxelmon/game.js`. The compiler uses the same
//! pinned QuickJS revision as the PSP runtime. The PSP therefore only
//! deserializes bytecode; it never constructs the parser/AST working set that
//! exhausts PSP-1000 memory.
//!
//! Capture inputs (VOXEL_CAP_INPUT / VOXEL_CAP_MARKS) pass through as
//! rustc-env so a stale value can never linger in cargo's fingerprint —
//! tools always set them, capture builds read them via `env!`.

use std::path::Path;
use std::{env, fs};

fn main() {
    let out_dir = env::var("OUT_DIR").unwrap();
    let bytecode_path = env::var("VOXELMON_QJBC").unwrap_or_default();
    let bytecode = if bytecode_path.is_empty() {
        Vec::new()
    } else {
        println!("cargo:rerun-if-changed={bytecode_path}");
        fs::read(&bytecode_path)
            .unwrap_or_else(|e| panic!("could not read VOXELMON_QJBC={bytecode_path}: {e}"))
    };
    fs::write(Path::new(&out_dir).join("game.qjbc"), bytecode).unwrap();
    println!("cargo:rerun-if-env-changed=VOXELMON_QJBC");

    for var in ["VOXEL_CAP_INPUT", "VOXEL_CAP_MARKS", "VOXEL_CAP_DUMP"] {
        println!("cargo:rustc-env={var}={}", env::var(var).unwrap_or_default());
        println!("cargo:rerun-if-env-changed={var}");
    }
}
