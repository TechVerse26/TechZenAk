// ---------- Android app UI · Home screen widgets ----------
//
// The five widgets (next prayer, ayah of the day, continue reading, Quran shortcuts, daily goal and reminders) are drawn by the
// Android launcher from the native layer (Kotlin, android-build/native/widgets). This screen lets the person ADD them:
//   * Android 8+ with a launcher that supports it: one tap on "Add" opens the system dialog "Add widget to the home screen?"
//     (requestPinWidget), the person confirms, and the widget appears - nothing else to do.
//   * Anywhere that is not possible (older Android, a launcher without that feature, or the request is refused) the screen shows
//     the manual way in words: touch and hold an empty spot on the home screen -> Widgets -> Quran Bangla.
// It exists only where the native layer exists (the website never shows it). The rules are plain functions in
// QRApp.widgets.core, tested without a screen: tests/widgets-ui.test.js.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  if(!QRApp) return;
  var UI = QRApp.ui, Nav = QRApp.nav, h = QRApp.h, T = QRApp.T;

  // the keys are the ones of js/quran-native.js (WIDGET_KEYS) and of WidgetUpdater.kt - a test keeps the three in step
  var CATALOG = [
    { key: 'next_prayer', icon: 'clock', title: ['পরবর্তী নামাজ', 'Next prayer'], sub: ['পরবর্তী নামাজের সময় ও সরাসরি কাউন্টডাউন', 'The next prayer time with a live countdown'] },
    { key: 'daily_ayah', icon: 'sparkle', title: ['আজকের আয়াত', 'Ayah of the day'], sub: ['প্রতিদিনের একটি আয়াত অনুবাদসহ', 'A daily ayah with its translation'] },
    { key: 'continue_reading', icon: 'book', title: ['পড়া চালিয়ে যান', 'Continue reading'], sub: ['সর্বশেষ পড়া সূরা, আয়াত ও আপনার অগ্রগতি', 'Your last read surah and ayah, and your progress'] },
    { key: 'quick_actions', icon: 'grid', title: ['কুরআন শর্টকাট', 'Quran shortcuts'], sub: ['কুরআন, সার্চ, কিবলা ও তাসবিহ এক ট্যাপে', 'Quran, search, Qibla and tasbih in one tap'] },
    { key: 'reminder_status', icon: 'bell', title: ['দৈনিক লক্ষ্য ও রিমাইন্ডার', 'Daily goal and reminders'], sub: ['পড়ার লক্ষ্য, ধারাবাহিকতা ও পরবর্তী রিমাইন্ডার', 'Your reading goal, streak and the next reminder'] }
  ];

  // ---------- rules (pure) ----------
  // How many copies of a widget are on the home screen, from the capabilities the phone reported.
  function installedCount(caps, key){
    var m = caps && caps.widgetsInstalled;
    var n = m && typeof m === 'object' ? Number(m[key]) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  function totalInstalled(caps){
    var t = 0;
    CATALOG.forEach(function(w){ t += installedCount(caps, w.key); });
    return t;
  }
  // 'pin' = the launcher can add widgets from the app; 'manual' = the person has to add them from the launcher's own widget list
  function mode(caps){ return caps && caps.pinWidgetSupported === true ? 'pin' : 'manual'; }

  // ---------- the screen ----------
  var bridge = function(){ return window.QR_NATIVE || null; };
  var S = { caps: null };
  var els = {};
  var onVisible = null;

  function load(){
    var b = bridge();
    if(!b || !b.isAvailable()) return Promise.resolve(false);
    return b.refreshCapabilities().then(function(c){ S.caps = c; return !!c; });
  }

  function manualHelp(){
    return h('div', { class: 'qa-stack', style: { gap: '6px' } },
      h('div', { class: 'qa-card-sub' }, T('হোম স্ক্রিনের ফাঁকা জায়গায় আঙুল চেপে ধরে রাখুন → "উইজেট" বেছে নিন → "কুরআন বাংলা" খুঁজে নিয়ে পছন্দের উইজেটটি হোম স্ক্রিনে টেনে আনুন।', 'Touch and hold an empty spot on the home screen -> choose "Widgets" -> find "Quran Bangla" and drag the widget you like onto the home screen.')));
  }

  function add(w, button){
    var b = bridge();
    if(!b) return;
    if(button) button.disabled = true;
    b.requestPinWidget(w.key).then(function(res){
      if(button) button.disabled = false;
      if(res && res.requested){
        UI.snack(T('হোম স্ক্রিনে যোগ করার অনুমতি দিন', 'Confirm to add it to the home screen'), { duration: 3500 });
      } else {
        // not supported here, or refused: say how to add it by hand
        UI.alert(T('হাতে যোগ করুন', 'Add it by hand'),
          T('এই ফোনের লঞ্চার অ্যাপ থেকে সরাসরি যোগ করতে দেয় না। হোম স্ক্রিনের ফাঁকা জায়গায় আঙুল চেপে ধরে রাখুন → "উইজেট" → "কুরআন বাংলা" → "' + w.title[0] + '" টেনে আনুন।',
            'This phone\'s launcher does not allow adding from the app. Touch and hold an empty spot on the home screen -> "Widgets" -> "Quran Bangla" -> drag "' + w.title[1] + '".'));
      }
      // the number of copies changes only after the person confirmed: ask again when the app comes back to the front
    }, function(){ if(button) button.disabled = false; });
  }

  function render(){
    if(!els.body) return;
    els.body.innerHTML = '';
    if(!S.caps){
      els.body.appendChild(UI.banner(T('এই ফিচার শুধু Android অ্যাপে পাওয়া যায়।', 'This feature is only available in the Android app.'), 'info', 'info'));
      return;
    }
    var pin = mode(S.caps) === 'pin';
    els.body.appendChild(UI.banner(pin
      ? T('"যোগ করুন" চাপলে ফোন জিজ্ঞেস করবে — অনুমতি দিলেই উইজেট হোম স্ক্রিনে চলে আসবে।', 'Tap "Add" and the phone asks you to confirm - then the widget appears on your home screen.')
      : T('এই ফোনে অ্যাপ থেকে সরাসরি যোগ করা যায় না। নিচের নিয়মে হোম স্ক্রিন থেকে যোগ করুন।', 'This phone cannot add widgets from the app. Add them from the home screen as described below.'), 'info', 'info'));
    var rows = CATALOG.map(function(w){
      var n = installedCount(S.caps, w.key);
      var sub = T(w.sub[0], w.sub[1]) + (n > 0 ? ' \u2022 ' + T(QRApp.N(n) + 'টি যোগ করা আছে', n + ' on your home screen') : '');
      // the whole row is the button (a button inside a button is not valid): the value says what a tap does
      return UI.row({
        icon: w.icon, title: T(w.title[0], w.title[1]), sub: sub,
        value: pin ? (n > 0 ? T('আরও একটি', 'Add another') : T('যোগ করুন', 'Add')) : '',
        onClick: pin ? function(ev, row){ add(w, row); } : null
      });
    });
    els.body.appendChild(UI.section(T('উপলব্ধ উইজেট', 'Available widgets')));
    els.body.appendChild(UI.group(rows));
    if(!pin) els.body.appendChild(manualHelp());
    else els.body.appendChild(h('div', { class: 'qa-card-sub' }, T('অন্য নিয়মে: হোম স্ক্রিনের ফাঁকা জায়গায় আঙুল চেপে ধরে রাখুন → উইজেট → কুরআন বাংলা।', 'Or by hand: touch and hold an empty spot on the home screen -> Widgets -> Quran Bangla.')));
  }

  function mount(el){
    els.body = h('div', { class: 'qa-stack qa-widgets', style: { gap: '16px', padding: '16px' } });
    el.appendChild(els.body);
    // back from the launcher's dialog: show the new numbers
    onVisible = function(){ if(document.visibilityState === 'visible' && els.body){ load().then(render); } };
    document.addEventListener('visibilitychange', onVisible);
  }

  if(Nav && typeof Nav.register === 'function'){
    Nav.register('widgets', {
      singleton: true,
      mount: mount,
      show: function(){ S.caps = null; render(); load().then(render); },
      hide: function(){},
      unmount: function(){ if(onVisible) document.removeEventListener('visibilitychange', onVisible); onVisible = null; els = {}; },
      relocalize: function(){ render(); },
      topbar: function(){ return { lead: 'back', title: T('হোম স্ক্রিন উইজেট', 'Home screen widgets') }; }
    });
  }

  QRApp.widgets = {
    open: function(){ if(Nav && Nav.push) Nav.push('widgets'); },
    available: function(){ var b = bridge(); return !!(b && b.isAvailable()); },
    // exported for tests/widgets-ui.test.js
    core: { CATALOG: CATALOG, installedCount: installedCount, totalInstalled: totalInstalled, mode: mode }
  };
})();
