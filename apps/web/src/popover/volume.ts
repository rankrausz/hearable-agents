// Ramps the shell's overall output fader; must not alter scene parameters or step audible gain.
import { gainToDb, getDestination, now } from "tone";
export function setShellVolume(volume: number, at = now()): void {
  const parameter = getDestination().volume;
  parameter.cancelAndHoldAtTime(at);
  parameter.linearRampTo(gainToDb(Math.max(0, Math.min(1, volume))), 1, at);
}
