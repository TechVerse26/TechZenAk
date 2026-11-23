"use strict";
// ---------------------------------------------------------------------------------------------------------------------
// Typed bridge between the web app and the Android native layer (Kotlin).     build: `npm run build:ts`  ->  js/quran-native.js
//
// ONE contract: the `QuranNativePlugin` interface below is mirrored by android-build/native/kotlin/.../bridge/QuranNativePlugin.kt
// (every method here has a @PluginMethod of the same name there - tests/native-bridge.test.js checks it). The web app talks to
// the `QuranNativeClient`, never to Capacitor directly:
//   * where there is no native layer (the website, a browser, the "safe" build) every call resolves with a harmless "not available"
//     answer - the caller never needs `if (isNative)` and never has to catch
//   * the app state pushed to widgets and alarms is validated and de-duplicated here, debounced, and size limited
//   * reminders are validated with the SAME rules as the Kotlin side before they cross the bridge
//
// This file is a classic script (no import / export): it ends in `window.QR_NATIVE`, and in `module.exports` for the tests.
// ---------------------------------------------------------------------------------------------------------------------
(function (root) {
    'use strict';
    const BRIDGE_VERSION = 1;
    const MAX_STATE_CHARS = 100000; // the same limit as the Kotlin plugin
    const MAX_REMINDERS = 64;
    const ALL_DAYS = 127;
    const TOTAL_AYAHS = 6236;
    const ID_RE = /^[a-z0-9_.-]{1,48}$/;
    const LINK_PREFIX = 'quranbangla://';
    const KINDS = ['prayer', 'daily_quran', 'azkar_morning', 'azkar_evening', 'daily_ayah', 'goal', 'streak', 'course', 'custom',
        'ramadan_suhoor', 'ramadan_iftar', 'taraweeh', 'tahajjud', 'jumuah'];
    const MODES = ['sound', 'vibrate', 'silent'];
    const PRIORITIES = ['high', 'default', 'low'];
    const PRAYER_KEYS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha', 'imsak', 'lastthird'];
    const WIDGET_KEYS = ['next_prayer', 'daily_ayah', 'continue_reading', 'quick_actions', 'reminder_status'];
    const PRAYER_METHODS = [1, 2, 3, 4, 5, 8, 13, 20]; // the methods the native calculator implements
    const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
    const isInt = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
    const finite = (v) => typeof v === 'number' && Number.isFinite(v);
    const oneOf = (list, v) => typeof v === 'string' && list.indexOf(v) >= 0;
    // ------------------------------------------------------------------------------------------------ reminders
    /** The rules of Reminder.fromJson in Kotlin. Returns what is wrong, or null when the reminder is acceptable. */
    function validateReminder(r) {
        if (!isRecord(r))
            return 'not an object';
        if (typeof r.id !== 'string' || !ID_RE.test(r.id))
            return 'id must be 1-48 characters of a-z 0-9 _ . -';
        if (r.kind !== undefined && !oneOf(KINDS, r.kind))
            return 'unknown kind';
        if (typeof r.title !== 'string' || r.title.length < 1 || r.title.length > 120)
            return 'title must be 1-120 characters';
        if (r.body !== undefined && (typeof r.body !== 'string' || r.body.length > 300))
            return 'body must be at most 300 characters';
        if (r.prayer !== undefined && r.prayer !== null && !oneOf(PRAYER_KEYS, r.prayer))
            return 'unknown prayer';
        if (r.timeMinutes !== undefined && !isInt(r.timeMinutes, 0, 1439))
            return 'timeMinutes must be 0-1439';
        if (r.offsetMinutes !== undefined && !isInt(r.offsetMinutes, -720, 720))
            return 'offsetMinutes must be -720..720';
        if (r.days !== undefined && !isInt(r.days, 1, ALL_DAYS))
            return 'days must be a week mask 1-127';
        if (r.mode !== undefined && !oneOf(MODES, r.mode))
            return 'unknown mode';
        if (r.priority !== undefined && !oneOf(PRIORITIES, r.priority))
            return 'unknown priority';
        if (r.link !== undefined && (typeof r.link !== 'string' || r.link.indexOf(LINK_PREFIX) !== 0 || r.link.length > 200))
            return 'link must be a quranbangla:// link';
        return null;
    }
    /** Week mask from day numbers (0 = Sunday ... 6 = Saturday). */
    function daysMask(days) {
        let mask = 0;
        for (const d of days)
            if (isInt(d, 0, 6))
                mask |= 1 << d;
        return mask || ALL_DAYS;
    }
    const PRAYER_TEXT = {
        fajr: { bn: ['ফজরের সময়', 'ফজরের নামাজের সময় হয়েছে।'], en: ['Fajr', 'It is time for the Fajr prayer.'] },
        dhuhr: { bn: ['যোহরের সময়', 'যোহরের নামাজের সময় হয়েছে।'], en: ['Dhuhr', 'It is time for the Dhuhr prayer.'] },
        asr: { bn: ['আসরের সময়', 'আসরের নামাজের সময় হয়েছে।'], en: ['Asr', 'It is time for the Asr prayer.'] },
        maghrib: { bn: ['মাগরিবের সময়', 'মাগরিবের নামাজের সময় হয়েছে।'], en: ['Maghrib', 'It is time for the Maghrib prayer.'] },
        isha: { bn: ['এশার সময়', 'এশার নামাজের সময় হয়েছে।'], en: ['Isha', 'It is time for the Isha prayer.'] }
    };
    /** Every reminder the app can offer, all OFF - the settings screen switches them on. Texts follow the app language (bn / en). */
    function defaultCatalog(language) {
        const bn = language !== 'en';
        const t = (b, e) => (bn ? b : e);
        const base = { enabled: false, timeMinutes: 0, prayer: null, offsetMinutes: 0, days: ALL_DAYS, mode: 'sound', priority: 'default', ramadanOnly: false, link: LINK_PREFIX + 'home' };
        const out = [];
        ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].forEach((p) => {
            const x = PRAYER_TEXT[p][bn ? 'bn' : 'en'];
            out.push(Object.assign(Object.assign({}, base), { id: 'prayer_' + p, kind: 'prayer', title: x[0], body: x[1], prayer: p, priority: 'high', link: LINK_PREFIX + 'prayer' }));
        });
        out.push(Object.assign(Object.assign({}, base), { id: 'jumuah', kind: 'jumuah', title: t('জুমার প্রস্তুতি', 'Jumu\u2019ah'), body: t('জুমার নামাজের সময় ঘনিয়ে আসছে।', 'The Jumu\u2019ah prayer is near.'), prayer: 'dhuhr', offsetMinutes: -60, days: 1 << 5, priority: 'high', link: LINK_PREFIX + 'prayer' }));
        out.push(Object.assign(Object.assign({}, base), { id: 'tahajjud', kind: 'tahajjud', title: t('তাহাজ্জুদের সময়', 'Tahajjud'), body: t('রাতের শেষ তৃতীয়াংশ শুরু হয়েছে।', 'The last third of the night has begun.'), prayer: 'lastthird', link: LINK_PREFIX + 'prayer' }));
        out.push(Object.assign(Object.assign({}, base), { id: 'azkar_morning', kind: 'azkar_morning', title: t('সকালের আযকার', 'Morning azkar'), body: t('সকালের আযকার পড়ার সময়।', 'Time for the morning azkar.'), timeMinutes: 6 * 60 + 30 }));
        out.push(Object.assign(Object.assign({}, base), { id: 'azkar_evening', kind: 'azkar_evening', title: t('সন্ধ্যার আযকার', 'Evening azkar'), body: t('সন্ধ্যার আযকার পড়ার সময়।', 'Time for the evening azkar.'), prayer: 'asr', offsetMinutes: 30 }));
        out.push(Object.assign(Object.assign({}, base), { id: 'daily_quran', kind: 'daily_quran', title: t('কুরআন তিলাওয়াত', 'Quran reading'), body: t('আজকের তিলাওয়াতের সময়।', 'Time for today\u2019s reading.'), timeMinutes: 21 * 60, link: LINK_PREFIX + 'continue' }));
        out.push(Object.assign(Object.assign({}, base), { id: 'daily_ayah', kind: 'daily_ayah', title: t('আজকের আয়াত', 'Ayah of the day'), body: t('আজকের আয়াতটি পড়ুন।', 'Read today\u2019s ayah.'), timeMinutes: 8 * 60, link: LINK_PREFIX + 'home' }));
        out.push(Object.assign(Object.assign({}, base), { id: 'goal', kind: 'goal', title: t('পড়ার পরিকল্পনা', 'Reading plan'), body: t('আজকের পরিকল্পনা সম্পন্ন করুন।', 'Complete today\u2019s plan.'), timeMinutes: 19 * 60, link: LINK_PREFIX + 'planner' }));
        out.push(Object.assign(Object.assign({}, base), { id: 'ramadan_suhoor', kind: 'ramadan_suhoor', title: t('সেহরির সময়', 'Suhoor'), body: t('সেহরির সময় শেষ হতে আর ৩০ মিনিট।', '30 minutes until the end of suhoor.'), prayer: 'imsak', offsetMinutes: -30, ramadanOnly: true, priority: 'high', link: LINK_PREFIX + 'prayer' }));
        out.push(Object.assign(Object.assign({}, base), { id: 'ramadan_iftar', kind: 'ramadan_iftar', title: t('ইফতারের সময়', 'Iftar'), body: t('ইফতারের সময় প্রায় হয়েছে।', 'Iftar is almost here.'), prayer: 'maghrib', offsetMinutes: -10, ramadanOnly: true, priority: 'high', link: LINK_PREFIX + 'prayer' }));
        out.push(Object.assign(Object.assign({}, base), { id: 'taraweeh', kind: 'taraweeh', title: t('তারাবীহর সময়', 'Taraweeh'), body: t('তারাবীহর নামাজের সময় হয়েছে।', 'It is time for Taraweeh.'), prayer: 'isha', offsetMinutes: 20, ramadanOnly: true, link: LINK_PREFIX + 'prayer' }));
        return out;
    }
    // ------------------------------------------------------------------------------------------------ app state snapshot
    /** Builds the snapshot the widgets and alarms read. Anything that is not clearly valid is left out, never guessed. */
    function buildSnapshot(env) {
        const language = typeof env.language === 'string' && env.language ? env.language : 'bn';
        const translationEdition = typeof env.translationEdition === 'string' && /^[a-z]{2,3}\.[a-z0-9_]{2,40}$/.test(env.translationEdition) ? env.translationEdition : 'bn.bengali';
        let lastRead = null;
        if (isRecord(env.lastRead) && isInt(env.lastRead.surah, 1, 114) && isInt(env.lastRead.ayah, 1, 286))
            lastRead = { surah: env.lastRead.surah, ayah: env.lastRead.ayah };
        let prayer = null;
        const loc = env.prayerLocation;
        if (isRecord(loc) && finite(loc.lat) && finite(loc.lon) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180) {
            const method = isInt(env.prayerMethod, 1, 99) && PRAYER_METHODS.indexOf(env.prayerMethod) >= 0 ? env.prayerMethod : 1;
            prayer = { lat: loc.lat, lon: loc.lon, method, school: env.prayerSchool === 1 ? 1 : 0 };
            if (typeof loc.label === 'string' && loc.label)
                prayer.label = loc.label.slice(0, 60);
        }
        const ayahsRead = isRecord(env.ayahsRead) ? Math.min(TOTAL_AYAHS, Object.keys(env.ayahsRead).length) : 0;
        const streak = isInt(env.streak, 0, 99999) ? env.streak : 0;
        // the plan shown by the widget: the first plan that is not finished yet, else the first one
        let plan = null;
        if (Array.isArray(env.planners)) {
            const valid = env.planners.filter((p) => isRecord(p) && isInt(p.days, 1, 5000) && isInt(p.completedDays, 0, 5000));
            const chosen = valid.find((p) => p.completedDays < p.days) || valid[0];
            if (chosen) {
                plan = {
                    title: typeof chosen.title === 'string' ? chosen.title.slice(0, 60) : '',
                    days: chosen.days,
                    completedDays: Math.min(chosen.completedDays, chosen.days),
                    markedToday: typeof env.today === 'string' && chosen.lastMarkedDate === env.today
                };
            }
        }
        return { v: 1, language, translationEdition, lastRead, prayer, goals: { ayahsRead, streak, plan } };
    }
    // ------------------------------------------------------------------------------------------------ the client
    const defaultScheduler = {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (handle) => clearTimeout(handle)
    };
    class QuranNativeClient {
        constructor(getPlugin, scheduler = defaultScheduler, debounceMs = 800) {
            this.getPlugin = getPlugin;
            this.scheduler = scheduler;
            this.debounceMs = debounceMs;
            this.caps = null;
            this.lastSent = '';
            this.timer = null;
            this.pending = null;
        }
        /** true when this app has the native layer (false on the website and in the safe build). */
        isAvailable() { return this.getPlugin() !== null; }
        /** What the native layer can do on this phone, or null when there is none. Asked once, then remembered. */
        capabilities() {
            if (!this.caps) {
                const plugin = this.getPlugin();
                this.caps = plugin ? plugin.getCapabilities().then((c) => c, () => null) : Promise.resolve(null);
            }
            return this.caps;
        }
        /** Forget the remembered capabilities (after the user changed a permission in the system settings). */
        refreshCapabilities() { this.caps = null; return this.capabilities(); }
        /** Pushes the app state to widgets and alarms. Debounced, de-duplicated, fire and forget. */
        syncState(snapshot) {
            this.pending = snapshot;
            if (this.timer !== null)
                this.scheduler.clear(this.timer);
            this.timer = this.scheduler.set(() => { this.timer = null; void this.flush(); }, this.debounceMs);
        }
        /** Sends the pending snapshot now. Resolves true when the native side has the current state. */
        flush() {
            if (this.timer !== null) {
                this.scheduler.clear(this.timer);
                this.timer = null;
            }
            const plugin = this.getPlugin();
            const snapshot = this.pending;
            this.pending = null;
            if (!plugin || !snapshot)
                return Promise.resolve(false);
            const json = JSON.stringify(snapshot);
            if (json === this.lastSent)
                return Promise.resolve(true);
            if (json.length > MAX_STATE_CHARS)
                return Promise.resolve(false);
            return plugin.syncState({ state: snapshot }).then(() => { this.lastSent = json; return true; }, () => false);
        }
        getReminders() {
            const plugin = this.getPlugin();
            if (!plugin)
                return Promise.resolve([]);
            return plugin.getReminders().then((r) => (Array.isArray(r.reminders) ? r.reminders : []), () => []);
        }
        /** Validates (same rules as Kotlin), sends the valid ones and returns what was wrong with the others. */
        async setReminders(list) {
            const errors = [];
            const valid = [];
            const seen = Object.create(null);
            list.forEach((r, index) => {
                const message = validateReminder(r);
                if (message)
                    errors.push({ index, message });
                else if (seen[r.id])
                    errors.push({ index, message: 'duplicate id' });
                else if (valid.length >= MAX_REMINDERS)
                    errors.push({ index, message: 'at most ' + MAX_REMINDERS + ' reminders' });
                else {
                    seen[r.id] = true;
                    valid.push(r);
                }
            });
            const plugin = this.getPlugin();
            if (!plugin)
                return { ok: false, errors, report: null };
            try {
                const report = await plugin.setReminders({ reminders: valid });
                return { ok: errors.length === 0, errors, report };
            }
            catch (e) {
                return { ok: false, errors, report: null };
            }
        }
        describeSchedule() { return this.call((p) => p.describeSchedule()); }
        refreshWidgets() { return this.call((p) => p.refreshWidgets()).then((r) => (r ? r.updated : 0)); }
        getStorageInfo() { return this.call((p) => p.getStorageInfo()); }
        getDatabaseInfo() { return this.call((p) => p.getDatabaseInfo()); }
        /** Asks the launcher to add a widget (Android 8+, the user confirms). */
        requestPinWidget(widget) {
            if (!oneOf(WIDGET_KEYS, widget))
                return Promise.resolve({ supported: false, requested: false });
            return this.call((p) => p.requestPinWidget({ widget })).then((r) => r || { supported: false, requested: false });
        }
        /** Opens a system settings page (exact alarms, notifications, battery, app info). */
        openSettings(screen) {
            return this.call((p) => p.openSettings({ screen })).then((r) => !!(r && r.opened));
        }
        call(fn) {
            const plugin = this.getPlugin();
            if (!plugin)
                return Promise.resolve(null);
            try {
                return fn(plugin).then((v) => v, () => null);
            }
            catch (e) {
                return Promise.resolve(null);
            }
        }
    }
    /** The Capacitor plugin when this build has it, else null. */
    function pluginFromCapacitor(win) {
        const c = win.Capacitor;
        if (!c || typeof c.isNativePlatform !== 'function' || !c.isNativePlatform())
            return null;
        if (typeof c.isPluginAvailable === 'function' && !c.isPluginAvailable('QuranNative'))
            return null;
        const plugin = c.Plugins ? c.Plugins['QuranNative'] : undefined;
        return plugin ? plugin : null;
    }
    const api = {
        BRIDGE_VERSION, MAX_STATE_CHARS, MAX_REMINDERS, ALL_DAYS,
        KINDS, MODES, PRIORITIES, PRAYER_KEYS, WIDGET_KEYS, PRAYER_METHODS,
        QuranNativeClient, validateReminder, daysMask, defaultCatalog, buildSnapshot, pluginFromCapacitor
    };
    root.QR_NATIVE = new QuranNativeClient(() => pluginFromCapacitor(root));
    root.QR_NATIVE_API = api;
    if (typeof module === 'object' && module)
        module.exports = api;
})(typeof window !== 'undefined' ? window : {});
