// ==================== AQUEOUS - Kitchen Station Manager ====================

const APP_VERSION = 'B2.0';
const APP_BUILD = 124;
let lastSync = localStorage.getItem('aqueous_lastSync') || null;

function updateLastSync() {
    lastSync = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    localStorage.setItem('aqueous_lastSync', lastSync);
    // Update settings display if visible
    const el = document.getElementById('lastSyncDisplay');
    if (el) el.textContent = lastSync;
}

let stations = [];
let editingStationId = null;
let currentView = sessionStorage.getItem('aqueous_currentView') || 'home';
let homeSubTab = localStorage.getItem('aqueous_homeSubTab') || 'stations';
let mlDayStates = {}; // { "YYYY-MM-DD_stationId_ingId": { struck: bool } }
let history = [];
let settings = { vibration: true, sound: true, cookName: '', mascot: 'mascot', wakeLock: true, timerNotifications: true };
let prepTimes = {}; // { "ingredientName": { avgSecPerUnit, bestSecPerUnit, count, baseUnit } }
let ingredientDefaults = {}; // { "ingredientname": { qty: N, unit: "quart" } }
let taskTemplates = {}; // { "ingredientname": { activeFixedSeconds, activeSecondsPerUnit, passiveFixedSeconds, passiveSecondsPerUnit, lastUpdatedAt, calibratedBy, templateVersion } }
let globalIngredients = {}; // { [id]: { name, normKey } }

// Mascot animation tracking
let checkCount = 0;
const mascotAnimations = ['mascot-wiggle', 'mascot-bounce', 'mascot-nod'];

// Multi-task timer state: { "stationId_ingredientId": { seconds, interval, running, ingName, stationId, ingredientId } }
let taskTimers = {};
let blockTimers = {}; // { "high": { seconds, running, interval }, "_all": { ... } }
let summaryStationCollapsed = {}; // { stationId: true/false }
let logsBlockCollapsed = { withData: false, missingData: true };
// Activity log database
let activityLog = JSON.parse(localStorage.getItem('aqueous_activityLog') || '[]');
// Wake Lock to keep screen on during timers
let wakeLock = null;
let historySelectedDate = null;

// Mascot definitions — type: 'video' for mp4, 'image' for png/gif
const MASCOTS = {
    mascot:    { file: 'mascot.png',            name: 'Chef Buddy',   personality: 'The Original',   emoji: '👨‍🍳', type: 'image' },
    explosive: { file: 'mascot-explosive.mp4',  name: 'Fuego',        personality: 'The Explosive',  emoji: '🔥', type: 'video' },
    chill:     { file: 'mascot-rasta.mp4',      name: 'Rasta',        personality: 'The Chill One',  emoji: '🌿', type: 'video' },
    sad:       { file: 'mascot-sad.mp4',        name: 'Onion',        personality: 'The Sad One',    emoji: '😢', type: 'video' },
    excited:   { file: 'mascot-excited.mp4',    name: 'Sparky',       personality: 'The Hyper One',  emoji: '🎉', type: 'video' },
    sexy:      { file: 'mascot-sexy.mp4',       name: 'Smooth',       personality: 'The Flirty One', emoji: '😏', type: 'video' },
    wise:      { file: 'mascot-wise.mp4',       name: 'Umami',        personality: 'The Wise One',   emoji: '🍜', type: 'video' },
    mexican:   { file: 'mascot-mexican.mp4',    name: 'El Jefe',      personality: 'The Arrogant',   emoji: '🇲🇽', type: 'video' }
};

// Debounce utility
let _debounceTimers = {};
function debounce(key, fn, delay) {
    if (_debounceTimers[key]) clearTimeout(_debounceTimers[key]);
    _debounceTimers[key] = setTimeout(fn, delay || 400);
}

// ==================== UNIT CONVERSIONS ====================

const UNIT_TO_OZ = { quart: 32, pint: 16, cup: 8, oz: 1 };
const PAN_UNITS = ['1/9pan', '1/6pan', '1/3pan', '1/2pan', 'fullpan'];
const PAN_OZ = {
    '1/9pan': { 2: 16, 4: 38, 6: 58 },
    '1/6pan': { 2: 26, 4: 58, 6: 92 },
    '1/3pan': { 2: 58, 4: 128, 6: 194 },
    '1/2pan': { 2: 100, 4: 214, 6: 326 },
    'fullpan': { 2: 212, 4: 448, 6: 660 }
};
const UNIT_TO_G = { kg: 1000, lb: 453.592, g: 1 };
const VOLUME_UNITS = ['quart', 'pint', 'cup', 'oz'];
const WEIGHT_UNITS = ['kg', 'lb', 'g'];
const COUNT_UNITS = ['each', 'recipe'];

function getBaseUnit(unit) {
    if (VOLUME_UNITS.includes(unit) || PAN_UNITS.includes(unit)) return 'oz';
    if (WEIGHT_UNITS.includes(unit)) return 'g';
    if (COUNT_UNITS.includes(unit)) return unit;
    return 'unit';
}

function convertToBase(qty, unit, depth) {
    if (PAN_UNITS.includes(unit)) {
        const d = depth || 4;
        const oz = (PAN_OZ[unit] && PAN_OZ[unit][d]) || PAN_OZ[unit][4] || 1;
        return qty * oz;
    }
    if (VOLUME_UNITS.includes(unit)) return qty * (UNIT_TO_OZ[unit] || 1);
    if (WEIGHT_UNITS.includes(unit)) return qty * (UNIT_TO_G[unit] || 1);
    return qty;
}

function formatEstimate(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function getTimerSeconds(t) {
    if (!t) return 0;
    if (t.running) return t.pausedElapsed + Math.floor((Date.now() - t.startedAt) / 1000);
    return t.pausedElapsed;
}

function getBlockRemainingSeconds(bt) {
    if (!bt) return 0;
    const elapsed = bt.running
        ? bt.pausedElapsed + Math.floor((Date.now() - bt.startedAt) / 1000)
        : bt.pausedElapsed;
    return bt.goalSeconds - elapsed;
}

function getIngredientEstimate(ingName, parQty, parUnit, parDepth) {
    const key = ingName.toLowerCase();

    // Check task templates first (active/passive calibrated data)
    const tmpl = taskTemplates[key];
    if (tmpl && (tmpl.activeSecondsPerUnit > 0 || tmpl.passiveSecondsPerUnit > 0)) {
        const baseQty = convertToBase(parQty || 1, parUnit || 'each', parDepth);
        const activeTotal = (tmpl.activeFixedSeconds || 0) + Math.round((tmpl.activeSecondsPerUnit || 0) * baseQty);
        const passiveTotal = (tmpl.passiveFixedSeconds || 0) + Math.round((tmpl.passiveSecondsPerUnit || 0) * baseQty);
        const convFactor = PAN_UNITS.includes(parUnit)
            ? ((PAN_OZ[parUnit] && PAN_OZ[parUnit][parDepth || 4]) || 1)
            : (UNIT_TO_OZ[parUnit] || UNIT_TO_G[parUnit] || 1);
        return {
            activeSeconds: activeTotal,
            passiveSeconds: passiveTotal,
            totalSeconds: activeTotal + passiveTotal,
            bestPerDisplayUnit: Math.round((tmpl.activeSecondsPerUnit || 0) * convFactor),
            displayUnit: parUnit,
            hasTemplate: true
        };
    }

    // Fallback to prepTimes (legacy single-timer data)
    const pt = prepTimes[key];
    if (!pt || !pt.bestSecPerUnit || !parQty || !parUnit) return null;
    const baseUnit = getBaseUnit(parUnit);
    if (pt.baseUnit && pt.baseUnit !== 'unit' && pt.baseUnit !== baseUnit) return null;
    const baseQty = convertToBase(parQty, parUnit, parDepth);
    const estSeconds = Math.round(pt.bestSecPerUnit * baseQty);
    const convFactor = PAN_UNITS.includes(parUnit)
        ? ((PAN_OZ[parUnit] && PAN_OZ[parUnit][parDepth || 4]) || 1)
        : (UNIT_TO_OZ[parUnit] || UNIT_TO_G[parUnit] || 1);
    const bestPerDisplayUnit = Math.round(pt.bestSecPerUnit * convFactor);
    return { totalSeconds: estSeconds, bestPerDisplayUnit, displayUnit: parUnit, hasTemplate: false };
}

function getIngredientBestTime(ingName) {
    const key = ingName.toLowerCase();
    let best = null;
    activityLog.forEach(entry => {
        if (entry.type !== 'task_complete') return;
        if (!entry.data || entry.data.ingredient.toLowerCase() !== key) return;
        const total = entry.data.elapsedSeconds || entry.data.seconds || ((entry.data.activeSeconds || 0) + (entry.data.passiveSeconds || 0));
        if (total > 0 && (best === null || total < best)) best = total;
    });
    return best;
}

function getUnitFamily(unit) {
    if (VOLUME_UNITS.includes(unit)) return 'volume';
    if (WEIGHT_UNITS.includes(unit)) return 'weight';
    return 'other';
}

function shouldHideStopwatch(ingName) {
    const pt = prepTimes[ingName.toLowerCase()];
    if (!pt) return false;
    return (pt.volumeCount || 0) >= 3 || (pt.weightCount || 0) >= 3;
}

function ingredientHasTimingData(ingName) {
    const key = ingName.toLowerCase();
    return !!prepTimes[key] || !!taskTemplates[key];
}

function autoCalcPrepWindow() {
    if (!settings.shiftStart || !settings.serviceTime) return;
    const [sh, sm] = settings.shiftStart.split(':').map(Number);
    const [eh, em] = settings.serviceTime.split(':').map(Number);
    let diffMin = (eh * 60 + em) - (sh * 60 + sm);
    if (diffMin < 0) diffMin += 24 * 60;
    settings.prepWindowMinutes = diffMin;
}

function formatTimeAmPm(timeStr) {
    if (!timeStr) return null;
    const [hh, mm] = timeStr.split(':').map(Number);
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = hh === 0 ? 12 : (hh > 12 ? hh - 12 : hh);
    return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
}

function clockIn() {
    handleClick();
    const now = new Date();
    settings.shiftStart = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    settings.clockInTimestamp = now.getTime();
    autoCalcPrepWindow();
    saveSettings();
    startCountdownBar();
    startPrepNotification();
    requestNotificationPermission();
    refreshSummaryPanel();
    panelDirty.home = true;
    renderPanel('home');
}

function clockOut() {
    handleClick();
    // Confirm before ending shift
    const overlay = document.createElement('div');
    overlay.className = 'time-picker-overlay';
    overlay.innerHTML = `
        <div class="time-picker-panel">
            <div class="tp-title">Stop Timer?</div>
            <p style="font-size:13px;color:var(--text-secondary);margin:16px 0 24px;line-height:1.4;">You want to stop timer?</p>
            <div class="tp-actions">
                <button class="tp-btn tp-cancel" onclick="closeTimePicker()">No</button>
                <button class="tp-btn tp-save" onclick="confirmClockOut()">Yes</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
}

function confirmClockOut() {
    settings.shiftStart = null;
    settings.clockInTimestamp = null;
    settings.prepWindowMinutes = null;
    saveSettings();
    stopCountdownBar();
    clearPrepNotification();
    closeTimePicker();
    refreshSummaryPanel();
    panelDirty.home = true;
    renderPanel('home');
}

// ==================== COUNTDOWN TIMER BAR ====================
let countdownBarInterval = null;

function getCountdownTotalSeconds() {
    const f = calculateFeasibility();
    return f ? f.totalActive : 0;
}

function startCountdownBar() {
    stopCountdownBar();
    countdownBarInterval = setInterval(updateCountdownBar, 1000);
}

function stopCountdownBar() {
    if (countdownBarInterval) {
        clearInterval(countdownBarInterval);
        countdownBarInterval = null;
    }
}

let prepAlarmFired = false;
let prepNotifInterval = null;

function updateCountdownBar() {
    const bar = document.getElementById('countdownBar');
    const label = document.getElementById('countdownLabel');
    if (!bar || !label) return;

    if (!settings.clockInTimestamp) {
        bar.style.width = '100%';
        label.textContent = '';
        return;
    }

    const totalSec = getCountdownTotalSeconds();
    if (totalSec <= 0) {
        bar.style.width = '100%';
        label.textContent = 'No timing data';
        return;
    }

    const elapsedSec = Math.floor((Date.now() - settings.clockInTimestamp) / 1000);
    const remainingSec = Math.max(0, totalSec - elapsedSec);
    const pct = Math.max(0, (remainingSec / totalSec) * 100);

    bar.style.width = pct + '%';

    if (remainingSec <= 0) {
        label.textContent = 'Time is up!';
        bar.style.width = '0%';
        if (!prepAlarmFired) {
            prepAlarmFired = true;
            playAlarm();
        }
    } else {
        const m = Math.floor(remainingSec / 60);
        const s = remainingSec % 60;
        label.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }
}

function playAlarm() {
    try {
        const ctx = getAudioCtx();
        const duration = 1.5;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.3);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.6);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.9);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 1.2);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + duration);
    } catch (e) {}
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
}

function startPrepNotification() {
    clearPrepNotification();
    prepAlarmFired = false;
    updatePrepNotification();
    prepNotifInterval = setInterval(updatePrepNotification, 1000);
}

function clearPrepNotification() {
    if (prepNotifInterval) {
        clearInterval(prepNotifInterval);
        prepNotifInterval = null;
    }
    sendSWMessage({ type: 'PREP_TIMER_CLEAR' });
}

function updatePrepNotification() {
    if (!settings.clockInTimestamp) return;
    if (!settings.timerNotifications) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const totalSec = getCountdownTotalSeconds();
    if (totalSec <= 0) return;

    const elapsedSec = Math.floor((Date.now() - settings.clockInTimestamp) / 1000);
    const remainingSec = Math.max(0, totalSec - elapsedSec);

    let body;
    if (remainingSec <= 0) {
        body = 'Time is up!';
    } else {
        const m = Math.floor(remainingSec / 60);
        const s = remainingSec % 60;
        body = `${m}:${String(s).padStart(2, '0')} remaining`;
    }

    sendSWMessage({
        type: 'PREP_TIMER_UPDATE',
        body,
        timeUp: remainingSec <= 0
    });
}

function openTimePicker(field) {
    handleClick();
    const current = settings[field] || '12:00';
    let [hh, mm] = current.split(':').map(Number);
    const label = field === 'shiftStart' ? 'Shift Start' : 'Service';

    const overlay = document.createElement('div');
    overlay.className = 'time-picker-overlay';
    overlay.innerHTML = `
        <div class="time-picker-panel">
            <div class="tp-title">${label}</div>
            <div class="tp-scroll-area">
                <div class="tp-col">
                    <button class="tp-arrow" onclick="tpAdjust('h',1)">&#9650;</button>
                    <span class="tp-digit" id="tpHour">${hh === 0 ? 12 : (hh > 12 ? hh - 12 : hh)}</span>
                    <button class="tp-arrow" onclick="tpAdjust('h',-1)">&#9660;</button>
                </div>
                <span class="tp-sep">:</span>
                <div class="tp-col">
                    <button class="tp-arrow" onclick="tpAdjust('m',1)">&#9650;</button>
                    <span class="tp-digit" id="tpMin">${String(mm).padStart(2,'0')}</span>
                    <button class="tp-arrow" onclick="tpAdjust('m',-1)">&#9660;</button>
                </div>
                <button class="tp-ampm-btn" id="tpAmpm" onclick="tpToggleAmPm()">${hh >= 12 ? 'PM' : 'AM'}</button>
            </div>
            <div class="tp-actions">
                <button class="tp-btn tp-cancel" onclick="closeTimePicker()">Cancel</button>
                <button class="tp-btn tp-save" onclick="saveTimePicker()">Set</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    window._tpField = field;
    window._tpH = hh;
    window._tpM = mm;
}

function tpAdjust(part, delta) {
    handleClick();
    if (part === 'h') {
        window._tpH = (window._tpH + delta + 24) % 24;
    } else {
        window._tpM += delta * 5;
        if (window._tpM >= 60) { window._tpM = 0; window._tpH = (window._tpH + 1) % 24; }
        if (window._tpM < 0) { window._tpM = 55; window._tpH = (window._tpH - 1 + 24) % 24; }
    }
    const h = window._tpH;
    document.getElementById('tpHour').textContent = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    document.getElementById('tpMin').textContent = String(window._tpM).padStart(2, '0');
    document.getElementById('tpAmpm').textContent = h >= 12 ? 'PM' : 'AM';
}

function tpToggleAmPm() {
    handleClick();
    window._tpH = (window._tpH + 12) % 24;
    document.getElementById('tpAmpm').textContent = window._tpH >= 12 ? 'PM' : 'AM';
    const h = window._tpH;
    document.getElementById('tpHour').textContent = h === 0 ? 12 : (h > 12 ? h - 12 : h);
}

function saveTimePicker() {
    handleClick();
    settings[window._tpField] = `${String(window._tpH).padStart(2,'0')}:${String(window._tpM).padStart(2,'0')}`;
    autoCalcPrepWindow();
    saveSettings();
    closeTimePicker();
    refreshSummaryPanel();
    panelDirty.home = true;
    renderPanel('home');
}

function closeTimePicker() {
    const overlay = document.querySelector('.time-picker-overlay');
    if (overlay) {
        overlay.classList.remove('open');
        setTimeout(() => overlay.remove(), 200);
    }
}

function toggleSummaryStation(stationId) {
    handleClick();
    summaryStationCollapsed[stationId] = !summaryStationCollapsed[stationId];
    refreshSummaryPanel();
}

// ==================== DISH HELPERS ====================

function getAllIngredients(station) {
    if (station.dishes) {
        const all = [];
        station.dishes.forEach(dish => {
            (dish.ingredients || []).forEach(ing => all.push(ing));
        });
        return all;
    }
    return station.ingredients || [];
}

function findDishForIngredient(station, ingredientId) {
    if (!station.dishes) return null;
    return station.dishes.find(dish =>
        (dish.ingredients || []).some(ing => ing.id === ingredientId)
    ) || null;
}

function getDefaultDish(station) {
    if (!station.dishes || station.dishes.length === 0) return null;
    return station.dishes[0];
}

function normalizeIngredientKey(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function registerGlobalIngredient(id, name) {
    globalIngredients[id] = { name, normKey: normalizeIngredientKey(name) };
}

function saveGlobalIngredients() {
    localStorage.setItem('aqueous_globalIngredients', JSON.stringify(globalIngredients));
}

// PWA Install
let deferredPrompt = null;

// ==================== HAPTICS & SOUND ====================

let audioCtx = null;

function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function playClick() {
    if (!settings.sound) return;
    try {
        const ctx = getAudioCtx();
        const bufferSize = ctx.sampleRate * 0.03;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        // Realistic click: sharp noise burst with fast decay
        for (let i = 0; i < bufferSize; i++) {
            const t = i / ctx.sampleRate;
            const envelope = Math.exp(-t * 200);
            data[i] = (Math.random() * 2 - 1) * envelope * 0.3;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        // Band-pass filter for crisp click
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 3000;
        filter.Q.value = 1.2;
        const gain = ctx.createGain();
        gain.gain.value = 0.6;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        source.start(ctx.currentTime);
    } catch (e) {}
}

function vibrate(ms) {
    if (!settings.vibration) return;
    if (navigator.vibrate) navigator.vibrate(ms || 18);
}

function handleClick() {
    vibrate(18);
    playClick();
}

function animateMascot() {
    checkCount++;
    // Animate every 2-3 checks (random feel)
    if (checkCount % (2 + Math.floor(Math.random() * 2)) !== 0) return;
    const container = document.getElementById('mascotContainer');
    if (!container) return;
    const anim = mascotAnimations[Math.floor(Math.random() * mascotAnimations.length)];
    container.classList.remove(...mascotAnimations);
    void container.offsetWidth; // force reflow
    container.classList.add(anim);
    setTimeout(() => container.classList.remove(anim), 700);
}

// ==================== PWA INSTALL ====================

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Show install banner after short delay
    const dismissed = localStorage.getItem('aqueous_install_dismissed');
    if (!dismissed) {
        setTimeout(() => {
            const banner = document.getElementById('installBanner');
            if (banner) banner.classList.remove('hidden');
        }, 3000);
    }
});

function installPWA() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(result => {
        if (result.outcome === 'accepted') {
            showToast('App installed!');
        }
        deferredPrompt = null;
        const banner = document.getElementById('installBanner');
        if (banner) banner.classList.add('hidden');
    });
}

function dismissInstall() {
    const banner = document.getElementById('installBanner');
    if (banner) banner.classList.add('hidden');
    localStorage.setItem('aqueous_install_dismissed', '1');
}

// ==================== INITIALIZATION ====================

function initApp() {
    loadData();
    mlLoadDayStates();
    processCarryOver();
    updateHeader();

    // Check URL params (e.g. opened from notification)
    const urlParams = new URLSearchParams(window.location.search);
    const viewParam = urlParams.get('view');
    if (viewParam && SWIPE_VIEW_ORDER.includes(viewParam)) {
        currentView = viewParam;
        window.history.replaceState(null, '', window.location.pathname);
    }

    // Restore saved view and nav highlight
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => item.classList.remove('active'));
    if (currentView === 'timer') currentView = 'logs'; // legacy redirect
    if (OVERLAY_VIEWS.includes(currentView)) currentView = 'home';
    if (currentView === 'home') navItems[0].classList.add('active');
    else if (currentView === 'summary') navItems[1].classList.add('active');
    else if (currentView === 'logs') navItems[2].classList.add('active');
    else if (currentView === 'history') navItems[3].classList.add('active');
    if (currentView === 'share') currentView = 'home';

    // Position track instantly (no animation) and render initial panel
    slideTrackTo(currentView, false);
    renderPanel(currentView);

    // Resume prep timer notification if active
    if (settings.clockInTimestamp) {
        startPrepNotification();
    }

    // First time: ask cook name
    if (!settings.cookName) {
        setTimeout(() => showNameSetup(), 500);
    }
}

