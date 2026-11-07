// Fixed native focus scripts; session values travel only as argv, never executable source or keystrokes.
export const hostApplicationScript = `
ObjC.import('AppKit');
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (!app || !ObjC.unwrap(app) || app.isTerminated || Number(app.activationPolicy) === 2) return '{}';
  if (ObjC.unwrap(app.executableURL.path) !== argv[1]) return '{}';
  return JSON.stringify({
    name: ObjC.unwrap(app.localizedName),
    bundleId: ObjC.unwrap(app.bundleIdentifier),
    path: ObjC.unwrap(app.bundleURL.path),
    activated: Boolean(app.activateWithOptions(3))
  });
}`;

export const terminalFocusScript = `
on run argv
  set targetTTY to item 1 of argv
  tell application id "com.apple.Terminal"
    if not running then return "missing"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTTY then
          set selected of t to true
          set miniaturized of w to false
          set index of w to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

export const itermFocusScript = `
on run argv
  set targetTTY to item 1 of argv
  set targetID to item 2 of argv
  tell application id "com.googlecode.iterm2"
    if not running then return "missing"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (targetTTY is not "" and tty of s is targetTTY) or (targetTTY is "" and targetID is not "" and id of s is targetID) then
            select s
            select t
            set miniaturized of w to false
            select w
            activate
            return "focused"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;
