// ---------- Android app UI · Tasbih (digital counter) ----------
// A tap counter for dhikr: five common phrases and a free counter, a target (33 / 99 / 100 / none), rounds, today's total,
// undo and reset. Everything is stored on the device (QRApp.prefs): it works with no network and no account.
//
// The counting rules are plain functions (QRApp.tasbih.core) so they are tested without a screen: tests/tasbih.test.js.
// Opened from Discover (QRApp.features), the quranbangla://tasbih deep link and the Quran quick-actions home screen widget.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  if(!QRApp) return;
  var UI = QRApp.ui, Nav = QRApp.nav, NAT = QRApp.native, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, NUM = QRApp.N;

  // The phrases are the well known short dhikr; the meanings are plain translations of those phrases.
  var DHIKR = [
    { id: 'subhanallah', ar: 'سُبْحَانَ ٱللَّهِ', bn: 'সুবহানাল্লাহ', en: 'Subhanallah', mbn: 'আল্লাহ পবিত্র', men: 'Glory be to Allah' },
    { id: 'alhamdulillah', ar: 'ٱلْحَمْدُ لِلَّهِ', bn: 'আলহামদুলিল্লাহ', en: 'Alhamdulillah', mbn: 'সমস্ত প্রশংসা আল্লাহর', men: 'All praise is for Allah' },
    { id: 'allahuakbar', ar: 'ٱللَّهُ أَكْبَرُ', bn: 'আল্লাহু আকবার', en: 'Allahu Akbar', mbn: 'আল্লাহ সর্বমহান', men: 'Allah is the Greatest' },
    { id: 'lailaha', ar: 'لَا إِلَٰهَ إِلَّا ٱللَّهُ', bn: 'লা ইলাহা ইল্লাল্লাহ', en: 'La ilaha illallah', mbn: 'আল্লাহ ছাড়া কোনো ইলাহ নেই', men: 'There is no god but Allah' },
    { id: 'astaghfirullah', ar: 'أَسْتَغْفِرُ ٱللَّهَ', bn: 'আস্তাগফিরুল্লাহ', en: 'Astaghfirullah', mbn: 'আমি আল্লাহর কাছে ক্ষমা চাই', men: 'I ask Allah for forgiveness' },
    { id: 'free', ar: '', bn: 'ফ্রি কাউন্টার', en: 'Free counter', mbn: 'যেকোনো জিকিরের জন্য', men: 'For any dhikr you choose' }
  ];
  var TARGETS = [33, 99, 100, 0]; // 0 = no target
  var byId = Object.create(null); // a plain {} would answer true for "__proto__" / "constructor" - stored data is never trusted
  DHIKR.forEach(function(d){ byId[d.id] = d; });
  function known(id){ return typeof id === 'string' && Object.prototype.hasOwnProperty.call(byId, id); }
  var PREF_KEY = 'tasbih';
  var MAX_UNDO = 50;

  // ---------- the counting rules (pure) ----------
  function pad(n){ return n < 10 ? '0' + n : String(n); }
  function dayKey(d){ d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toInt(n, lo, hi, dflt){ n = Number(n); return isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt; }

  function defaults(){
    var s = { v: 1, dhikr: 'subhanallah', target: 33, counts: {}, rounds: {}, day: '', today: 0, undo: [] };
    DHIKR.forEach(function(d){ s.counts[d.id] = 0; s.rounds[d.id] = 0; });
    return s;
  }

  // Anything read from storage is checked: a damaged value becomes a clean default, never an exception.
  function normalize(raw){
    var s = defaults();
    if(!raw || typeof raw !== 'object') return s;
    if(known(raw.dhikr)) s.dhikr = raw.dhikr;
    s.target = TARGETS.indexOf(raw.target) >= 0 ? raw.target : 33;
    DHIKR.forEach(function(d){
      s.counts[d.id] = toInt(raw.counts && raw.counts[d.id], 0, 999999, 0);
      s.rounds[d.id] = toInt(raw.rounds && raw.rounds[d.id], 0, 99999, 0);
    });
    s.day = typeof raw.day === 'string' ? raw.day : '';
    s.today = toInt(raw.today, 0, 9999999, 0);
    s.undo = Array.isArray(raw.undo) ? raw.undo.filter(known).slice(-MAX_UNDO) : [];
    return s;
  }

  function rollDay(s, now){
    var k = dayKey(now);
    if(s.day !== k){ s.day = k; s.today = 0; }
    return s;
  }

  // One tap on the big button. -> { state, roundCompleted }
  function tap(s, now){
    rollDay(s, now);
    var id = s.dhikr;
    s.counts[id] += 1;
    s.today += 1;
    var done = false;
    if(s.target > 0 && s.counts[id] >= s.target){ s.counts[id] = 0; s.rounds[id] += 1; done = true; }
    s.undo.push(id);
    if(s.undo.length > MAX_UNDO) s.undo.shift();
    return { state: s, roundCompleted: done };
  }

  // Takes back the last tap (also the one that finished a round). -> true when something was taken back
  function undo(s){
    var id = s.undo.pop();
    if(!id) return false;
    if(s.counts[id] > 0) s.counts[id] -= 1;
    else if(s.rounds[id] > 0){ s.rounds[id] -= 1; s.counts[id] = Math.max(0, (s.target || 1) - 1); }
    else return false;
    if(s.today > 0) s.today -= 1;
    return true;
  }

  // Resets the count and rounds of the selected dhikr; today's total stays (it is a record of what was said).
  function reset(s){
    var id = s.dhikr;
    s.counts[id] = 0;
    s.rounds[id] = 0;
    s.undo = s.undo.filter(function(x){ return x !== id; });
    return s;
  }

  function select(s, id){ if(known(id)) s.dhikr = id; return s; }
  function setTarget(s, n){ if(TARGETS.indexOf(n) >= 0) s.target = n; return s; }
  function progress(s){ return s.target > 0 ? Math.min(100, Math.round(s.counts[s.dhikr] * 100 / s.target)) : 0; }

  // ---------- storage ----------
  var current = null;
  function load(){
    if(current) return current;
    var raw = null;
    try{ raw = QRApp.prefs.get(PREF_KEY, null); }catch(e){ raw = null; }
    current = rollDay(normalize(raw), new Date());
    return current;
  }
  var saveSoon = QRApp.debounce ? QRApp.debounce(function(){ try{ QRApp.prefs.set(PREF_KEY, current); }catch(e){} }, 400) : function(){};
  function saveNow(){ try{ QRApp.prefs.set(PREF_KEY, current); }catch(e){} }

  // ---------- the screen ----------
  var els = {};
  function haptic(kind){ try{ if(NAT && NAT.haptic) NAT.haptic(kind); }catch(e){} }

  function render(){
    if(!els.root) return;
    var s = load(), d = byId[s.dhikr], isBn = QRApp.isBn();
    els.chips.innerHTML = '';
    DHIKR.forEach(function(x){
      els.chips.appendChild(UI.chip(isBn ? x.bn : x.en, function(){ select(load(), x.id); saveNow(); haptic('light'); render(); }, x.id === s.dhikr));
    });
    els.arabic.textContent = d.ar;
    els.arabic.style.display = d.ar ? '' : 'none';
    els.meaning.textContent = isBn ? d.mbn : d.men;
    els.count.textContent = NUM(s.counts[s.dhikr]);
    els.of.textContent = s.target > 0 ? T('লক্ষ্য ', 'Target ') + NUM(s.target) : T('লক্ষ্য ছাড়া', 'No target');
    els.ring.style.setProperty('--p', String(progress(s)));
    els.ring.setAttribute('aria-label', (isBn ? d.bn : d.en) + ': ' + NUM(s.counts[s.dhikr]));
    els.stats.textContent = T('রাউন্ড ', 'Rounds ') + NUM(s.rounds[s.dhikr]) + '  •  ' + T('আজকের মোট ', 'Today ') + NUM(s.today);
    els.targets.innerHTML = '';
    TARGETS.forEach(function(n){
      els.targets.appendChild(UI.chip(n > 0 ? NUM(n) : T('∞ ফ্রি', '∞ Free'), function(){ setTarget(load(), n); saveNow(); render(); }, n === s.target));
    });
    els.undoBtn.disabled = !s.undo.length;
  }

  function onTap(){
    var r = tap(load(), new Date());
    saveSoon();
    haptic(r.roundCompleted ? 'success' : 'light');
    if(r.roundCompleted && UI && UI.snack) UI.snack(T('একটি রাউন্ড সম্পূর্ণ হয়েছে — মাশাআল্লাহ', 'Round complete'));
    render();
  }

  function onReset(){
    UI.confirm({ title: T('এই জিকিরের গণনা শূন্য করবেন?', 'Reset this counter?'), text: T('গণনা ও রাউন্ড শূন্য হবে। আজকের মোট অপরিবর্তিত থাকবে।', 'The count and rounds go back to zero. Today\'s total stays.'),
      confirmLabel: T('শূন্য করুন', 'Reset'), danger: true }).then(function(ok){ if(ok){ reset(load()); saveNow(); render(); } });
  }

  function mount(el){
    els.root = h('div', { class: 'qa-tasbih' });
    els.chips = h('div', { class: 'qa-tasbih-chips' });
    els.arabic = h('div', { class: 'qa-tasbih-ar', lang: 'ar', dir: 'rtl' });
    els.meaning = h('div', { class: 'qa-tasbih-meaning' });
    els.count = h('div', { class: 'qa-tasbih-count' });
    els.of = h('div', { class: 'qa-tasbih-of' });
    els.ring = h('button', { class: 'qa-tasbih-ring', type: 'button', onclick: onTap }, h('div', { class: 'qa-tasbih-face' }, els.count, els.of));
    els.stats = h('div', { class: 'qa-tasbih-stats' });
    els.targets = h('div', { class: 'qa-tasbih-targets' });
    els.undoBtn = h('button', { class: 'qa-btn qa-btn-text', type: 'button', onclick: function(){ if(undo(load())){ saveNow(); haptic('light'); render(); } } }, T('আগেরটি ফেরত', 'Undo'));
    els.resetBtn = h('button', { class: 'qa-btn qa-btn-text', type: 'button', onclick: onReset }, T('শূন্য করুন', 'Reset'));
    els.root.appendChild(els.chips);
    els.root.appendChild(els.arabic);
    els.root.appendChild(els.meaning);
    els.root.appendChild(els.ring);
    els.root.appendChild(els.stats);
    els.root.appendChild(els.targets);
    els.root.appendChild(h('div', { class: 'qa-tasbih-actions' }, els.undoBtn, els.resetBtn));
    el.appendChild(els.root);
  }

  if(Nav && typeof Nav.register === 'function'){
    Nav.register('tasbih', {
      singleton: true,
      mount: mount,
      show: function(){ current = null; render(); },
      hide: function(){ saveNow(); },
      unmount: function(){ els = {}; },
      relocalize: function(){
        if(els.undoBtn) els.undoBtn.textContent = T('আগেরটি ফেরত', 'Undo');
        if(els.resetBtn) els.resetBtn.textContent = T('শূন্য করুন', 'Reset');
        render();
      },
      topbar: function(){ return { lead: 'back', title: T('তাসবিহ', 'Tasbih') }; }
    });
  }

  QRApp.tasbih = {
    open: function(){ if(Nav && Nav.push) Nav.push('tasbih'); },
    // exported for tests/tasbih.test.js
    core: { DHIKR: DHIKR, TARGETS: TARGETS, defaults: defaults, normalize: normalize, tap: tap, undo: undo, reset: reset, select: select, setTarget: setTarget, progress: progress, dayKey: dayKey, rollDay: rollDay }
  };
})();