function showNameSetup() {
    const existing = document.getElementById('modalNameSetup');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalNameSetup';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Welcome, Chef!</div>
            <p style="font-size:13px;color:var(--text-secondary);margin-bottom:20px;">What should we call you?</p>
            <div class="form-group">
                <input type="text" id="setupCookName" class="form-control" placeholder="Your name" style="text-align:center;font-size:16px;">
            </div>
            <button class="btn btn-primary squishy" onclick="handleClick(); saveCookName()">Let's Cook!</button>
        </div>`;
    document.body.appendChild(modal);
    setTimeout(() => { const input = document.getElementById('setupCookName'); if (input) input.focus(); }, 300);
}

function saveCookName() {
    const input = document.getElementById('setupCookName');
    const name = input ? input.value.trim() : '';
    if (!name) { showToast('Enter your name, chef!'); return; }
    settings.cookName = name;
    saveSettings();
    const modal = document.getElementById('modalNameSetup');
    if (modal) modal.remove();
    updateHeader();
    showToast(`Welcome, ${name}!`);
}

function updateHeader() {
    showDate();
    // Update cook name display
    const nameEl = document.getElementById('cookNameDisplay');
    if (nameEl) nameEl.textContent = settings.cookName || '';
    // Update mascot (image or video) with fallback + gear icon
    const container = document.getElementById('mascotContainer');
    if (container) {
        const m = MASCOTS[settings.mascot] || MASCOTS.mascot;
        const gearSvg = `<div class="mascot-gear"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg></div>`;
        if (m.type === 'video') {
            container.innerHTML = gearSvg + `<video src="${m.file}" class="header-mascot" autoplay loop muted playsinline onerror="this.outerHTML='<div class=\\'header-mascot mascot-fallback\\'>${m.emoji}</div>'"></video>`;
        } else {
            container.innerHTML = gearSvg + `<img src="${m.file}" alt="${m.name}" class="header-mascot" onerror="this.outerHTML='<div class=\\'header-mascot mascot-fallback\\'>${m.emoji}</div>'">`;
        }
    }
}

function showDate() {
    const today = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const el = document.getElementById('dateDisplay');
    if (el) el.textContent = today.toLocaleDateString('en-US', options);
}

// ==================== DATA PERSISTENCE ====================

function loadData() {
    const saved = localStorage.getItem('aqueous_stations');
    if (saved) {
        stations = JSON.parse(saved);
    } else {
        const defaultIngs = [
            { id: 1, name: 'Fresno Chili' },
            { id: 2, name: 'Lemongrass' },
            { id: 3, name: 'Pistachio (sliced)' },
            { id: 4, name: 'Paobon' },
            { id: 5, name: 'Asparagus' },
            { id: 6, name: 'Green Onions' },
            { id: 7, name: 'Pistachio (ground)' },
            { id: 8, name: 'Lemon' },
            { id: 9, name: 'King Trumpet' },
            { id: 10, name: 'Pavé' },
            { id: 11, name: 'Broccoli' }
        ];
        stations = [{
            id: Date.now(),
            name: 'My Station',
            dishes: [{ id: Date.now() + 1, name: 'General', sortOrder: 0, expanded: true, ingredients: defaultIngs }],
            status: {}
        }];
        getAllIngredients(stations[0]).forEach(ing => {
            stations[0].status[ing.id] = { low: false, priority: null, parLevel: '', completed: false };
        });
        saveData(true);
    }

    // --- Migration: flat ingredients[] → dishes[] ---
    let migrated = false;
    stations.forEach(station => {
        if (station.ingredients && !station.dishes) {
            station.dishes = [{
                id: Date.now() + Math.floor(Math.random() * 10000),
                name: 'General',
                sortOrder: 0,
                expanded: true,
                ingredients: station.ingredients
            }];
            delete station.ingredients;
            migrated = true;
        }
    });

    // Build globalIngredients from all stations/dishes
    const savedGlobal = localStorage.getItem('aqueous_globalIngredients');
    if (savedGlobal) {
        globalIngredients = JSON.parse(savedGlobal);
    }
    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            if (!globalIngredients[ing.id]) {
                registerGlobalIngredient(ing.id, ing.name);
            }
        });
    });
    saveGlobalIngredients();

    if (migrated) saveData(true);

    const savedHistory = localStorage.getItem('aqueous_history');
    if (savedHistory) {
        history = JSON.parse(savedHistory);
    }

    const savedSettings = localStorage.getItem('aqueous_settings');
    if (savedSettings) {
        const s = JSON.parse(savedSettings);
        settings = { vibration: true, sound: true, cookName: '', mascot: 'mascot', ...s };
    }

    const savedPrepTimes = localStorage.getItem('aqueous_prep_times');
    if (savedPrepTimes) {
        prepTimes = JSON.parse(savedPrepTimes);
        // Migration: backfill volumeCount/weightCount from activityLog
        Object.keys(prepTimes).forEach(key => {
            const pt = prepTimes[key];
            if (pt.volumeCount === undefined) {
                let vc = 0, wc = 0;
                activityLog.forEach(entry => {
                    if (entry.type !== 'task_complete' || !entry.data) return;
                    if ((entry.data.ingredient || '').toLowerCase() !== key) return;
                    if ((entry.data.seconds || 0) <= 0 && !(entry.data.activeSeconds > 0)) return;
                    const fam = getUnitFamily(entry.data.unit);
                    if (fam === 'volume') vc++;
                    else if (fam === 'weight') wc++;
                });
                pt.volumeCount = Math.min(vc, 3);
                pt.weightCount = Math.min(wc, 3);
            }
        });
    }

    const savedDefaults = localStorage.getItem('aqueous_ingredient_defaults');
    if (savedDefaults) {
        ingredientDefaults = JSON.parse(savedDefaults);
    }

    // --- Migration: backfill new fields ---
    stations.forEach(station => {
        Object.keys(station.status).forEach(id => {
            const st = station.status[id];
            if (st.parQty === undefined) {
                // Parse existing parLevel "2 quart" → parQty + parUnit
                const match = (st.parLevel || '').match(/^([\d.]+)\s*(.+)$/);
                st.parQty = match ? parseFloat(match[1]) : null;
                st.parUnit = match ? match[2].trim() : '';
                st.parNotes = '';
            }
        });
    });

    // Backfill prepTimes with bestSecPerUnit and baseUnit
    Object.keys(prepTimes).forEach(key => {
        const pt = prepTimes[key];
        if (pt.bestSecPerUnit === undefined) pt.bestSecPerUnit = pt.avgSecPerUnit;
        if (pt.baseUnit === undefined) pt.baseUnit = 'unit';
        if (pt.baseUnit === 'batch') pt.baseUnit = 'recipe';
        if (pt.baseUnit === 'lb') {
            pt.avgSecPerUnit = pt.avgSecPerUnit / 453.592;
            pt.bestSecPerUnit = pt.bestSecPerUnit / 453.592;
            pt.baseUnit = 'g';
        }
    });
    savePrepTimes();

    // Migrate parUnit batch → recipe
    stations.forEach(station => {
        Object.values(station.status || {}).forEach(st => {
            if (st.parUnit === 'batch') st.parUnit = 'recipe';
        });
    });

    // Load task templates
    const savedTemplates = localStorage.getItem('aqueous_taskTemplates');
    if (savedTemplates) taskTemplates = JSON.parse(savedTemplates);
}

function savePrepTimes() {
    localStorage.setItem('aqueous_prep_times', JSON.stringify(prepTimes));
}

function saveTaskTemplates() {
    localStorage.setItem('aqueous_taskTemplates', JSON.stringify(taskTemplates));
}

function saveIngredientDefaults() {
    localStorage.setItem('aqueous_ingredient_defaults', JSON.stringify(ingredientDefaults));
}

function saveSettings() {
    localStorage.setItem('aqueous_settings', JSON.stringify(settings));
}

function saveData(silent) {
    localStorage.setItem('aqueous_stations', JSON.stringify(stations));
    saveGlobalIngredients();
    markAllPanelsDirty();
    if (!silent) showToast('Saved');
}

function saveHistory() {
    localStorage.setItem('aqueous_history', JSON.stringify(history));
}

// ==================== DAILY CARRY-OVER ====================

function processCarryOver() {
    const today = new Date().toDateString();
    const lastDate = localStorage.getItem('aqueous_last_date');

    if (lastDate && lastDate !== today) {
        // Save yesterday's snapshot to history
        saveSnapshotToHistory(lastDate);

        // Carry over uncompleted items: increase priority to high
        stations.forEach(station => {
            getAllIngredients(station).forEach(ing => {
                const st = station.status[ing.id];
                if (st && st.low && !st.completed) {
                    st.priority = 'high';
                }
                if (st) st.completed = false;
            });
        });
        saveData(true);
        cleanOldHistory();
    }

    localStorage.setItem('aqueous_last_date', today);
}

function saveSnapshotToHistory(dateStr) {
    const snapshot = {
        date: dateStr,
        stations: JSON.parse(JSON.stringify(stations))
    };
    history.unshift(snapshot);
    if (history.length > 7) history = history.slice(0, 7);
    saveHistory();
}

function cleanOldHistory() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    history = history.filter(h => new Date(h.date) >= sevenDaysAgo);
    saveHistory();
}

// ==================== VIEW MANAGEMENT ====================

let previousView = 'home';
let skipPopstate = false;

const SWIPE_VIEW_ORDER = ['home', 'summary', 'logs', 'history'];
const SWIPE_PANELS = { home: 'panelHome', summary: 'panelSummary', logs: 'panelLogs', history: 'panelHistory' };
const OVERLAY_VIEWS = ['settings', 'logDetail'];
// Track which panels have been rendered at least once
const panelDirty = { home: true, summary: true, logs: true, history: true };

function resolveSwipeView(v) {
    if (v === 'logDetail') return 'logs';
    if (v === 'settings') return null;
    return v;
}

function getPanel(view) {
    return document.getElementById(SWIPE_PANELS[view] || '');
}

function slideTrackTo(view, animate) {
    const idx = SWIPE_VIEW_ORDER.indexOf(view);
    if (idx === -1) return;
    const track = document.getElementById('swipeTrack');
    if (animate) {
        track.classList.add('snapping');
        const onEnd = () => { track.removeEventListener('transitionend', onEnd); track.classList.remove('snapping'); };
        track.addEventListener('transitionend', onEnd);
    }
    track.style.transform = `translateX(-${idx * 25}%)`;
}

function showOverlay(show) {
    const overlay = document.getElementById('panelOverlay');
    if (show) {
        // Start at bottom, then animate up
        overlay.style.transform = 'translateY(100%)';
        overlay.classList.add('open');
        // Force reflow so the browser registers the start position
        overlay.offsetHeight;
        overlay.classList.add('animating');
        overlay.style.transform = '';
        const onEnd = () => { overlay.removeEventListener('transitionend', onEnd); overlay.classList.remove('animating'); };
        overlay.addEventListener('transitionend', onEnd);
    } else {
        // Instant hide (used by nav-bar clicks)
        overlay.classList.remove('open', 'animating');
        overlay.innerHTML = '';
        overlay.style.transform = '';
    }
}

function dismissOverlay() {
    const overlay = document.getElementById('panelOverlay');
    overlay.classList.add('animating');
    overlay.style.transform = 'translateY(100%)';
    overlay.addEventListener('transitionend', function handler() {
        overlay.removeEventListener('transitionend', handler);
        overlay.classList.remove('open', 'animating');
        overlay.innerHTML = '';
        overlay.style.transform = '';
        // Navigate back to previous swipe view
        const target = previousView || 'home';
        currentView = target;
        sessionStorage.setItem('aqueous_currentView', target);
        document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
        const navItems = document.querySelectorAll('.nav-item');
        const idx = SWIPE_VIEW_ORDER.indexOf(target);
        if (idx >= 0 && navItems[idx]) navItems[idx].classList.add('active');
    });
}

function markAllPanelsDirty() {
    panelDirty.home = true;
    panelDirty.summary = true;
    panelDirty.logs = true;
    panelDirty.history = true;
}

function switchView(view, skipSlide) {
    // Toggle: if tapping mascot while already in settings, go back
    if (view === 'settings' && currentView === 'settings') {
        skipPopstate = true;
        window.history.back();
        view = previousView || 'home';
    }

    // Save previous view (but not settings itself)
    if (currentView !== 'settings' && !OVERLAY_VIEWS.includes(currentView)) {
        previousView = currentView;
    }

    // Hide overlay when leaving overlay views
    if (OVERLAY_VIEWS.includes(currentView) && !OVERLAY_VIEWS.includes(view)) {
        showOverlay(false);
    }

    if (view === 'timer') view = 'logs'; // legacy redirect
    currentView = view;
    sessionStorage.setItem('aqueous_currentView', view);

    // Nav highlight
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const navItems = document.querySelectorAll('.nav-item');
    if (view === 'home') navItems[0].classList.add('active');
    else if (view === 'summary') navItems[1].classList.add('active');
    else if (view === 'logs') navItems[2].classList.add('active');
    else if (view === 'history') navItems[3].classList.add('active');
    else if (view === 'settings') { window.history.pushState({ view: 'settings' }, ''); }
    else if (view === 'logDetail') navItems[2].classList.add('active');

    // Overlay views (settings, logDetail)
    if (OVERLAY_VIEWS.includes(view)) {
        const overlay = document.getElementById('panelOverlay');
        showOverlay(true);
        if (view === 'settings') renderSettings(overlay);
        else if (view === 'logDetail') renderLogDetail(overlay);
        // Prepend pull bar for drag-to-dismiss
        const bar = document.createElement('div');
        bar.className = 'overlay-pull-bar';
        overlay.prepend(bar);
        overlay.scrollTop = 0;
        return;
    }

    // Swipe views — slide track + render if needed
    if (!skipSlide) slideTrackTo(view, true);
    renderPanel(view);
}

function renderPanel(view) {
    const panel = getPanel(view);
    if (!panel) return;
    document.getElementById('fab').style.display = 'none';

    // Only re-render if dirty (data changed) or never rendered
    if (!panelDirty[view]) return;
    panelDirty[view] = false;

    const scrollBefore = panel.scrollTop;
    if (view === 'home') renderHome(panel);
    else if (view === 'summary') renderSummary(panel);
    else if (view === 'logs') renderLogs(panel);
    else if (view === 'history') renderHistoryTab(panel);
    panel.scrollTop = scrollBefore;
}

function renderCurrentView() {
    if (OVERLAY_VIEWS.includes(currentView)) {
        const overlay = document.getElementById('panelOverlay');
        if (currentView === 'settings') renderSettings(overlay);
        else if (currentView === 'logDetail') renderLogDetail(overlay);
    } else {
        panelDirty[currentView] = true;
        renderPanel(currentView);
    }
}

function refreshSummaryPanel() {
    const panel = document.getElementById('panelSummary');
    if (!panel) return;
    const scrollBefore = panel.scrollTop;
    renderSummary(panel);
    panel.scrollTop = scrollBefore;
}

// ==================== HOME VIEW ====================

function switchHomeSubTab(tab) {
    handleClick();
    homeSubTab = tab;
    localStorage.setItem('aqueous_homeSubTab', tab);
    panelDirty.home = true;
    renderPanel('home');
}

function renderHome(container) {
    autoCalcPrepWindow();
    const timerOn = !!settings.shiftStart;

    let content = '';
    if (homeSubTab === 'master') {
        content = renderMasterListView();
    } else {
        content = renderStationsView();
    }

    container.innerHTML = `
        <div class="home-tab-sticky">
            <div class="home-tab-switch">
                <button class="home-tab-btn ${homeSubTab === 'stations' ? 'active' : ''}" onclick="switchHomeSubTab('stations')">Stations</button>
                <button class="home-tab-btn ${homeSubTab === 'master' ? 'active' : ''}" onclick="switchHomeSubTab('master')">Master List</button>
            </div>
            ${homeSubTab === 'master' ? `
            <div class="home-timer-row">
                <span class="timer-label">Timer</span>
                <span class="countdown-label" id="countdownLabel"></span>
                <button class="neu-toggle ${timerOn ? 'active' : ''}"
                    onclick="${timerOn ? 'clockOut()' : 'clockIn()'}"></button>
            </div>
            <div class="countdown-bar-container">
                <div class="countdown-bar" id="countdownBar" style="width: 100%"></div>
            </div>` : ''}
        </div>
        <div class="home-tab-content">${content}</div>`;

    // Kick off countdown bar if shift is active
    if (settings.clockInTimestamp) {
        updateCountdownBar();
        startCountdownBar();
    }

    if (homeSubTab === 'stations') {
        expandedIngs.forEach(key => {
            const ctrl = document.getElementById(`ing-ctrl-${key}`);
            if (ctrl) ctrl.classList.add('open');
        });
    }
}

function renderStationsView() {
    if (stations.length === 0) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <p>No stations created</p>
                <p class="empty-sub">Go to Settings ⚙️ to add a station</p>
            </div>`;
    }

    let html = '';
    stations.forEach(station => {
        const lowCount = Object.values(station.status).filter(s => s.low).length;
        const totalCount = getAllIngredients(station).length;
        const isExpanded = station.expanded !== false;
        const allDone = lowCount > 0 && lowCount === totalCount;

        html += `
        <div class="neu-card station-card">
            <div class="station-header"
                 onclick="toggleStation(${station.id})"
                 ontouchstart="startStationLongPress(event, ${station.id})"
                 ontouchend="cancelStationLongPress()"
                 ontouchmove="cancelStationLongPress()"
                 oncontextmenu="if(!event.target.closest('.expand-toggle')){event.preventDefault(); event.stopPropagation(); showRenameStationModal(${station.id})}">
                <div class="station-header-left">
                    <span class="station-name">${station.name}</span>
                    <span class="station-count${allDone ? ' all-done' : ''}" id="stationCount-${station.id}">${lowCount}/${totalCount}</span>
                </div>
                <div class="station-header-right">
                    <span class="expand-toggle" id="expandToggle-${station.id}">${isExpanded ? '−' : '+'}</span>
                </div>
            </div>
            <div class="station-body ${isExpanded ? '' : 'collapsed'}" id="body-${station.id}">
                ${renderIngredients(station)}
                ${stationFooter(station.id)}
            </div>
        </div>`;
    });
    return html;
}

// ── Master List Day States (strike only, per day) ──

function mlGetDateKey() {
    return new Date().toISOString().slice(0, 10);
}

function mlLoadDayStates() {
    const dateKey = mlGetDateKey();
    const saved = localStorage.getItem('aqueous_mlDayStates');
    if (saved) {
        const all = JSON.parse(saved);
        mlDayStates = {};
        Object.entries(all).forEach(([k, v]) => {
            if (k.startsWith(dateKey + '_')) mlDayStates[k] = v;
        });
    } else {
        mlDayStates = {};
    }
}

function mlSaveDayStates() {
    const dateKey = mlGetDateKey();
    const toSave = {};
    Object.entries(mlDayStates).forEach(([k, v]) => {
        if (k.startsWith(dateKey + '_')) toSave[k] = v;
    });
    localStorage.setItem('aqueous_mlDayStates', JSON.stringify(toSave));
}

function mlStateKey(stationId, ingredientId) {
    return `${mlGetDateKey()}_${stationId}_${ingredientId}`;
}

function mlIsStruck(stationId, ingredientId) {
    const ds = mlDayStates[mlStateKey(stationId, ingredientId)];
    return ds ? ds.struck : false;
}

// ── Master List Interactions ──

let mlSwipeState = null;

function mlToggleStrike(stationId, ingredientId) {
    handleClick();
    const key = mlStateKey(stationId, ingredientId);
    const isStruck = mlIsStruck(stationId, ingredientId);
    if (!isStruck) {
        mlDayStates[key] = { struck: true };
    } else {
        delete mlDayStates[key];
    }
    mlSaveDayStates();
    const row = document.getElementById(`ml-${stationId}-${ingredientId}`);
    if (row) row.classList.toggle('ml-struck', !isStruck);
}

function mlSwipeStart(e, stationId, ingredientId) {
    if (mlSwipeState) return;
    const touch = e.touches ? e.touches[0] : e;
    const row = document.getElementById(`ml-${stationId}-${ingredientId}`);
    if (!row) return;

    // Long-press gate: start a timer, only activate swipe after 250ms hold
    const pending = {
        stationId,
        ingredientId,
        startX: touch.clientX,
        startY: touch.clientY,
        row,
        width: row.offsetWidth,
        activated: false,
        cancelled: false,
        timer: null
    };

    pending.timer = setTimeout(() => {
        if (!pending.cancelled) {
            pending.activated = true;
            row.classList.add('ml-swipe-active');
        }
    }, 250);

    mlSwipeState = pending;
    document.addEventListener('touchmove', mlSwipeMove, { passive: false });
    document.addEventListener('touchend', mlSwipeEnd);
    document.addEventListener('touchcancel', mlSwipeEnd);
}

function mlSwipeMove(e) {
    if (!mlSwipeState) return;
    const touch = e.touches[0];
    const dx = touch.clientX - mlSwipeState.startX;
    const dy = touch.clientY - mlSwipeState.startY;

    // If user moves vertically before activation, cancel swipe and allow scroll
    if (!mlSwipeState.activated) {
        if (Math.abs(dy) > 8) {
            mlSwipeState.cancelled = true;
            clearTimeout(mlSwipeState.timer);
            mlCleanupListeners();
            mlSwipeState = null;
            return;
        }
        return; // Not activated yet, don't move anything
    }

    e.preventDefault();
    // Swipe RIGHT only
    const clampedDx = Math.max(0, dx);
    mlSwipeState.currentX = touch.clientX;
    mlSwipeState.row.style.transform = `translateX(${clampedDx}px)`;
    mlSwipeState.row.style.transition = 'none';

    const pct = clampedDx / mlSwipeState.width;
    mlSwipeState.row.classList.toggle('ml-swipe-delete', pct > 0.35);
}

