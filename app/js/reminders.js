// ---------- Android app UI · Reminders (the native alarm engine) ----------
//
// Prayer times, Jumu'ah, Tahajjud, azkar, Quran reading, the ayah of the day, the reading plan and the Ramadan reminders are
// scheduled by the Android alarm engine (Kotlin, android-build/native), NOT by the web view: they fire on time with the app
// closed, after a restart, and with no network (prayer times are calculated on the device). This screen only edits the list;
// the typed bridge (js/quran-native.js) sends it. It exists only where the native layer exists (the website never shows it).
//
// The rules (merge with the saved list, alert style, descriptions, time conversion) are plain functions in QRApp.reminders.core,
// tested without a screen: tests/reminders-ui.test.js.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  if(!QRApp) return;
  var UI = QRApp.ui, Nav = QRApp.nav, h = QRApp.h, T = QRApp.T, NUM = QRApp.N;

  var MODES = ['sound', 'vibrate', 'silent'];

  // ---------- rules (pure) ----------
  function pad(n){ return n < 10 ? '0' + n : String(n); }
  function toHHMM(minutes){
    var m = Math.max(0, Math.min(1439, Math.floor(Number(minutes) || 0)));
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }
  // '06:30' -> 390, anything else -> null
  function toMinutes(text){
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
    if(!m) return null;
    var hh = +m[1], mm = +m[2];
    return hh <= 23 && mm <= 59 ? hh * 60 + mm : null;
  }
  function fixedTime(r){ return !r.prayer; }

  // The catalog (in the current language) carries the texts and the schedule; what the user chose (on/off, the time of a fixed
  // time reminder, the alert style) is taken from the saved list. Reminders the catalog no longer knows are dropped.
  function merge(catalog, saved){
    var byId = {};
    (Array.isArray(saved) ? saved : []).forEach(function(s){ if(s && typeof s.id === 'string') byId[s.id] = s; });
    return catalog.map(function(c){
      var s = byId[c.id];
      var out = Object.assign({}, c);
      if(!s) return out;
      out.enabled = s.enabled === true;
      if(MODES.indexOf(s.mode) >= 0) out.mode = s.mode;
      if(fixedTime(c) && typeof s.timeMinutes === 'number' && s.timeMinutes >= 0 && s.timeMinutes <= 1439) out.timeMinutes = Math.floor(s.timeMinutes);
      return out;
    });
  }

  // the alert style of the enabled reminders (the first one decides; "sound" when none is on)
  function styleOf(list){
    var on = list.filter(function(r){ return r.enabled; });
    return on.length && MODES.indexOf(on[0].mode) >= 0 ? on[0].mode : 'sound';
  }
  function applyStyle(list, mode){
    if(MODES.indexOf(mode) < 0) return list;
    return list.map(function(r){ return Object.assign({}, r, { mode: mode }); });
  }

  function groupOf(r){
    if(r.ramadanOnly) return 'ramadan';
    if(r.kind === 'prayer' || r.kind === 'jumuah' || r.kind === 'tahajjud') return 'prayer';
    return 'daily';
  }

  // "At the prayer time" / "30 min before Isha ..." / "06:30", plus Fridays / Ramadan
  function describe(r, bn){
    var t = function(b, e){ return bn ? b : e; };
    var s;
    if(r.prayer){
      if(r.offsetMinutes === 0) s = t('ঠিক ওয়াক্তে', 'At the time');
      else if(r.offsetMinutes < 0) s = (bn ? toBnDigits(-r.offsetMinutes) : String(-r.offsetMinutes)) + t(' মিনিট আগে', ' min before');
      else s = (bn ? toBnDigits(r.offsetMinutes) : String(r.offsetMinutes)) + t(' মিনিট পরে', ' min after');
    } else s = bn ? toBnDigits(toHHMM(r.timeMinutes)) : toHHMM(r.timeMinutes);
    if(r.days === 32) s += t(' • শুক্রবার', ' • Fridays');
    if(r.ramadanOnly) s += t(' • শুধু রমজানে', ' • Ramadan only');
    return s;
  }
  function toBnDigits(text){ return String(text).replace(/[0-9]/g, function(d){ return '০১২৩৪৫৬৭৮৯'.charAt(+d); }); }

  // ---------- the screen ----------
  var bridge = function(){ return window.QR_NATIVE || null; };
  var api = function(){ return window.QR_NATIVE_API || null; };
  var S = { caps: null, list: [], report: null };
  var els = {};
  var queue = Promise.resolve();
  var onVisible = null;

  function lang(){ return QRApp.isBn() ? 'bn' : 'en'; }

  function load(){
    var b = bridge(), a = api();
    if(!b || !a || !b.isAvailable()) return Promise.resolve(false);
    var before = S.caps;
    return Promise.all([b.refreshCapabilities(), b.getReminders()]).then(function(r){
      S.caps = r[0];
      S.list = merge(a.defaultCatalog(lang()), r[1]);
      // a permission was just given in the system settings: plan the alarms again at once (exact times, notifications allowed)
      if(permissionGained(before, S.caps)) save();
      return true;
    });
  }

  // changes are sent one after the other; resolving false puts the switch back
  function save(){
    var b = bridge();
    queue = queue.then(function(){ return b.setReminders(S.list); }).then(function(res){
      if(!res.report){ if(UI && UI.snack) UI.snack(T('রিমাইন্ডার সংরক্ষণ করা যায়নি', 'Could not save the reminders')); return false; }
      S.report = res.report;
      renderNext();
      return true;
    }, function(){ return false; });
    return queue;
  }

  function nextText(){
    var n = S.report && S.report.next && S.report.next[0];
    if(!n) return T('কোনো রিমাইন্ডার চালু নেই', 'No reminder is switched on');
    var r = S.list.filter(function(x){ return x.id === n.id; })[0];
    var when;
    try{ when = new Date(n.at).toLocaleString(QRApp.isBn() ? 'bn-BD' : 'en', { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }catch(e){ when = new Date(n.at).toString(); }
    return T('পরবর্তী: ', 'Next: ') + (r ? r.title : n.id) + ' • ' + when;
  }
  function renderNext(){ if(els.next) els.next.textContent = nextText(); }

  // ---------- permissions ----------
  // Notifications: Android 13+ asks at run time, so the person gets the SYSTEM DIALOG first. Only when that cannot help any more
  // (the answer was "don't allow" twice, or notifications are switched off in the phone settings) the phone's own notification
  // settings are opened - after a short explanation, so the button never feels like it does nothing. Resolves true when allowed.
  function askNotifications(){
    var b = bridge();
    if(!b) return Promise.resolve(false);
    return b.requestNotifications().then(function(res){
      if(res && res.granted) return true;
      return UI.confirm({
        title: T('নোটিফিকেশনের অনুমতি দরকার', 'Notifications need your permission'),
        text: T('রিমাইন্ডার দেখাতে নোটিফিকেশন চালু থাকতে হবে। ফোনের সেটিংস খুলে নোটিফিকেশন চালু করুন, তারপর অ্যাপে ফিরে আসুন।', 'Reminders can only be shown when notifications are on. Open the phone settings, switch notifications on, then come back to the app.'),
        confirmLabel: T('সেটিংস খুলুন', 'Open settings')
      }).then(function(ok){ if(ok) b.openSettings('notifications'); return false; });
    });
  }
  // Precise alarms (Android 12+): there is no dialog for this one, the system page "Alarms & reminders" of the app is the way.
  function askExactAlarms(){
    var b = bridge();
    if(!b) return Promise.resolve(false);
    return b.openSettings('exact-alarms').then(function(opened){
      if(!opened) UI.snack(T('সেটিংস খোলা যায়নি — ফোনের Settings > Apps > কুরআন বাংলা > Alarms & reminders থেকে চালু করুন', 'Could not open the settings - turn on Alarms & reminders in Settings > Apps > Quran Bangla'), { duration: 5000 });
      return opened;
    });
  }
  // true when notifications or exact alarms were off before and are on now
  function permissionGained(before, now){
    if(!before || !now) return false;
    return (before.exactAlarms === false && now.exactAlarms === true) || (before.notificationsEnabled === false && now.notificationsEnabled === true);
  }

  function permissionBlock(){
    var b = bridge(), c = S.caps, box = h('div', { class: 'qa-stack', style: { gap: '8px' } });
    if(!c) return box;
    function line(text, icon, kind, label, onClick, primary){
      var wrap = h('div', { class: 'qa-stack', style: { gap: '8px' } });
      wrap.appendChild(UI.banner(text, icon, kind));
      wrap.appendChild(primary ? UI.button(label, { kind: 'filled', block: true, onClick: onClick }) : UI.linkButton(label, onClick));
      box.appendChild(wrap);
    }
    function refresh(){ return load().then(render); }
    if(c.notificationsEnabled === false) line(T('নোটিফিকেশন বন্ধ আছে — রিমাইন্ডার দেখা যাবে না।', 'Notifications are off - reminders cannot be shown.'), 'bell', '', T('নোটিফিকেশনের অনুমতি দিন', 'Allow notifications'), function(){ askNotifications().then(refresh); }, true);
    if(c.exactAlarms === false && c.sdk >= 31) line(T('নির্ভুল অ্যালার্মের অনুমতি নেই: রিমাইন্ডার কয়েক মিনিট দেরিতে আসতে পারে।', 'Precise alarms are not allowed: reminders may be a few minutes late.'), 'clock', 'info', T('নির্ভুল অ্যালার্মের অনুমতি দিন', 'Allow precise alarms'), function(){ askExactAlarms(); }, true);
    if(c.ignoringBatteryOptimizations === false) line(T('কিছু ফোন ব্যাটারি বাঁচাতে অ্যালার্ম বন্ধ করে দেয়। দরকার হলে অ্যাপটিকে ব্যাটারি সীমাবদ্ধতা থেকে বাদ দিন।', 'Some phones stop alarms to save battery. If reminders are missed, exclude the app from battery optimisation.'), 'info', 'info', T('ব্যাটারি সেটিংস', 'Battery settings'), function(){ b.openSettings('battery'); }, false);
    return box;
  }

  function timeRow(r){
    return UI.row({ title: T('সময়', 'Time'), value: QRApp.isBn() ? toBnDigits(toHHMM(r.timeMinutes)) : toHHMM(r.timeMinutes), onClick: function(){
      var input = h('input', { type: 'time', value: toHHMM(r.timeMinutes), style: { position: 'fixed', opacity: '0', pointerEvents: 'none', left: '0', top: '0' } });
      document.body.appendChild(input);
      var done = function(){ if(input.parentNode) input.parentNode.removeChild(input); };
      input.addEventListener('change', function(){
        var m = toMinutes(input.value);
        if(m !== null){ r.timeMinutes = m; save(); render(); }
        done();
      });
      input.addEventListener('blur', function(){ setTimeout(done, 300); });
      try{ if(input.showPicker) input.showPicker(); else input.click(); }catch(e){ input.focus(); input.click(); }
    } });
  }

  function section(titleBn, titleEn, group){
    var rows = [];
    S.list.filter(function(r){ return groupOf(r) === group; }).forEach(function(r){
      rows.push(UI.switchRow({ icon: 'bell', title: r.title, sub: describe(r, QRApp.isBn()), checked: r.enabled, onChange: function(v){
        r.enabled = v;
        var p = save();
        render();
        // the first reminder that is switched on asks for what it needs: the notification permission right away
        if(v && S.caps && S.caps.notificationsEnabled === false) askNotifications().then(function(){ return load(); }).then(render);
        return p;
      } }));
      if(r.enabled && fixedTime(r)) rows.push(timeRow(r));
    });
    if(!rows.length) return null;
    var box = h('div', { class: 'qa-stack', style: { gap: '8px' } });
    box.appendChild(UI.section(T(titleBn, titleEn)));
    box.appendChild(UI.group(rows));
    return box;
  }

  function render(){
    if(!els.body) return;
    els.body.innerHTML = '';
    if(!S.caps){
      els.body.appendChild(UI.banner(T('এই ফিচার শুধু Android অ্যাপে পাওয়া যায়।', 'This feature is only available in the Android app.'), 'info', 'info'));
      return;
    }
    els.body.appendChild(permissionBlock());
    els.next = h('div', { class: 'qa-card-sub qa-reminders-next' }, nextText());
    els.body.appendChild(els.next);
    els.body.appendChild(UI.section(T('অ্যালার্টের ধরন', 'Alert style')));
    els.body.appendChild(UI.seg([{ id: 'sound', label: T('শব্দসহ', 'Sound') }, { id: 'vibrate', label: T('ভাইব্রেশন', 'Vibrate') }, { id: 'silent', label: T('নীরব', 'Silent') }], styleOf(S.list), function(mode){ S.list = applyStyle(S.list, mode); save(); }));
    [['নামাজ ও রাত্রিকালীন', 'Prayer and night', 'prayer'], ['রমজান', 'Ramadan', 'ramadan'], ['আযকার ও তিলাওয়াত', 'Azkar and reading', 'daily']].forEach(function(g){
      var s = section(g[0], g[1], g[2]);
      if(s) els.body.appendChild(s);
    });
  }

  function mount(el){
    els.body = h('div', { class: 'qa-stack qa-reminders', style: { gap: '16px', padding: '16px' } });
    el.appendChild(els.body);
    // coming back from a system settings page: ask the phone again what is allowed now
    onVisible = function(){ if(document.visibilityState === 'visible' && els.body){ load().then(render); } };
    document.addEventListener('visibilitychange', onVisible);
  }

  if(Nav && typeof Nav.register === 'function'){
    Nav.register('reminders', {
      singleton: true,
      mount: mount,
      show: function(){ S.caps = null; render(); load().then(render); },
      hide: function(){},
      unmount: function(){ if(onVisible) document.removeEventListener('visibilitychange', onVisible); onVisible = null; els = {}; },
      relocalize: function(){ if(S.caps){ S.list = merge(api().defaultCatalog(lang()), S.list); } render(); },
      topbar: function(){ return { lead: 'back', title: T('রিমাইন্ডার', 'Reminders') }; }
    });
  }

  QRApp.reminders = {
    open: function(){ if(Nav && Nav.push) Nav.push('reminders'); },
    available: function(){ var b = bridge(); return !!(b && b.isAvailable()); },
    // exported for tests/reminders-ui.test.js
    core: { merge: merge, styleOf: styleOf, applyStyle: applyStyle, groupOf: groupOf, describe: describe, toHHMM: toHHMM, toMinutes: toMinutes, fixedTime: fixedTime, permissionGained: permissionGained, askNotifications: askNotifications, askExactAlarms: askExactAlarms }
  };
})();
