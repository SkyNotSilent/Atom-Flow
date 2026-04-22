/**
 * Avatar upload logic tests — no server or database needed.
 * Tests sharp compression, size-check logic, and base64 data URL generation.
 *
 * Run: npx tsx tests/avatar.test.ts
 */

import sharp from "sharp";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB — matches server.ts

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function main() {
  // -------------------------------------------------------
  // Test 1: sharp is installed and can resize an image
  // -------------------------------------------------------
  console.log("\n[Test 1] sharp can create and resize an image");
  const original = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg()
    .toBuffer();

  const resized = await sharp(original).resize(128, 128).jpeg().toBuffer();

  assert(original.length > 0, "original buffer is non-empty");
  assert(resized.length > 0, "resized buffer is non-empty");
  assert(resized.length < original.length, `resized (${resized.length}B) < original (${original.length}B)`);

  // -------------------------------------------------------
  // Test 2: Large image (> 2MB) is compressed below 2MB
  // -------------------------------------------------------
  console.log("\n[Test 2] Large image (> 2MB) compressed to < 2MB");

  // Create a large noisy image to exceed 2MB
  const bigWidth = 2048;
  const bigHeight = 2048;
  const rawPixels = Buffer.alloc(bigWidth * bigHeight * 3);
  for (let i = 0; i < rawPixels.length; i++) {
    rawPixels[i] = Math.floor(Math.random() * 256);
  }

  const bigBuffer = await sharp(rawPixels, {
    raw: { width: bigWidth, height: bigHeight, channels: 3 },
  })
    .png() // PNG of random noise is large
    .toBuffer();

  assert(bigBuffer.length > AVATAR_MAX_BYTES, `big image is > 2MB (${(bigBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  // Apply the same compression logic as server.ts
  const compressed = await sharp(bigBuffer)
    .resize(256, 256, { fit: "cover" })
    .jpeg({ quality: 80 })
    .toBuffer();

  assert(compressed.length < AVATAR_MAX_BYTES, `compressed is < 2MB (${(compressed.length / 1024).toFixed(1)} KB)`);
  assert(compressed.length > 0, "compressed buffer is non-empty");

  // -------------------------------------------------------
  // Test 3: Small image (< 2MB) would NOT be compressed
  // -------------------------------------------------------
  console.log("\n[Test 3] Small image (< 2MB) skips compression");

  const smallBuffer = await sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 0, g: 128, b: 255 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

  assert(smallBuffer.length < AVATAR_MAX_BYTES, `small image is < 2MB (${smallBuffer.length}B)`);

  const shouldCompress = smallBuffer.length > AVATAR_MAX_BYTES;
  assert(shouldCompress === false, "size check correctly says: do NOT compress");

  // -------------------------------------------------------
  // Test 4: base64 data URL format is correct
  // -------------------------------------------------------
  console.log("\n[Test 4] base64 data URL generation");

  // Case A: JPEG mimetype
  const jpegMime = "image/jpeg";
  const jpegDataUrl = `data:${jpegMime};base64,${smallBuffer.toString("base64")}`;
  assert(jpegDataUrl.startsWith("data:image/jpeg;base64,"), "JPEG data URL has correct prefix");
  assert(jpegDataUrl.length > 30, "JPEG data URL has non-trivial content");

  // Verify the base64 portion is valid
  const b64Part = jpegDataUrl.split(",")[1];
  const decoded = Buffer.from(b64Part, "base64");
  assert(decoded.length === smallBuffer.length, "round-trip decode matches original buffer length");

  // Case B: PNG mimetype
  const pngBuffer = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const pngDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  assert(pngDataUrl.startsWith("data:image/png;base64,"), "PNG data URL has correct prefix");

  // Case C: After compression, mimetype should change to image/jpeg
  let mimetype = "image/png";
  let buf = bigBuffer;
  if (buf.length > AVATAR_MAX_BYTES) {
    buf = await sharp(buf).resize(256, 256, { fit: "cover" }).jpeg({ quality: 80 }).toBuffer();
    mimetype = "image/jpeg";
  }
  const compressedDataUrl = `data:${mimetype};base64,${buf.toString("base64")}`;
  assert(compressedDataUrl.startsWith("data:image/jpeg;base64,"), "compressed data URL uses JPEG mimetype");

  // -------------------------------------------------------
  // Summary
  // -------------------------------------------------------
  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