function mlSwipeEnd() {
    if (!mlSwipeState) return;
    clearTimeout(mlSwipeState.timer);
    mlCleanupListeners();

    const row = mlSwipeState.row;
    const wasActivated = mlSwipeState.activated;

    if (!wasActivated) {
        // Never activated — treat as a normal tap
        row.classList.remove('ml-swipe-active');
        mlSwipeState = null;
        return;
    }

    // Recalculate from row's current transform
    const transform = row.style.transform;
    const match = transform && transform.match(/translateX\(([\d.]+)px\)/);
    const actualDx = match ? parseFloat(match[1]) : 0;
    const pct = actualDx / mlSwipeState.width;

    if (pct > 0.35) {
        row.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        row.style.transform = `translateX(${mlSwipeState.width}px)`;
        row.style.opacity = '0';
        const { stationId, ingredientId } = mlSwipeState;
        mlSwipeState = null;
        setTimeout(() => mlDeleteItem(stationId, ingredientId), 220);
    } else {
        row.style.transition = 'transform 0.25s ease';
        row.style.transform = 'translateX(0)';
        row.classList.remove('ml-swipe-delete', 'ml-swipe-active');
        mlSwipeState = null;
    }
}

function mlCleanupListeners() {
    document.removeEventListener('touchmove', mlSwipeMove);
    document.removeEventListener('touchend', mlSwipeEnd);
    document.removeEventListener('touchcancel', mlSwipeEnd);
}

function mlDeleteItem(stationId, ingredientId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const st = station.status[ingredientId];
    const ing = getAllIngredients(station).find(i => i.id === ingredientId);

    logActivity('task_complete', {
        ingredient: ing ? ing.name : '',
        station: station.name, seconds: 0, quantity: 0, secPerUnit: 0
    });

    // Auto-clean station data
    if (st) {
        const pLevel = st.priority || 'none';
        st.completed = false;
        st.priority = null;
        st.low = false;
        saveData(true);
        animateMascot();
        checkBlockCompletion(pLevel);
        refreshSummaryPanel();
    }

    // Remove strike state if any
    const key = mlStateKey(stationId, ingredientId);
    delete mlDayStates[key];
    mlSaveDayStates();

    panelDirty.home = true;
    renderPanel('home');
}

// ── Master List Render ──

function getTimeForMasterList(ingName, parQty, parUnit, parDepth) {
    const est = getIngredientEstimate(ingName, parQty, parUnit, parDepth);
    if (est && est.totalSeconds > 0) return est.totalSeconds;
    const best = getIngredientBestTime(ingName);
    return (best && best > 0) ? best : null;
}

function renderMasterListView() {
    mlLoadDayStates();

    // Collect active items grouped by station
    const stationGroups = [];
    stations.forEach(station => {
        const items = [];
        getAllIngredients(station).forEach(ing => {
            const st = station.status[ing.id];
            if (!st || !st.low || !st.priority) return;
            items.push({
                stationId: station.id,
                ingredientId: ing.id,
                name: ing.name,
                priority: st.priority,
                parQty: st.parQty,
                parUnit: st.parUnit,
                parDepth: st.parDepth,
                struck: mlIsStruck(station.id, ing.id),
                timeEstimate: getTimeForMasterList(ing.name, st.parQty, st.parUnit, st.parDepth)
            });
        });
        if (items.length > 0) {
            const priOrder = { high: 0, medium: 1, low: 2 };
            items.sort((a, b) => {
                const pa = priOrder[a.priority] ?? 3;
                const pb = priOrder[b.priority] ?? 3;
                if (pa !== pb) return pa - pb;
                return a.name.localeCompare(b.name);
            });
            stationGroups.push({ name: station.name, items });
        }
    });

    if (stationGroups.length === 0) {
        return `
            <div class="empty-state">
                <p style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px;">All clear</p>
                <p class="empty-sub">No active tasks — set priorities in Stations</p>
            </div>`;
    }

    let html = '';
    stationGroups.forEach(group => {
        html += `<div class="ml-station-label">${group.name}</div>`;
        group.items.forEach(item => {
            html += mlRenderRow(item);
        });
    });

    return html;
}

function mlRenderRow(item) {
    const dotClass = `priority-dot ${item.priority}`;
    const qtyDisplay = item.parQty && item.parUnit
        ? `${item.parQty} ${PAN_UNITS.includes(item.parUnit) ? (item.parDepth || 4) + '" ' + item.parUnit : item.parUnit}`
        : (item.parQty ? `${item.parQty}` : '');
    const struckClass = item.struck ? ' ml-struck' : '';
    const timePill = item.timeEstimate
        ? `<span class="ml-time">${formatTime(item.timeEstimate)}</span>`
        : '';

    return `
    <div class="ml-row${struckClass}" id="ml-${item.stationId}-${item.ingredientId}"
         onclick="mlToggleStrike(${item.stationId}, ${item.ingredientId})"
         ontouchstart="mlSwipeStart(event, ${item.stationId}, ${item.ingredientId})">
        <span class="${dotClass}"></span>
        <span class="ml-name">${item.name}</span>
        ${qtyDisplay ? `<span class="ml-qty">${qtyDisplay}</span>` : ''}
        ${timePill}
    </div>`;
}

function renderIngredients(station) {
    if (!station.dishes || station.dishes.length === 0) return '';
    const singleDish = station.dishes.length === 1;
    let html = '';
    station.dishes.forEach(dish => {
        const dishIngs = dish.ingredients || [];
        const dishLow = dishIngs.filter(ing => station.status[ing.id] && station.status[ing.id].low).length;
        const dishTotal = dishIngs.length;
        const isDishExpanded = dish.expanded !== false;
        if (singleDish) {
            html += renderDishIngredients(station, dish);
        } else {
            html += `
            <div class="dish-folder" data-station-id="${station.id}" data-dish-id="${dish.id}">
                <div class="dish-header" onclick="toggleDish(${station.id}, ${dish.id})"
                     oncontextmenu="event.preventDefault(); event.stopPropagation(); showDishContextMenu(event, ${station.id}, ${dish.id})">
                    <span class="dish-toggle">${isDishExpanded ? '▾' : '▸'}</span>
                    <span class="dish-name">${dish.name}</span>
                    <span class="dish-count">${dishLow}/${dishTotal}</span>
                </div>
                <div class="dish-body ${isDishExpanded ? '' : 'collapsed'}">
                    ${renderDishIngredients(station, dish)}
                    <div class="dish-quick-add">
                        <input type="text" class="quick-add-input" id="quickAdd_${station.id}_${dish.id}" placeholder="Add to ${dish.name}..." onkeydown="if(event.key==='Enter'){quickAddIngredient(${station.id}, ${dish.id})}">
                        <button class="quick-add-btn" onclick="quickAddIngredient(${station.id}, ${dish.id})">+</button>
                    </div>
                </div>
            </div>`;
        }
    });
    return html;
}

