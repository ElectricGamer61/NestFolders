"use strict";
/*
 * Renders the NestFolders icon SVGs to the transparent PNGs the manifest ships.
 *   node assets/icon/render.js [--chrome <path>]
 * Uses headless Chrome's --screenshot with a transparent default background, one process per
 * size, so each PNG is a true render at its own size rather than a downscale of a big one.
 * The 16px output comes from the hand-hinted 16px SVG; the rest from the master SVG.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findChrome } = require("../../test/chromium.js");

const HERE = __dirname;
const OUT_DIR = path.join(HERE, "..", "..", "App");
const SIZES = [
    { size: 16, svg: "nestfolders-icon-16.svg" },
    { size: 32, svg: "nestfolders-icon.svg" },
    { size: 48, svg: "nestfolders-icon.svg" },
    { size: 64, svg: "nestfolders-icon.svg" },
    { size: 128, svg: "nestfolders-icon.svg" },
];

const chrome = findChrome();
if (!chrome) {
    console.error("No Chrome/Chromium found; set CHROME_PATH or pass --chrome <path>.");
    process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nf-icon-"));
for (const { size, svg } of SIZES) {
    const markup = fs.readFileSync(path.join(HERE, svg), "utf8");
    const page = path.join(tmp, `page-${size}.html`);
    fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;background:transparent}` +
        `svg{display:block;width:${size}px;height:${size}px}</style>${markup}`);
    const out = path.join(tmp, `icon${size}.png`);
    execFileSync(chrome, [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        `--window-size=${size},${size}`,
        `--screenshot=${out}`,
        `file://${page}`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    fs.copyFileSync(out, path.join(OUT_DIR, `icon${size}.png`));
    console.log(`wrote App/icon${size}.png`);
}
fs.rmSync(tmp, { recursive: true, force: true });
