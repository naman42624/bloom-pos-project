// Voice notes recorded in a web browser arrive as WebM/Opus, which Safari on
// iPhone cannot play. Convert them to M4A (AAC) on upload so every device can.
// Never throws: if ffmpeg is missing or the conversion fails, the original file
// is kept and its filename returned, so a voice note is never lost.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) ffmpegPath = null;
} catch (_e) {
  ffmpegPath = null;
}
if (!ffmpegPath) {
  console.warn('[audio-convert] ffmpeg binary not found; web voice notes will stay WebM and will not play on iPhone Safari. Run npm install in server/ with install scripts allowed for ffmpeg-static.');
}

const CONVERT_EXT = /^\.(webm|ogg|oga|opus|wav)$/i;

function needsConversion(filename) {
  return CONVERT_EXT.test(path.extname(filename || ''));
}

// Converts `dir/filename` to `dir/<same name>.m4a`. Resolves to the filename
// that should be stored: the new .m4a on success, the original otherwise.
function convertToM4a(dir, filename) {
  return new Promise((resolve) => {
    if (!ffmpegPath || !needsConversion(filename)) return resolve(filename);
    const input = path.join(dir, filename);
    const outName = `${path.basename(filename, path.extname(filename))}.m4a`;
    const output = path.join(dir, outName);
    execFile(
      ffmpegPath,
      ['-y', '-loglevel', 'error', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', output],
      { timeout: 30000 },
      (err) => {
        let ok = !err;
        if (ok) {
          try { ok = fs.statSync(output).size > 0; } catch (_e) { ok = false; }
        }
        if (!ok) {
          console.warn('[audio-convert] conversion failed, keeping original', filename, err ? err.message : 'empty output');
          try { fs.unlinkSync(output); } catch (_e) { /* nothing to remove */ }
          return resolve(filename);
        }
        try { fs.unlinkSync(input); } catch (_e) { /* original stays; harmless */ }
        resolve(outName);
      }
    );
  });
}

module.exports = { convertToM4a, needsConversion, ffmpegAvailable: () => !!ffmpegPath };
