//! Positional Memory Stick/host0 reader for the file-backed VXPK index.
//!
//! Feature-gated until geometry and atlas caches consume it. Keeping this
//! separate from the legacy loader makes enabling the foundation incapable
//! of changing rendering or memory ownership by itself.

use core::ffi::c_void;

use alloc::{vec, vec::Vec};
use pocketvoxel_core::draw::{GeometryRequest, MeshDraw, WorkingSet};
use pocketvoxel_core::pak::{PakVert, index::{IndexError, PakIndex, ReadAt, read_index}};
use pocketvoxel_core::spec::{VXPK_ALIGN, VXPK_ENTRY_SIZE, VXPK_HEADER_SIZE, VXPK_MAGIC, VXPK_VERSION};
use pocketvoxel_gu::GeometrySource;
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};

pub struct PakFileReader {
    fd: SceUid,
    len: u64,
}

impl PakFileReader {
    /// Open one VXPK and record its length without allocating its payload.
    pub unsafe fn open(path: &'static [u8]) -> Result<Self, IndexError> {
        let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
        if fd.0 < 0 {
            return Err("could not open voxelmon.vxpak");
        }
        let len = sys::sceIoLseek(fd, 0, IoWhence::End);
        if len <= 0 || sys::sceIoLseek(fd, 0, IoWhence::Set) != 0 {
            sys::sceIoClose(fd);
            return Err("could not size voxelmon.vxpak");
        }
        Ok(Self { fd, len: len as u64 })
    }

    /// Open and validate the small resident catalog. Bulk payloads remain on
    /// the Memory Stick and `self` stays open for later cache fills.
    pub unsafe fn open_index(path: &'static [u8]) -> Result<(Self, PakIndex), IndexError> {
        let mut file = Self::open(path)?;
        let index = read_index(&mut file)?;
        Ok((file, index))
    }
}

/// 16-byte-aligned compact VXPK image containing every legacy-resident
/// section except CHNK and STMP. The latter are supplied by `PakIndex`.
pub struct ResidentBlob {
    words: Vec<u128>,
    len: usize,
}

impl ResidentBlob {
    pub fn bytes(&self) -> &[u8] {
        unsafe { core::slice::from_raw_parts(self.words.as_ptr() as *const u8, self.len) }
    }

    pub fn allocated_bytes(&self) -> usize { self.words.capacity() * core::mem::size_of::<u128>() }
}

fn put16(dst: &mut [u8], at: usize, value: u16) { dst[at..at + 2].copy_from_slice(&value.to_le_bytes()); }
fn put32(dst: &mut [u8], at: usize, value: u32) { dst[at..at + 4].copy_from_slice(&value.to_le_bytes()); }

impl PakFileReader {
    /// Minimal data required by the guest's top-level initialization. The
    /// full resident image (atlases, palettes, tables) can be deferred until
    /// after JS_EvalFunction for the PSP-1000 startup-memory experiment.
    pub fn load_startup(&mut self, index: &PakIndex) -> Result<Vec<u8>, IndexError> {
        let mut game = vec![0; index.game.len as usize];
        self.read_exact_at(index.game.offset, &mut game)?;
        Ok(game)
    }

    /// Load only the sections retained by the legacy runtime. Geometry and
    /// stamp records stay solely in the file-backed index/cache path.
    pub fn load_resident(&mut self, index: &PakIndex) -> Result<ResidentBlob, IndexError> {
        let table_end = VXPK_HEADER_SIZE + index.sections.len() * VXPK_ENTRY_SIZE;
        let mut ordered: Vec<_> = index.sections.iter().copied().collect();
        ordered.sort_unstable_by_key(|section| section.tag);
        let mut placements = Vec::with_capacity(ordered.len());
        let mut end = table_end.div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        for section in &ordered {
            let omitted = section.tag == pocketvoxel_core::spec::tag::CHUNKS
                || section.tag == pocketvoxel_core::spec::tag::STAMPS
                || section.tag == pocketvoxel_core::spec::tag::ATLAS
                || section.tag == pocketvoxel_core::spec::tag::GAME
                ;
            let len = if omitted { 0 } else { section.range.len as usize };
            placements.push((end, len));
            end = (end + len).div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        }
        if end > u32::MAX as usize { return Err("resident VXPK is too large"); }
        let mut words = vec![0u128; end.div_ceil(16)];
        let dst = unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr() as *mut u8, end) };
        put32(dst, 0, VXPK_MAGIC);
        put16(dst, 4, VXPK_VERSION);
        put16(dst, 6, ordered.len() as u16);
        put32(dst, 8, end as u32);
        for (i, (section, &(offset, len))) in ordered.iter().zip(&placements).enumerate() {
            let at = VXPK_HEADER_SIZE + i * VXPK_ENTRY_SIZE;
            put32(dst, at, section.tag);
            put32(dst, at + 4, offset as u32);
            put32(dst, at + 8, len as u32);
            put32(dst, at + 12, section.count);
            if len != 0 {
                self.read_exact_at(section.range.offset, &mut dst[offset..offset + len])?;
            }
        }
        Ok(ResidentBlob { words, len: end })
    }
}

