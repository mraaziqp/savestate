// LiveArea artwork for the Vita app from the SaveState icon. The Vita wants
// 8-bit indexed PNGs: icon0 128x128, bg 840x500, startup 280x158.
// node vita/make-art.mjs   (from the repo root; needs sharp)
import sharp from "sharp";
import { mkdirSync } from "node:fs";
const logo = "public/pwa-512x512.png";
const out = "vita/sce_sys";
mkdirSync(`${out}/livearea/contents`, { recursive: true });
const pal = (img) => img.png({ palette: true, colours: 256, dither: 0.5 });
const bgSvg = (w, h, title, sub) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><radialGradient id="g" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#16203b"/><stop offset="1" stop-color="#07080f"/></radialGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  ${title ? `<text x="${w / 2}" y="${h * 0.8}" font-family="Segoe UI, Arial" font-weight="800" font-size="${Math.round(h * 0.11)}" fill="#e8ecff" text-anchor="middle">${title}</text>` : ""}
  ${sub ? `<text x="${w / 2}" y="${h * 0.9}" font-family="Segoe UI, Arial" font-size="${Math.round(h * 0.05)}" fill="#22d3ee" text-anchor="middle">${sub}</text>` : ""}
</svg>`);

await pal(sharp(logo).resize(128, 128)).toFile(`${out}/icon0.png`);
const bgLogo = await sharp(logo).resize(260, 260).toBuffer();
await pal(sharp(bgSvg(840, 500, "SaveState", "Your games, from your SaveState host")).composite([{ input: bgLogo, top: 60, left: 290 }])).toFile(`${out}/livearea/contents/bg.png`);
const startLogo = await sharp(logo).resize(100, 100).toBuffer();
await pal(sharp(bgSvg(280, 158, "", "")).composite([{ input: startLogo, top: 12, left: 16 }, {
  input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="158"><text x="0" y="72" font-family="Segoe UI, Arial" font-weight="800" font-size="30" fill="#e8ecff">Start</text></svg>`), top: 0, left: 130,
}])).toFile(`${out}/livearea/contents/startup.png`);
console.log("art written");
