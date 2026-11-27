// ---------- Android app UI · Launch splash (drawn in code) ----------
// The animated launch screen of the Android app. It is drawn entirely by this file - inline SVG + CSS animation - so it needs no
// animation JSON, no Lottie / animation library and no other file: nothing to download, nothing that can arrive late, nothing that
// can fail on a slow or missing connection. This file is the ONLY place that knows about the splash; the rest of the app talks to it
// through window.QR_PLATFORM.splash (created by js/platform.js).
//
//   Website (normal browser) -> this file is never requested: js/platform.js stops before it gets here.
//   Android app              -> js/platform.js injects this script at the very start of a launch (NOT through APP_SCRIPTS, which
//                               only run after DOMContentLoaded) and keeps the native splash screen on until the first frame of
//                               this splash is painted.
//
// What the person sees (about 2 seconds)
//   * the screen has the colour of the native splash (#092723, manifest.json theme_color), so the hand-over has no colour jump
//   * a soft emerald glow breathes in behind the logo; a fine gold ring and a faint eight-pointed star turn slowly around it
//   * the Quran logo is DRAWN as a thin gold line (stroke by stroke), then fills with a warm gold gradient
//   * the wordmark "Quran Bangla" rises letter by letter; a thin gold light travels under it until the app is ready
//   * the whole screen fades away, with a slight zoom, onto the app that is already painted underneath
//
// Sequence
//   1. the overlay (#qa-splash) is created with every animation PAUSED at its first state (the plain native colour)
//   2. when that first frame is on screen, the native splash is released (SplashScreen.hide, through platform.js) - nothing flickers,
//      because both show the same colour - and the animation starts when the native fade is over
//   3. the overlay leaves only when BOTH are true: the animation has played for T.minShow AND the app UI is ready
//      (QR_PLATFORM.ready / "qr:app-ready") - whichever comes last. The app UI under it is already painted by then.
//
// Only transform / opacity (composited) and the stroke of a few small paths are animated: no blur, no shadow, no layout work, so it
// stays smooth on a phone that is also busy starting the app. "Remove animations" (prefers-reduced-motion) shows the finished logo
// with one calm fade instead. Timers guarantee that the overlay can never stay on screen for good; platform.js has a last-resort
// timer of its own in case this file misbehaves.
//
// The logo and the wordmark are the traced vector outlines of the original artwork (see the two arrays below). Nothing here touches
// Firebase, storage, the network layer of the app or the app's own CSS: the overlay lives directly under <html> with an id selector
// and is removed (with its <style>) when it is done.
(function(){
  'use strict';
  var w = window, d = document, root = d.documentElement;
  var P = w.QR_PLATFORM;
  var S = P && P.splash;
  // Only in the app, only once per document, and never after platform.js has given up waiting for this script.
  if(!P || !P.isApp || !S || S.started || S.gaveUp) return;
  S.started = true;

  var FILES = S.files || {};

  // All times in ms.
  var T = {
    afterPaint: 250,   // rAF does not run while the WebView is in the background: never wait for the first frame longer than this
    nativeFade: 200,   // the native splash fades out in 180 ms (platform.js hideSplash); the animation starts after it
    minShow: 2000,     // the animation (draw, fill, wordmark) plays for this long before the overlay may leave
    still: 1100,       // the same with "remove animations": a finished logo and one calm fade
    leave: 360,        // fade-out of the overlay (also the CSS transition)
    hardCap: 14000     // the overlay is removed after this, whatever happened (platform.js reloads at 12 s if the app never starts)
  };
  var BG = '#092723';  // = manifest.json theme_color = the native splash colour

  // ---------- the artwork ----------
  // Traced outlines of the Quran Bangla logo (9 contours) and wordmark (11 letters, each outline + its counters in one path), centred on 0,0; coordinates in
  // viewBox units (logo viewBox -172 -147 344 294, wordmark viewBox -117 -19 234 38). Each wordmark entry is [outline, delay 0..1
  // from the left edge to the right edge] - the delay staggers the letters.
  var LOGO = [
    'M-102.9 -142.7l-67.1 156.6 0.4 1.1 2.8 0.7 0.8 0.7 1.1 0 0.7 0.7 1.1 0 9.3 4 1.1 0 0.7 0.7 1.1 0 2.9 1.5 1.1 0 0.7 0.7 1.1 0 9.4 4 1.1 0 0.7 0.7 2.9 0.7 1.1 1.1 0 113.7 1 0 2.6-1.5 0.7 0 0.7-0.7 0.7 0 2.2-1.4 0.7 0 0.7-0.7 0.8 0 0.7-0.8 6.5-3.2 0.7 0 0.7-0.7 0.8 0 0.7-0.8 0.7 0 0.7-0.7 0.7 0 0.8-0.7 0.7 0 0.7-0.7 5.1-2.5 0.7 0 0.7-0.8 0.7 0 0.7-0.7 0.8 0 2.1-1.4 0.8 0 0.7-0.8 0.7 0 0.7-0.7 0.7 0 0.8-0.7 5-2.5 2.2-0.7 0.7-0.8 0.7 0 0.8-0.7 0.7 0 0.7-0.7 2.2-0.7 0.7-0.8 0.7 0 0.7-0.7 4.4-1.8 0.7-0.7 0.7 0 2.2-1.4 0.7 0 3.6-2.2 0.7 0 0.7-0.7 4.4-1.8 0.7-0.8 0.7 0 0.7-0.7 0.8 0 0.7-0.7 0.7 0 0.7-0.7 2.2-0.7 0.7-0.8 0.7 0 0.8-0.7 4.3-1.8 0.7-0.7 0.7 0 2.2-1.5 0.7 0 3.6-2.1 0.8 0 0.7-0.8 4.3-1.8 0.7-0.7 0.7 0 0.8-0.7 0.7 0 0.7-0.7 0.7 0 0.8-0.7 2.1-0.8 0.7-0.7 0.8 0 0.7-0.7 4.3-1.8 0.7-0.7 2.2-0.8 0.7-0.7 0.7 0 0.8-0.7 0.7 0 0.7-0.7 0.7 0 7.3-4 2.1 0 0.7 0.7 0.8 0 4.3 2.6 0.7 0 0.7 0.7 0.8 0 0.7 0.7 0.7 0 0.7 0.7 0.8 0 0.7 0.7 0.7 0 0.7 0.8 0.7 0 0.8 0.7 0.7 0 4.3 2.5 0.7 0 0.8 0.7 0.7 0 0.7 0.8 0.7 0 0.7 0.7 0.8 0 0.7 0.7 0.7 0 0.7 0.7 0.8 0 0.7 0.7 0.7 0 5.8 3.3 0.7 0 0.7 0.7 0.7 0 0.8 0.7 0.7 0 0.7 0.8 0.7 0 0.7 0.7 0.8 0 0.7 0.7 0.7 0 5.8 3.3 0.7 0 0.7 0.7 0.8 0 0.7 0.7 0.7 0 0.7 0.7 0.7 0 0.8 0.7 0.7 0 0.7 0.8 0.7 0 5.8 3.2 0.7 0 0.7 0.7 0.8 0 0.7 0.8 0.7 0 0.7 0.7 0.8 0 0.7 0.7 0.7 0 0.7 0.7 0.7 0 0.8 0.7 0.7 0 4.3 2.6 0.7 0 0.8 0.7 0.7 0 0.7 0.7 0.7 0 0.7 0.7 0.8 0 0.7 0.8 0.7 0 0.7 0.7 0.8 0 7.2 3.9 0.7 0 0.7 0.8 0.7 0 0.8 0.7 0.7 0 0.7 0.7 0.7 0 0.8 0.7 0.7 0 30.7 15.6 0.3-0.4 0-113.7 3.3-1.8 1 0 9.4-4 1.1 0 0.7-0.7 1.1 0 2.9-1.4 1.1 0 2.5-1.5 1.1 0 9.4-4 1.1 0 0.7-0.7 1.1 0 3.6-1.4 0.3-1.1-67.1-156.6-1.4 0-0.8 0.7-1 0-0.8 0.7-1 0-0.8 0.7-1.1 0-0.7 0.7-1.1 0-5.4 2.6-18 7.2-1.8 0.3-0.7 0.8-1.8 0-7.3-15.9-3.6 0.3-0.3 0.4-6.2 0.4-0.3 0.3-3.6 0-2.6 0.8-3.6 0-1.8 0.7-1.8 0-1.4 0.7-1.8 0-1.1 0.7-1.5 0-1 0.7-1.1 0-1.1 0.8-1.1 0-1.1 0.7-3.9 1.1-0.8 0.7-3.9 1.4-3.3 2.2-2.5 1.1-9 6.5-1.5 0-2.1-1.5-0.4-0.7-1.1-0.4-7.2-5-0.7 0-3.3-2.2-0.7 0-4-2.1-3.6-1.1-2.9-1.5-1.4 0-3.6-1.4-2.2 0-1.1-0.7-1.8 0-1.8-0.7-3.6 0-2.5-0.8-3.6 0-0.4-0.3-6.1-0.4-0.4-0.4-3.6-0.3-7.2 15.9-1.8 0-0.7-0.8-1.8-0.3-23.5-9.8-1.1 0-0.7-0.7-1.1 0-0.7-0.7-1.1 0-2.5-1.4z',
    'M109.7 112.4l-0.7 0.8-1.4-1.1-0.8 0-0.7-0.8-2.2-0.7-2.1-1.4-0.7 0-0.8-0.7-0.7 0-0.7-0.8-0.7 0-5.8-3.2-5.1-2.2-0.7-0.7-0.7 0-53.1-26.7-0.7 0-2.1-1.4-0.8 0-3.9-2.2-0.8-1.1 1.8-1.1 2.9-0.7 1.8-1.1 1.1 0 4.7-2.2 1.1 0 0.7-0.7 1.1 0 4.7-2.1 2.9-0.8 1.8-1 2.9-0.8 2.9-1.4 1 0 2.6-1.5 1.1 0 2.8-1.4 4.7-1.4 1.8-1.1 1.1 0 2.9-1.5 1.1 0 2.5-1.4 1.1 0 4.7-2.2 2.9-0.7 5.8-2.5 1 0 0.8-0.7 1 0 0.8-0.8 1 0 13.4-5.4 0.7 0.7z',
    'M-110.8 112.1l0-73.7 0.7-0.7 1.1 0 0.7 0.7 1.1 0 9.4 4 1.1 0 2.5 1.5 1.1 0 2.9 1.4 1 0 0.8 0.7 1.1 0 9.3 4 1.1 0 2.5 1.4 1.1 0 9.4 4 1.1 0 0.7 0.7 1.1 0 4.7 2.2 1.1 0 0.7 0.7 1.1 0 9.4 4 1 0 2.6 1.4 1.1 0 2.8 1.5 1.1 0 0.8 0.7 1 0 8.3 3.6-0.7 1.1-2.5 1.4-0.7 0-0.8 0.8-0.7 0-0.7 0.7-0.7 0-0.7 0.7-0.8 0-0.7 0.7-0.7 0-0.7 0.7-0.8 0-5.7 3.3-0.8 0-0.7 0.7-0.7 0-0.7 0.7-0.7 0-0.8 0.8-0.7 0-0.7 0.7-0.7 0-8 3.9-0.7 0.8-2.2 0.7-0.7 0.7-0.7 0-25.6 13-0.7 0-0.8 0.7-0.7 0-0.7 0.7-9.4 4.7-2.2 0.8-7.9 4.3-1.1 0z',
    'M85.2 -17.1l-0.4 0.7-3.6 1.4-1.1 0-2.5 1.5-1.1 0-11.2 4.7-1.1 0-0.7 0.7-1.1 0-11.1 4.7-1.1 0-2.6 1.4-1 0-2.9 1.5-1.1 0-0.7 0.7-7.6 2.5-0.7 0.7-1.1 0-4.7 2.2-1.1 0-0.7 0.7-1.1 0-11.2 4.7-1.1 0-2.5 1.5-0.7-0.8 0-15.5 1.1-1.1 12.2-4.7 0.8-0.7 1 0 0.8-0.7 1 0 0.8-0.7 1.1 0 0.7-0.8 1.1 0 0.7-0.7 14.1-5.4 0.7-0.7 1.1 0 1-0.7 1.1 0 0.7-0.8 1.5 0 4.7-1.4 9.7-0.7 0.4 0.3 6.1 0.4 3.6 0.7 1.1 0.7 1.5 0 5.4 2.2z',
    'M-85.5 -17.1l3.6-2.2 1.1 0 0.7-0.7 1.1 0 1-0.8 11.6-2.1 6.1 0 0.4 0.3 6.1 0.4 10.5 2.9 0.7 0.7 1.1 0 0.7 0.7 2.5 0.8 0.8 0.7 6.5 2.5 0.7 0.7 1.1 0 2.1 1.5 1.1 0 0.7 0.7 2.6 0.7 0.7 0.7 11.2 4.7 1.1 1.5 0 14.4-0.8 1.1-2.1-0.4-2.6-1.4-1 0-9.4-4-1.1 0-0.7-0.7-1.1 0-0.7-0.7-1.1 0-4.7-2.2-1.1 0-3.6-1.4-1.8-1.1-1.1 0-0.7-0.7-1.1 0-18.8-7.6-1 0-2.6-1.5-1.1 0-9.3-3.9-1.1 0-0.7-0.8-1.1 0-0.7-0.7-2.9-0.7z',
    'M91.7 -118.2l1.4 2.2 0.7 2.5 0.8 0.7 1.4 4.3 0.7 0.8 4.7 11.9 0.7 0.7 0 1.1 2.2 3.9 2.5 6.9 0.8 0.7 0 1.1 2.1 4 0 1.1 0.7 0.7 4 10.1 0.7 0.7 0.8 2.9 1.4 2.2 0 1 0.7 0.8 4 10.1 0.7 0.7 0 1.1 0.7 0.7 4.7 11.9 2.2 4 0 1.1 0.7 0.7 1.5 4.3 1.8 3.3 0.7 2.5 0.7 0.7 0.7 2.9 2.2 4 5.4 13.3-1.8 1.5-1.1 0-13.3 5.4-1.1 0-0.7 0.7-1.1 0-0.7 0.7-1.1 0-2.9 1.5-1.1 0-0.7 0.7-1.1 0-7.6 3.2-1.1 0-2.5 1.5-3.2 0.7-2.6 1.5-1 0-9.4 3.9-1.1 0-0.7 0.7-1.1 0-2.9 1.5-1.1 0-0.7 0.7-1.1 0-9.4 4-1.1 0-0.7 0.7-1.1 0-2.8 1.4-1.1 0-0.8 0.8-1 0-9.4 3.9-1.1 0-0.7 0.8-3.3 0.7-2.5 1.4-1.1 0-9.4 4-1.1 0-0.7 0.7-1.1 0-2.8 1.5-1.1 0-0.7 0.7-1.1 0-9.4 4-1.1 0-0.7 0.7-1.1 0-2.9 1.4-1.1 0-0.7 0.7-0.7-0.7 0-20.9 0.7-0.7 2.5-1.1 1.1 0 0.7-0.7 1.1 0 0.7-0.8 1.1 0 2.9-1.4 1.1 0 0.7-0.7 1.1 0 11.2-4.7 1.1 0 0.7-0.7 1.1 0 11.2-4.7 1 0 0.8-0.8 1.1 0 2.8-1.4 1.1 0 0.7-0.7 1.1 0 11.2-4.7 1.1 0 0.7-0.7 1.1 0 4.7-2.2 1.1 0 0.7-0.7 1.1 0 9.4-4 1.1 0 2.5-1.4 1.1 0 11.1-4.7 1.1 0 0.8-0.8 1 0 2.9-1.4 1.1 0 0.7-0.7 1.1 0 5.8-2.5-3.3-8-0.7-0.7 0-1.1-0.7-0.7-0.7-2.5-0.7-0.8-1.5-4.3-1.8-3.2-0.7-2.6-2.2-3.9 0-1.1-1.4-2.2 0-1.1-0.8-0.7-3.2-8.3-0.7-0.7-0.7-2.5-0.8-0.8-0.7-2.5-4-8.3-0.7-2.5-0.7-0.7-4.7-11.6-0.7-0.7 0-1.1-2.2-4 0-1-1.4-2.2-1.8-5.1-2.2-3.9 0-1.1-2.2-4 0-1.1-0.7-0.7-2.1-5 0.3-1.8z',
    'M-92 -118.2l1 0.7 1.1 0 0.7 0.7 1.1 0 0.8 0.8 1 0 0.8 0.7 1 0 0.8 0.7 1 0 3.7 1.8 2.5 0.7 1.8 1.1 0 1.5-2.2 5-0.7 0.7 0 1.1-2.2 4-4.7 11.5-0.7 0.8 0 1-2.1 4-4 10.1-0.7 0.7-4.7 11.6-0.8 0.7-1.4 4.3-0.7 0.8-4.7 11.5-0.7 0.7 0 1.1-1.5 2.2 0 1.1-2.1 3.9-0.8 2.6-1.8 3.2-1.4 4.3-1.5 2.2 0 1.1-0.7 0.7-3.9 9.8 5.7 2.5 1.1 0 0.7 0.7 1.1 0 0.7 0.7 1.1 0 2.9 1.5 1.1 0 0.7 0.7 2.9 0.7 3.6 1.8 1.1 0 4.7 2.2 1.1 0 2.5 1.4 1.1 0 9.4 4 1 0 2.6 1.4 1.1 0 4.6 2.2 1.1 0 5.4 2.5 2.9 0.8 0.8 0.7 3.2 0.7 2.5 1.4 1.1 0 11.2 4.7 1.1 0 0.7 0.8 1.1 0 4.7 2.1 1.1 0 0.7 0.7 1.1 0 3.6 1.9 1.1 0 6.5 2.8 1 0 0.8 0.8 1 0 0.8 0.7 1 0 2.6 1.1 1.1 1 0 19.9-0.8 1.1-2.1-0.4-2.9-1.4-1.1 0-0.7-0.7-1.1 0-9.4-4-1.1 0-2.5-1.5-3.2-0.7-2.6-1.4-1.1 0-9.3-4-1.1 0-2.6-1.4-3.2-0.8-0.7-0.7-1.1 0-9.4-4-1.1 0-2.5-1.4-1.1 0-2.9-1.4-1.1 0-5.4-2.6-1 0-4.7-2.1-1.1 0-0.7-0.8-1.1 0-9.4-3.9-1.1 0-0.7-0.7-1.1 0-2.9-1.5-1.1 0-0.7-0.7-1.1 0-0.7-0.7-1.1 0-9.4-4-1 0-0.8-0.7-1.1 0-15.1-6.2-1.1 0-0.7-0.7-1.1 0-3.6-1.4-2.2-1.5 5.4-13.3 0.8-0.7 0-1.1 1.4-2.2 0.7-2.9 0.7-0.7 4-10.1 0.7-0.7 0-1.1 0.8-0.7 1.4-4.4 1.8-3.2 1.5-4.3 2.1-4 0-1.1 0.7-0.7 0.8-2.6 2.5-5 1.4-4.3 2.2-4 0-1.1 0.7-0.7 4-10.1 0.7-0.7 0-1.1 0.7-0.7 4.7-12 2.2-3.9 0-1.1 0.7-0.7 4.7-11.9 2.2-4 0-1.1 0.7-0.7 0.7-2.5z',
    'M46.9 -124l1.8 3.3 3.3 8.3 0.7 0.7 0 1.1 0.7 0.7 4.7 11.5 2.2 4 0 1.1 0.7 0.7 4.7 11.6 0.7 0.7 0 1.1 1.5 2.1 0.7 2.9 1.4 2.2 1.8 5 2.2 4 0 1.1 2.2 4 0.7 2.5 1.8 3.2 0.7 2.6 0.7 0.7 0.7 2.5 0.8 0.7 0 1.1 0.7 0.7 1.4 4-1 0.7-2.9-1-5.1-0.8-1.8-0.7-5 0-0.4-0.3-11.6 0.3-1.8 0.7-2.8 0-5.5 1.8-1.4 0-3.3 1.5-3.6 0.7-0.7 0.7-1.1 0-0.7 0.7-12.3 4.7-0.7 0.8-1.1 0-0.7 0.7-1.1 0-0.7 0.7-1.1 0-0.7 0.7-6.5 2.6-0.7-0.8 0-81.5 7.2-5.8 2.9-1.8 0.7 0 1.8-1.5 0.7 0 4-2.1 6.1-2.6 3.7-0.7 1-0.7 2.9 0 1.1-0.7z',
    'M-46.9 -124l1.4 0.4 1.1-0.4 0.4 0.4 2.1 0 1.5 0.7 2.5 0 1.1 0.7 1.1 0 6.5 2.2 9 4.7 6.8 4.7 3.7 3.6 0 80.1-0.8 1.1-19.5-8.3-0.7-0.7-2.5-0.8-2.5-1.4-1.1 0-3.3-1.4-7.9-1.8-1.4-0.8-2.9 0-2.2-0.7-11.9-0.3-0.4 0.3-5.4 0-10.1 2.5-1.8-0.3 0-1.1 1.4-2.5 0.8-2.6 0.7-0.7 0-1.1 0.7-0.7 4.7-11.5 2.2-4 0-1.1 0.7-0.7 2.5-6.5 0.7-0.7 0-1.1 0.8-0.7 0.7-2.6 2.1-3.9 0-1.1 0.8-0.7 2.5-6.5 0.7-0.8 0-1 0.7-0.8 4.7-11.5 2.2-4 0-1.1 1.4-2.1 0-1.1 0.8-0.7 3.2-8.3 0.7-0.8 0.4-1.4z'
  ];
  var WORD = [
    ['M-109.9 -15.2l-2.2 2-1 1.3-1.3 2.7-0.6 2.4-0.1 2.9-0.1 0.1 0.1 0.2 0.1 2.8 0.8 2.9 0.7 1.7 0.9 1.3 2.4 2.4 1 0.6 2.2 1 2.5 0.5 2.5 0 2.1-0.4 1.4-0.4 2.1 2.7 4.4 0-3.5-4.5 1.7-2 1.6-2.8 0.6-2.1 0.4-2.6 0-2.4-0.4-2.7-1-3-1.2-1.9-2.1-2.3-0.9-0.6-2-1-2.3-0.6-0.9-0.1-3.4 0.1-2.6 0.8zM-104.4 -13l3 0.1 1.8 0.8 0.8 0.6 0.9 0.9 0.8 1.1 0.6 1.4 0.5 2 0.1 3.7-0.2 1.6-0.5 1.8-0.6 1.2-1 1.3-2.3-2.9-4 0 0.1 0.4 3.2 4-0.3 0.4-0.5 0.1-3-0.1-1.1-0.4-1.1-0.6-0.9-0.8-1.4-1.8-0.6-1.7-0.4-1.6 0-1-0.1-0.1 0.1-3.4 0.6-2.4 0.8-1.5 1-1.2 1.2-1 1.4-0.7z', 0],
    ['M-86.8 -10.2l0 12.7 0.2 0.1 0 1.3 0.6 2.1 0.9 1.4 1.2 1.1 1.7 0.7 1.2 0.3 2.6-0.1 1.2-0.4 1.2-0.8 1.2-1.3 0.8-1.4 0.1 0.1 0 3.6 4.3 0 0-19.4-4.5 0 0 12.3-0.1 0.7-0.6 1.1-0.8 1-1.2 0.6-1 0.3-1.2 0-1.2-0.4-1.3-1.2-0.7-1.8 0-12.6z', 0.12],
    ['M-53.6 -10.4l-2.4-0.1-1.9 0.6-1.5 1.4-0.7 1.5-0.3-0.1 0-3.1-4.4 0 0 19.4 4.6 0 0-12.1 0.2-1 0.5-0.9 1.6-1.3 1.3-0.4 3 0.1z', 0.21],
    ['M-49.2 -8.5l-1.2 1.3-0.8 1.7 4.1 0.9 0.5-0.9 1.1-1 1.9-0.6 1.4 0 1.4 0.5 0.9 0.8 0.4 0.9 0 1.4-0.5 0.6-0.9 0.4-5.9 0.7-1.6 0.6-1.7 1-1.1 1.3-0.6 1.7 0.2 2.7 0.2 0.7 0.8 1.3 1.1 1 1.1 0.6 2.2 0.5 2 0 1.8-0.5 1-0.5 1.3-1.1 0.5-0.9 0.2-0.1 0.2 0.1 0 2.6 4.2 0 0-14-0.4-1.6-0.7-1.4-1.7-1.4-1.2-0.7-2.8-0.6-2.3 0-2 0.4-1.9 0.7zM-39.4 0l0 2.6-0.2 1-0.5 0.9-1.4 1.3-1.3 0.4-2 0.2-1.7-0.6-0.7-0.9-0.3-0.8 0-0.9 0.4-0.8 0.7-0.8 2-0.7 3.2-0.4 1.7-0.6z', 0.29],
    ['M-15.5 -9.2l-1.6-0.9-1.7-0.4-1.8 0-1.2 0.3-1.6 0.7-0.6 0.5-0.9 1-0.9 1.5-0.1-0.1 0-3.6-4.2 0 0 19.4 4.5 0 0-12.2 0.5-1.6 0.7-1 1.4-0.9 1-0.3 1.2 0 1.6 0.6 1.1 1.1 0.6 1.6 0 12.7 4.5 0 0-13.2-0.1-1-0.5-1.8-0.9-1.4z', 0.39],
    ['M1.2 -16.9l0 26.1 11.8 0 0.1-0.1 1 0 2.3-0.6 1.6-0.9 1-0.8 1.1-1.8 0.5-1.9-0.1-2.6-0.7-1.9-1-1.2-2-1.3-1.6-0.2-0.2-0.3 0.2-0.2 1.8-0.6 1-0.8 0.8-0.9 0.4-1 0.4-1.5 0-1.5-0.4-1.6-0.8-1.6-1.5-1.4-1.5-0.7-1.9-0.6-1-0.1zM5.9 -2.2l0.1-0.2 6 0 1.1 0.3 1 0.5 1 0.8 0.8 1.4 0.1 1.8-0.4 1.1-0.8 1-1.6 0.7-1.6 0.3-5.6 0-0.1-0.1zM5.9 -13l0.1-0.1 5.4 0 1.2 0.2 1 0.5 0.9 0.9 0.5 1.1 0 1.8-0.8 1.5-1.2 1-1 0.3-6 0.2-0.1-0.2z', 0.54],
    ['M26.2 -8.5l-1.1 1.3-0.9 1.7 4.2 0.9 0.5-0.9 1.1-1 1.9-0.6 1.3 0 1.6 0.5 0.8 0.8 0.4 0.9 0 1.4-0.5 0.6-0.9 0.4-5.8 0.7-1.7 0.6-1.7 1-1.2 1.3-0.4 1.7 0.1 2.7 0.2 0.7 0.8 1.3 1.1 1 1.1 0.6 2.1 0.5 2 0 1.9-0.5 1-0.5 1.3-1.1 0.5-0.9 0.2-0.1 0.1 0.1 0 2.6 4.3 0 0-14-0.4-1.6-0.7-1.4-1.6-1.4-1.3-0.7-2.7-0.6-2.4 0-2 0.4-1.9 0.7zM36.1 0l0 2.6-0.2 1-0.5 0.9-1.4 1.3-1.2 0.4-2 0.2-1.8-0.6-0.8-0.9-0.2-0.8 0-0.9 0.4-0.8 0.7-0.8 2-0.7 3.1-0.4 1.8-0.6z', 0.64],
    ['M60 -9.2l-1.6-0.9-1.6-0.4-1.9 0-1.1 0.3-1.7 0.7-0.6 0.5-0.9 1-0.8 1.5-0.2-0.1 0-3.6-4.2 0 0 19.4 4.5 0 0-12.2 0.5-1.6 0.7-1 1.4-0.9 1-0.3 1.3 0 1.4 0.6 1.2 1.1 0.6 1.6 0 12.7 4.5 0 0-13.2-0.1-1-0.5-1.8-0.9-1.4z', 0.75],
    ['M85 -10.2l-4.4 0 0 3.1-0.2 0.1-1.3-1.8-1.7-1.2-1.9-0.5-2.5 0.1-1.2 0.4-1.7 0.9-0.9 0.7-1.3 1.9-0.7 1.4-0.4 1.9-0.2 4.4 0.3 1.6 0.5 1.4 0.8 1.7 1.3 1.3 1.3 0.9 1.6 0.7 1.4 0.2 1.6 0 0.8-0.1 1.7-0.7 1.5-1.2 0.7-1.2 0.5 0.1-0.1 4.7-0.5 1.3-1 1-1 0.5-1.1 0.2-2.8-0.1-1.5-0.6-1.1-1-0.4-0.7-3.7 1.3 0.6 1.4 1.4 1.3 0.7 0.6 1.4 0.6 2 0.5 1 0.1 3.6-0.1 2.4-0.7 1.3-0.6 1-0.7 1.2-1.5 0.6-1.4 0.4-2.1zM75.2 -6.9l1.9 0.1 1.1 0.6 1.3 1.2 0.4 0.6 0.6 2 0.1 2.5-0.2 1.7-0.4 1.1-0.5 0.9-1 1-0.6 0.3-1.3 0.4-1.5 0-1.2-0.4-0.7-0.3-1.2-1.4-0.6-1.5-0.3-1.3 0-2.4 0.3-1.3 0.6-1.5 1.5-1.6z', 0.85],
    ['M89.9 -16.9l0 26.1 4.5 0 0-26.1z', 0.93],
    ['M100.9 -8.5l-1.1 1.3-0.9 1.7 4.1 0.9 0.5-0.9 1.1-1 1.9-0.6 1.4 0 1.5 0.5 0.8 0.8 0.4 0.9 0 1.4-0.5 0.6-0.9 0.4-5.8 0.7-1.6 0.6-1.8 1-1.1 1.3-0.5 1.7 0.1 2.7 0.3 0.7 0.7 1.3 1.1 1 1.2 0.6 2.1 0.5 2 0 1.9-0.5 1-0.5 1.2-1.1 0.5-0.9 0.3-0.1 0.1 0.1 0 2.6 4.2 0 0-14-0.3-1.6-0.8-1.4-1.6-1.4-1.3-0.7-2.7-0.6-2.4 0-2 0.4-1.9 0.7zM110.8 0l0 2.6-0.3 1-0.5 0.9-1.4 1.3-1.2 0.4-2 0.2-1.8-0.6-0.7-0.9-0.3-0.8 0-0.9 0.4-0.8 0.8-0.8 2-0.7 3.1-0.4 1.7-0.6z', 1]
  ];

  // ---------- markup ----------
  function logoSvg(){
    // the fill is ONE path made of all contours: the inner contours are holes only when they belong to the same path
    var fills = '<path d="' + LOGO.join('') + '"/>', lines = '';
    for(var i = 0; i < LOGO.length; i++) lines += '<path class="qa-sp-line" pathLength="1" style="--i:' + i + '" d="' + LOGO[i] + '"/>';
    return '<svg class="qa-sp-logo" viewBox="-172 -147 344 294" aria-hidden="true" focusable="false">' +
      '<defs><linearGradient id="qa-sp-gold" gradientUnits="userSpaceOnUse" x1="0" y1="-147" x2="0" y2="147">' +
      '<stop offset="0" stop-color="#FFF3D0"/><stop offset=".55" stop-color="#F1D78C"/><stop offset="1" stop-color="#D2AC54"/></linearGradient></defs>' +
      '<g class="qa-sp-fill">' + fills + '</g><g>' + lines + '</g></svg>';
  }
  function wordSvg(){
    var out = '';
    for(var i = 0; i < WORD.length; i++) out += '<path style="--d:' + WORD[i][1] + '" d="' + WORD[i][0] + '"/>';
    return '<svg class="qa-sp-word" viewBox="-117 -19 234 38" aria-hidden="true" focusable="false">' + out + '</svg>';
  }
  // two squares turned against each other = the eight-pointed star of Islamic geometry; and a thin ring
  var STAR = '<svg viewBox="-100 -100 200 200" aria-hidden="true" focusable="false"><g fill="none" stroke="#F2D48A" stroke-width=".6" stroke-linejoin="round">' +
    '<path d="M-70.7-70.7H70.7V70.7H-70.7Z"/><path d="M0-100L100 0 0 100-100 0Z"/></g></svg>';
  var RING = '<svg viewBox="-110 -110 220 220" aria-hidden="true" focusable="false"><circle class="qa-sp-ringline" r="104" pathLength="1" transform="rotate(-90)"/></svg>';

  var CSS =
    '#qa-splash{--m:min(46vw,208px,38vh);position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;box-sizing:border-box;margin:0;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);' +
      'display:flex;align-items:center;justify-content:center;overflow:hidden;background:' + BG + ';opacity:1;' +
      'touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;' +
      'transition:opacity ' + T.leave + 'ms cubic-bezier(.4,0,.2,1);}' +
    '#qa-splash.qa-sp-leave{opacity:0;pointer-events:none;}' +
    '#qa-splash.qa-sp-wait *{animation-play-state:paused!important;}' +
    '#qa-splash *{box-sizing:border-box;}' +
    // backdrop: both layers fade in from nothing, so the very first frame is exactly the native splash colour
    '#qa-splash .qa-sp-vignette{position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none;' +
      'background:radial-gradient(120% 90% at 50% 42%,rgba(0,0,0,0) 52%,rgba(2,14,12,.62) 100%);animation:qa-sp-in 900ms ease-out both;}' +
    '#qa-splash .qa-sp-glow{position:absolute;left:50%;top:43%;width:150vmin;height:150vmin;margin:-75vmin 0 0 -75vmin;pointer-events:none;will-change:transform,opacity;' +
      'background:radial-gradient(closest-side,rgba(30,138,112,.46),rgba(16,84,69,.22) 45%,rgba(9,39,35,0) 100%);' +
      'animation:qa-sp-in 1200ms ease-out both,qa-sp-breathe 2800ms ease-in-out 1200ms infinite alternate;}' +
    '#qa-splash .qa-sp-stage{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;' +
      'transform:translateZ(0);will-change:transform,opacity;}' +
    // the mark: logo + ring + star share one centre
    '#qa-splash .qa-sp-mark{position:relative;flex:none;width:var(--m);aspect-ratio:344/294;margin-bottom:calc(var(--m) * .22);}' +
    '#qa-splash .qa-sp-orbit{position:absolute;left:50%;top:50%;aspect-ratio:1;pointer-events:none;transform:translate(-50%,-50%);}' +
    '#qa-splash .qa-sp-orbit svg{display:block;width:100%;height:100%;overflow:visible;}' +
    '#qa-splash .qa-sp-orbit--star{width:118%;opacity:.22;animation:qa-sp-in 1600ms ease-out 300ms both;}' +
    '#qa-splash .qa-sp-orbit--star svg{animation:qa-sp-spin 70s linear infinite;}' +
    '#qa-splash .qa-sp-orbit--ring{width:128%;}' +
    '#qa-splash .qa-sp-orbit--ring svg{animation:qa-sp-spin 36s linear infinite reverse;}' +
    '#qa-splash .qa-sp-ringline{fill:none;stroke:#F2D48A;stroke-width:.9;stroke-linecap:butt;stroke-opacity:.5;stroke-dasharray:1;stroke-dashoffset:1;' +
      'animation:qa-sp-draw 1500ms cubic-bezier(.65,0,.2,1) 150ms both;}' +
    '#qa-splash .qa-sp-logo{position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;will-change:transform;' +
      'animation:qa-sp-rise 1300ms cubic-bezier(.2,.7,.2,1) 100ms both;}' +
    '#qa-splash .qa-sp-fill{fill:url(#qa-sp-gold);animation:qa-sp-in 650ms ease-out 780ms both;}' +
    '#qa-splash .qa-sp-line{fill:none;stroke:#FFE9A8;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:butt;stroke-dasharray:1;stroke-dashoffset:1;' +
      'animation:qa-sp-draw 950ms cubic-bezier(.65,0,.2,1) calc(120ms + var(--i)*40ms) both,qa-sp-linefade 700ms ease-in-out 1350ms both;}' +
    // the wordmark rises letter by letter
    '#qa-splash .qa-sp-word{display:block;width:min(56vw,236px);aspect-ratio:234/38;margin-top:clamp(12px,2.2vh,22px);overflow:visible;}' +
    '#qa-splash .qa-sp-word path{fill:#F4ECD8;transform-box:fill-box;transform-origin:50% 100%;' +
      'animation:qa-sp-word 560ms cubic-bezier(.2,.7,.2,1) calc(940ms + var(--d)*340ms) both;}' +
    // a thin gold light travels until the app is ready
    '#qa-splash .qa-sp-bar{position:relative;width:56px;height:2px;margin-top:clamp(26px,5vh,46px);border-radius:2px;overflow:hidden;' +
      'background:rgba(242,212,138,.16);animation:qa-sp-in 500ms ease-out 1500ms both;}' +
    '#qa-splash .qa-sp-bar i{position:absolute;top:0;left:0;width:40%;height:100%;border-radius:2px;' +
      'background:linear-gradient(90deg,rgba(242,212,138,0),#F2D48A,rgba(242,212,138,0));animation:qa-sp-slide 1300ms cubic-bezier(.45,0,.25,1) 1500ms infinite;}' +
    // leaving: a slight zoom while it fades
    '#qa-splash.qa-sp-leave .qa-sp-stage{opacity:0;transform:scale(1.05);transition:opacity ' + (T.leave - 60) + 'ms ease-in,transform ' + T.leave + 'ms cubic-bezier(.4,0,.2,1);}' +
    '@keyframes qa-sp-in{from{opacity:0}to{opacity:1}}' +
    '@keyframes qa-sp-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}' +
    '@keyframes qa-sp-linefade{from{stroke-opacity:1}to{stroke-opacity:.45}}' +
    '@keyframes qa-sp-rise{from{transform:scale(.93)}to{transform:scale(1)}}' +
    '@keyframes qa-sp-word{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:translateY(0)}}' +
    '@keyframes qa-sp-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
    '@keyframes qa-sp-breathe{from{transform:scale(1);opacity:1}to{transform:scale(1.08);opacity:.78}}' +
    '@keyframes qa-sp-slide{from{transform:translateX(-110%)}to{transform:translateX(280%)}}' +
    // "remove animations": the finished logo, one calm fade, nothing moving
    '#qa-splash.qa-sp-still *{animation:none!important;}' +
    '#qa-splash.qa-sp-still .qa-sp-line{stroke-dashoffset:0;stroke-opacity:.45;}' +
    '#qa-splash.qa-sp-still .qa-sp-ringline{stroke-dashoffset:0;}' +
    '#qa-splash.qa-sp-still .qa-sp-bar{opacity:0;}' +
    '#qa-splash.qa-sp-still .qa-sp-stage,#qa-splash.qa-sp-still .qa-sp-glow,#qa-splash.qa-sp-still .qa-sp-vignette{animation:qa-sp-in 500ms ease-out both!important;}';

  var el = null, styleEl = null;
  var phase = 'building';                // building -> ready -> playing -> held -> leaving -> done
  var appReady = !!P.ready, animDone = false, finished = false, nativeReleased = false, barsHeld = false, reduced = false;
  var timers = {};
  var t0 = now();
  var info = S.info = { startMs: Math.round(t0), mode: 'code' };
  S.phase = phase;                       // visible from the first moment (tests and diagnostics read it)

  function now(){ return (w.performance && w.performance.now) ? w.performance.now() : Date.now(); }
  function elapsed(){ return Math.round(now() - t0); }
  function warn(){ try{ console.warn.apply(console, ['[splash]'].concat([].slice.call(arguments))); }catch(e){} }
  function setPhase(p){ phase = p; S.phase = p; }
  function later(name, fn, ms){ clearTimeout(timers[name]); timers[name] = setTimeout(function(){ timers[name] = 0; fn(); }, ms); }
  function cancel(name){ clearTimeout(timers[name]); timers[name] = 0; }
  function cancelAll(){ Object.keys(timers).forEach(cancel); }

  // ---------- system bars ----------
  // The native bars are painted with the app colour; during the splash they take the splash colour (so the screen has no edge) and
  // the app colour is applied again when the splash leaves. app/js/native.js does not touch the bars while barsHeld is set (it
  // remembers the wanted scheme in S.pendingScheme). Same plugins and values as QRApp.native.setSystemBars; best effort.
  function plugin(name){
    try{
      var c = w.Capacitor;
      if(!c || !c.Plugins) return null;
      if(typeof c.isPluginAvailable === 'function' && !c.isPluginAvailable(name)) return null;
      return c.Plugins[name] || null;
    }catch(e){ return null; }
  }
  function call(p, fn, arg){
    try{ var r = (p && typeof p[fn] === 'function') ? p[fn](arg) : null; if(r && typeof r.catch === 'function') r.catch(function(){}); }catch(e){}
  }
  function paintBars(bg, style){   // style: 'LIGHT' = dark icons for a light surface, 'DARK' = light icons for a dark surface
    call(plugin('SystemBars'), 'setStyle', { style: style });
    call(plugin('EdgeToEdge'), 'setBackgroundColor', { color: bg });
    var st = plugin('StatusBar');
    call(st, 'setStyle', { style: style });
    call(st, 'setBackgroundColor', { color: bg });
  }
  function holdBars(){
    if(barsHeld || !P.isNative) return;
    barsHeld = S.barsHeld = true;
    paintBars(BG, 'DARK');
  }
  function restoreBars(){
    if(!barsHeld) return;
    barsHeld = S.barsHeld = false;
    var scheme = S.pendingScheme || root.getAttribute('data-qa-scheme') || 'light';
    S.pendingScheme = null;
    var N = w.QRApp && w.QRApp.native;
    if(N && typeof N.setSystemBars === 'function') N.setSystemBars(scheme);
    else paintBars(scheme === 'dark' ? '#0B1513' : '#F6F4EE', scheme === 'dark' ? 'DARK' : 'LIGHT');
  }

  // ---------- native splash ----------
  // Released exactly once, and only when something is painted on top of it (the first frame of this splash).
  function releaseNative(){
    if(nativeReleased) return;
    nativeReleased = true;
    holdBars();                       // splash-coloured bars first, so nothing flips while the native splash fades
    S.holdsNative = false;            // platform.js markReady() may release it from now on as well
    try{ if(typeof P.hideSplash === 'function') P.hideSplash(); }catch(e){}
  }

  // ---------- overlay ----------
  function build(){
    var stale = d.getElementById('qa-splash');            // never two overlays
    if(stale && stale.parentNode) stale.parentNode.removeChild(stale);
    try{ reduced = !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches); }catch(e){}
    info.reduced = reduced;
    styleEl = d.createElement('style');
    styleEl.id = 'qa-splash-style';
    styleEl.textContent = CSS;
    (d.head || root).appendChild(styleEl);
    el = d.createElement('div');
    el.id = 'qa-splash';
    el.className = 'qa-sp-wait' + (reduced ? ' qa-sp-still' : '');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Quran Bangla');
    el.innerHTML =
      '<div class="qa-sp-vignette"></div><div class="qa-sp-glow"></div>' +
      '<div class="qa-sp-stage">' +
        '<div class="qa-sp-mark">' +
          '<div class="qa-sp-orbit qa-sp-orbit--star">' + STAR + '</div>' +
          '<div class="qa-sp-orbit qa-sp-orbit--ring">' + RING + '</div>' +
          logoSvg() +
        '</div>' +
        wordSvg() +
        '<div class="qa-sp-bar"><i></i></div>' +
      '</div>';
    // Directly under <html>, not <body>: the page hides <body> until the app UI is ready (platform.js), and <html> exists
    // from the very first script on.
    root.appendChild(el);
  }

  function teardown(){
    cancelAll();
    w.removeEventListener('qr:app-ready', onAppReady);
    if(el && el.parentNode) el.parentNode.removeChild(el);
    if(styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    el = styleEl = null;
    restoreBars();
  }
  function announce(){
    try{ w.dispatchEvent(new CustomEvent('qr:splash-done', { detail: info })); }catch(e){}
  }

  // Leaves immediately (nothing, or nothing worth fading, is on screen).
  function abort(why){
    if(finished) return;
    finished = true;
    info.mode = 'skipped';
    info.reason = info.reason || String(why);
    S.holdsNative = false;
    teardown();
    setPhase('done');
    try{ if(P.ready && typeof P.hideSplash === 'function') P.hideSplash(); }catch(e){}   // otherwise markReady() releases it
    announce();
  }

  // Leaves with a fade; the app UI (already painted) shows through.
  function leave(){
    if(finished) return;
    finished = true;
    cancelAll();
    setPhase('leaving');
    info.leaveMs = elapsed();
    releaseNative();                  // no-op normally; makes sure the native splash can never outlive the overlay
    // The bars take the app colour once the overlay is mostly transparent (not at the start of the fade): the system bars cannot fade,
    // so flipping them while the dark overlay is still opaque would show as a pop at the top of the screen.
    later('bars', restoreBars, Math.round(T.leave * 0.65));
    if(!el){ restoreBars(); setPhase('done'); announce(); return; }
    var removed = false;
    function remove(){
      if(removed) return;
      removed = true;
      teardown();
      setPhase('done');
      announce();
    }
    el.addEventListener('transitionend', function(ev){ if(ev.target === el) remove(); });
    later('remove', remove, T.leave + 150);      // transitionend does not fire when animations are switched off: never rely on it alone
    el.classList.add('qa-sp-leave');
  }

  // The one rule of the whole feature: leave only when the animation is over AND the app UI is ready.
  function maybeFinish(){
    if(finished || !animDone || !appReady) return;
    leave();
  }
  function onAppReady(){ appReady = true; maybeFinish(); }

  // ---------- playing ----------
  function afterPaint(fn){
    var done = false;
    function go(){ if(done) return; done = true; fn(); }
    try{ requestAnimationFrame(function(){ requestAnimationFrame(go); }); }catch(e){}
    setTimeout(go, T.afterPaint);     // rAF does not run while the WebView is in the background: never wait for it forever
  }

  function begin(){
    if(finished || phase !== 'building') return;
    setPhase('ready');
    info.firstFrameMs = elapsed();
    releaseNative();
    later('play', play, P.isNative ? T.nativeFade : 0);
  }

  function play(){
    if(finished || phase !== 'ready') return;
    setPhase('playing');
    info.playMs = elapsed();
    if(el) el.classList.remove('qa-sp-wait');     // every animation starts together, from its first state
    later('min', over, reduced ? T.still : T.minShow);
  }

  function over(){
    if(finished || phase !== 'playing') return;
    setPhase('held');                 // the finished logo stays; the animation does not loop or replay
    animDone = true;
    info.completeMs = elapsed();
    maybeFinish();
  }

  // ---------- offline starts ----------
  // The service worker keeps this file as soon as it is active - not only when the app has been idle for a while (app/js/boot.js
  // asks again then; the worker skips what it already has). So even a very short first session is enough for the next start to
  // work without any connection. Best effort, never blocks anything.
  function keepOffline(){
    try{
      if(!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.ready.then(function(reg){
        var worker = reg && (reg.active || navigator.serviceWorker.controller);
        if(worker) worker.postMessage({ type: 'CACHE_ASSETS', urls: [FILES.script || 'app/js/splash.js'] });
      }).catch(function(){});
    }catch(e){}
  }

  // ---------- go ----------
  try{
    w.addEventListener('qr:app-ready', onAppReady);
    if(P.ready) appReady = true;                       // markReady() may have run before this file did
    build();
    keepOffline();
    later('hard', function(){
      warn('hard time limit reached, splash removed');
      abort('hard time limit');                         // removes the overlay, restores the bars
      try{ if(typeof P.hideSplash === 'function') P.hideSplash(); }catch(e){}
    }, T.hardCap);
    afterPaint(begin);
  }catch(e){
    warn('could not start:', e);
    abort('start failed: ' + (e && e.message ? e.message : e));
  }
})();