function renderDishIngredients(station, dish) {
    let html = '';
    (dish.ingredients || []).forEach(ing => {
        const st = station.status[ing.id] || { low: false, priority: null, parLevel: '', parQty: null, parUnit: '', parNotes: '', completed: false };

        const escapedIngName = ing.name.replace(/'/g, "\\'");
        const isExpanded = expandedIngs.has(`${station.id}-${ing.id}`);
        const hasPri = st.priority && !st.completed;
        const priLabel = hasPri ? st.priority.charAt(0).toUpperCase() + st.priority.slice(1) : 'Priority';
        html += `
        <div class="ingredient ${st.low ? 'low' : ''} ${hasPri ? 'has-priority priority-' + st.priority : ''} ${isExpanded ? 'expanded' : ''}" id="ing-${station.id}-${ing.id}">
            <div class="ingredient-header"
                 ontouchstart="startLongPress(event, ${station.id}, ${ing.id}, '${escapedIngName}')"
                 ontouchend="cancelLongPress()" ontouchmove="cancelLongPress()"
                 oncontextmenu="event.preventDefault(); showIngredientContextMenu(event, ${station.id}, ${ing.id}, '${escapedIngName}')">
                ${hasPri && !isExpanded ? `<span class="priority-dot ${st.priority}"></span>` : ''}
                ${isExpanded ? `<button class="priority-pill ${hasPri ? st.priority : ''}" onclick="event.stopPropagation(); cyclePriority(${station.id}, ${ing.id})">${priLabel}</button>` : ''}
                <span class="ingredient-name" onclick="toggleIngExpand(${station.id}, ${ing.id})" style="flex:1;pointer-events:auto;">${ing.name}</span>
                ${!isExpanded && taskTemplates[ing.name.toLowerCase()] ? '<span class="template-indicator">⏱</span>' : ''}
            </div>
            <div class="ingredient-controls" id="ing-ctrl-${station.id}-${ing.id}">
                <div class="smart-qty-row">
                    <input type="number" class="smart-qty-input"
                        value="${st.parQty || ''}"
                        placeholder="0"
                        min="0" step="1" inputmode="decimal"
                        oninput="debounce('parq_${station.id}_${ing.id}', () => setParQty(${station.id}, ${ing.id}, this.value), 400)"
                        onclick="event.stopPropagation()">
                    ${PAN_UNITS.includes(st.parUnit) ? `
                    <div class="depth-chips">
                        <button class="depth-chip ${(st.parDepth || 4) == 2 ? 'active' : ''}" onclick="event.stopPropagation(); setParDepth(${station.id}, ${ing.id}, 2)">2"</button>
                        <button class="depth-chip ${(st.parDepth || 4) == 4 ? 'active' : ''}" onclick="event.stopPropagation(); setParDepth(${station.id}, ${ing.id}, 4)">4"</button>
                        <button class="depth-chip ${(st.parDepth || 4) == 6 ? 'active' : ''}" onclick="event.stopPropagation(); setParDepth(${station.id}, ${ing.id}, 6)">6"</button>
                    </div>
                    ` : ''}
                    <select class="smart-unit-select" onchange="event.stopPropagation(); setParUnit(${station.id}, ${ing.id}, this.value)">
                        <option value="" ${!st.parUnit ? 'selected' : ''}>Unit</option>
                        <optgroup label="Weight">
                            ${WEIGHT_UNITS.map(u => `<option value="${u}" ${st.parUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
                        </optgroup>
                        <optgroup label="Volume">
                            ${VOLUME_UNITS.map(u => `<option value="${u}" ${st.parUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
                        </optgroup>
                        <optgroup label="Pans">
                            ${PAN_UNITS.map(u => `<option value="${u}" ${st.parUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
                        </optgroup>
                        <optgroup label="Count">
                            ${COUNT_UNITS.map(u => `<option value="${u}" ${st.parUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
                        </optgroup>
                    </select>
                </div>
                <div class="par-notes-row">
                    <input type="text" class="par-input par-notes-input" placeholder="Notes..."
                        value="${st.parNotes || ''}"
                        oninput="debounce('parn_${station.id}_${ing.id}', () => setParNotes(${station.id}, ${ing.id}, this.value), 600)"
                        onclick="event.stopPropagation()">
                </div>
            </div>
        </div>`;
    });
    return html;
}

let longPressTimer = null;
const expandedIngs = new Set();
let dragState = null;

function startLongPress(event, stationId, ingId, ingName) {
    const station = stations.find(s => s.id === stationId);
    const hasManyDishes = station && station.dishes && station.dishes.length > 1;

    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (navigator.vibrate) navigator.vibrate(30);
        if (hasManyDishes) {
            startIngredientDrag(stationId, ingId, ingName, event);
        } else {
            showIngredientContextMenu(event, stationId, ingId, ingName);
        }
    }, 500);
}

function cancelLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}

function startIngredientDrag(stationId, ingId, ingName, event) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const sourceDish = findDishForIngredient(station, ingId);
    if (!sourceDish) return;

    const ingEl = document.getElementById(`ing-${stationId}-${ingId}`);
    if (!ingEl) return;

    const touch = event.touches ? event.touches[0] : event;
    const rect = ingEl.getBoundingClientRect();

    // Create ghost
    const ghost = document.createElement('div');
    ghost.id = 'dragGhost';
    ghost.className = 'drag-ghost';
    ghost.textContent = ingName;
    ghost.style.left = (touch.clientX - 60) + 'px';
    ghost.style.top = (touch.clientY - 20) + 'px';
    document.body.appendChild(ghost);

    // Dim original
    ingEl.classList.add('dragging');

    dragState = {
        stationId,
        ingId,
        ingName,
        sourceDishId: sourceDish.id,
        ghost,
        ingEl,
        currentDropTarget: null
    };

    // Highlight all dish folders as potential drop zones
    document.querySelectorAll(`.dish-folder[data-station-id="${stationId}"]`).forEach(df => {
        if (parseInt(df.dataset.dishId) !== sourceDish.id) {
            df.classList.add('drop-zone');
        }
    });

    document.addEventListener('touchmove', handleDragMove, { passive: false });
    document.addEventListener('touchend', handleDragEnd);
    document.addEventListener('touchcancel', handleDragEnd);
}

function handleDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const touch = e.touches[0];
    dragState.ghost.style.left = (touch.clientX - 60) + 'px';
    dragState.ghost.style.top = (touch.clientY - 20) + 'px';

    // Detect drop target
    const folders = document.querySelectorAll(`.dish-folder[data-station-id="${dragState.stationId}"]`);
    let found = null;
    folders.forEach(df => {
        const r = df.getBoundingClientRect();
        if (touch.clientX >= r.left && touch.clientX <= r.right && touch.clientY >= r.top && touch.clientY <= r.bottom) {
            if (parseInt(df.dataset.dishId) !== dragState.sourceDishId) {
                found = df;
            }
        }
    });

    if (dragState.currentDropTarget && dragState.currentDropTarget !== found) {
        dragState.currentDropTarget.classList.remove('drop-target');
    }
    if (found) {
        found.classList.add('drop-target');
    }
    dragState.currentDropTarget = found;
}

function handleDragEnd(e) {
    if (!dragState) return;

    document.removeEventListener('touchmove', handleDragMove);
    document.removeEventListener('touchend', handleDragEnd);
    document.removeEventListener('touchcancel', handleDragEnd);

    // Clean up visual
    if (dragState.ghost) dragState.ghost.remove();
    if (dragState.ingEl) dragState.ingEl.classList.remove('dragging');
    document.querySelectorAll('.drop-zone, .drop-target').forEach(el => {
        el.classList.remove('drop-zone', 'drop-target');
    });

    // Execute move if dropped on valid target
    if (dragState.currentDropTarget) {
        const targetDishId = parseInt(dragState.currentDropTarget.dataset.dishId);
        moveIngredientToDish(dragState.stationId, dragState.sourceDishId, targetDishId, dragState.ingId);
    }

    dragState = null;
}

function moveIngredientToDish(stationId, fromDishId, toDishId, ingredientId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    const fromDish = station.dishes.find(d => d.id === fromDishId);
    const toDish = station.dishes.find(d => d.id === toDishId);
    if (!fromDish || !toDish) return;

    const ingIdx = fromDish.ingredients.findIndex(i => i.id === ingredientId);
    if (ingIdx === -1) return;

    const [ing] = fromDish.ingredients.splice(ingIdx, 1);
    toDish.ingredients.push(ing);

    saveData(true);
    rerenderStationBody(stationId);
    showToast(`Moved to ${toDish.name}`);
}

function showIngredientContextMenu(event, stationId, ingId, ingName) {
    event.preventDefault();
    event.stopPropagation();
    window.getSelection && window.getSelection().removeAllRanges();

    const existing = document.getElementById('ingredientContextMenu');
    if (existing) existing.remove();

    const safeIngName = ingName.replace(/"/g, '&quot;');

    const menu = document.createElement('div');
    menu.id = 'ingredientContextMenu';
    menu.className = 'context-menu-overlay';
    menu.innerHTML = `
        <div class="context-menu">
            <div class="context-menu-title">${ingName}</div>
            <button class="context-menu-item" onclick="editIngredientFromHome(${stationId}, ${ingId}, &quot;${safeIngName}&quot;)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Edit
            </button>
            <button class="context-menu-item" onclick="startCalibration(${stationId}, ${ingId}, &quot;${safeIngName}&quot;)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Calibrate
            </button>
            <button class="context-menu-item delete" onclick="deleteIngredientFromHome(${stationId}, ${ingId})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                Delete
            </button>
        </div>`;
    document.body.appendChild(menu);
    menu.onclick = function(e) { if (e.target === menu) menu.remove(); };
}

// ==================== DISH MANAGEMENT ====================

function toggleDish(stationId, dishId) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const dish = station.dishes.find(d => d.id === dishId);
    if (!dish) return;
    dish.expanded = !dish.expanded;
    saveData(true);
    rerenderStationBody(stationId);
}

function showNewDishModal(stationId) {
    const existing = document.getElementById('modalNewDish');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalNewDish';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">New Dish</div>
            <div class="form-group">
                <input type="text" id="newDishName" class="form-control" placeholder="Dish name" style="text-align:center;font-size:16px;">
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('modalNewDish').remove()">Cancel</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); createDish(${stationId})">Create</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    setTimeout(() => {
        const input = document.getElementById('newDishName');
        if (input) input.focus();
    }, 150);
}

function createDish(stationId) {
    const input = document.getElementById('newDishName');
    const name = input ? input.value.trim() : '';
    if (!name) { showToast('Enter a dish name'); return; }

    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    const newDish = {
        id: Date.now(),
        name: name,
        sortOrder: station.dishes.length,
        expanded: true,
        ingredients: []
    };
    station.dishes.push(newDish);
    saveData(true);

    const modal = document.getElementById('modalNewDish');
    if (modal) modal.remove();

    rerenderStationBody(stationId);
    showToast(`${name} created`);
}

function showDishContextMenu(event, stationId, dishId) {
    event.preventDefault();
    event.stopPropagation();

    const existing = document.getElementById('dishContextMenu');
    if (existing) existing.remove();

    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const dish = station.dishes.find(d => d.id === dishId);
    if (!dish) return;

    const menu = document.createElement('div');
    menu.id = 'dishContextMenu';
    menu.className = 'context-menu-overlay';
    menu.innerHTML = `
        <div class="context-menu">
            <div class="context-menu-title">${dish.name}</div>
            <button class="context-menu-item" onclick="promptRenameDish(${stationId}, ${dishId})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Rename
            </button>
            <button class="context-menu-item delete" onclick="deleteDish(${stationId}, ${dishId})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                Delete Dish
            </button>
        </div>`;
    document.body.appendChild(menu);
    menu.onclick = function(e) { if (e.target === menu) menu.remove(); };
}

function promptRenameDish(stationId, dishId) {
    const menu = document.getElementById('dishContextMenu');
    if (menu) menu.remove();

    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const dish = station.dishes.find(d => d.id === dishId);
    if (!dish) return;

    const existing = document.getElementById('modalRenameDish');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalRenameDish';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Rename Dish</div>
            <div class="form-group">
                <input type="text" id="renameDishInput" class="form-control" value="${dish.name}" style="text-align:center;font-size:16px;">
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('modalRenameDish').remove()">Cancel</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); renameDish(${stationId}, ${dishId})">Save</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    setTimeout(() => {
        const input = document.getElementById('renameDishInput');
        if (input) { input.focus(); input.select(); }
    }, 150);
}

function renameDish(stationId, dishId) {
    const input = document.getElementById('renameDishInput');
    const newName = input ? input.value.trim() : '';
    if (!newName) { showToast('Enter a name'); return; }

    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const dish = station.dishes.find(d => d.id === dishId);
    if (!dish) return;

    dish.name = newName;
    saveData(true);

    const modal = document.getElementById('modalRenameDish');
    if (modal) modal.remove();

    rerenderStationBody(stationId);
    showToast(`Renamed to ${newName}`);
}

function deleteDish(stationId, dishId) {
    const menu = document.getElementById('dishContextMenu');
    if (menu) menu.remove();

    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const dish = station.dishes.find(d => d.id === dishId);
    if (!dish) return;

    if (station.dishes.length <= 1) {
        showToast('Cannot delete the only dish');
        return;
    }

    const ingCount = (dish.ingredients || []).length;
    if (ingCount > 0) {
        if (!confirm(`Move ${ingCount} ingredient${ingCount > 1 ? 's' : ''} to "${station.dishes[0].id === dishId ? station.dishes[1].name : station.dishes[0].name}" and delete "${dish.name}"?`)) return;
        const targetDish = station.dishes.find(d => d.id !== dishId);
        dish.ingredients.forEach(ing => targetDish.ingredients.push(ing));
    } else {
        if (!confirm(`Delete "${dish.name}"?`)) return;
    }

    station.dishes = station.dishes.filter(d => d.id !== dishId);
    saveData(true);
    rerenderStationBody(stationId);
    showToast(`${dish.name} deleted`);
}

function deleteIngredientFromHome(stationId, ingId) {
    const menu = document.getElementById('ingredientContextMenu');
    if (menu) menu.remove();

    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const ing = getAllIngredients(station).find(i => i.id === ingId);
    const name = ing ? ing.name : 'ingredient';

    if (!confirm(`Delete "${name}"?`)) return;

    const dish = findDishForIngredient(station, ingId);
    if (dish) {
        dish.ingredients = dish.ingredients.filter(i => i.id !== ingId);
    }
    delete station.status[ingId];
    if (taskTimers[`${stationId}_${ingId}`]) {
        clearInterval(taskTimers[`${stationId}_${ingId}`].interval);
        delete taskTimers[`${stationId}_${ingId}`];
    }

    saveData(true);
    rerenderStationBody(stationId);
    showToast(`${name} deleted`);
}

function editIngredientFromHome(stationId, ingId, currentName) {
    const menu = document.getElementById('ingredientContextMenu');
    if (menu) menu.remove();

    const existing = document.getElementById('modalEditIngredient');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalEditIngredient';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Edit Ingredient</div>
            <div class="form-group">
                <input type="text" id="editIngNameInput" class="form-control" value="${currentName}" placeholder="Ingredient name" style="text-align:center;font-size:16px;">
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('modalEditIngredient').remove()">Cancel</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); confirmEditIngredientName(${stationId}, ${ingId})">Save</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    setTimeout(() => {
        const input = document.getElementById('editIngNameInput');
        if (input) { input.focus(); input.select(); }
    }, 150);
}

function confirmEditIngredientName(stationId, ingId) {
    const input = document.getElementById('editIngNameInput');
    const newName = input ? input.value.trim() : '';
    if (!newName) { showToast('Enter a name'); return; }

    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const ing = getAllIngredients(station).find(i => i.id === ingId);
    if (!ing) return;

    ing.name = newName;
    registerGlobalIngredient(ing.id, newName);
    saveData(true);

    const modal = document.getElementById('modalEditIngredient');
    if (modal) modal.remove();

    rerenderStationBody(stationId);
    showToast(`Renamed to ${newName}`);
}

// ==================== CALIBRATION WORKFLOW ====================

let calibrationState = null;

function getCalibrationTimerSeconds(timer) {
    if (!timer) return 0;
    if (timer.running) return timer.pausedElapsed + Math.floor((Date.now() - timer.startedAt) / 1000);
    return timer.pausedElapsed;
}

function startCalibration(stationId, ingredientId, ingName) {
    const menu = document.getElementById('ingredientContextMenu');
    if (menu) menu.remove();

    const station = stations.find(s => s.id === stationId);
    const st = station ? station.status[ingredientId] : null;

    calibrationState = {
        stationId, ingredientId, ingName,
        qty: st && st.parQty ? st.parQty : 1,
        unit: st && st.parUnit ? st.parUnit : 'each',
        depth: st && st.parDepth ? st.parDepth : 4,
        step: 'qty',
        activeTimer: null,
        passiveTimer: null,
        activeTotal: 0,
        passiveTotal: 0
    };
    renderCalibrationModal();
}

function renderCalibrationModal() {
    const cs = calibrationState;
    if (!cs) return;

    const existing = document.getElementById('modalCalibration');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalCalibration';
    modal.className = 'modal show';

    let content = '';

    if (cs.step === 'qty') {
        const unitOptions = [...WEIGHT_UNITS, ...VOLUME_UNITS, ...PAN_UNITS, ...COUNT_UNITS]
            .map(u => `<option value="${u}" ${cs.unit === u ? 'selected' : ''}>${u}</option>`).join('');
        content = `
            <div class="modal-content calibration-modal">
                <div class="calibration-title">${cs.ingName}</div>
                <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;">How many are you prepping?</p>
                <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:20px;">
                    <input type="number" id="calQtyInput" class="smart-qty-input" value="${cs.qty}" min="0.1" step="1" inputmode="decimal" style="width:80px;font-size:24px;text-align:center;">
                    <select id="calUnitSelect" class="smart-unit-select" style="font-size:14px;">
                        ${unitOptions}
                    </select>
                </div>
                ${PAN_UNITS.includes(cs.unit) ? `
                <div class="depth-chips" style="justify-content:center;margin-bottom:16px;">
                    <button class="depth-chip ${cs.depth == 2 ? 'active' : ''}" onclick="calibrationSetDepth(2)">2"</button>
                    <button class="depth-chip ${cs.depth == 4 ? 'active' : ''}" onclick="calibrationSetDepth(4)">4"</button>
                    <button class="depth-chip ${cs.depth == 6 ? 'active' : ''}" onclick="calibrationSetDepth(6)">6"</button>
                </div>` : ''}
                <div class="btn-group">
                    <button class="btn btn-secondary squishy" onclick="calibrationDiscard()">Cancel</button>
                    <button class="btn btn-primary squishy" onclick="handleClick(); calibrationStartActive()">Start Active</button>
                </div>
            </div>`;
    } else if (cs.step === 'active') {
        const sec = getCalibrationTimerSeconds(cs.activeTimer);
        const isPaused = cs.activeTimer && !cs.activeTimer.running;
        content = `
            <div class="modal-content calibration-modal">
                <div class="calibration-title">${cs.ingName} <span style="color:var(--text-muted);font-size:14px;">x${cs.qty}</span></div>
                <div class="calibration-phase-label active">ACTIVE — Hands-On</div>
                <div class="calibration-clock" id="calClock">${formatTime(sec)}</div>
                <div class="btn-group" style="margin-top:20px;">
                    ${isPaused ? `
                        <button class="btn btn-secondary squishy" onclick="handleClick(); calibrationResumeActive()">Resume</button>
                    ` : `
                        <button class="btn btn-secondary squishy" onclick="handleClick(); calibrationPauseActive()">Pause</button>
                    `}
                    <button class="btn btn-primary squishy" onclick="handleClick(); calibrationNextPhase()">Next</button>
                </div>
                <button class="btn-text" style="margin-top:12px;font-size:11px;color:var(--text-muted);border:none;background:none;cursor:pointer;" onclick="handleClick(); calibrationSkipToConfirm()">Skip passive</button>
            </div>`;
    } else if (cs.step === 'passive') {
        const sec = getCalibrationTimerSeconds(cs.passiveTimer);
        const isPaused = cs.passiveTimer && !cs.passiveTimer.running;
        content = `
            <div class="modal-content calibration-modal">
                <div class="calibration-title">${cs.ingName} <span style="color:var(--text-muted);font-size:14px;">x${cs.qty}</span></div>
                <div class="calibration-phase-label passive">PASSIVE — Hands-Off</div>
                <div class="calibration-clock" id="calClock">${formatTime(sec)}</div>
                <div class="btn-group" style="margin-top:20px;">
                    ${isPaused ? `
                        <button class="btn btn-secondary squishy" onclick="handleClick(); calibrationResumePassive()">Resume</button>
                    ` : `
                        <button class="btn btn-secondary squishy" onclick="handleClick(); calibrationPausePassive()">Pause</button>
                    `}
                    <button class="btn btn-primary squishy" onclick="handleClick(); calibrationDone()">Done</button>
                </div>
            </div>`;
    } else if (cs.step === 'confirm') {
        const baseQty = convertToBase(cs.qty, cs.unit, cs.depth);
        const activePerUnit = baseQty > 0 ? cs.activeTotal / baseQty : cs.activeTotal;
        const passivePerUnit = baseQty > 0 ? cs.passiveTotal / baseQty : cs.passiveTotal;
        const convFactor = PAN_UNITS.includes(cs.unit)
            ? ((PAN_OZ[cs.unit] && PAN_OZ[cs.unit][cs.depth || 4]) || 1)
            : (UNIT_TO_OZ[cs.unit] || UNIT_TO_G[cs.unit] || 1);
        const activePerDisplay = Math.round(activePerUnit * convFactor);
        const passivePerDisplay = Math.round(passivePerUnit * convFactor);
        content = `
            <div class="modal-content calibration-modal">
                <div class="calibration-title">${cs.ingName} <span style="color:var(--text-muted);font-size:14px;">x${cs.qty}</span></div>
                <div class="calibration-summary">
                    <div class="calibration-summary-row">
                        <span style="font-weight:600;color:var(--accent);">Active</span>
                        <span>${formatTime(cs.activeTotal)} <span style="font-size:10px;color:var(--text-muted);">(${formatEstimate(activePerDisplay)}/${cs.unit})</span></span>
                    </div>
                    <div class="calibration-summary-row">
                        <span style="font-weight:600;color:var(--low);">Passive</span>
                        <span>${formatTime(cs.passiveTotal)} <span style="font-size:10px;color:var(--text-muted);">(${formatEstimate(passivePerDisplay)}/${cs.unit})</span></span>
                    </div>
                </div>
                <div class="btn-group" style="margin-top:20px;">
                    <button class="btn btn-secondary squishy" onclick="handleClick(); calibrationDiscard()">Discard</button>
                    <button class="btn btn-primary squishy" onclick="handleClick(); calibrationSave()">Save Template</button>
                </div>
            </div>`;
    }

    modal.innerHTML = content;
    document.body.appendChild(modal);
}

function calibrationSetDepth(d) {
    if (!calibrationState) return;
    calibrationState.depth = d;
    renderCalibrationModal();
}

function calibrationStartActive() {
    const cs = calibrationState;
    if (!cs) return;
    const qtyInput = document.getElementById('calQtyInput');
    const unitSelect = document.getElementById('calUnitSelect');
    if (qtyInput) cs.qty = parseFloat(qtyInput.value) || 1;
    if (unitSelect) cs.unit = unitSelect.value;

    cs.step = 'active';
    cs.activeTimer = {
        running: true,
        startedAt: Date.now(),
        pausedElapsed: 0,
        interval: setInterval(() => {
            const clock = document.getElementById('calClock');
            if (clock) clock.textContent = formatTime(getCalibrationTimerSeconds(cs.activeTimer));
        }, 1000)
    };
    renderCalibrationModal();
}

function calibrationPauseActive() {
    const cs = calibrationState;
    if (!cs || !cs.activeTimer || !cs.activeTimer.running) return;
    cs.activeTimer.pausedElapsed = getCalibrationTimerSeconds(cs.activeTimer);
    cs.activeTimer.running = false;
    cs.activeTimer.startedAt = null;
    if (cs.activeTimer.interval) clearInterval(cs.activeTimer.interval);
    cs.activeTimer.interval = null;
    renderCalibrationModal();
}

function calibrationResumeActive() {
    const cs = calibrationState;
    if (!cs || !cs.activeTimer || cs.activeTimer.running) return;
    cs.activeTimer.running = true;
    cs.activeTimer.startedAt = Date.now();
    cs.activeTimer.interval = setInterval(() => {
        const clock = document.getElementById('calClock');
        if (clock) clock.textContent = formatTime(getCalibrationTimerSeconds(cs.activeTimer));
    }, 1000);
    renderCalibrationModal();
}

function calibrationNextPhase() {
    const cs = calibrationState;
    if (!cs) return;
    cs.activeTotal = getCalibrationTimerSeconds(cs.activeTimer);
    if (cs.activeTimer && cs.activeTimer.interval) clearInterval(cs.activeTimer.interval);

    cs.step = 'passive';
    cs.passiveTimer = {
        running: true,
        startedAt: Date.now(),
        pausedElapsed: 0,
        interval: setInterval(() => {
            const clock = document.getElementById('calClock');
            if (clock) clock.textContent = formatTime(getCalibrationTimerSeconds(cs.passiveTimer));
        }, 1000)
    };
    renderCalibrationModal();
}

function calibrationPausePassive() {
    const cs = calibrationState;
    if (!cs || !cs.passiveTimer || !cs.passiveTimer.running) return;
    cs.passiveTimer.pausedElapsed = getCalibrationTimerSeconds(cs.passiveTimer);
    cs.passiveTimer.running = false;
    cs.passiveTimer.startedAt = null;
    if (cs.passiveTimer.interval) clearInterval(cs.passiveTimer.interval);
    cs.passiveTimer.interval = null;
    renderCalibrationModal();
}

function calibrationResumePassive() {
    const cs = calibrationState;
    if (!cs || !cs.passiveTimer || cs.passiveTimer.running) return;
    cs.passiveTimer.running = true;
    cs.passiveTimer.startedAt = Date.now();
    cs.passiveTimer.interval = setInterval(() => {
        const clock = document.getElementById('calClock');
        if (clock) clock.textContent = formatTime(getCalibrationTimerSeconds(cs.passiveTimer));
    }, 1000);
    renderCalibrationModal();
}

function calibrationSkipToConfirm() {
    const cs = calibrationState;
    if (!cs) return;
    cs.activeTotal = getCalibrationTimerSeconds(cs.activeTimer);
    if (cs.activeTimer && cs.activeTimer.interval) clearInterval(cs.activeTimer.interval);
    cs.passiveTotal = 0;
    cs.step = 'confirm';
    renderCalibrationModal();
}

function calibrationDone() {
    const cs = calibrationState;
    if (!cs) return;
    cs.passiveTotal = getCalibrationTimerSeconds(cs.passiveTimer);
    if (cs.passiveTimer && cs.passiveTimer.interval) clearInterval(cs.passiveTimer.interval);
    cs.step = 'confirm';
    renderCalibrationModal();
}

function calibrationSave() {
    const cs = calibrationState;
    if (!cs) return;
    const baseQty = convertToBase(cs.qty, cs.unit, cs.depth);
    const activePerUnit = baseQty > 0 ? cs.activeTotal / baseQty : cs.activeTotal;
    const passivePerUnit = baseQty > 0 ? cs.passiveTotal / baseQty : cs.passiveTotal;
    const key = cs.ingName.toLowerCase();
    const existing = taskTemplates[key];

    taskTemplates[key] = {
        activeFixedSeconds: 0,
        activeSecondsPerUnit: activePerUnit,
        passiveFixedSeconds: 0,
        passiveSecondsPerUnit: passivePerUnit,
        lastUpdatedAt: new Date().toISOString(),
        calibratedBy: settings.cookName || 'Chef',
        templateVersion: existing ? (existing.templateVersion || 0) + 1 : 1
    };
    saveTaskTemplates();

    logActivity('calibration', {
        ingredient: cs.ingName,
        station: stations.find(s => s.id === cs.stationId)?.name || '',
        activeSeconds: cs.activeTotal,
        passiveSeconds: cs.passiveTotal,
        quantity: cs.qty,
        unit: cs.unit,
        depth: cs.depth
    });

    const modal = document.getElementById('modalCalibration');
    if (modal) modal.remove();
    calibrationState = null;

    animateMascot();
    showToast('Template saved');
    markAllPanelsDirty();
}

function calibrationDiscard() {
    const cs = calibrationState;
    if (cs) {
        if (cs.activeTimer && cs.activeTimer.interval) clearInterval(cs.activeTimer.interval);
        if (cs.passiveTimer && cs.passiveTimer.interval) clearInterval(cs.passiveTimer.interval);
    }
    calibrationState = null;
    const modal = document.getElementById('modalCalibration');
    if (modal) modal.remove();
}

function toggleStation(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    station.expanded = station.expanded === false ? true : false;
    const body = document.getElementById(`body-${stationId}`);
    const toggle = document.getElementById(`expandToggle-${stationId}`);
    if (body) body.classList.toggle('collapsed', !station.expanded);
    if (toggle) toggle.textContent = station.expanded ? '−' : '+';
    saveData(true);
}

// ==================== STATION RENAME (long-press) ====================

let stationLongPressTimer = null;

function startStationLongPress(event, stationId) {
    if (event.target.closest('.expand-toggle')) return;
    stationLongPressTimer = setTimeout(() => {
        stationLongPressTimer = null;
        if (navigator.vibrate) navigator.vibrate(30);
        event.stopPropagation();
        showRenameStationModal(stationId);
    }, 500);
}

function cancelStationLongPress() {
    if (stationLongPressTimer) { clearTimeout(stationLongPressTimer); stationLongPressTimer = null; }
}

function showRenameStationModal(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    const existing = document.getElementById('modalRenameStation');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalRenameStation';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Rename Station</div>
            <div class="form-group">
                <input type="text" id="renameStationInput" class="form-control" value="${station.name}" maxlength="30" placeholder="Station name" style="text-align:center;font-size:16px;">
                <div class="rename-char-count" id="renameCharCount">${station.name.length}/30</div>
            </div>
            <div class="btn-group">
                <button class="btn btn-outline" onclick="document.getElementById('modalRenameStation').remove()">Cancel</button>
                <button class="btn btn-primary" onclick="confirmRenameStation(${stationId})">Save</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };

    const input = document.getElementById('renameStationInput');
    input.focus();
    input.select();
    input.addEventListener('input', () => {
        document.getElementById('renameCharCount').textContent = input.value.length + '/30';
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmRenameStation(stationId);
    });
}

function confirmRenameStation(stationId) {
    const input = document.getElementById('renameStationInput');
    const newName = input.value.trim();
    if (!newName) { showToast('Name cannot be empty'); return; }

    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    station.name = newName;
    saveData(true);
    document.getElementById('modalRenameStation').remove();
    markAllPanelsDirty();
    renderCurrentView();
    showToast('Station renamed');
}

// ==================== INGREDIENT ACTIONS ====================

function toggleIngExpand(stationId, ingredientId) {
    handleClick();
    const key = `${stationId}-${ingredientId}`;
    const wasOpen = expandedIngs.has(key);

    if (wasOpen) {
        expandedIngs.delete(key);
    } else {
        expandedIngs.add(key);
        // Auto-fill defaults on first expand
        const station = stations.find(s => s.id === stationId);
        if (station && station.status[ingredientId]) {
            const st = station.status[ingredientId];
            if (!st.parQty && !st.parUnit) {
                const ing = getAllIngredients(station).find(i => i.id === ingredientId);
                if (ing) {
                    const defaults = ingredientDefaults[ing.name.toLowerCase()];
                    if (defaults) {
                        if (defaults.qty) st.parQty = defaults.qty;
                        if (defaults.unit) st.parUnit = defaults.unit;
                        if (defaults.depth) st.parDepth = defaults.depth;
                        updateParLevel(station, ingredientId);
                    }
                }
            }
        }
    }
    rerenderStationBody(stationId);
}

const PRIORITY_CYCLE = [null, 'high', 'medium', 'low'];

function cyclePriority(stationId, ingredientId) {
    handleClick();
    animateMascot();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    const st = station.status[ingredientId];

    const idx = PRIORITY_CYCLE.indexOf(st.priority);
    st.priority = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
    st.low = !!st.priority;

    if (!st.low) st.completed = false;

    saveData(true);
    rerenderStationBody(stationId);
}

function setPriority(stationId, ingredientId, priority) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    const st = station.status[ingredientId];

    st.priority = st.priority === priority ? null : priority;
    st.low = !!st.priority;

    if (!st.low) st.completed = false;

    saveData(true);
    rerenderStationBody(stationId);
}

function setParQty(stationId, ingredientId, value) {
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    station.status[ingredientId].parQty = parseFloat(value) || null;
    updateParLevel(station, ingredientId);
    saveIngredientDefault(station, ingredientId);
    saveData(true);
}

function setParUnit(stationId, ingredientId, value) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    const st = station.status[ingredientId];
    st.parUnit = value;
    if (PAN_UNITS.includes(value)) {
        st.parQty = 1;
        if (!st.parDepth) st.parDepth = 4;
    } else {
        st.parDepth = null;
        st.parQty = 1;
    }
    updateParLevel(station, ingredientId);
    saveIngredientDefault(station, ingredientId);
    saveData(true);
    rerenderStationBody(stationId);
}

function setParDepth(stationId, ingredientId, value) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    station.status[ingredientId].parDepth = parseInt(value) || 4;
    updateParLevel(station, ingredientId);
    saveIngredientDefault(station, ingredientId);
    saveData(true);
    rerenderStationBody(stationId);
}

function setParNotes(stationId, ingredientId, value) {
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    station.status[ingredientId].parNotes = value;
    saveData(true);
}

function adjustParQty(stationId, ingredientId, delta) {
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    const st = station.status[ingredientId];
    st.parQty = Math.max(0, (st.parQty || 0) + delta);
    if (st.parQty === 0) st.parQty = null;
    updateParLevel(station, ingredientId);
    saveIngredientDefault(station, ingredientId);
    saveData(true);
    rerenderStationBody(stationId);
}

function formatParDisplay(qty, unit, depth) {
    if (PAN_UNITS.includes(unit)) {
        const d = depth || 4;
        return `${qty || 1}  ${d}"  ${unit}`;
    }
    return `${qty} ${unit}`;
}

function updateParLevel(station, ingredientId) {
    const st = station.status[ingredientId];
    if (st.parQty && st.parUnit) {
        st.parLevel = formatParDisplay(st.parQty, st.parUnit, st.parDepth);
    } else if (st.parQty) {
        st.parLevel = `${st.parQty}`;
    } else {
        st.parLevel = '';
    }
}

function saveIngredientDefault(station, ingredientId) {
    const st = station.status[ingredientId];
    const ing = getAllIngredients(station).find(i => i.id === ingredientId);
    if (!ing) return;
    const key = ing.name.toLowerCase();
    if (st.parQty || st.parUnit) {
        ingredientDefaults[key] = { qty: st.parQty, unit: st.parUnit, depth: st.parDepth || null };
        saveIngredientDefaults();
    }
}

function stationFooter(stationId) {
    const station = stations.find(s => s.id === stationId);
    const singleDish = station && station.dishes && station.dishes.length === 1;
    const defaultDishId = station && station.dishes && station.dishes[0] ? station.dishes[0].id : 0;
    return `
        ${singleDish ? `<div class="quick-add-row">
            <input type="text" class="quick-add-input" id="quickAdd_${stationId}_${defaultDishId}" placeholder="Add ingredient..." onkeydown="if(event.key==='Enter'){quickAddIngredient(${stationId}, ${defaultDishId})}">
            <button class="quick-add-btn" onclick="quickAddIngredient(${stationId}, ${defaultDishId})">+</button>
        </div>` : ''}
        <div class="station-footer-actions">
            <button class="btn btn-outline dish-add-btn" onclick="handleClick(); showNewDishModal(${stationId})">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
                New Dish
            </button>
            <button class="btn btn-outline" onclick="resetStation(${stationId})">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
                Clear Checklist
            </button>
        </div>`;
}

function quickAddIngredient(stationId, dishId) {
    handleClick();
    const input = document.getElementById(`quickAdd_${stationId}_${dishId}`);
    if (!input) return;
    const name = input.value.trim();
    if (!name) { showToast('Enter an ingredient name'); return; }

    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    const dish = dishId ? station.dishes.find(d => d.id === dishId) : getDefaultDish(station);
    if (!dish) return;

    const newIng = { id: Date.now(), name };
    dish.ingredients.push(newIng);
    station.status[newIng.id] = { low: false, priority: null, parLevel: '', parQty: null, parUnit: '', parNotes: '', completed: false };
    registerGlobalIngredient(newIng.id, name);

    saveData(true);
    rerenderStationBody(stationId);
    showToast(`${name} added`);

    setTimeout(() => {
        const newInput = document.getElementById(`quickAdd_${stationId}_${dishId}`);
        if (newInput) newInput.focus();
    }, 50);
}

function rerenderStationBody(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const body = document.getElementById(`body-${stationId}`);
    if (body) {
        const panel = getPanel('home');
        const scrollBefore = panel ? panel.scrollTop : 0;
        body.innerHTML = renderIngredients(station) + stationFooter(stationId);
        // Restore expand states
        expandedIngs.forEach(key => {
            const ctrl = document.getElementById(`ing-ctrl-${key}`);
            if (ctrl) ctrl.classList.add('open');
        });
        if (panel) panel.scrollTop = scrollBefore;
    }
    updateStationCount(stationId);
}

function rerenderHomePanel() {
    if (homeSubTab === 'master') {
        panelDirty.home = true;
        renderPanel('home');
    } else {
        stations.forEach(s => rerenderStationBody(s.id));
    }
}

function updateStationCount(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const el = document.getElementById(`stationCount-${stationId}`);
    if (!el) return;
    const lowCount = Object.values(station.status).filter(s => s.low).length;
    const totalCount = getAllIngredients(station).length;
    el.textContent = `${lowCount}/${totalCount}`;
    el.classList.toggle('all-done', lowCount > 0 && lowCount === totalCount);
}