impl ReadAt for PakFileReader {
    fn len(&self) -> u64 {
        self.len
    }

    fn read_exact_at(&mut self, offset: u64, out: &mut [u8]) -> Result<(), IndexError> {
        let end = offset.checked_add(out.len() as u64).ok_or("VXPK read range overflow")?;
        if end > self.len || offset > i64::MAX as u64 {
            return Err("VXPK read range is outside the file");
        }
        unsafe {
            if sys::sceIoLseek(self.fd, offset as i64, IoWhence::Set) != offset as i64 {
                return Err("VXPK seek failed");
            }
            let mut done = 0usize;
            while done < out.len() {
                let want = (out.len() - done).min(u32::MAX as usize);
                let got = sys::sceIoRead(
                    self.fd,
                    out.as_mut_ptr().add(done) as *mut c_void,
                    want as u32,
                );
                if got <= 0 {
                    return Err("VXPK short read");
                }
                done += got as usize;
            }
        }
        Ok(())
    }
}

impl Drop for PakFileReader {
    fn drop(&mut self) {
        unsafe {
            sys::sceIoClose(self.fd);
        }
    }
}

#[derive(Clone, Copy)]
struct ResidentMesh {
    request: GeometryRequest,
    vert_at: usize,
    index_at: usize,
}

/// Reusable compact backing for every mesh belonging to the currently shown
/// map slots. It is rebuilt on a map-set change, not while walking a map.
pub struct MapGeometry {
    requests: Vec<GeometryRequest>,
    meshes: Vec<ResidentMesh>,
    verts: Vec<PakVert>,
    indices: Vec<u16>,
    peak_bytes: usize,
}

impl MapGeometry {
    pub fn new() -> Self {
        Self { requests: Vec::new(), meshes: Vec::new(), verts: Vec::new(), indices: Vec::new(), peak_bytes: 0 }
    }

    /// Release all scene geometry allocations after the GE has finished.
    /// The next sync reads a fresh working set from the Memory Stick.
    pub fn unload(&mut self) {
        let peak = self.peak_bytes;
        *self = Self::new();
        self.peak_bytes = peak;
    }

    /// Evict a warm working set while reusing storage during ordinary walks.
    fn clear_retaining_capacity(&mut self) {
        self.requests.clear();
        self.meshes.clear();
        self.verts.clear();
        self.indices.clear();
    }

    /// Whether [`sync`](Self::sync) may mutate or reallocate GE-visible
    /// backing storage. The caller must finish the preceding display list
    /// before allowing that to happen.
    pub fn needs_sync(&self, set: &WorkingSet) -> bool {
        set.geometry.iter().any(|request| !self.requests.contains(request))
    }

