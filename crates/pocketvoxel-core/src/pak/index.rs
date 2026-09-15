//! Read-only VXPK catalog for hosts that cannot keep the payload resident.
//!
//! Unlike [`super::read`], this parser reads only fixed-size metadata. Bulk
//! vertex, index, atlas, GAME, and AUDI payloads remain in the source and are
//! represented by validated file ranges.

use alloc::vec;
use alloc::vec::Vec;

use super::{Chunk, MapDir, MeshRange, Meta, Stamp};
use crate::spec::{self, MESH_KINDS, VERTEX_STRIDE, VXPK_ALIGN, VXPK_CHUNK_RECORD_SIZE,
    VXPK_ENTRY_SIZE, VXPK_HEADER_SIZE, VXPK_MAGIC, VXPK_VERSION};

pub type IndexError = &'static str;

/// Bounded positional reader. Implementations must fill `out` completely or
/// return an error; callers never accept a short read as valid content.
pub trait ReadAt {
    fn len(&self) -> u64;
    fn read_exact_at(&mut self, offset: u64, out: &mut [u8]) -> Result<(), IndexError>;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FileRange {
    pub offset: u64,
    pub len: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Section {
    pub tag: u32,
    pub range: FileRange,
    pub count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AtlasRecord {
    pub w: u16,
    pub h: u16,
    pub kind: u16,
    pub frames: u16,
    pub frame_len: u32,
    pub texels: FileRange,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolRanges {
    pub vertices: FileRange,
    pub indices: FileRange,
}

/// Small resident catalog for a file-backed VXPK.
#[derive(Debug)]
pub struct PakIndex {
    pub file_len: u64,
    pub meta: Meta,
    pub sections: [Section; 9],
    pub maps: Vec<MapDir>,
    pub chunks: Vec<Chunk>,
    pub stamp_maps: Vec<MapDir>,
    pub stamps: Vec<Stamp>,
    pub atlases: Vec<AtlasRecord>,
    pub pools: PoolRanges,
    pub game: FileRange,
    pub audio: FileRange,
}

impl PakIndex {
    pub fn find_map(&self, map_id: u32) -> Option<&MapDir> {
        self.maps.iter().find(|m| m.map_id == map_id)
    }

    pub fn chunks_of(&self, dir: &MapDir) -> &[Chunk] {
        &self.chunks[dir.first as usize..(dir.first + dir.count) as usize]
    }

    /// Absolute source range for one mesh's vertices.
    pub fn vertex_range(&self, mesh: &MeshRange) -> Result<FileRange, IndexError> {
        subrange(self.pools.vertices, mesh.vert_base as u64 * VERTEX_STRIDE as u64,
            mesh.vert_count as u64 * VERTEX_STRIDE as u64, "vertex mesh range out of bounds")
    }

    /// Absolute source range for one mesh's indices.
    pub fn index_range(&self, mesh: &MeshRange) -> Result<FileRange, IndexError> {
        subrange(self.pools.indices, mesh.index_base as u64 * 2,
            mesh.index_count as u64 * 2, "index mesh range out of bounds")
    }
}

const TAGS: [u32; 9] = [
    spec::tag::META, spec::tag::GAME, spec::tag::CHUNKS, spec::tag::PALETTE,
    spec::tag::CHARMAP, spec::tag::STAMPS, spec::tag::ATLAS, spec::tag::AUDIO,
    spec::tag::COLOR,
];

fn le16(b: &[u8], o: usize) -> u16 { u16::from_le_bytes([b[o], b[o + 1]]) }
fn lei16(b: &[u8], o: usize) -> i16 { i16::from_le_bytes([b[o], b[o + 1]]) }
fn le32(b: &[u8], o: usize) -> u32 { u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) }

fn checked_range(offset: u64, len: u64, limit: u64, err: IndexError) -> Result<FileRange, IndexError> {
    let end = offset.checked_add(len).ok_or(err)?;
    if end > limit || len > u32::MAX as u64 { return Err(err); }
    Ok(FileRange { offset, len: len as u32 })
}

fn subrange(base: FileRange, rel: u64, len: u64, err: IndexError) -> Result<FileRange, IndexError> {
    if rel.checked_add(len).ok_or(err)? > base.len as u64 { return Err(err); }
    checked_range(base.offset.checked_add(rel).ok_or(err)?, len,
        base.offset + base.len as u64, err)
}

fn read_vec<R: ReadAt>(source: &mut R, range: FileRange) -> Result<Vec<u8>, IndexError> {
    let mut out = vec![0; range.len as usize];
    source.read_exact_at(range.offset, &mut out)?;
    Ok(out)
}

fn section<'a>(sections: &'a [Section; 9], tag: u32) -> &'a Section {
    sections.iter().find(|s| s.tag == tag).expect("required section indexed")
}

fn parse_dirs(bytes: &[u8], at: &mut usize, count: usize, total: u32) -> Result<Vec<MapDir>, IndexError> {
    let need = count.checked_mul(12).and_then(|n| at.checked_add(n)).ok_or("directory overflow")?;
    if need > bytes.len() { return Err("directory truncated"); }
    let mut out = Vec::with_capacity(count);
    let mut expected = 0u32;
    for _ in 0..count {
        let map_id = le32(bytes, *at);
        let first = le32(bytes, *at + 4);
        let n = le32(bytes, *at + 8);
        *at += 12;
        if first != expected || first.checked_add(n).ok_or("directory range overflow")? > total {
            return Err("directory records are not contiguous");
        }
        if out.iter().any(|m: &MapDir| m.map_id == map_id) { return Err("duplicate map id"); }
        expected += n;
        out.push(MapDir { map_id, first, count: n });
    }
    if expected != total { return Err("directory does not cover all records"); }
    Ok(out)
}

fn parse_mesh(bytes: &[u8], at: usize, pools: &PoolRanges) -> Result<MeshRange, IndexError> {
    let mesh = MeshRange {
        vert_base: le32(bytes, at), vert_count: le16(bytes, at + 4),
        index_count: le16(bytes, at + 6), index_base: le32(bytes, at + 8),
    };
    if mesh.index_count % 3 != 0 { return Err("mesh index count is not triangular"); }
    subrange(pools.vertices, mesh.vert_base as u64 * VERTEX_STRIDE as u64,
        mesh.vert_count as u64 * VERTEX_STRIDE as u64, "vertex mesh range out of bounds")?;
    subrange(pools.indices, mesh.index_base as u64 * 2, mesh.index_count as u64 * 2,
        "index mesh range out of bounds")?;
    Ok(mesh)
}

/// Parse and validate the random-access metadata of a VXPK without loading
/// any bulk section into one resident allocation.
pub fn read_index<R: ReadAt>(source: &mut R) -> Result<PakIndex, IndexError> {
    let file_len = source.len();
    let mut head = [0u8; VXPK_HEADER_SIZE + 9 * VXPK_ENTRY_SIZE];
    if file_len < head.len() as u64 { return Err("VXPK header truncated"); }
    source.read_exact_at(0, &mut head)?;
    if le32(&head, 0) != VXPK_MAGIC { return Err("not a VXPK blob (bad magic)"); }
    if le16(&head, 4) != VXPK_VERSION { return Err("unsupported VXPK version"); }
    if le16(&head, 6) != 9 { return Err("wrong section count"); }
    if le32(&head, 8) as u64 != file_len || le32(&head, 12) != 0 {
        return Err("header length or reserved word is invalid");
    }
    let mut expected = TAGS;
    expected.sort_unstable();
    let empty = Section { tag: 0, range: FileRange { offset: 0, len: 0 }, count: 0 };
    let mut sections = [empty; 9];
    let mut previous_end = head.len() as u64;
    for (i, want) in expected.into_iter().enumerate() {
        let at = VXPK_HEADER_SIZE + i * VXPK_ENTRY_SIZE;
        let tag = le32(&head, at);
        if tag != want { return Err("section table is missing or unsorted"); }
        let off = le32(&head, at + 4) as u64;
        let len = le32(&head, at + 8) as u64;
        if off % VXPK_ALIGN as u64 != 0 || off < previous_end { return Err("section is misaligned or overlaps"); }
        let range = checked_range(off, len, file_len, "section range out of file")?;
        previous_end = off + len;
        let slot = TAGS.iter().position(|t| *t == tag).unwrap();
        sections[slot] = Section { tag, range, count: le32(&head, at + 12) };
    }

    let meta_section = section(&sections, spec::tag::META);
    if meta_section.range.len != spec::VXPK_META_SIZE as u32 || meta_section.count != 1 {
        return Err("META shape is invalid");
    }
    let m = read_vec(source, meta_section.range)?;
    let meta = Meta { map_count: le32(&m, 0), atlas_count: le32(&m, 4),
        palette_count: le32(&m, 8), stamp_count: le32(&m, 12), glyph_count: le32(&m, 16),
        emote_page: le32(&m, 20), view_w: le32(&m, 24), view_h: le32(&m, 28), flags: le32(&m, 32) };
    if le32(&m, 36) != 0 || meta.view_w != spec::VIEW_W as u32 || meta.view_h != spec::VIEW_H as u32 {
        return Err("META viewport or reserved word is invalid");
    }

    let chnk_section = section(&sections, spec::tag::CHUNKS);
    let prefix_len = 32u64 + meta.map_count as u64 * 12;
    let prefix_range = subrange(chnk_section.range, 0, prefix_len, "CHNK header truncated")?;
    let prefix = read_vec(source, prefix_range)?;
    let map_count = le16(&prefix, 0) as usize;
    let chunk_total = le32(&prefix, 4);
    if le16(&prefix, 2) != 0 || map_count as u32 != meta.map_count || chnk_section.count != meta.map_count {
        return Err("CHNK map count is invalid");
    }
    let vertices = subrange(chnk_section.range, le32(&prefix, 8) as u64, le32(&prefix, 12) as u64,
        "CHNK vertex pool out of range")?;
    let indices = subrange(chnk_section.range, le32(&prefix, 16) as u64, le32(&prefix, 20) as u64,
        "CHNK index pool out of range")?;
    if vertices.offset % VXPK_ALIGN as u64 != 0 || indices.offset % VXPK_ALIGN as u64 != 0
        || vertices.len as usize % VERTEX_STRIDE != 0 || indices.len % 2 != 0
        || le32(&prefix, 24) != 0 || le32(&prefix, 28) != 0 { return Err("CHNK pools are malformed"); }
    let pools = PoolRanges { vertices, indices };
    let mut at = 32;
    let maps = parse_dirs(&prefix, &mut at, map_count, chunk_total)?;
    let records_rel = prefix_len;
    let records_len = chunk_total as u64 * VXPK_CHUNK_RECORD_SIZE as u64;
    let records = read_vec(source, subrange(chnk_section.range, records_rel, records_len,
        "CHNK records truncated")?)?;
    let mut chunks = Vec::with_capacity(chunk_total as usize);
    for i in 0..chunk_total as usize {
        let q = i * VXPK_CHUNK_RECORD_SIZE;
        let aabb_min = [lei16(&records, q + 4), lei16(&records, q + 6), lei16(&records, q + 8)];
        let aabb_max = [lei16(&records, q + 10), lei16(&records, q + 12), lei16(&records, q + 14)];
        if aabb_min.iter().zip(aabb_max).any(|(a, b)| a > &b) { return Err("chunk AABB is inverted"); }
        let bake_page = le16(&records, q + 16);
        let flags = le16(&records, q + 18);
        if flags & !spec::VXPK_CHUNK_FLAG_BORDER_RING != 0
            || (bake_page != spec::BAKE_PAGE_NONE && bake_page as u32 >= meta.atlas_count) {
            return Err("chunk flags or bake page are invalid");
        }
        let mut meshes = [MeshRange::default(); MESH_KINDS];
        for (k, mesh) in meshes.iter_mut().enumerate() { *mesh = parse_mesh(&records, q + 20 + k * 12, &pools)?; }
        chunks.push(Chunk { cx: lei16(&records, q), cy: lei16(&records, q + 2),
            aabb_min, aabb_max, bake_page, flags, meshes });
    }

    let atlas_section = section(&sections, spec::tag::ATLAS);
    let atlas_header_len = 2u64 + meta.atlas_count as u64 * 16;
    let atlas_bytes = read_vec(source, subrange(atlas_section.range, 0, atlas_header_len,
        "ATLS headers truncated")?)?;
    if le16(&atlas_bytes, 0) as u32 != meta.atlas_count || atlas_section.count != meta.atlas_count {
        return Err("ATLS count is invalid");
    }
    let mut atlases = Vec::with_capacity(meta.atlas_count as usize);
    for i in 0..meta.atlas_count as usize {
        let q = 2 + i * 16;
        let (w, h, kind, frames) = (le16(&atlas_bytes, q), le16(&atlas_bytes, q + 2),
            le16(&atlas_bytes, q + 4), le16(&atlas_bytes, q + 6));
        let frame_len = le32(&atlas_bytes, q + 12);
        if w == 0 || h == 0 || frames == 0 || kind > spec::atlas_kind::PICS { return Err("ATLS page header is invalid"); }
        let texels = subrange(atlas_section.range, le32(&atlas_bytes, q + 8) as u64,
            frame_len as u64 * frames as u64, "ATLS texels out of range")?;
        if texels.offset % VXPK_ALIGN as u64 != 0 { return Err("ATLS texels are misaligned"); }
        atlases.push(AtlasRecord { w, h, kind, frames, frame_len, texels });
    }

    let stmp_section = section(&sections, spec::tag::STAMPS);
    let stmp = read_vec(source, stmp_section.range)?;
    if stmp.len() < 8 { return Err("STMP header truncated"); }
    let stamp_map_count = le16(&stmp, 0) as usize;
    let stamp_total = le32(&stmp, 4);
    if le16(&stmp, 2) != 0 || stamp_total != meta.stamp_count || stmp_section.count != stamp_map_count as u32 {
        return Err("STMP counts are invalid");
    }
    let mut at = 8;
    let stamp_maps = parse_dirs(&stmp, &mut at, stamp_map_count, stamp_total)?;
    let mut stamps = Vec::with_capacity(stamp_total as usize);
    for _ in 0..stamp_total {
        if at + 16 > stmp.len() { return Err("STMP records truncated"); }
        let mesh = parse_mesh(&stmp, at + 4, &pools)?;
        stamps.push(Stamp { cx: lei16(&stmp, at), cy: lei16(&stmp, at + 2), mesh });
        at += 16;
    }

    let game = section(&sections, spec::tag::GAME).range;
    let audio = section(&sections, spec::tag::AUDIO).range;
    Ok(PakIndex { file_len, meta, sections, maps, chunks, stamp_maps, stamps, atlases, pools, game, audio })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pak::builder::{ChunkDef, PakBuilder};
    use crate::pak::PakVert;

    struct SliceSource(Vec<u8>);
    impl ReadAt for SliceSource {
        fn len(&self) -> u64 { self.0.len() as u64 }
        fn read_exact_at(&mut self, offset: u64, out: &mut [u8]) -> Result<(), IndexError> {
            let src = self.0.get(offset as usize..offset as usize + out.len()).ok_or("short read")?;
            out.copy_from_slice(src); Ok(())
        }
    }

    fn fixture() -> Vec<u8> {
        let mut b = PakBuilder::new();
        b.palette([0; 256]);
        b.atlas_linear(16, 16, spec::atlas_kind::TERRAIN, &[&[0; 256]]);
        let verts = [PakVert { u: 0, v: 0, abgr: 0, x: 0, y: 0, z: 0, pad: 0 }; 3];
        let mesh = b.mesh(&verts, &[0, 1, 2]);
        let mut meshes = [MeshRange::default(); MESH_KINDS];
        meshes[0] = mesh;
        b.map(7, &[ChunkDef { cx: 0, cy: 0, aabb_min: [0; 3], aabb_max: [1; 3],
            bake_page: spec::BAKE_PAGE_NONE, flags: 0, meshes }]);
        b.game(b"{}");
        b.finish()
    }

    #[test]
    fn indexes_bulk_ranges_without_owning_them() {
        let blob = fixture();
        let mut src = SliceSource(blob);
        let idx = read_index(&mut src).unwrap();
        assert_eq!(idx.maps[0].map_id, 7);
        assert_eq!(idx.chunks.len(), 1);
        assert_eq!(idx.vertex_range(&idx.chunks[0].meshes[0]).unwrap().len, 48);
        assert_eq!(idx.index_range(&idx.chunks[0].meshes[0]).unwrap().len, 6);
        assert_eq!(idx.game.len, 2);
    }

    #[test]
    fn rejects_truncated_source_before_bulk_reads() {
        let mut blob = fixture();
        blob.pop();
        let mut src = SliceSource(blob);
        assert!(matches!(read_index(&mut src), Err("header length or reserved word is invalid")));
    }
}