// ==================== SERVICE FEASIBILITY ====================

function calculateFeasibility() {
    let totalActive = 0;
    let totalPassive = 0;
    let taskBreakdown = [];

    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            const st = station.status[ing.id];
            if (!st || !st.low || st.completed) return;
            const est = getIngredientEstimate(ing.name, st.parQty, st.parUnit, st.parDepth);
            if (!est) return;

            const active = est.activeSeconds || est.totalSeconds || 0;
            const passive = est.passiveSeconds || 0;
            totalActive += active;
            totalPassive += passive;
            taskBreakdown.push({ name: ing.name, active, passive });
        });
    });

    if (taskBreakdown.length === 0) return null;

    const longestPassive = taskBreakdown.reduce((max, t) => Math.max(max, t.passive), 0);
    const estimatedElapsed = Math.max(totalActive, longestPassive);

    const prepWindowSec = (settings.prepWindowMinutes || 0) * 60;

    let status, message;
    if (prepWindowSec <= 0) {
        status = 'unknown';
        message = 'Set Shift Start & Service time above';
    } else if (totalActive > prepWindowSec) {
        status = 'weeds';
        message = 'High risk — likely In the Weeds';
    } else if (totalActive > prepWindowSec * 0.8) {
        status = 'tight';
        message = 'Tight window — schedule carefully';
    } else {
        status = 'pocket';
        message = "You're In the Pocket";
    }

    const passiveWindowMinutes = Math.max(0, Math.floor(totalPassive / 60));

    return {
        totalActive, totalPassive, estimatedElapsed,
        status, message,
        passiveWindowMinutes,
        prepWindowSec, taskBreakdown
    };
}

// ==================== SUMMARY VIEW ====================

function renderSummary(container) {
    let allTasks = [];

    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            const st = station.status[ing.id];
            if (st && st.low) {
                allTasks.push({
                    stationId: station.id,
                    stationName: station.name,
                    ingredient: ing,
                    status: st
                });
            }
        });
    });

    if (allTasks.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px;">All clear</p>
                <p class="empty-sub">No items need attention right now</p>
            </div>`;
        return;
    }

    let html = '';

    // Group tasks by station
    const stationGroups = {};
    allTasks.forEach(task => {
        if (!stationGroups[task.stationId]) {
            stationGroups[task.stationId] = { name: task.stationName, tasks: [] };
        }
        stationGroups[task.stationId].tasks.push(task);
    });

    Object.entries(stationGroups).forEach(([stationId, group]) => {
        const high = group.tasks.filter(t => t.status.priority === 'high');
        const medium = group.tasks.filter(t => t.status.priority === 'medium');
        const low = group.tasks.filter(t => t.status.priority === 'low');
        const none = group.tasks.filter(t => !t.status.priority);
        const isCollapsed = summaryStationCollapsed[stationId];

        html += `<div class="summary-station-section">
            <div class="summary-station-header" onclick="toggleSummaryStation(${stationId})">
                <span>${group.name}</span>
                <span class="summary-expand-icon">${isCollapsed ? '+' : '\u2212'}</span>
            </div>
            <div class="summary-station-body${isCollapsed ? ' collapsed' : ''}">`;

        if (high.length > 0) html += renderSummaryGroup('Before Service', 'high', high);
        if (medium.length > 0) html += renderSummaryGroup('Necessary, Not Urgent', 'medium', medium);
        if (low.length > 0) html += renderSummaryGroup('Backup for Next Days', 'low', low);
        if (none.length > 0) html += renderSummaryGroup('No Priority Set', 'none', none);

        html += '</div></div>';
    });

    container.innerHTML = html;
}

function renderSummaryGroup(title, level, tasks) {
    const colorClass = level === 'none' ? '' : `summary-${level}`;

    // Block timer in title bar
    const bt = blockTimers[level];
    const hasData = blockHasTimingData(level);
    let blockTimerHTML = '';
    if (bt) {
        const remaining = getBlockRemainingSeconds(bt);
        const clockText = formatTime(Math.abs(remaining));
        const overtimeClass = remaining < 0 ? ' overtime' : '';
        blockTimerHTML = `
            <div class="block-timer-row">
                <span class="block-timer-clock${overtimeClass}" id="blockClock_${level}">${clockText}</span>
                ${bt.running
                    ? `<button class="block-timer-ctrl pause" onclick="event.stopPropagation(); handleClick(); pauseBlockTimer('${level}')">⏸</button>`
                    : `<button class="block-timer-ctrl resume" onclick="event.stopPropagation(); handleClick(); resumeBlockTimer('${level}')">▶</button>`
                }
                <button class="block-timer-ctrl reset" onclick="event.stopPropagation(); handleClick(); resetBlockTimer('${level}')">✕</button>
            </div>`;
    } else if (hasData && level !== 'none') {
        blockTimerHTML = `
            <button class="block-timer-start" onclick="event.stopPropagation(); handleClick(); toggleBlockTimer('${level}')">⏱</button>`;
    }

    let html = `
        <div class="summary-group ${colorClass}">
            <div class="summary-group-title">
                <span>${title}</span>
                ${blockTimerHTML}
            </div>`;

    tasks.forEach(task => {
        const timerKey = `${task.stationId}_${task.ingredient.id}`;
        const timer = taskTimers[timerKey];
        const isRunning = timer && timer.running;
        const isPaused = timer && !timer.running && getTimerSeconds(timer) > 0;
        const hasTimer = isRunning || isPaused;
        const escapedName = task.ingredient.name.replace(/'/g, "\\'");
        const bestTime = getIngredientBestTime(task.ingredient.name);
        const hideStopwatch = shouldHideStopwatch(task.ingredient.name);

        const parTag = task.status.parQty && task.status.parUnit
            ? `<span class="par-tag">${formatParDisplay(task.status.parQty, task.status.parUnit, task.status.parDepth)}</span>`
            : (task.status.parLevel ? `<span class="par-tag">${task.status.parLevel}</span>` : '');

        // Right-aligned timer display
        let timerDisplayHTML = '';
        if (!task.status.completed) {
            if (hasTimer) {
                // Active timer: show inline clock + controls
                const elapsed = getTimerSeconds(timer);
                let clockText, clockClass = '';
                if (timer.bestGoalSeconds > 0) {
                    const remaining = timer.bestGoalSeconds - elapsed;
                    clockText = (remaining < 0 ? '-' : '') + formatTime(Math.abs(remaining));
                    if (remaining < 0) clockClass = ' overtime';
                } else {
                    clockText = formatTime(elapsed);
                }
                timerDisplayHTML = `
                    <span class="inline-item-clock${clockClass}" id="clock_${timerKey}">${clockText}</span>
                    <button class="task-timer-btn mini ${isRunning ? 'active' : 'paused'}"
                        onclick="event.stopPropagation(); handleClick(); toggleTaskTimer('${timerKey}', ${task.stationId}, ${task.ingredient.id}, '${escapedName}')">
                        ${isRunning ? '⏸' : '▶'}
                    </button>
                    <button class="task-timer-btn mini reset"
                        onclick="event.stopPropagation(); handleClick(); resetTaskTimer('${timerKey}')">✕</button>`;
            } else if (hideStopwatch && bestTime) {
                // AUTO MODE: enough logs, show auto countdown badge
                timerDisplayHTML = `
                    <span class="auto-timer-badge">⏱ ${formatTime(bestTime)}</span>`;
            } else {
                // Manual: show stopwatch button + best time if available
                if (bestTime) timerDisplayHTML += `<span class="best-time-badge">${formatTime(bestTime)}</span>`;
                timerDisplayHTML += `
                    <button class="task-timer-btn ${isRunning ? 'active' : ''} ${isPaused ? 'paused' : ''}"
                        onclick="event.stopPropagation(); handleClick(); toggleTaskTimer('${timerKey}', ${task.stationId}, ${task.ingredient.id}, '${escapedName}')">⏱</button>`;
            }
        }

        html += `
            <div class="summary-item ${task.status.completed ? 'done' : ''}">
                <label class="summary-check-label">
                    <input type="checkbox" class="neu-check"
                        ${task.status.completed ? 'checked' : ''}
                        onchange="toggleCompleted(${task.stationId}, ${task.ingredient.id})">
                    <span class="summary-item-name">${task.ingredient.name}</span>
                </label>
                <div class="summary-item-actions">
                    ${parTag}
                    ${timerDisplayHTML}
                </div>
            </div>`;
    });

    html += '</div>';
    return html;
}

function toggleCompleted(stationId, ingredientId) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;

    const isCompleting = !station.status[ingredientId].completed;

    if (isCompleting) {
        const timerKey = `${stationId}_${ingredientId}`;
        const t = taskTimers[timerKey];
        if (t && getTimerSeconds(t) > 0) {
            showTaskCompleteConfirm(stationId, ingredientId);
        } else {
            if (t) { if (t.interval) clearInterval(t.interval); delete taskTimers[timerKey]; }
            const pLevel = station.status[ingredientId].priority || 'none';
            logActivity('task_complete', {
                ingredient: getAllIngredients(station).find(i => i.id === ingredientId)?.name || '',
                station: station.name, seconds: 0, quantity: 0, secPerUnit: 0
            });
            // Auto-clean: reset priority and low so dot disappears from Home
            station.status[ingredientId].completed = false;
            station.status[ingredientId].priority = null;
            station.status[ingredientId].low = false;
            saveData(true);
            animateMascot();
            checkBlockCompletion(pLevel);
            refreshSummaryPanel();
            rerenderHomePanel();
        }
    } else {
        station.status[ingredientId].completed = false;
        saveData(true);
        refreshSummaryPanel();
    }
}

// ==================== SCREEN WAKE LOCK & NOTIFICATIONS ====================

async function requestWakeLock() {
    if (wakeLock) return; // already active
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch (e) { /* not supported or denied */ }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
}

// Re-acquire wake lock and recalculate timers when page becomes visible (phone unlocked)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        Object.entries(taskTimers).forEach(([key, t]) => {
            const clock = document.getElementById(`clock_${key}`);
            if (clock) clock.textContent = formatTime(getTimerSeconds(t));
        });
        Object.entries(blockTimers).forEach(([level, bt]) => {
            const clock = document.getElementById(`blockClock_${level}`);
            if (clock) clock.textContent = formatTime(Math.abs(getBlockRemainingSeconds(bt)));
        });
        if (Object.values(taskTimers).some(t => t.running) || Object.values(blockTimers).some(t => t.running)) {
            requestWakeLock();
            forceUpdateTimerNotification();
        }
    }
});

function checkAndManageWakeLock() {
    if (!settings.wakeLock) { releaseWakeLock(); return; }
    const hasRunning = Object.values(taskTimers).some(t => t.running) || Object.values(blockTimers).some(t => t.running);
    if (hasRunning) {
        requestWakeLock();
    } else {
        releaseWakeLock();
    }
}

async function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
    }
}

function sendSWMessage(msg) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(msg);
    } else if (navigator.serviceWorker) {
        navigator.serviceWorker.ready.then(reg => {
            if (reg.active) reg.active.postMessage(msg);
        });
    }
}

let _lastNotifSignature = '';
let _notifStationIds = new Set();

function updateTimerNotification() {
    // no-op for interval ticks — notifications only update on state changes
}

function forceUpdateTimerNotification() {
    if (!settings.timerNotifications) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!navigator.serviceWorker) return;

    // Group active ingredients by station
    const stationMap = {}; // { stationId: { name, ingredients: [] } }

    Object.entries(taskTimers).forEach(([key, t]) => {
        const sid = t.stationId;
        const station = stations.find(s => s.id === sid);
        const sName = station ? station.name : 'Station';
        if (!stationMap[sid]) stationMap[sid] = { name: sName, ingredients: [] };
        stationMap[sid].ingredients.push(t.ingName);
    });

    Object.entries(blockTimers).forEach(([level, bt]) => {
        stations.forEach(station => {
            getAllIngredients(station).forEach(ing => {
                const st = station.status[ing.id];
                if (!st || st.completed) return;
                if ((st.priority || 'none') !== level) return;
                const sid = station.id;
                if (!stationMap[sid]) stationMap[sid] = { name: station.name, ingredients: [] };
                if (!stationMap[sid].ingredients.includes(ing.name)) {
                    stationMap[sid].ingredients.push(ing.name);
                }
            });
        });
    });

    const stationList = Object.entries(stationMap).map(([id, data]) => ({
        id,
        name: data.name,
        ingredients: data.ingredients
    }));

    if (stationList.length === 0) {
        _lastNotifSignature = '';
        _notifStationIds = new Set();
        sendSWMessage({ type: 'TIMER_CLEAR_ALL' });
        return;
    }

    const sig = stationList.map(s => `${s.id}:${s.ingredients.join(',')}`).join('|');
    if (sig === _lastNotifSignature) return;

    // Detect which stations are truly new (for vibration)
    const newStationIds = new Set(stationList.map(s => s.id));
    const brandNew = stationList.filter(s => !_notifStationIds.has(s.id)).map(s => s.id);

    _lastNotifSignature = sig;
    _notifStationIds = newStationIds;

    sendSWMessage({
        type: 'TIMER_STATIONS',
        stations: stationList,
        newStationIds: brandNew
    });
}

// Listen for messages from Service Worker
if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', event => {
        if (!event.data) return;
        if (event.data.type === 'OPEN_SUMMARY') {
            switchView('summary');
        }
        if (event.data.type === 'STOP_PREP_TIMER') {
            confirmClockOut();
        }
    });
}

// ==================== MULTI-TASK TIMER SYSTEM ====================

function toggleTaskTimer(timerKey, stationId, ingredientId, ingName) {
    if (taskTimers[timerKey]) {
        // Already exists — toggle pause/resume
        if (taskTimers[timerKey].running) {
            pauseTaskTimer(timerKey);
        } else {
            resumeTaskTimer(timerKey);
        }
        return;
    }

    // Request notification permission on first timer
    requestNotificationPermission();

    // Check if template exists for active/passive phases
    const key = ingName.toLowerCase();
    const tmpl = taskTemplates[key];
    const hasTemplate = tmpl && (tmpl.activeSecondsPerUnit > 0 || tmpl.passiveSecondsPerUnit > 0);
    const hasPassive = hasTemplate && tmpl.passiveSecondsPerUnit > 0;

    // Best time from logs for countdown
    const bestGoal = getIngredientBestTime(ingName) || 0;

    // Start new timer
    taskTimers[timerKey] = {
        stationId, ingredientId, ingName,
        running: true,
        startedAt: Date.now(),
        pausedElapsed: 0,
        phase: hasTemplate ? 'active' : 'legacy',
        activeSeconds: 0,
        passiveSeconds: 0,
        wallStartedAt: Date.now(),
        hasPassivePhase: hasPassive,
        bestGoalSeconds: bestGoal,
        interval: setInterval(() => {
            const t = taskTimers[timerKey];
            const elapsed = getTimerSeconds(t);
            const clock = document.getElementById(`clock_${timerKey}`);
            if (clock) {
                if (t.bestGoalSeconds > 0) {
                    const remaining = t.bestGoalSeconds - elapsed;
                    clock.textContent = (remaining < 0 ? '-' : '') + formatTime(Math.abs(remaining));
                    if (remaining < 0) clock.classList.add('overtime');
                    else clock.classList.remove('overtime');
                } else {
                    clock.textContent = formatTime(elapsed);
                }
            }
            updateTimerNotification();
        }, 1000)
    };

    forceUpdateTimerNotification();

    checkAndManageWakeLock();
    showToast(bestGoal > 0 ? `⏱ ${formatTime(bestGoal)} countdown` : `⏱ Timing: ${ingName}`);
    refreshSummaryPanel();
}

function pauseTaskTimer(timerKey) {
    const t = taskTimers[timerKey];
    if (!t || !t.running) return;
    t.pausedElapsed = getTimerSeconds(t);
    t.running = false;
    t.startedAt = null;
    if (t.interval) clearInterval(t.interval);
    t.interval = null;
    forceUpdateTimerNotification();
    checkAndManageWakeLock();
    refreshSummaryPanel();
}

function resumeTaskTimer(timerKey) {
    const t = taskTimers[timerKey];
    if (!t || t.running) return;
    t.running = true;
    t.startedAt = Date.now();
    t.interval = setInterval(() => {
        const clock = document.getElementById(`clock_${timerKey}`);
        if (clock) clock.textContent = formatTime(getTimerSeconds(t));
        updateTimerNotification();
    }, 1000);
    forceUpdateTimerNotification();
    checkAndManageWakeLock();
    refreshSummaryPanel();
}

function resetTaskTimer(timerKey) {
    const t = taskTimers[timerKey];
    if (!t) return;
    if (t.interval) clearInterval(t.interval);
    delete taskTimers[timerKey];
    forceUpdateTimerNotification();

    checkAndManageWakeLock();
    refreshSummaryPanel();
}

function nextTimerPhase(timerKey) {
    const t = taskTimers[timerKey];
    if (!t || t.phase !== 'active') return;

    // Snapshot active time
    t.activeSeconds += getTimerSeconds(t);

    // Switch to passive
    t.phase = 'passive';
    t.pausedElapsed = 0;
    t.startedAt = Date.now();

    // Restart interval for passive display
    if (t.interval) clearInterval(t.interval);
    t.interval = setInterval(() => {
        const clock = document.getElementById(`clock_${timerKey}`);
        if (clock) {
            const passiveElapsed = getTimerSeconds(t);
            const totalElapsed = t.activeSeconds + passiveElapsed;
            if (t.bestGoalSeconds > 0) {
                const remaining = t.bestGoalSeconds - totalElapsed;
                clock.textContent = (remaining < 0 ? '-' : '') + formatTime(Math.abs(remaining));
                if (remaining < 0) clock.classList.add('overtime');
                else clock.classList.remove('overtime');
            } else {
                clock.textContent = formatTime(passiveElapsed);
            }
        }
        updateTimerNotification();
    }, 1000);

    forceUpdateTimerNotification();
    refreshSummaryPanel();
    showToast('Passive phase started');
}

// ── Block Timers (countdown from estimated total) ──
function getBlockEstimateSeconds(level) {
    // Sum best times from completed logs for incomplete tasks in this block
    let totalEst = 0;
    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            const st = station.status[ing.id];
            if (!st || st.completed) return;
            if ((st.priority || 'none') !== level) return;
            const best = getIngredientBestTime(ing.name);
            if (best) totalEst += best;
        });
    });
    return { total: totalEst };
}

function blockHasTimingData(level) {
    // Check if ANY incomplete ingredient in this block has completed log data
    let has = false;
    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            const st = station.status[ing.id];
            if (!st || st.completed) return;
            if ((st.priority || 'none') !== level) return;
            if (getIngredientBestTime(ing.name)) has = true;
        });
    });
    return has;
}

function toggleBlockTimer(level) {
    handleClick();
    if (blockTimers[level]) {
        if (blockTimers[level].running) {
            pauseBlockTimer(level);
        } else {
            resumeBlockTimer(level);
        }
        return;
    }
    requestNotificationPermission();
    const blockEst = getBlockEstimateSeconds(level);
    blockTimers[level] = {
        goalSeconds: blockEst.total,
        running: true,
        countdown: true,
        startedAt: Date.now(),
        pausedElapsed: 0,
        _alertedZero: false,
        interval: setInterval(() => {
            const remaining = getBlockRemainingSeconds(blockTimers[level]);
            const clock = document.getElementById(`blockClock_${level}`);
            if (clock) clock.textContent = formatTime(Math.abs(remaining));
            if (!blockTimers[level]._alertedZero && remaining <= 0) {
                blockTimers[level]._alertedZero = true;
                if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
                showToast('Block time reached!');
            }
            updateTimerNotification();
        }, 1000)
    };
    forceUpdateTimerNotification();
    checkAndManageWakeLock();
    refreshSummaryPanel();
}

function pauseBlockTimer(level) {
    const bt = blockTimers[level];
    if (!bt || !bt.running) return;
    bt.pausedElapsed = bt.pausedElapsed + Math.floor((Date.now() - bt.startedAt) / 1000);
    bt.running = false;
    bt.startedAt = null;
    if (bt.interval) clearInterval(bt.interval);
    bt.interval = null;
    forceUpdateTimerNotification();
    checkAndManageWakeLock();
    refreshSummaryPanel();
}

function resumeBlockTimer(level) {
    const bt = blockTimers[level];
    if (!bt || bt.running) return;
    bt.running = true;
    bt.startedAt = Date.now();
    bt.interval = setInterval(() => {
        const remaining = getBlockRemainingSeconds(bt);
        const clock = document.getElementById(`blockClock_${level}`);
        if (clock) clock.textContent = formatTime(Math.abs(remaining));
        if (!bt._alertedZero && remaining <= 0) {
            bt._alertedZero = true;
            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
            showToast('Block time reached!');
        }
        updateTimerNotification();
    }, 1000);
    forceUpdateTimerNotification();
    checkAndManageWakeLock();
    refreshSummaryPanel();
}

function resetBlockTimer(level) {
    const bt = blockTimers[level];
    if (!bt) return;
    if (bt.interval) clearInterval(bt.interval);
    delete blockTimers[level];
    forceUpdateTimerNotification();
    checkAndManageWakeLock();
    refreshSummaryPanel();
}

function checkBlockCompletion(level) {
    const bt = blockTimers[level];
    if (!bt) return;
    let allDone = true;
    let taskCount = 0;
    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            const st = station.status[ing.id];
            if (!st) return;
            if ((st.priority || 'none') !== level) return;
            taskCount++;
            if (!st.completed) allDone = false;
        });
    });
    if (!allDone || taskCount === 0) return;

    const seconds = getBlockRemainingSeconds(bt);
    const goal = bt.goalSeconds || 0;
    let status;
    if (seconds < -15) status = 'behind';
    else if (seconds > 15) status = 'ahead';
    else status = 'ontime';

    const labels = { high: 'High Priority', medium: 'Medium Priority', low: 'Low Priority', none: 'No Priority Set' };
    const label = labels[level] || level;

    if (bt.interval) clearInterval(bt.interval);
    delete blockTimers[level];
    forceUpdateTimerNotification();
    checkAndManageWakeLock();

    logActivity('block_complete', { level, label, seconds, goal, status });

    const msgs = { behind: 'Behind', ontime: 'On Time', ahead: 'Ahead!' };
    const icons = { behind: '\u23F0', ontime: '\u2705', ahead: '\uD83C\uDFC6' };
    showToast(`${label}: ${icons[status]} ${msgs[status]}`);
    refreshSummaryPanel();
}

function showTaskCompleteConfirm(stationId, ingredientId) {
    const timerKey = `${stationId}_${ingredientId}`;
    const t = taskTimers[timerKey];
    const station = stations.find(s => s.id === stationId);
    const ing = station ? getAllIngredients(station).find(i => i.id === ingredientId) : null;
    if (!ing) return;

    const ingName = ing.name;
    const st = station.status[ingredientId];
    const timeStr = t ? formatTime(getTimerSeconds(t)) : '0:00';
    const defaultQty = st.parQty || 1;
    const defaultUnit = st.parUnit || '';

    // Pause timer if running
    if (t && t.running) {
        pauseTaskTimer(timerKey);
    }

    const existing = document.getElementById('modalTaskComplete');
    if (existing) existing.remove();

    const unitLabel = defaultUnit ? `<span style="font-size:14px;font-weight:600;color:var(--text-secondary);margin-left:6px;">${PAN_UNITS.includes(defaultUnit) ? `${st.parDepth || 4}" ${defaultUnit}` : defaultUnit}</span>` : '';

    // Calculate active/passive breakdown for display
    const hasPhases = t && t.phase && t.phase !== 'legacy';
    const activeTotal = hasPhases ? ((t.activeSeconds || 0) + (t.phase === 'active' ? getTimerSeconds(t) : 0)) : 0;
    const passiveTotal = hasPhases ? ((t.passiveSeconds || 0) + (t.phase === 'passive' ? getTimerSeconds(t) : 0)) : 0;
    const elapsedTotal = t && t.wallStartedAt ? Math.floor((Date.now() - t.wallStartedAt) / 1000) : 0;

    const phaseBreakdown = hasPhases ? `
        <div style="display:flex;justify-content:center;gap:16px;margin-bottom:12px;font-size:12px;">
            <span style="color:var(--accent);font-weight:700;">Active: ${formatTime(activeTotal)}</span>
            ${passiveTotal > 0 ? `<span style="color:var(--low);font-weight:700;">Passive: ${formatTime(passiveTotal)}</span>` : ''}
        </div>
        <p style="font-size:10px;color:var(--text-muted);margin-bottom:12px;">Elapsed: ${formatTime(elapsedTotal)}</p>
    ` : `
        <p style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">You took</p>
        <p style="font-size:28px;font-weight:800;color:var(--accent);margin-bottom:12px;">${timeStr}</p>
    `;

    const modal = document.createElement('div');
    modal.id = 'modalTaskComplete';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Task Done</div>
            <p style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px;">${ingName}</p>
            ${phaseBreakdown}
            <div class="form-group" style="margin-bottom:16px;">
                <label style="font-size:11px;font-weight:600;color:var(--text-secondary);">Quantity prepped</label>
                <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
                    <input type="number" id="completeQty" class="form-control" value="${defaultQty}" min="0.1" step="0.5" style="text-align:center;font-size:18px;width:100px;">
                    ${unitLabel}
                </div>
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="handleClick(); cancelTaskComplete(${stationId}, ${ingredientId})">Continue</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); confirmTaskComplete(${stationId}, ${ingredientId})">Done</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
}

function confirmTaskComplete(stationId, ingredientId) {
    const timerKey = `${stationId}_${ingredientId}`;
    const t = taskTimers[timerKey];
    const station = stations.find(s => s.id === stationId);
    const ing = station ? getAllIngredients(station).find(i => i.id === ingredientId) : null;

    // Log time to prepTimes database if timer was running
    const tSec = getTimerSeconds(t);
    if (t && tSec > 0 && ing) {
        const qtyEl = document.getElementById('completeQty');
        const qty = parseFloat(qtyEl ? qtyEl.value : 1) || 1;
        const key = ing.name.toLowerCase();
        const st = station.status[ingredientId];
        const unit = st.parUnit || 'unit';
        const baseQty = convertToBase(qty, unit, st.parDepth);
        const baseUnit = getBaseUnit(unit);

        // Calculate active/passive breakdown
        const activeTotal = (t.activeSeconds || 0) + (t.phase === 'active' ? getTimerSeconds(t) : 0);
        const passiveTotal = (t.passiveSeconds || 0) + (t.phase === 'passive' ? getTimerSeconds(t) : 0);
        const elapsedTotal = t.wallStartedAt ? Math.floor((Date.now() - t.wallStartedAt) / 1000) : tSec;

        // For prepTimes, use active time only (exclude passive)
        const activeForRate = activeTotal > 0 ? activeTotal : tSec;
        const secPerBaseUnit = baseQty > 0 ? activeForRate / baseQty : activeForRate;

        if (!prepTimes[key]) {
            prepTimes[key] = { avgSecPerUnit: secPerBaseUnit, bestSecPerUnit: secPerBaseUnit, count: 1, baseUnit, volumeCount: 0, weightCount: 0 };
        } else {
            const pt = prepTimes[key];
            pt.avgSecPerUnit = ((pt.avgSecPerUnit * pt.count) + secPerBaseUnit) / (pt.count + 1);
            pt.bestSecPerUnit = Math.min(pt.bestSecPerUnit, secPerBaseUnit);
            pt.count++;
            if (pt.baseUnit === 'unit') pt.baseUnit = baseUnit;
        }
        // Track per-family log count (capped at 3)
        const family = getUnitFamily(unit);
        const ptEntry = prepTimes[key];
        if (family === 'volume') ptEntry.volumeCount = Math.min((ptEntry.volumeCount || 0) + 1, 3);
        else if (family === 'weight') ptEntry.weightCount = Math.min((ptEntry.weightCount || 0) + 1, 3);
        savePrepTimes();

        const tmpl = taskTemplates[key];
        logActivity('task_complete', {
            ingredient: ing.name,
            station: station.name,
            seconds: tSec,
            quantity: qty,
            unit,
            depth: st.parDepth || null,
            baseUnit,
            secPerUnit: Math.round(secPerBaseUnit),
            activeSeconds: activeTotal,
            passiveSeconds: passiveTotal,
            elapsedSeconds: elapsedTotal,
            templateVersion: tmpl ? tmpl.templateVersion : null
        });
    } else if (ing) {
        logActivity('task_complete', {
            ingredient: ing.name,
            station: station.name,
            seconds: 0,
            quantity: 0,
            unit: '',
            secPerUnit: 0,
            activeSeconds: 0,
            passiveSeconds: 0,
            elapsedSeconds: 0,
            templateVersion: null
        });
    }

    // Clean up timer
    if (t) {
        if (t.interval) clearInterval(t.interval);
        delete taskTimers[timerKey];
    }
    forceUpdateTimerNotification();

    // Auto-clean: reset priority and low so dot disappears from Home
    if (station && station.status[ingredientId]) {
        const pLevel = station.status[ingredientId].priority || 'none';
        station.status[ingredientId].completed = false;
        station.status[ingredientId].priority = null;
        station.status[ingredientId].low = false;
        saveData(true);

        const modal = document.getElementById('modalTaskComplete');
        if (modal) modal.remove();

        animateMascot();
        checkBlockCompletion(pLevel);
        refreshSummaryPanel();
        rerenderHomePanel();
    }
}

function cancelTaskComplete(stationId, ingredientId) {
    // User wants to continue — resume timer if it existed
    const timerKey = `${stationId}_${ingredientId}`;
    const t = taskTimers[timerKey];
    if (t) {
        resumeTaskTimer(timerKey);
    }
    const modal = document.getElementById('modalTaskComplete');
    if (modal) modal.remove();
}

// ==================== ACTIVITY LOG ====================

function logActivity(type, data) {
    activityLog.push({
        type,
        data,
        timestamp: new Date().toISOString(),
        cook: settings.cookName || 'Unknown'
    });
    // Keep last 500 entries
    if (activityLog.length > 500) activityLog = activityLog.slice(-500);
    localStorage.setItem('aqueous_activityLog', JSON.stringify(activityLog));
    markAllPanelsDirty();
}

function saveActivityLog() {
    localStorage.setItem('aqueous_activityLog', JSON.stringify(activityLog));
}

// ==================== CELEBRATION ====================

function launchCelebration() {
    const overlay = document.createElement('div');
    overlay.className = 'celebration-overlay';
    overlay.innerHTML = `
        <div class="celebration-content">
            <div class="celebration-emoji">🎉</div>
            <h2>All Tasks Complete!</h2>
            <p>Great job today, chef!</p>
            <button class="btn btn-primary" onclick="this.closest('.celebration-overlay').remove()">Close</button>
        </div>
        <canvas id="confettiCanvas"></canvas>`;
    document.body.appendChild(overlay);

    // Confetti animation
    const canvas = document.getElementById('confettiCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = [];
    const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#5f27cd', '#01a3a4'];

    for (let i = 0; i < 150; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            w: Math.random() * 10 + 5,
            h: Math.random() * 6 + 3,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: (Math.random() - 0.5) * 4,
            vy: Math.random() * 3 + 2,
            rotation: Math.random() * 360,
            rv: (Math.random() - 0.5) * 10
        });
    }

    let frames = 0;
    let animId = null;
    function animate() {
        if (frames > 180 || !document.getElementById('confettiCanvas')) {
            // Cleanup: cancel animation and release references
            if (animId) cancelAnimationFrame(animId);
            particles.length = 0;
            return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.rotation += p.rv;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        });
        frames++;
        animId = requestAnimationFrame(animate);
    }
    animate();
}

// ==================== SHARE VIEW ====================

function renderShare(container) {
    let html = `
        <div class="share-section">
            <h3 class="share-title">Share Full Report</h3>
            <div class="share-cards">
                <button class="share-card" onclick="handleClick(); shareAllWhatsApp()">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                    <span>WhatsApp</span>
                </button>
                <button class="share-card" onclick="handleClick(); shareAllSMS()">
                    <span style="font-size:28px;">📱</span>
                    <span>Text / SMS</span>
                </button>
                <button class="share-card" onclick="handleClick(); shareAppLink()">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                    <span>Copy Link</span>
                </button>
                ${navigator.share ? `<button class="share-card" onclick="handleClick(); nativeShareAll()">
                    <span style="font-size:28px;">📤</span>
                    <span>More</span>
                </button>` : `<button class="share-card" style="visibility:hidden;"></button>`}
            </div>

            <h3 class="share-title" style="margin-top:24px">Share by Station</h3>`;

    stations.forEach(station => {
        const lowCount = Object.values(station.status).filter(s => s.low).length;
        html += `
            <button class="share-station-btn" onclick="shareStation(${station.id})">
                <span>${station.name}</span>
                <span class="share-station-count">${lowCount} items</span>
            </button>`;
    });

    html += '</div>';
    container.innerHTML = html;
}

function buildStationReport(station) {
    const stationIngs = getAllIngredients(station);
    if (stationIngs.length === 0) return null;

    const lowItems = stationIngs.filter(ing =>
        station.status[ing.id] && station.status[ing.id].low
    );
    const okItems = stationIngs.filter(ing =>
        !station.status[ing.id] || !station.status[ing.id].low
    );

    let msg = `📋 *CHECKLIST - ${station.name.toUpperCase()}*\n`;
    msg += `📅 ${new Date().toLocaleDateString('en-US')}\n\n`;

    // Needs prep section
    if (lowItems.length > 0) {
        const high = lowItems.filter(i => station.status[i.id].priority === 'high');
        const medium = lowItems.filter(i => station.status[i.id].priority === 'medium');
        const low = lowItems.filter(i => station.status[i.id].priority === 'low');
        const none = lowItems.filter(i => !station.status[i.id].priority);

        msg += `⚠️ *NEEDS PREP (${lowItems.length}):*\n`;
        if (high.length) {
            msg += `\n🔴 *High Priority:*\n`;
            high.forEach(i => {
                const st = station.status[i.id];
                const par = st.parLevel;
                const done = st.completed ? ' ✅' : '';
                msg += `  • ${i.name}${par ? ' — ' + par : ''}${done}\n`;
            });
        }
        if (medium.length) {
            msg += `\n🟡 *Medium:*\n`;
            medium.forEach(i => {
                const st = station.status[i.id];
                const par = st.parLevel;
                const done = st.completed ? ' ✅' : '';
                msg += `  • ${i.name}${par ? ' — ' + par : ''}${done}\n`;
            });
        }
        if (low.length) {
            msg += `\n🔵 *Low:*\n`;
            low.forEach(i => {
                const st = station.status[i.id];
                const par = st.parLevel;
                const done = st.completed ? ' ✅' : '';
                msg += `  • ${i.name}${par ? ' — ' + par : ''}${done}\n`;
            });
        }
        if (none.length) {
            msg += `\n⚪ *No Priority:*\n`;
            none.forEach(i => {
                const st = station.status[i.id];
                const par = st.parLevel;
                const done = st.completed ? ' ✅' : '';
                msg += `  • ${i.name}${par ? ' — ' + par : ''}${done}\n`;
            });
        }
        msg += '\n';
    }

    // All good section
    if (okItems.length > 0) {
        msg += `✅ *ALL GOOD (${okItems.length}):*\n`;
        okItems.forEach(i => {
            msg += `  • ${i.name}\n`;
        });
    }

    return msg;
}

function shareStation(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    const msg = buildStationReport(station);
    if (!msg) {
        showToast('No ingredients in this station');
        return;
    }

    showShareModal(msg, stationId);
}

function showShareModal(msg, stationId) {
    // Remove existing share modal if any
    const existing = document.getElementById('modalShareOptions');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalShareOptions';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Share Station</div>
            <p style="font-size:12px;color:var(--text-secondary);margin-bottom:20px;">Choose how to share</p>
            <button class="btn btn-primary squishy" style="margin-bottom:10px;" onclick="handleClick(); shareViaWhatsApp('${btoa(encodeURIComponent(msg))}')">
                💬 WhatsApp Report
            </button>
            <button class="btn btn-secondary squishy" style="margin-bottom:10px;" onclick="handleClick(); shareViaSMS('${btoa(encodeURIComponent(msg))}')">
                📱 Text / SMS
            </button>
            <button class="btn btn-secondary squishy" style="margin-bottom:10px;" onclick="handleClick(); shareStationLink(${stationId})">
                🔗 Copy Station Link
            </button>
            ${navigator.share ? `<button class="btn btn-secondary squishy" style="margin-bottom:10px;" onclick="handleClick(); nativeShareStation('${btoa(encodeURIComponent(msg))}')">
                📤 More Options
            </button>` : ''}
            <button class="btn btn-link" onclick="document.getElementById('modalShareOptions').remove()">Cancel</button>
        </div>`;
    document.body.appendChild(modal);

    modal.onclick = function(e) {
        if (e.target === modal) modal.remove();
    };
}