    /// Grow the current map's geometry cache to cover the requested spans.
    /// Entries remain warm until `unload`: camera motion must not evict
    /// a chunk only to reread it from the Memory Stick on the walk back.
    pub fn sync(&mut self, file: &mut PakFileReader, index: &PakIndex, set: &WorkingSet) -> Result<bool, IndexError> {
        // Leave QuickJS a hard margin on PSP-1000. Forest's thinned current
        // view fits below this; walking back may reread chunks instead of
        // letting the warm superset permanently claim several MiB.
        const CACHE_BUDGET: usize = 1024 * 1024;
        let mut additions: Vec<_> = set.geometry.iter().copied()
            .filter(|request| !self.requests.contains(request)).collect();
        if additions.is_empty() { return Ok(false); }
        let added_bytes: usize = additions.iter().map(|r|
            r.vert_count as usize * core::mem::size_of::<PakVert>() + r.index_count as usize * 2
        ).sum();
        if self.resident_bytes().saturating_add(added_bytes) > CACHE_BUDGET {
            // A large map or a long roam reached the PSP-1000 headroom cap.
            // Fall back to the caller's current/deep set instead of growing
            // until the allocator fails. The current view is first in every
            // deep set, so it remains render-complete under pressure.
            self.clear_retaining_capacity();
            additions = set.geometry.clone();
        }
        // The threshold limits the warm superset, never the current frame.
        // If one unusually dense view itself exceeds it, load that complete
        // view and recycle again when the camera working set changes.
        let vert_total: usize = additions.iter().map(|r| r.vert_count as usize).sum();
        let index_total: usize = additions.iter().map(|r| r.index_count as usize).sum();
        self.meshes.reserve_exact(additions.len());
        self.requests.reserve_exact(additions.len());
        self.verts.reserve_exact(vert_total);
        self.indices.reserve_exact(index_total);
        for request in additions {
            let vert_at = self.verts.len();
            let index_at = self.indices.len();
            self.verts.resize(vert_at + request.vert_count as usize, PakVert {
                u: 0, v: 0, abgr: 0, x: 0, y: 0, z: 0, pad: 0,
            });
            self.indices.resize(index_at + request.index_count as usize, 0);
            let mesh = pocketvoxel_core::pak::MeshRange { vert_base: request.vert_base,
                vert_count: request.vert_count, index_base: request.index_base,
                index_count: request.index_count };
            let vr = index.vertex_range(&mesh)?;
            let ir = index.index_range(&mesh)?;
            let vb = unsafe { core::slice::from_raw_parts_mut(
                self.verts[vert_at..].as_mut_ptr() as *mut u8, vr.len as usize) };
            let ib = unsafe { core::slice::from_raw_parts_mut(
                self.indices[index_at..].as_mut_ptr() as *mut u8, ir.len as usize) };
            file.read_exact_at(vr.offset, vb)?;
            file.read_exact_at(ir.offset, ib)?;
            self.meshes.push(ResidentMesh { request, vert_at, index_at });
            self.requests.push(request);
        }
        let allocated = self.allocated_bytes();
        let new_peak = allocated > self.peak_bytes;
        self.peak_bytes = self.peak_bytes.max(allocated);
        Ok(new_peak)
    }

    pub fn resident_bytes(&self) -> usize {
        self.verts.len() * core::mem::size_of::<PakVert>()
            + self.indices.len() * core::mem::size_of::<u16>()
    }


    pub fn allocated_bytes(&self) -> usize {
        self.verts.capacity() * core::mem::size_of::<PakVert>()
            + self.indices.capacity() * core::mem::size_of::<u16>()
            + self.meshes.capacity() * core::mem::size_of::<ResidentMesh>()
            + self.requests.capacity() * core::mem::size_of::<GeometryRequest>()
    }

    pub fn peak_bytes(&self) -> usize { self.peak_bytes }
}

impl GeometrySource for MapGeometry {
    fn mesh<'a>(&'a self, mesh: &MeshDraw) -> Option<(&'a [PakVert], &'a [u16])> {
        let request = GeometryRequest { vert_base: mesh.vert_base, vert_count: mesh.vert_count,
            index_base: mesh.index_base, index_count: mesh.index_count };
        let found = self.meshes.iter().find(|entry| entry.request == request)?;
        Some((
            &self.verts[found.vert_at..found.vert_at + request.vert_count as usize],
            &self.indices[found.index_at..found.index_at + request.index_count as usize],
        ))
    }
}

#[derive(Clone, Copy)]
struct CachedAtlas {
    page: u16,
    frame: u16,
    at: usize,
    len: usize,
}

/// Exact atlas working set for the current draw list. Pages remain on the
/// Memory Stick until referenced and are replaced together on a set change.
pub struct AtlasCache {
    pages: Vec<u16>,
    entries: Vec<CachedAtlas>,
    words: Vec<u128>,
    len: usize,
    peak_bytes: usize,
}

impl AtlasCache {
    pub fn new() -> Self {
        Self { pages: Vec::new(), entries: Vec::new(), words: Vec::new(), len: 0, peak_bytes: 0 }
    }

    pub fn page_count(&self) -> usize { self.pages.len() }

    pub fn kind_count(&self, pak: &pocketvoxel_core::pak::Pak<'_>, kind: u16) -> usize {
        self.pages.iter().filter(|&&page| pak.atlases[page as usize].kind == kind).count()
    }

