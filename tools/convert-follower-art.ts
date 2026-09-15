// Convert the generated reference atlas into portable 2-bit runtime sprite data.
// Usage: bun tools/convert-follower-art.ts
import { inflateSync } from "node:zlib";
const file = Buffer.from(await Bun.file("output/imagegen/party-directions.png").arrayBuffer());
let w = 0, h = 0, channels = 0;
const parts: Buffer[] = [];
for (let p = 8; p < file.length;) {
  const n = file.readUInt32BE(p), type = file.toString("ascii", p + 4, p + 8), d = file.subarray(p + 8, p + 8 + n);
  if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); channels = d[9] === 2 ? 3 : d[9] === 6 ? 4 : 0; if (d[8] !== 8 || d[12]) throw new Error("Expected non-interlaced 8-bit PNG"); }
  if (type === "IDAT") parts.push(d);
  p += n + 12;
}
if (!channels || w % 6 || h % 4) throw new Error("Expected RGB/RGBA 6x4 atlas");
const raw = inflateSync(Buffer.concat(parts)), stride = w * channels, pixels = new Uint8Array(stride * h);
const paeth = (a: number, b: number, c: number) => { const p = a + b - c, x = Math.abs(p-a), y = Math.abs(p-b), z = Math.abs(p-c); return x <= y && x <= z ? a : y <= z ? b : c; };
for (let y = 0; y < h; y++) {
  const filter = raw[y * (stride + 1)];
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? pixels[y*stride+x-channels] : 0, b = y ? pixels[(y-1)*stride+x] : 0, c = y && x >= channels ? pixels[(y-1)*stride+x-channels] : 0;
    pixels[y*stride+x] = raw[y*(stride+1)+1+x] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a+b)/2) : filter === 4 ? paeth(a,b,c) : 0);
  }
}
const icons = ["BALL", "HELIX", "BUG", "GRASS", "SNAKE", "QUADRUPED"];
const out: Record<string, string[][]> = {};
for (let col = 0; col < 6; col++) {
  out[icons[col]] = [];
  for (let row = 0; row < 4; row++) {
    const frame: string[] = [];
    for (let y = 0; y < 16; y++) {
      let line = "";
      for (let x = 0; x < 16; x++) {
        const sx = Math.floor((col + (x+.5)/16)*w/6), sy = Math.floor((row+(y+.5)/16)*h/4), i=(sy*w+sx)*channels;
        const [r,g,b] = pixels.subarray(i,i+3);
        line += r > g + 60 && b > g + 60 ? "." : String(3-Math.round((r+g+b)/3/85));
      }
      frame.push(line);
    }
    out[icons[col]].push(frame);
  }
}
await Bun.write("voxelmon/cook/follower-directions.json", JSON.stringify(out, null, 2)+"\n");
