import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { verifyVoxel3dsShader } from '../tools/3ds-shader.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/3ds/${name}.shbin`, import.meta.url));

test('assembled Voxel shader completes every mapped output exactly once', () => {
  expect(() => verifyVoxel3dsShader(fixture('complete-output'))).not.toThrow();
});

test('rejects the assembled shader whose first frame wedged physical PICA200', () => {
  expect(() => verifyVoxel3dsShader(fixture('incomplete-output'))).toThrow('o1 is missing zw output writes');
});

test('rejects repeated output writes even when all components are eventually written', () => {
  const shader = fixture('complete-output');
  const code = 12 + shader.readUInt32LE(20);
  // Redirect the first temporary xyz move to o0. The subsequent DP4s would
  // complete the position, but hardware cannot accept the duplicate writes.
  shader.writeUInt32LE(shader.readUInt32LE(code) & ~(0x1f << 21), code);
  expect(() => verifyVoxel3dsShader(shader)).toThrow('repeated output write');
});

test('requires an explicit audit when the shader gains control flow', () => {
  const shader = fixture('complete-output');
  const code = 12 + shader.readUInt32LE(20);
  shader.writeUInt32LE((0x24 << 26) >>> 0, code); // CALL
  expect(() => verifyVoxel3dsShader(shader)).toThrow('unsupported opcode');
});

test('rejects a truncated shader binary', () => {
  expect(() => verifyVoxel3dsShader(fixture('complete-output').subarray(0, 20))).toThrow();
});
