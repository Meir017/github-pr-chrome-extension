import { copyFileSync } from "fs";
import { join } from "path";

const outdir = "./dist";

async function build() {
  // Build content script
  const contentBuild = await Bun.build({
    entrypoints: ["./src/content.ts"],
    outdir,
    naming: "[name].js",
    target: "browser",
    minify: false,
  });

  // Build background service worker
  const backgroundBuild = await Bun.build({
    entrypoints: ["./src/background.ts"],
    outdir,
    naming: "[name].js",
    target: "browser",
    minify: false,
  });

  // Build popup script
  const popupBuild = await Bun.build({
    entrypoints: ["./src/popup.ts"],
    outdir,
    naming: "[name].js",
    target: "browser",
    minify: false,
  });

  // Copy static assets to dist
  const staticFiles = [
    ["manifest.json", "manifest.json"],
    ["popup.html", "popup.html"],
    ["src/styles.css", "styles.css"],
  ];

  for (const [src, dest] of staticFiles) {
    copyFileSync(src, join(outdir, dest));
  }

  // Copy icons directory
  const iconSizes = [16, 48, 128];
  const { mkdirSync, existsSync } = await import("fs");
  const iconsDir = join(outdir, "icons");
  if (!existsSync(iconsDir)) {
    mkdirSync(iconsDir, { recursive: true });
  }
  for (const size of iconSizes) {
    const src = `icons/icon${size}.png`;
    if (existsSync(src)) {
      copyFileSync(src, join(iconsDir, `icon${size}.png`));
    }
  }

  const allSuccess = contentBuild.success && backgroundBuild.success && popupBuild.success;

  if (!allSuccess) {
    console.error("Build failed:");
    for (const build of [contentBuild, backgroundBuild, popupBuild]) {
      if (!build.success) {
        for (const log of build.logs) {
          console.error(log);
        }
      }
    }
    process.exit(1);
  }

  console.log("✅ Build succeeded!");
  console.log(`   📁 Output: ${outdir}/`);
  console.log(`   📄 content.js, background.js, popup.js`);
  console.log(`   📄 manifest.json, popup.html, styles.css`);
}

build();
