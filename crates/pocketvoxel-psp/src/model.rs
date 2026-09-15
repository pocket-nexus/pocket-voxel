//! Optional KUBridge model query using rust-psp's native import layout.
//! NID/weak flags: https://github.com/pspdev/kubridge/blob/main/kubridge.S
//! Avoids linking the SDK's legacy MIPS assembly objects with rust-lld.
use psp::sys::SceStubLibraryEntry;

#[repr(C)]
struct ImportStub {
    library: &'static SceStubLibraryEntry,
    nid: &'static u32,
}

#[link_section = ".rodata.sceResident.KUBridge"]
static NAME: [u8; 12] = *b"KUBridge\0\0\0\0";
#[link_section = ".rodata.sceNid.KUBridge.kuKernelGetModel"]
static NID: u32 = 0x24331850;
#[link_section = ".lib.stub.entry.KUBridge"]
static LIBRARY: SceStubLibraryEntry = SceStubLibraryEntry {
    name: NAME.as_ptr(), version: [0, 0], flags: 0x4009, len: 5,
    v_stub_count: 0, stub_count: 0,
    nid_table: &NID,
    stub_table: &KU_MODEL_STUB as *const ImportStub as *const _,
};
#[used]
#[no_mangle]
#[link_section = ".sceStub.text.KUBridge.kuKernelGetModel"]
static KU_MODEL_STUB: ImportStub = ImportStub { library: &LIBRARY, nid: &NID };

pub unsafe fn get() -> i32 {
    // Only execute a resolved jump or syscall. A missing weak import may
    // remain jr ra/nop or receive the loader's unresolved syscall 0x15.
    let words = &KU_MODEL_STUB as *const ImportStub as *const u32;
    let first = words.read_volatile();
    let second = words.add(1).read_volatile();
    let jump = first >> 26 == 2;
    let syscall = first == 0x03e00008 && second & 0xfc00003f == 0x0c && second != 0x54c;
    if !jump && !syscall { return -1; }
    extern "C" {
        #[link_name = "KU_MODEL_STUB"]
        fn call_model() -> i32;
    }
    call_model()
}