    /// Release every loaded map/sprite/UI/battle texture and its storage.
    /// Caller must wait for the GE before this and before the next sync.
    pub fn unload(&mut self) {
        let peak = self.peak_bytes;
        *self = Self::new();
        self.peak_bytes = peak;
    }

    fn clear_retaining_capacity(&mut self) {
        self.pages.clear();
        self.entries.clear();
        self.words.clear();
        self.len = 0;
    }

    /// Whether [`sync`](Self::sync) may mutate or reallocate GE-visible
    /// texels. See [`MapGeometry::needs_sync`].
    pub fn needs_sync(&self, set: &WorkingSet) -> bool {
        set.atlas_frames.iter().any(|request| !self.entries.iter().any(|entry|
            entry.page == request.page && entry.frame == request.frame))
    }

    pub fn sync(&mut self, file: &mut PakFileReader, index: &PakIndex, set: &WorkingSet) -> Result<bool, IndexError> {
        const CACHE_BUDGET: usize = 512 * 1024;
        if !self.needs_sync(set) { return Ok(false); }
        // Frames have already been animated and swizzled by the PC cooker.
        // Stream only the exact frames sampled by this display list.
        let mut additions: Vec<_> = set.atlas_frames.iter().copied().filter(|request|
            !self.entries.iter().any(|entry| entry.page == request.page && entry.frame == request.frame)
        ).collect();
        let added_bytes = additions.iter().try_fold(0usize, |total, request| {
            let record = index.atlases.get(request.page as usize).ok_or("atlas page out of range")?;
            if request.frame >= record.frames { return Err("atlas frame out of range"); }
            Ok::<usize, IndexError>(total.saturating_add(record.frame_len as usize))
        })?;
        if self.len.saturating_add(added_bytes) > CACHE_BUDGET {
            self.clear_retaining_capacity();
            additions = set.atlas_frames.clone();
        }
        for request in additions {
            let record = index.atlases.get(request.page as usize).ok_or("atlas page out of range")?;
            if request.frame >= record.frames { return Err("atlas frame out of range"); }
            let n = record.frame_len as usize;
            // Replace an obsolete animation frame in place. Never replace a
            // frame another draw in this same list still needs.
            let reusable = self.entries.iter().position(|entry| entry.page == request.page &&
                !set.atlas_frames.iter().any(|wanted| wanted.page == entry.page && wanted.frame == entry.frame));
            let at = reusable.map(|i| self.entries[i].at).unwrap_or(self.len);
            if reusable.is_none() {
                self.len = (at + n).div_ceil(16) * 16;
                self.words.resize(self.len / 16, 0);
            }
            let bytes = unsafe { core::slice::from_raw_parts_mut(self.words.as_mut_ptr().cast::<u8>(), self.len) };
            file.read_exact_at(record.texels.offset + request.frame as u64 * n as u64, &mut bytes[at..at + n])?;
            let entry = CachedAtlas { page: request.page, frame: request.frame, at, len: n };
            if let Some(i) = reusable { self.entries[i] = entry; } else { self.entries.push(entry); }
            if !self.pages.contains(&request.page) { self.pages.push(request.page); }
        }
        let bytes = unsafe { core::slice::from_raw_parts(self.words.as_ptr().cast::<u8>(), self.len) };
        unsafe { pocketvoxel_gu::writeback(bytes); }
        self.peak_bytes = self.peak_bytes.max(self.allocated_bytes());
        Ok(true)
    }

    pub fn allocated_bytes(&self) -> usize {
        self.words.capacity() * 16 + self.entries.capacity() * core::mem::size_of::<CachedAtlas>()
            + self.pages.capacity() * core::mem::size_of::<u16>()
    }

    pub fn peak_bytes(&self) -> usize { self.peak_bytes }
}

impl pocketvoxel_gu::AtlasSource for AtlasCache {
    fn frame<'a>(&'a self, pak: &'a pocketvoxel_core::pak::Pak<'a>, page: u16, frame: u16) -> Option<&'a [u8]> {
        let meta = pak.atlases.get(page as usize)?;
        let frame = frame % meta.frames;
        let entry = self.entries.iter().find(|entry| entry.page == page && entry.frame == frame)?;
        let frame_len = meta.frame_len as usize;
        let start = entry.at;
        let end = start + frame_len;
        if end > entry.at + entry.len || end > self.len { return None; }
        let bytes = unsafe { core::slice::from_raw_parts(self.words.as_ptr() as *const u8, self.len) };
        Some(&bytes[start..end])
    }
}