function shareViaWhatsApp(encodedMsg) {
    const msg = decodeURIComponent(atob(encodedMsg));
    closeShareModal();
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

function shareViaSMS(encodedMsg) {
    const msg = decodeURIComponent(atob(encodedMsg));
    closeShareModal();
    window.open(`sms:?body=${encodeURIComponent(msg)}`, '_blank');
}

function shareStationLink(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    closeShareModal();

    const data = compressData([station]);
    const link = window.location.origin + window.location.pathname + '?d=' + data;

    if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(() => showToast('Station link copied!'));
    } else {
        prompt('Copy this link:', link);
    }
}

function nativeShareStation(encodedMsg) {
    const msg = decodeURIComponent(atob(encodedMsg));
    closeShareModal();
    if (navigator.share) {
        navigator.share({ title: 'Aqueous Checklist', text: msg }).catch(() => {});
    }
}

function closeShareModal() {
    const modal = document.getElementById('modalShareOptions');
    if (modal) modal.remove();
}

function shareAllWhatsApp() {
    const msg = buildFullReport();
    if (!msg) {
        showToast('No items marked in any station');
        return;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

function buildFullReport() {
    if (stations.length === 0) return null;

    let msg = `📋 *AQUEOUS — FULL STATION REPORT*\n`;
    msg += `📅 ${new Date().toLocaleDateString('en-US')}\n`;
    if (settings.cookName) msg += `👨‍🍳 ${settings.cookName}\n`;
    msg += '\n';

    stations.forEach(station => {
        const stationIngs = getAllIngredients(station);
        if (stationIngs.length === 0) return;

        const lowItems = stationIngs.filter(i =>
            station.status[i.id] && station.status[i.id].low
        );
        const okItems = stationIngs.filter(i =>
            !station.status[i.id] || !station.status[i.id].low
        );

        msg += `━━━━━━━━━━━━━━━━\n`;
        msg += `🏪 *${station.name.toUpperCase()}*\n━━━━━━━━━━━━━━━━\n\n`;

        if (lowItems.length > 0) {
            const high = lowItems.filter(i => station.status[i.id].priority === 'high');
            const medium = lowItems.filter(i => station.status[i.id].priority === 'medium');
            const low = lowItems.filter(i => station.status[i.id].priority === 'low');
            const none = lowItems.filter(i => !station.status[i.id].priority);

            if (high.length) msg += `🔴 High: ${high.map(i => { const st = station.status[i.id]; return i.name + (st.parLevel ? ' (' + st.parLevel + ')' : '') + (st.completed ? ' ✅' : ''); }).join(', ')}\n`;
            if (medium.length) msg += `🟡 Medium: ${medium.map(i => { const st = station.status[i.id]; return i.name + (st.parLevel ? ' (' + st.parLevel + ')' : '') + (st.completed ? ' ✅' : ''); }).join(', ')}\n`;
            if (low.length) msg += `🔵 Low: ${low.map(i => { const st = station.status[i.id]; return i.name + (st.parLevel ? ' (' + st.parLevel + ')' : '') + (st.completed ? ' ✅' : ''); }).join(', ')}\n`;
            if (none.length) msg += `⚪ Unmarked: ${none.map(i => { const st = station.status[i.id]; return i.name + (st.parLevel ? ' (' + st.parLevel + ')' : '') + (st.completed ? ' ✅' : ''); }).join(', ')}\n`;
        }

        if (okItems.length > 0) {
            msg += `✅ All good: ${okItems.map(i => i.name).join(', ')}\n`;
        }
        msg += '\n';
    });

    return msg;
}

function shareAllSMS() {
    const msg = buildFullReport();
    if (!msg) {
        showToast('No items marked in any station');
        return;
    }
    window.open(`sms:?body=${encodeURIComponent(msg)}`, '_blank');
}

function nativeShareAll() {
    const msg = buildFullReport();
    if (!msg) {
        showToast('No items marked in any station');
        return;
    }
    if (navigator.share) {
        navigator.share({ title: 'Aqueous Station Report', text: msg }).catch(() => {});
    }
}

function compressData(data) {
    // Minify station data: include ALL ingredients across dishes, shorten keys
    const mini = data.map(s => {
        const allIngs = getAllIngredients(s);
        const items = allIngs.map(i => {
            const st = s.status[i.id] || {};
            const obj = { n: i.name };
            if (st.low) obj.l = 1;
            if (st.priority) obj.p = st.priority[0]; // h, m, l
            if (st.parLevel) obj.v = st.parLevel;
            if (st.completed) obj.c = 1;
            return obj;
        });
        return { s: s.name, i: items };
    });
    return btoa(encodeURIComponent(JSON.stringify(mini)));
}

function decompressData(encoded) {
    try {
        const mini = JSON.parse(decodeURIComponent(atob(encoded)));
        return mini.map(s => {
            const ings = [];
            const status = {};
            (s.i || []).forEach((item, idx) => {
                const ingId = Date.now() + idx + Math.floor(Math.random() * 10000);
                ings.push({ id: ingId, name: item.n });
                const pMap = { h: 'high', m: 'medium', l: 'low' };
                status[ingId] = {
                    low: !!item.l,
                    priority: item.p ? pMap[item.p] : null,
                    parLevel: item.v || '',
                    completed: !!item.c
                };
            });
            return {
                id: Date.now() + Math.floor(Math.random() * 10000),
                name: s.s,
                dishes: [{ id: Date.now() + Math.floor(Math.random() * 10000), name: 'General', sortOrder: 0, expanded: true, ingredients: ings }],
                status,
                expanded: true
            };
        });
    } catch (e) {
        return null;
    }
}

function shareAppLink() {
    const data = compressData(stations);
    const link = window.location.origin + window.location.pathname + '?d=' + data;

    // Try native share first for cleaner experience
    if (navigator.share) {
        navigator.share({
            title: 'Aqueous Checklist',
            text: '📋 Check out my prep list on Aqueous!',
            url: link
        }).catch(() => {
            // Fallback to clipboard
            copyToClipboard(link);
        });
    } else {
        copyToClipboard(link);
    }
}

function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Link copied!');
        });
    } else {
        prompt('Copy this link:', text);
    }
}

// ==================== LOGS VIEW ====================

let logDetailIngredient = null;

function toggleLogsBlock(blockKey) {
    handleClick();
    logsBlockCollapsed[blockKey] = !logsBlockCollapsed[blockKey];
    panelDirty.logs = true;
    renderPanel('logs');
}

