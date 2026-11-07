// Bundled acoustic piano recordings; never fetch remote content during playback.
import c3 from "../scenes/clearing/assets/piano/C3.wav?url";
import c4 from "../scenes/clearing/assets/piano/C4.wav?url";
import c5 from "../scenes/clearing/assets/piano/C5.wav?url";
import c6 from "../scenes/clearing/assets/piano/C6.wav?url";
import fs3 from "../scenes/clearing/assets/piano/Fs3.wav?url";
import fs4 from "../scenes/clearing/assets/piano/Fs4.wav?url";
import fs5 from "../scenes/clearing/assets/piano/Fs5.wav?url";
export const PIANO_ASSET_URLS: Readonly<Record<number, string>> = {
  48: c3,
  54: fs3,
  60: c4,
  66: fs4,
  72: c5,
  78: fs5,
  84: c6,
};
