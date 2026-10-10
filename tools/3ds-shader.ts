/** Check the assembled Voxel shader, since emulators tolerate incomplete PICA
 * outputs that freeze hardware. SHBIN layout follows libctru's gpu/shbin.c;
 * instruction fields follow devkitPro/picasso's picasso_assembler.cpp.
 * This validator deliberately supports only our straight-line MOV/MUL/DP4
 * program. New instruction/control-flow forms need an explicit audit.
 */
export function verifyVoxel3dsShader(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (offset: number): number => {
    if (offset % 4 || offset < 0 || offset + 4 > view.byteLength) {
      throw new Error('3DS shader: invalid SHBIN offset');
    }
    return view.getUint32(offset, true);
  };
  if (word(0) !== 0x424c5644 || word(4) !== 1) {
    throw new Error('3DS shader: expected one DVLE');
  }
  const program = 12;
  const entry = word(8);
  if (word(program) !== 0x504c5644 || word(entry) !== 0x454c5644 ||
      ((word(entry + 4) >>> 16) & 0xff) !== 0) {
    throw new Error('3DS shader: expected a vertex program');
  }
  const code = program + word(program + 8);
  const codeCount = word(program + 12);
  const descriptors = program + word(program + 16);
  const descriptorCount = word(program + 20);
  const start = word(entry + 8);
  const end = word(entry + 12);
  if (start >= end || end > codeCount) throw new Error('3DS shader: invalid entry range');
  const outputTable = entry + word(entry + 40);
  const outputs = new Map<number, number>();
  for (let i = 0; i < word(entry + 44); i++) {
    const register = word(outputTable + i * 8) >>> 16;
    if (register >= 16) throw new Error('3DS shader: invalid output register');
    outputs.set(register, 0);
  }
  if (!outputs.size) throw new Error('3DS shader: no mapped outputs');
  let ended = false;
  for (let pc = start; pc < end; pc++) {
    const instruction = word(code + pc * 4);
    const opcode = instruction >>> 26;
    if (opcode === 0x22) { ended = true; break; } // END
    if (opcode === 0x21) continue; // NOP
    if (opcode !== 0x13 && opcode !== 0x08 && opcode !== 0x02) {
      throw new Error(`3DS shader: unsupported opcode 0x${opcode.toString(16)} at ${pc}`);
    }
    const descriptor = instruction & 0x7f;
    if (descriptor >= descriptorCount) throw new Error('3DS shader: invalid operand descriptor');
    const mask = word(descriptors + descriptor * 8) & 0xf;
    const destination = (instruction >>> 21) & 0x1f;
    if (destination >= 16) continue; // temporary register
    const previous = outputs.get(destination);
    if (previous === undefined) throw new Error(`3DS shader: write to unmapped o${destination}`);
    if (previous & mask) throw new Error(`3DS shader: repeated output write to o${destination}`);
    outputs.set(destination, previous | mask);
  }
  if (!ended) throw new Error('3DS shader: no END instruction');
  for (const [register, mask] of outputs) {
    if (mask !== 0xf) {
      const missing = [...'xyzw'].filter((_, i) => !(mask & (8 >>> i))).join('');
      throw new Error(`3DS shader: o${register} is missing ${missing} output writes; this can freeze PICA200`);
    }
  }
}