function renderLogs(container) {
    // Collect ALL unique ingredients from all stations
    const allIngredients = [];
    const seen = new Set();
    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            const key = ing.name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            allIngredients.push({ name: ing.name, station: station.name });
        });
    });

    if (allIngredients.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📝</div>
                <p>No ingredients yet</p>
                <p class="empty-sub">Add ingredients to your stations first</p>
            </div>`;
        return;
    }

    // Build log count map from activityLog
    const logMap = {};
    activityLog.forEach(entry => {
        if (entry.type !== 'task_complete' || !entry.data || !entry.data.seconds || entry.data.seconds === 0) return;
        const d = entry.data;
        const key = d.ingredient;
        if (!logMap[key]) logMap[key] = { count: 0, lastTimestamp: entry.timestamp };
        logMap[key].count++;
        if (entry.timestamp > logMap[key].lastTimestamp) logMap[key].lastTimestamp = entry.timestamp;
    });

    // Partition
    const withData = [];
    const missingData = [];
    allIngredients.forEach(ing => {
        if (ingredientHasTimingData(ing.name)) {
            const lm = logMap[ing.name];
            const bestTime = getIngredientBestTime(ing.name);
            withData.push({
                name: ing.name,
                station: ing.station,
                count: lm ? lm.count : 0,
                bestTime,
                lastTimestamp: lm ? lm.lastTimestamp : ''
            });
        } else {
            missingData.push(ing);
        }
    });

    // Sort withData by most recent first
    withData.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));

    let html = '';

    // Block 1: With Timing Data
    html += `
        <div class="logs-block-header" onclick="toggleLogsBlock('withData')">
            <span>With Timing Data (${withData.length})</span>
            <span class="summary-expand-icon">${logsBlockCollapsed.withData ? '+' : '\u2212'}</span>
        </div>
        <div class="logs-block-body${logsBlockCollapsed.withData ? ' collapsed' : ''}">`;

    if (withData.length === 0) {
        html += `<div style="padding:12px 4px;font-size:12px;color:var(--text-muted);">No timing data yet — complete tasks with timers</div>`;
    } else {
        withData.forEach(ing => {
            const escapedName = ing.name.replace(/'/g, "\\'");
            const hasLogs = ing.count > 0;
            html += `
            <button class="log-ingredient-card" ${hasLogs ? `onclick="handleClick(); openLogDetail('${escapedName}')"` : ''} ${!hasLogs ? 'style="cursor:default;"' : ''}>
                <div class="log-ing-top">
                    <span class="log-ing-name">${ing.name}</span>
                    <span class="log-ing-count">${ing.count > 0 ? ing.count + ' log' + (ing.count !== 1 ? 's' : '') : 'template'}</span>
                </div>
                <div class="log-ing-bottom">
                    <span class="log-ing-station">${ing.station}</span>
                    ${ing.bestTime ? `<span class="log-ing-best">${formatTime(ing.bestTime)}</span>` : ''}
                </div>
                ${hasLogs ? '<svg class="log-ing-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>' : ''}
            </button>`;
        });
    }
    html += `</div>`;

    // Block 2: Missing Timing Data
    html += `
        <div class="logs-block-header" onclick="toggleLogsBlock('missingData')">
            <span>Missing Timing Data (${missingData.length})</span>
            <span class="summary-expand-icon">${logsBlockCollapsed.missingData ? '+' : '\u2212'}</span>
        </div>
        <div class="logs-block-body${logsBlockCollapsed.missingData ? ' collapsed' : ''}">`;

    if (missingData.length === 0) {
        html += `<div style="padding:12px 4px;font-size:12px;color:var(--text-muted);">All ingredients have timing data!</div>`;
    } else {
        missingData.forEach(ing => {
            html += `
            <div class="logs-missing-card">
                <span class="logs-missing-name">${ing.name}</span>
                <span class="logs-missing-station">${ing.station}</span>
            </div>`;
        });
    }
    html += `</div>`;

    container.innerHTML = html;
}

function openLogDetail(ingredientName) {
    logDetailIngredient = ingredientName;
    switchView('logDetail');
}

function renderLogDetail(container) {
    if (!logDetailIngredient) { switchView('logs'); return; }

    const entries = activityLog.filter(e =>
        e.type === 'task_complete' && e.data && e.data.ingredient === logDetailIngredient && e.data.seconds > 0
    ).sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Find best (shortest) active time (or total for legacy)
    let bestSeconds = Infinity;
    entries.forEach(e => {
        const activeTime = e.data.activeSeconds > 0 ? e.data.activeSeconds : e.data.seconds;
        if (activeTime > 0 && activeTime < bestSeconds) bestSeconds = activeTime;
    });

    const bestStr = bestSeconds < Infinity ? formatTime(bestSeconds) : '—';
    const totalSessions = entries.length;

    // Group entries by day
    const grouped = {};
    entries.forEach(entry => {
        const dateKey = new Date(entry.timestamp).toISOString().split('T')[0];
        if (!grouped[dateKey]) grouped[dateKey] = [];
        grouped[dateKey].push(entry);
    });

    let html = `
        <button class="log-back-btn" onclick="handleClick(); switchView('logs')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            Logs
        </button>
        <div class="log-detail-header">
            <div class="log-detail-name">${logDetailIngredient}</div>
            <div class="log-detail-stats">
                <div class="log-stat">
                    <span class="log-stat-value"><img src="./badge-96.png" style="width:14px;height:14px;vertical-align:middle;margin-right:2px;">${bestStr}</span>
                    <span class="log-stat-label">${entries.some(e => e.data.activeSeconds > 0) ? 'Best Active' : 'Best'}</span>
                </div>
                <div class="log-stat">
                    <span class="log-stat-value">${totalSessions}</span>
                    <span class="log-stat-label">Sessions</span>
                </div>
            </div>
        </div>`;

    Object.keys(grouped).sort().reverse().forEach(dateKey => {
        const dayEntries = grouped[dateKey];
        const dateObj = new Date(dateKey + 'T12:00:00');
        const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

        html += `
        <div class="log-day-card">
            <div class="log-day-header">
                <span style="font-size:13px;font-weight:700;color:var(--text);">${dateStr}</span>
                <span style="font-size:11px;color:var(--text-muted);">${dayEntries.length} session${dayEntries.length !== 1 ? 's' : ''}</span>
            </div>`;

        dayEntries.forEach(entry => {
            const d = entry.data;
            const hasPhaseData = d.activeSeconds > 0 || d.passiveSeconds > 0;
            const activeTime = hasPhaseData ? d.activeSeconds : d.seconds;
            const isBest = bestSeconds < Infinity && activeTime > 0 && activeTime <= bestSeconds;
            const time = new Date(entry.timestamp);
            const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            const logIndex = activityLog.indexOf(entry);

            html += `
            <div class="log-entry ${isBest ? 'log-best' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="font-size:18px;font-weight:800;color:var(--accent);">${formatTime(activeTime)}</span>
                        ${isBest ? '<span style="font-size:10px;color:var(--accent);display:flex;align-items:center;gap:2px;"><img src="./badge-96.png" style="width:12px;height:12px;">Best</span>' : ''}
                    </div>
                    <span style="font-size:10px;color:var(--text-muted);">${timeStr}</span>
                </div>
                ${hasPhaseData ? `
                <div style="display:flex;gap:12px;margin-top:4px;font-size:10px;">
                    <span style="color:var(--accent);font-weight:600;">Active: ${formatTime(d.activeSeconds)}</span>
                    ${d.passiveSeconds > 0 ? `<span style="color:var(--low);font-weight:600;">Passive: ${formatTime(d.passiveSeconds)}</span>` : ''}
                    ${d.elapsedSeconds > 0 ? `<span style="color:var(--text-muted);">Elapsed: ${formatTime(d.elapsedSeconds)}</span>` : ''}
                </div>` : ''}
                <div style="display:flex;gap:14px;margin-top:4px;font-size:11px;color:var(--text-secondary);">
                    <span>${PAN_UNITS.includes(d.unit) ? formatParDisplay(d.quantity, d.unit, d.depth) : `${d.quantity} ${d.unit || 'units'}`}</span>
                    <span>${d.station || ''}</span>
                </div>
                ${entry.cook ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${entry.cook}</div>` : ''}
                <div style="display:flex;gap:8px;margin-top:6px;">
                    <button class="log-action-btn" onclick="handleClick(); editLogEntry(${logIndex})">Edit</button>
                    ${hasPhaseData ? `<button class="log-action-btn" onclick="handleClick(); updateTemplateFromLog(${logIndex})">Update Template</button>` : ''}
                </div>
            </div>`;
        });

        html += '</div>';
    });

    container.innerHTML = html;
}

function editLogEntry(index) {
    const entry = activityLog[index];
    if (!entry) return;
    const d = entry.data;

    const totalSec = d.elapsedSeconds || d.seconds || ((d.activeSeconds || 0) + (d.passiveSeconds || 0)) || 0;
    const initActive = d.activeSeconds != null ? d.activeSeconds : totalSec;
    const unitLabel = d.unit || 'each';

    const existing = document.getElementById('modalEditLog');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalEditLog';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Edit Log</div>
            <p style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${d.ingredient}</p>
            <p style="font-size:11px;color:var(--text-muted);margin-bottom:14px;">Total: ${formatTime(totalSec)}</p>

            <div class="split-slider-labels">
                <span class="split-label active">Active<br><strong id="editActiveDisplay">${formatTime(initActive)}</strong></span>
                <span class="split-label passive">Passive<br><strong id="editPassiveDisplay">${formatTime(totalSec - initActive)}</strong></span>
            </div>
            <div class="split-slider-track" id="splitTrack" data-total="${totalSec}" style="--thumb-pct:${totalSec > 0 ? (initActive / totalSec * 100) : 100}%">
                <div class="split-slider-fill-active" id="splitFillActive" style="width:${totalSec > 0 ? (initActive / totalSec * 100) : 100}%"></div>
                <div class="split-slider-fill-passive" id="splitFillPassive" style="width:${totalSec > 0 ? ((totalSec - initActive) / totalSec * 100) : 0}%"></div>
                <input type="hidden" id="editSplitSlider" value="${initActive}">
            </div>

            <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;margin-bottom:16px;">
                <span style="font-size:12px;font-weight:600;color:var(--text-secondary);">Qty</span>
                <input type="number" id="editLogQty" class="form-control" value="${d.quantity || 1}" min="0.1" step="0.5" style="width:64px;text-align:center;font-size:14px;">
                <span class="edit-log-unit-pill">${unitLabel}</span>
            </div>

            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('modalEditLog').remove()">Cancel</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); saveLogEdit(${index}, ${totalSec})">Save</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    initSplitSliderDrag(totalSec);
}

function initSplitSliderDrag(totalSec) {
    const track = document.getElementById('splitTrack');
    if (!track || totalSec <= 0) return;

    function posToActive(clientX) {
        const rect = track.getBoundingClientRect();
        const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        const ratio = x / rect.width;
        // Left = active, right = passive
        // ratio 0 (full left) = active 0 = all passive
        // ratio 1 (full right) = active totalSec = all active
        return Math.round(ratio * totalSec);
    }

    function update(clientX) {
        const active = posToActive(clientX);
        const passive = totalSec - active;
        document.getElementById('editSplitSlider').value = active;
        document.getElementById('editActiveDisplay').textContent = formatTime(active);
        document.getElementById('editPassiveDisplay').textContent = formatTime(passive);
        const activePct = active / totalSec * 100;
        document.getElementById('splitFillActive').style.width = activePct + '%';
        document.getElementById('splitFillPassive').style.width = (100 - activePct) + '%';
        track.style.setProperty('--thumb-pct', activePct + '%');
    }

    // Touch events
    track.addEventListener('touchstart', function(e) {
        e.preventDefault();
        update(e.touches[0].clientX);
        function onMove(ev) { ev.preventDefault(); update(ev.touches[0].clientX); }
        function onEnd() { document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd); }
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }, { passive: false });

    // Mouse events
    track.addEventListener('mousedown', function(e) {
        e.preventDefault();
        update(e.clientX);
        function onMove(ev) { ev.preventDefault(); update(ev.clientX); }
        function onEnd() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onEnd); }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
    });
}

function saveLogEdit(index, totalSec) {
    const entry = activityLog[index];
    if (!entry) return;

    const activeSeconds = parseInt(document.getElementById('editSplitSlider').value) || 0;
    const passiveSeconds = totalSec - activeSeconds;
    const qty = parseFloat(document.getElementById('editLogQty').value) || 1;

    entry.data.activeSeconds = activeSeconds;
    entry.data.passiveSeconds = passiveSeconds;
    entry.data.seconds = totalSec;
    entry.data.elapsedSeconds = totalSec;
    entry.data.quantity = qty;

    localStorage.setItem('aqueous_activityLog', JSON.stringify(activityLog));

    const modal = document.getElementById('modalEditLog');
    if (modal) modal.remove();

    showToast('Log updated');
    renderLogDetail(document.getElementById('panelOverlay'));
}

function updateTemplateFromLog(index) {
    const entry = activityLog[index];
    if (!entry) return;
    const d = entry.data;
    if (!d.activeSeconds && !d.passiveSeconds) {
        showToast('No active/passive data');
        return;
    }

    const key = d.ingredient.toLowerCase();
    const baseQty = convertToBase(d.quantity || 1, d.unit || 'each', d.depth);
    const activePerUnit = baseQty > 0 ? d.activeSeconds / baseQty : d.activeSeconds;
    const passivePerUnit = baseQty > 0 ? (d.passiveSeconds || 0) / baseQty : (d.passiveSeconds || 0);

    taskTemplates[key] = {
        activeFixedSeconds: 0,
        activeSecondsPerUnit: activePerUnit,
        passiveFixedSeconds: 0,
        passiveSecondsPerUnit: passivePerUnit,
        lastUpdatedAt: new Date().toISOString(),
        calibratedBy: settings.cookName || 'Chef',
        templateVersion: (taskTemplates[key]?.templateVersion || 0) + 1
    };
    saveTaskTemplates();
    showToast('Template updated from log');
}

function formatTime(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function calculateBlockGoals() {
    const result = {
        high: { mins: 30, items: 0, detail: 'Default: 30 min' },
        medium: { mins: 60, items: 0, detail: 'Default: 60 min' },
        low: { mins: 45, items: 0, detail: 'Default: 45 min' }
    };

    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            const st = station.status[ing.id];
            if (!st || !st.low || st.completed) return;
            const p = st.priority || 'none';
            if (p === 'none') return;

            result[p].items++;

            const key = ing.name.toLowerCase();
            const est = getIngredientEstimate(ing.name, st.parQty || 1, st.parUnit || 'unit', st.parDepth);
            if (est) {
                if (!result[p].estSeconds) result[p].estSeconds = 0;
                result[p].estSeconds += est.totalSeconds;
                if (!result[p].ingredients) result[p].ingredients = [];
                result[p].ingredients.push(`${ing.name}: ~${Math.ceil(est.totalSeconds / 60)}m`);
            }
        });
    });

    // Calculate smart minutes from history data
    ['high', 'medium', 'low'].forEach(p => {
        if (result[p].estSeconds) {
            result[p].mins = Math.max(1, Math.ceil(result[p].estSeconds / 60));
            result[p].detail = `Smart goal: ${result[p].ingredients.join(', ')}`;
        } else if (result[p].items > 0) {
            // No history data, use defaults scaled by item count
            const baseMin = p === 'high' ? 5 : p === 'medium' ? 8 : 6;
            result[p].mins = Math.max(5, result[p].items * baseMin);
            result[p].detail = `${result[p].items} items × ~${baseMin} min each (log prep times for smarter goals)`;
        }
    });

    return result;
}


// ==================== MASTER INGREDIENT LIST ====================

const PREP_QUALIFIERS = ['sliced', 'diced', 'chopped', 'minced', 'julienned', 'brunoise', 'chiffonade', 'ground', 'crushed', 'grated', 'shaved', 'blanched', 'roasted', 'toasted', 'fried', 'pickled', 'marinated', 'smoked', 'dried', 'fresh', 'whole', 'halved', 'quartered'];

function hasPreqQualifier(name) {
    const lower = name.toLowerCase();
    return PREP_QUALIFIERS.some(q => lower.includes(q));
}

function showMasterIngredientList() {
    const existing = document.getElementById('masterIngOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'masterIngOverlay';
    overlay.className = 'master-ing-overlay';

    let content = `
        <div class="master-ing-container">
            <div class="master-ing-top">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('masterIngOverlay').remove()" style="padding:8px 16px;">← Back</button>
                <span style="font-size:16px;font-weight:800;color:var(--text);">Master Ingredients</span>
                <span style="width:60px;"></span>
            </div>
            <div class="master-ing-list">`;

    // Group by normKey
    const groups = {};
    stations.forEach(station => {
        (station.dishes || []).forEach(dish => {
            (dish.ingredients || []).forEach(ing => {
                const normKey = normalizeIngredientKey(ing.name);
                if (!groups[normKey]) groups[normKey] = { name: ing.name, normKey, instances: [] };
                groups[normKey].instances.push({
                    id: ing.id,
                    name: ing.name,
                    stationName: station.name,
                    dishName: dish.name,
                    stationId: station.id,
                    dishId: dish.id
                });
            });
        });
    });

    const sortedGroups = Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
    const dupeCount = sortedGroups.filter(g => g.instances.length > 1).length;

    content += `<div style="padding:8px 16px;font-size:12px;color:var(--text-muted);font-weight:600;">${sortedGroups.length} unique ingredients${dupeCount > 0 ? ` · ${dupeCount} with duplicates` : ''}</div>`;

    sortedGroups.forEach(group => {
        const isDupe = group.instances.length > 1;
        const hasPrepQ = hasPreqQualifier(group.name);
        const locations = group.instances.map(inst =>
            `<span class="master-ing-location">${inst.stationName} › ${inst.dishName}</span>`
        ).join('');

        content += `
            <div class="master-ing-card ${isDupe ? 'master-ing-duplicate' : ''}">
                <div class="master-ing-name">${group.name}</div>
                <div class="master-ing-locations">${locations}</div>
                ${isDupe && !hasPrepQ ? `
                    <button class="merge-btn squishy" onclick="handleClick(); mergeIngredients('${group.normKey}')">
                        Merge ${group.instances.length} instances
                    </button>
                ` : ''}
                ${isDupe && hasPrepQ ? `
                    <span class="master-ing-prep-note">Has prep qualifier — merge skipped</span>
                ` : ''}
            </div>`;
    });

    content += '</div></div>';
    overlay.innerHTML = content;
    document.body.appendChild(overlay);
}

function mergeIngredients(normKey) {
    // Find all instances with this normKey
    const instances = [];
    stations.forEach(station => {
        (station.dishes || []).forEach(dish => {
            (dish.ingredients || []).forEach(ing => {
                if (normalizeIngredientKey(ing.name) === normKey) {
                    instances.push({ ing, dish, station });
                }
            });
        });
    });

    if (instances.length <= 1) { showToast('Nothing to merge'); return; }

    // Use first instance as canonical
    const canonical = instances[0];
    const canonicalId = canonical.ing.id;
    const canonicalName = canonical.ing.name;

    // Merge: remove duplicates from other dishes, keep status data per station
    for (let i = 1; i < instances.length; i++) {
        const dup = instances[i];
        // Remove from dish
        dup.dish.ingredients = dup.dish.ingredients.filter(ing => ing.id !== dup.ing.id);
        // Transfer status if it has data and canonical doesn't have it in that station
        if (dup.station.status[dup.ing.id]) {
            if (!dup.station.status[canonicalId]) {
                dup.station.status[canonicalId] = dup.station.status[dup.ing.id];
            }
            delete dup.station.status[dup.ing.id];
        }
        // Remove from globalIngredients
        delete globalIngredients[dup.ing.id];
    }

    saveData(true);
    showToast(`Merged into "${canonicalName}"`);

    // Refresh the list
    showMasterIngredientList();
}

// ==================== HISTORY TAB ====================

function getDateKey(d) {
    return d.toISOString().slice(0, 10);
}

function selectHistoryDate(dateKey) {
    historySelectedDate = dateKey;
    panelDirty.history = true;
    renderPanel('history');
}

function renderHistoryTab(container) {
    const today = new Date();
    if (!historySelectedDate) historySelectedDate = getDateKey(today);

    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = getDateKey(d);
        const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        days.push({ key, label });
    }

    let html = '<div class="history-date-chips">';
    days.forEach(d => {
        html += `<button class="history-chip ${d.key === historySelectedDate ? 'active' : ''}" onclick="selectHistoryDate('${d.key}')">${d.label}</button>`;
    });
    html += '</div>';

    const entries = activityLog.filter(e => e.type === 'block_complete' && e.timestamp && e.timestamp.startsWith(historySelectedDate));

    if (entries.length === 0) {
        html += `<div class="history-day-status">
            <div class="history-day-label">No Data</div>
            <div class="history-day-sub">No block timers completed this day</div>
        </div>`;
        container.innerHTML = html;
        return;
    }

    let totalGoal = 0;
    let totalActual = 0;
    entries.forEach(e => {
        const d = e.data || {};
        totalGoal += d.goal || 0;
        totalActual += (d.goal || 0) - (d.seconds || 0);
    });
    const dayDiff = totalGoal - totalActual;
    let dayLabel, dayStatusClass;
    if (dayDiff < -15) { dayLabel = 'In the Weeds'; dayStatusClass = 'behind'; }
    else if (dayDiff > 15) { dayLabel = 'In the Pocket'; dayStatusClass = 'ahead'; }
    else { dayLabel = 'On Pace'; dayStatusClass = 'ontime'; }
    const totalGoalStr = formatTime(Math.abs(totalGoal));
    const totalActualStr = formatTime(Math.abs(totalActual));

    html += `<div class="history-day-status">
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <div class="history-day-label">${stations.length > 0 ? stations[0].name : 'Station'}</div>
            <span class="history-block-badge ${dayStatusClass}">${dayLabel}</span>
        </div>
        <div class="history-day-sub">Goal: ${totalGoalStr} &bull; Actual: ${totalActualStr}</div>
    </div>`;

    entries.forEach(e => {
        const d = e.data || {};
        const statusLabels = { behind: 'In the Weeds', ontime: 'On Pace', ahead: 'In the Pocket' };
        const statusClass = d.status || 'ontime';
        const goalSec = d.goal || 0;
        const actualSec = goalSec - (d.seconds || 0);
        const goalStr = formatTime(Math.abs(goalSec));
        const actualStr = formatTime(Math.abs(actualSec));

        html += `<div class="history-block-card">
            <div class="history-block-info">
                <div class="history-block-name">${d.label || d.level || 'Block'}</div>
                <div class="history-block-time">Goal: ${goalStr} &bull; Actual: ${actualStr}</div>
            </div>
            <span class="history-block-badge ${statusClass}">${statusLabels[statusClass] || 'On Time'}</span>
        </div>`;
    });

    container.innerHTML = html;
}

// ==================== STATION MANAGEMENT ====================

function showNewStationModal() {
    document.getElementById('newStationName').value = '';
    document.getElementById('modalNewStation').classList.add('show');
}

function createStation() {
    const name = document.getElementById('newStationName').value.trim();
    if (!name) {
        showToast('Please enter a station name');
        return;
    }

    stations.push({
        id: Date.now(),
        name: name,
        dishes: [{ id: Date.now() + 1, name: 'General', sortOrder: 0, expanded: true, ingredients: [] }],
        status: {},
        expanded: true
    });

    saveData(true);
    closeModal('modalNewStation');
    renderCurrentView();
    showToast('Station created');
}

function showEditStationModal(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    editingStationId = stationId;
    document.getElementById('editStationName').value = station.name;
    renderEditIngredients(station);
    document.getElementById('modalEditStation').classList.add('show');
}

function renderEditIngredients(station) {
    const container = document.getElementById('editIngredientsList');
    const allIngs = getAllIngredients(station);
    if (allIngs.length === 0) {
        container.innerHTML = '<p class="empty-sub" style="padding:20px;text-align:center">No ingredients</p>';
        return;
    }

    container.innerHTML = '';
    allIngs.forEach(ing => {
        const div = document.createElement('div');
        div.className = 'edit-ingredient-item';
        div.innerHTML = `
            <span>${ing.name}</span>
            <button class="btn-delete" onclick="deleteIngredient(${ing.id})">Delete</button>`;
        container.appendChild(div);
    });
}

function addIngredient() {
    const input = document.getElementById('newIngredientName');
    const name = input.value.trim();
    if (!name) { showToast('Enter an ingredient name'); return; }

    const station = stations.find(s => s.id === editingStationId);
    if (!station) return;

    const newIng = { id: Date.now(), name };
    const dish = getDefaultDish(station);
    if (dish) {
        dish.ingredients.push(newIng);
    }
    station.status[newIng.id] = { low: false, priority: null, parLevel: '', parQty: null, parUnit: '', parNotes: '', completed: false };
    registerGlobalIngredient(newIng.id, name);

    input.value = '';
    renderEditIngredients(station);
    saveData(true);
    showToast('Ingredient added');
}

function deleteIngredient(ingredientId) {
    if (!confirm('Delete this ingredient?')) return;

    const station = stations.find(s => s.id === editingStationId);
    if (!station) return;

    const dish = findDishForIngredient(station, ingredientId);
    if (dish) {
        dish.ingredients = dish.ingredients.filter(i => i.id !== ingredientId);
    }
    delete station.status[ingredientId];

    renderEditIngredients(station);
    saveData(true);
}

function saveEditStation() {
    const station = stations.find(s => s.id === editingStationId);
    if (!station) return;

    const name = document.getElementById('editStationName').value.trim();
    if (!name) { showToast('Station name cannot be empty'); return; }

    station.name = name;
    saveData(true);
    closeModal('modalEditStation');
    renderCurrentView();
    showToast('Station updated');
}

function deleteStation() {
    if (!confirm('Delete this station? This cannot be undone.')) return;

    stations = stations.filter(s => s.id !== editingStationId);
    saveData(true);
    closeModal('modalEditStation');
    renderCurrentView();
    showToast('Station deleted');
}

function resetStation(stationId) {
    if (!confirm('Clear the checklist for this station?')) return;

    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    getAllIngredients(station).forEach(ing => {
        station.status[ing.id] = { low: false, priority: null, parLevel: '', completed: false };
    });

    saveData(true);
    renderCurrentView();
    showToast('Checklist cleared');
}

// ==================== SETTINGS VIEW ====================

function renderSettings(container) {
    // Build mascot picker
    let mascotPicker = '';
    Object.entries(MASCOTS).forEach(([key, m]) => {
        const isActive = settings.mascot === key;
        const boxShadow = isActive ? 'var(--neu-inset)' : 'var(--neu-shadow-sm)';
        const fallbackStyle = `width:52px;height:52px;border-radius:14px;box-shadow:${boxShadow};display:flex;align-items:center;justify-content:center;font-size:24px;background:var(--bg);`;
        const mediaEl = m.type === 'video'
            ? `<video src="${m.file}" style="width:52px;height:52px;border-radius:14px;box-shadow:${boxShadow};object-fit:cover;" autoplay loop muted playsinline onerror="this.outerHTML='<div style=\\'${fallbackStyle}\\'>${m.emoji}</div>'"></video>`
            : `<img src="${m.file}" alt="${m.name}" style="width:52px;height:52px;border-radius:14px;box-shadow:${boxShadow};object-fit:cover;" onerror="this.outerHTML='<div style=\\'${fallbackStyle}\\'>${m.emoji}</div>'">`;
        mascotPicker += `
            <div style="display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;${isActive ? '' : 'opacity:0.5;'}"
                 onclick="handleClick(); selectMascot('${key}')">
                ${mediaEl}
                <span style="font-size:9px;font-weight:700;color:${isActive ? 'var(--accent)' : 'var(--text-muted)'};">${m.emoji} ${m.name}</span>
                <span style="font-size:8px;color:var(--text-muted);">${m.personality}</span>
            </div>`;
    });

    let html = `
        <div class="settings-group">
            <div class="settings-group-title">Stations</div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">${stations.length} station${stations.length !== 1 ? 's' : ''}</span>
                    <span class="setting-desc">Manage your kitchen stations</span>
                </div>
                <button class="btn-delete" style="background:var(--accent);box-shadow:0 2px 6px var(--accent-glow);" onclick="handleClick(); showNewStationModal()">+ Add</button>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Profile</div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Chef Name</span>
                    <span class="setting-desc">${settings.cookName || 'Not set'}</span>
                </div>
                <button class="btn-delete" style="background:var(--accent);box-shadow:0 2px 6px var(--accent-glow);" onclick="handleClick(); editCookName()">Edit</button>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Choose Your Mascot</div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:8px 0;">
                ${mascotPicker}
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Feedback</div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Haptic Vibration</span>
                    <span class="setting-desc">Vibrate on button press (Android)</span>
                </div>
                <button class="neu-toggle ${settings.vibration ? 'active' : ''}"
                    onclick="toggleSetting('vibration', this)"></button>
            </div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Click Sound</span>
                    <span class="setting-desc">Play sound on interactions</span>
                </div>
                <button class="neu-toggle ${settings.sound ? 'active' : ''}"
                    onclick="toggleSetting('sound', this)"></button>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Timer</div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Keep Screen On</span>
                    <span class="setting-desc">Screen stays awake while timers run</span>
                </div>
                <button class="neu-toggle ${settings.wakeLock ? 'active' : ''}"
                    onclick="toggleSetting('wakeLock', this); checkAndManageWakeLock()"></button>
            </div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Lock Screen Timer</span>
                    <span class="setting-desc">Show timer notifications when phone is locked</span>
                </div>
                <button class="neu-toggle ${settings.timerNotifications ? 'active' : ''}"
                    onclick="toggleSetting('timerNotifications', this)"></button>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Prep Time Database</div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">${Object.keys(prepTimes).length} ingredients logged</span>
                    <span class="setting-desc">Used for smart block timer goals</span>
                </div>
                ${Object.keys(prepTimes).length > 0 ? `<button class="btn-delete" onclick="handleClick(); clearPrepTimes()">Clear</button>` : ''}
            </div>
            ${Object.keys(prepTimes).length > 0 ? renderPrepTimesTable() : ''}
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Task Templates</div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">${Object.keys(taskTemplates).length} templates</span>
                    <span class="setting-desc">Active/passive time calibrations</span>
                </div>
                ${Object.keys(taskTemplates).length > 0 ? `<button class="btn-delete" onclick="handleClick(); clearTaskTemplates()">Clear</button>` : ''}
            </div>
            ${Object.keys(taskTemplates).length > 0 ? renderTaskTemplatesTable() : ''}
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Data</div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Clear All Data</span>
                    <span class="setting-desc">Reset stations, history & settings</span>
                </div>
                <button class="btn-delete" onclick="clearAllData()">Reset</button>
            </div>
        </div>
        <div class="settings-group">
            <div class="settings-group-title">Share</div>
            <div class="share-cards">
                <button class="share-card" onclick="handleClick(); shareAllWhatsApp()">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                    <span>WhatsApp</span>
                </button>
                <button class="share-card" onclick="handleClick(); shareAllSMS()">
                    <span style="font-size:28px;">📱</span>
                    <span>Text / SMS</span>
                </button>
                <button class="share-card" onclick="handleClick(); shareAppLink()">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                    <span>Copy Link</span>
                </button>
                ${navigator.share ? `<button class="share-card" onclick="handleClick(); nativeShareAll()">
                    <span style="font-size:28px;">📤</span>
                    <span>More</span>
                </button>` : `<button class="share-card" style="visibility:hidden;"></button>`}
            </div>
        </div>
        <div class="settings-group">
            <div class="settings-group-title">About</div>
            <div class="version-card">
                <div class="version-title">Kitchen Station Manager</div>
                <div class="version-row">
                    <span class="version-label">Version</span>
                    <span class="version-value">${APP_VERSION}</span>
                </div>
                <div class="version-row">
                    <span class="version-label">Build</span>
                    <span class="version-value">${APP_BUILD}</span>
                </div>
                <div class="version-row">
                    <span class="version-label">Last Sync</span>
                    <span class="version-value" id="lastSyncDisplay">${lastSync || 'Never'}</span>
                </div>
                <div class="version-actions">
                    <button class="btn btn-outline version-btn" onclick="handleClick(); syncNow()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/><path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/></svg>
                        Sync Now
                    </button>
                    <button class="btn btn-outline version-btn" onclick="handleClick(); checkForUpdates()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15 6.7L3 16"/></svg>
                        Force Update
                    </button>
                </div>
            </div>
        </div>`;

    container.innerHTML = html;
}

function renderPrepTimesTable() {
    let html = '<div style="margin-top:8px;">';
    Object.entries(prepTimes).forEach(([key, pt]) => {
        const mins = Math.floor(pt.bestSecPerUnit / 60);
        const secs = Math.round(pt.bestSecPerUnit % 60);
        const unit = pt.baseUnit || 'unit';
        html += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.04);font-size:11px;">
            <span style="font-weight:600;text-transform:capitalize;">${key}</span>
            <span style="color:var(--text-muted);">Best: ${mins}m ${secs}s/${unit} (${pt.count} logs)</span>
        </div>`;
    });
    html += '</div>';
    return html;
}

function renderTaskTemplatesTable() {
    let html = '<div style="margin-top:8px;">';
    Object.entries(taskTemplates).forEach(([key, tmpl]) => {
        const aMins = Math.floor((tmpl.activeSecondsPerUnit || 0) / 60);
        const aSecs = Math.round((tmpl.activeSecondsPerUnit || 0) % 60);
        const pMins = Math.floor((tmpl.passiveSecondsPerUnit || 0) / 60);
        const pSecs = Math.round((tmpl.passiveSecondsPerUnit || 0) % 60);
        html += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.04);font-size:11px;">
            <span style="font-weight:600;text-transform:capitalize;">${key}</span>
            <span style="color:var(--text-muted);">A: ${aMins}m${aSecs}s P: ${pMins}m${pSecs}s v${tmpl.templateVersion || 1}</span>
        </div>`;
    });
    html += '</div>';
    return html;
}

function clearTaskTemplates() {
    if (!confirm('Clear all task templates?')) return;
    taskTemplates = {};
    saveTaskTemplates();
    renderSettings(document.getElementById('panelOverlay'));
    showToast('Templates cleared');
}

function selectMascot(key) {
    settings.mascot = key;
    saveSettings();
    updateHeader();
    renderSettings(document.getElementById('panelOverlay'));
    const m = MASCOTS[key];
    showToast(`${m.emoji} ${m.name} selected!`);
}

function editCookName() {
    const existing = document.getElementById('modalEditName');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modalEditName';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Edit Chef Name</div>
            <div class="form-group">
                <input type="text" id="editNameInput" class="form-control" value="${settings.cookName || ''}" placeholder="Your name" style="text-align:center;font-size:16px;">
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('modalEditName').remove()">Cancel</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); confirmEditName()">Save</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    setTimeout(() => { const input = document.getElementById('editNameInput'); if (input) { input.focus(); input.select(); } }, 200);
}

function confirmEditName() {
    const input = document.getElementById('editNameInput');
    const name = input ? input.value.trim() : '';
    if (!name) { showToast('Enter your name, chef!'); return; }
    settings.cookName = name;
    saveSettings();
    updateHeader();
    const modal = document.getElementById('modalEditName');
    if (modal) modal.remove();
    renderSettings(document.getElementById('panelOverlay'));
    showToast('Name updated!');
}

function clearPrepTimes() {
    if (!confirm('Clear all logged prep times?')) return;
    prepTimes = {};
    savePrepTimes();
    renderSettings(document.getElementById('panelOverlay'));
    showToast('Prep times cleared');
}

function toggleSetting(key, el) {
    handleClick();
    settings[key] = !settings[key];
    el.classList.toggle('active');
    saveSettings();
}

function clearAllData() {
    handleClick();
    if (!confirm('This will delete ALL your data. Are you sure?')) return;
    localStorage.clear();
    location.reload();
}

// ==================== SYNC & UPDATES ====================

function syncNow() {
    markAllPanelsDirty();
    SWIPE_VIEW_ORDER.forEach(v => { panelDirty[v] = true; renderPanel(v); });
    updateLastSync();
    if (navigator.vibrate) navigator.vibrate(20);
    showToast(`✓ Synced – ${lastSync}`);
}

function checkForUpdates() {
    showToast('Checking for updates...');

    // 1. Delete all caches
    const clearCaches = caches.keys().then(names =>
        Promise.all(names.map(n => caches.delete(n)))
    );

    // 2. Unregister service worker
    const unregSW = navigator.serviceWorker
        ? navigator.serviceWorker.getRegistration().then(reg => reg ? reg.unregister() : true)
        : Promise.resolve(true);

    Promise.all([clearCaches, unregSW]).then(() => {
        // 3. Hard reload — bypass browser cache
        showToast('Updating...');
        setTimeout(() => {
            window.location.href = window.location.pathname + '?v=' + Date.now();
        }, 500);
    }).catch(() => {
        // Fallback: just force reload
        window.location.reload(true);
    });
}

// ==================== UTILITIES ====================

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1800);
}

// Import shared data from URL
function checkSharedData() {
    const params = new URLSearchParams(window.location.search);

    // Support new compact format (?d=) and legacy format (?data=)
    const compactData = params.get('d');
    const legacyData = params.get('data');

    if (compactData) {
        const imported = decompressData(compactData);
        if (imported && confirm('Import shared station data?')) {
            // Replace matching stations entirely, add new ones
            imported.forEach(impStation => {
                const existingIdx = stations.findIndex(s => s.name.toLowerCase() === impStation.name.toLowerCase());
                if (existingIdx >= 0) {
                    // Replace entire station with imported version (keeps full checklist)
                    stations[existingIdx] = impStation;
                } else {
                    stations.push(impStation);
                }
            });
            saveData(true);
            // Clear URL params so data persists on refresh
            window.history.replaceState({}, '', window.location.pathname);
            showToast('Data imported!');
        } else {
            window.history.replaceState({}, '', window.location.pathname);
        }
    } else if (legacyData) {
        try {
            const imported = JSON.parse(decodeURIComponent(atob(legacyData)));
            if (confirm('Import shared station data?')) {
                // Merge imported into existing
                imported.forEach(impStation => {
                    const existing = stations.find(s => s.name.toLowerCase() === impStation.name.toLowerCase());
                    if (!existing) {
                        stations.push(impStation);
                    }
                });
                saveData(true);
                window.history.replaceState({}, '', window.location.pathname);
                showToast('Data imported!');
            } else {
                window.history.replaceState({}, '', window.location.pathname);
            }
        } catch (e) {
            console.error('Invalid shared data');
            window.history.replaceState({}, '', window.location.pathname);
        }
    }
}

// Close modals on outside click
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.classList.remove('show');
    }
};

// ==================== STARTUP ====================

document.addEventListener('DOMContentLoaded', () => {
    checkSharedData();
    initApp();

    // Back button support
    // Push initial state so we can intercept back
    window.history.pushState({ view: 'home' }, '');

    window.addEventListener('popstate', (e) => {
        // Skip if triggered by mascot toggle
        if (skipPopstate) { skipPopstate = false; return; }

        if (currentView === 'settings') {
            // From settings: go back to previous view
            window.history.pushState({ view: previousView || 'home' }, '');
            switchView(previousView || 'home');
        } else if (currentView !== 'home') {
            // From any non-home view: go back to home
            window.history.pushState({ view: 'home' }, '');
            switchView('home');
        } else {
            // Already on home: confirm exit
            if (confirm('Exit Aqueous?')) {
                window.history.back();
            } else {
                window.history.pushState({ view: 'home' }, '');
            }
        }
    });

    // Gesture-driven swipe — 4 persistent panels
    const track = document.getElementById('swipeTrack');
    let swStartX = 0, swStartY = 0, swDx = 0;
    let swSwiping = false, swDirectionLocked = false, swIsHorizontal = false;
    let swPrevView = null, swNextView = null, swViewportW = 0;
    let swBaseIdx = 0;

    document.addEventListener('touchstart', (e) => {
        if (track.classList.contains('snapping')) return;
        if (OVERLAY_VIEWS.includes(currentView)) return;
        swStartX = e.touches[0].clientX;
        swStartY = e.touches[0].clientY;
        swDx = 0;
        swSwiping = false;
        swDirectionLocked = false;
        swIsHorizontal = false;
        swViewportW = window.innerWidth;

        const resolved = resolveSwipeView(currentView);
        if (!resolved) return;
        swBaseIdx = SWIPE_VIEW_ORDER.indexOf(resolved);
        if (swBaseIdx === -1) return;

        swPrevView = swBaseIdx > 0 ? SWIPE_VIEW_ORDER[swBaseIdx - 1] : null;
        swNextView = swBaseIdx < SWIPE_VIEW_ORDER.length - 1 ? SWIPE_VIEW_ORDER[swBaseIdx + 1] : null;

        // Pre-render adjacent panels if dirty
        if (swPrevView) renderPanel(swPrevView);
        if (swNextView) renderPanel(swNextView);
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!swStartX && !swStartY) return;
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        const dx = x - swStartX;
        const dy = y - swStartY;

        if (!swDirectionLocked) {
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                swDirectionLocked = true;
                swIsHorizontal = Math.abs(dx) > Math.abs(dy);
            }
            return;
        }

        if (!swIsHorizontal) return;
        if (dx > 0 && !swPrevView) return;
        if (dx < 0 && !swNextView) return;

        swSwiping = true;
        swDx = dx;
        const basePct = swBaseIdx * 25;
        const offsetPct = (dx / swViewportW) * 25;
        track.style.transform = `translateX(${-(basePct) + offsetPct}%)`;
    }, { passive: true });

    document.addEventListener('touchend', () => {
        if (!swSwiping) {
            swStartX = 0; swStartY = 0;
            return;
        }

        const threshold = swViewportW * 0.2;
        const shouldSwitch = Math.abs(swDx) > threshold;

        track.classList.add('snapping');

        if (shouldSwitch && swDx > 0 && swPrevView) {
            // Swipe right → previous view
            slideTrackTo(swPrevView, false); // snapping class already on
            track.addEventListener('transitionend', function handler() {
                track.removeEventListener('transitionend', handler);
                track.classList.remove('snapping');
                switchView(swPrevView, true); // skipSlide — already there
            });
        } else if (shouldSwitch && swDx < 0 && swNextView) {
            // Swipe left → next view
            slideTrackTo(swNextView, false);
            track.addEventListener('transitionend', function handler() {
                track.removeEventListener('transitionend', handler);
                track.classList.remove('snapping');
                switchView(swNextView, true);
            });
        } else {
            // Snap back
            slideTrackTo(SWIPE_VIEW_ORDER[swBaseIdx], false);
            track.addEventListener('transitionend', function handler() {
                track.removeEventListener('transitionend', handler);
                track.classList.remove('snapping');
            });
        }

        swSwiping = false;
        swStartX = 0; swStartY = 0;
        swDx = 0;
    }, { passive: true });

    // Overlay drag-to-dismiss (bottom-sheet style)
    const overlayEl = document.getElementById('panelOverlay');
    let ovStartY = 0, ovDragging = false, ovDy = 0;

    overlayEl.addEventListener('touchstart', (e) => {
        if (overlayEl.scrollTop <= 0) {
            ovStartY = e.touches[0].clientY;
        } else {
            ovStartY = 0;
        }
        ovDragging = false;
        ovDy = 0;
        // Remove transition during drag for instant finger-tracking
        overlayEl.classList.remove('animating');
    }, { passive: true });

    overlayEl.addEventListener('touchmove', (e) => {
        if (!ovStartY) return;
        const dy = e.touches[0].clientY - ovStartY;
        // Only drag down (positive dy), and only when at scroll top
        if (dy > 0 && overlayEl.scrollTop <= 0) {
            ovDragging = true;
            ovDy = dy;
            // Rubber-band resistance: diminish movement as you drag further
            const dampened = dy * 0.6;
            overlayEl.style.transform = `translateY(${dampened}px)`;
        }
    }, { passive: true });

    overlayEl.addEventListener('touchend', () => {
        if (!ovDragging) { ovStartY = 0; return; }
        if (ovDy > 120) {
            // Dismiss — animate down to 100% then clean up
            dismissOverlay();
        } else {
            // Snap back — animate back to translateY(0)
            overlayEl.classList.add('animating');
            overlayEl.style.transform = '';
            const onSnap = () => {
                overlayEl.removeEventListener('transitionend', onSnap);
                overlayEl.classList.remove('animating');
            };
            overlayEl.addEventListener('transitionend', onSnap);
        }
        ovStartY = 0;
        ovDragging = false;
        ovDy = 0;
    }, { passive: true });

    // Splash screen: only show full on first visit, skip on return visits
    const splash = document.getElementById('splashScreen');
    const hasVisited = localStorage.getItem('aqueous_visited');

    if (splash) {
        if (!hasVisited) {
            // First time: show full splash for 2.5 seconds
            localStorage.setItem('aqueous_visited', '1');
            setTimeout(() => {
                splash.classList.add('fade-out');
                setTimeout(() => splash.remove(), 400);
            }, 2500);
        } else {
            // Return visit: remove immediately
            splash.remove();
        }
    }
});
