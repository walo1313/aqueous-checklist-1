// ==================== AQUEOUS - Kitchen Station Manager ====================

const APP_VERSION = 'B2.0';
const APP_BUILD = 166;
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
if (currentView === 'summary' || currentView === 'logs' || currentView === 'history') currentView = 'home';
let dayChecklists = {}; // { "YYYY-MM-DD": [{ stationId, ingredientId, name, stationName, priority, parQty, parUnit, parDepth, struck, timeEstimate }] }
let history = [];
let completedHistory = {}; // { "YYYY-MM-DD": [{ name, stationName, priority, parQty, parUnit, parDepth, timeEstimate }] }
let settings = { vibration: true, sound: true, cookName: '', mascot: 'mascot', wakeLock: true, timerNotifications: true, activeDay: null, numCooks: 1 };
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
let toolsSubTab = 'stations'; // 'stations' | 'logs' | 'history'
let librarySubTab = 'bible';  // 'bible' | 'recipes' | 'tempLogs'
let summaryStationCollapsed = {}; // { stationId: true/false }
let logsBlockCollapsed = { withData: false, missingData: true };
let logsStationCollapsed = {}; // { "stationName": true/false }
let homeStationPickerOpen = false;
let mlStopwatches = {}; // { "stationId-ingId": { startedAt, elapsed, interval } }
let mlLongPressTimer = null;
let recipes = [];
let recipeFilterCat = 'all';
let recipeSearchTerm = '';
let recipesV2 = [];
let recipeViewerOpen = false;
let recipeViewerRecipeId = null;
let recipeViewerPage = 0;
let recipeViewerPages = [];
let recipeLongPressTimer = null;
const PRESET_NOTES = ['Defrost', 'Pick up', "86'd"];
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

const UNIT_TO_OZ = { quart: 32, pint: 16, cup: 8, oz: 1, 'sq btl': 12 };
const PAN_UNITS = ['1/9pan', '1/6pan', '1/3pan', '1/2pan', 'fullpan'];
const PAN_OZ = {
    '1/9pan': { 2: 16, 4: 38, 6: 58 },
    '1/6pan': { 2: 26, 4: 58, 6: 92 },
    '1/3pan': { 2: 58, 4: 128, 6: 194 },
    '1/2pan': { 2: 100, 4: 214, 6: 326 },
    'fullpan': { 2: 212, 4: 448, 6: 660 }
};
const UNIT_TO_G = { kg: 1000, lb: 453.592, g: 1 };
const VOLUME_UNITS = ['quart', 'pint', 'cup', 'oz', 'sq btl'];
const WEIGHT_UNITS = ['kg', 'lb', 'g'];
const COUNT_UNITS = ['each', 'recipe', 'order', 'bag', 'block', 'batch', 'case', 'jar', 'portion', 'orders'];
const CONTAINER_UNITS = ['hotel pan', '10 qt', '22 qt'];
const CONTAINER_OZ = { 'hotel pan': 660, '10 qt': 320, '22 qt': 704 };
const TASK_UNITS = ['(task)'];

function getBaseUnit(unit) {
    if (VOLUME_UNITS.includes(unit) || PAN_UNITS.includes(unit) || CONTAINER_UNITS.includes(unit)) return 'oz';
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
    if (CONTAINER_UNITS.includes(unit)) return qty * (CONTAINER_OZ[unit] || 1);
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
    const tmpl = taskTemplates[key];
    if (!tmpl) {
        const pt = prepTimes[key];
        if (!pt || !pt.bestSecPerUnit || !parQty || !parUnit) return null;
        const baseUnit = getBaseUnit(parUnit);
        if (pt.baseUnit && pt.baseUnit !== 'unit' && pt.baseUnit !== baseUnit) return null;
        const baseQty = convertToBase(parQty, parUnit, parDepth);
        return { totalSeconds: Math.round(pt.bestSecPerUnit * baseQty), hasTemplate: false };
    }

    const targetFamily = getTimingFamily(parUnit);

    // V3: check exact family sub-object
    if (tmpl[targetFamily] && tmpl[targetFamily].secPerBaseUnit > 0 && parQty) {
        const baseQty = convertToBase(parQty, parUnit, parDepth);
        return { totalSeconds: Math.max(Math.round(tmpl[targetFamily].secPerBaseUnit * baseQty), 1), hasTemplate: true, family: targetFamily };
    }

    // Fallback: try other families' refSeconds
    const allFamilies = ['volume', 'weight', 'count'].filter(f => f !== targetFamily);
    for (const otherFamily of allFamilies) {
        if (tmpl[otherFamily] && tmpl[otherFamily].refSeconds > 0) {
            return { totalSeconds: tmpl[otherFamily].refSeconds, hasTemplate: true, family: otherFamily, approximate: true };
        }
    }

    // Legacy V2 flat format
    if (tmpl.secPerBaseUnit > 0 && tmpl.baseFamily) {
        if (targetFamily === tmpl.baseFamily && parQty) {
            const baseQty = convertToBase(parQty, parUnit, parDepth);
            return { totalSeconds: Math.max(Math.round(tmpl.secPerBaseUnit * baseQty), 1), hasTemplate: true };
        }
        if (tmpl.refSeconds > 0) return { totalSeconds: tmpl.refSeconds, hasTemplate: true };
    }
    if (tmpl.manualSeconds > 0) return { totalSeconds: tmpl.manualSeconds, hasTemplate: true };
    if (tmpl.activeSecondsPerUnit > 0 || tmpl.passiveSecondsPerUnit > 0) {
        const baseQty = convertToBase(parQty || 1, parUnit || 'each', parDepth);
        const total = (tmpl.activeFixedSeconds || 0) + Math.round((tmpl.activeSecondsPerUnit || 0) * baseQty)
                    + (tmpl.passiveFixedSeconds || 0) + Math.round((tmpl.passiveSecondsPerUnit || 0) * baseQty);
        return { totalSeconds: total, hasTemplate: true };
    }

    return null;
}

function getTimingFamily(unit) {
    if (VOLUME_UNITS.includes(unit) || PAN_UNITS.includes(unit) || CONTAINER_UNITS.includes(unit)) return 'volume';
    if (WEIGHT_UNITS.includes(unit)) return 'weight';
    return 'count';
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
    const f = getIngTimingFamilies(ingName);
    return f.volume || f.weight || f.count;
}

function getIngTimingFamilies(ingName) {
    const key = ingName.toLowerCase();
    const tmpl = taskTemplates[key];
    if (!tmpl) return { volume: false, weight: false, count: false };
    return {
        volume: !!(tmpl.volume && tmpl.volume.secPerBaseUnit > 0),
        weight: !!(tmpl.weight && tmpl.weight.secPerBaseUnit > 0),
        count: !!(tmpl.count && tmpl.count.secPerBaseUnit > 0)
    };
}

function getIngTimingBadge(ingName, st) {
    const sec = getTimeForMasterList(ingName, st.parQty, st.parUnit, st.parDepth);
    if (sec && sec > 0) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        const display = m > 0 ? (s > 0 ? `${m}m${s}s` : `${m}m`) : `${s}s`;
        return `<span class="ing-time-badge">${display}</span>`;
    }
    return '';
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
    if (!allItemsHaveTiming()) {
        showToast('All items need timing data');
        return;
    }
    const now = new Date();
    settings.shiftStart = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    settings.clockInTimestamp = now.getTime();
    autoCalcPrepWindow();
    saveSettings();
    startCountdownBar();
    startPrepNotification();
    requestNotificationPermission();
    panelDirty.tools = true;
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
    panelDirty.tools = true;
    panelDirty.home = true;
    renderPanel('home');
}

function adjustCooks(delta) {
    handleClick();
    const current = settings.numCooks || 1;
    const next = Math.min(10, Math.max(1, current + delta));
    if (next === current) return;
    settings.numCooks = next;
    saveSettings();
    updateTimerDisplay();
    const btns = document.querySelectorAll('.cook-btn');
    if (btns.length === 2) {
        btns[0].disabled = next <= 1;
        btns[1].disabled = next >= 10;
    }
}

function updateTimerDisplay() {
    const totalSec = getCountdownTotalSeconds();
    const cooks = settings.numCooks || 1;
    const divided = totalSec > 0 ? Math.ceil(totalSec / cooks) : 0;
    const timeEl = document.getElementById('timerTotalDisplay');
    if (timeEl) timeEl.textContent = divided > 0 ? formatTime(divided) : '--:--';
    const cookEl = document.getElementById('cookCountDisplay');
    if (cookEl) cookEl.textContent = cooks;
}

// ==================== COUNTDOWN TIMER BAR ====================
let countdownBarInterval = null;

function getCountdownTotalSeconds() {
    const day = getActiveDay();
    const items = dayChecklists[day] || [];
    let total = 0;
    items.forEach(item => {
        if (item.struck) return;
        const t = getTimeForMasterList(item.name, item.parQty, item.parUnit, item.parDepth);
        if (t && t > 0) total += t;
    });
    return total;
}

function allItemsHaveTiming() {
    const day = getActiveDay();
    const items = dayChecklists[day] || [];
    if (items.length === 0) return false;
    return items.every(item => {
        const t = getTimeForMasterList(item.name, item.parQty, item.parUnit, item.parDepth);
        return t && t > 0;
    });
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

    const cooks = settings.numCooks || 1;
    const totalSec = Math.ceil(getCountdownTotalSeconds() / cooks);
    if (totalSec <= 0) {
        bar.style.width = '100%';
        label.textContent = 'No timing data';
        return;
    }

    // Keep static time display in sync
    const timeEl = document.getElementById('timerTotalDisplay');
    if (timeEl) timeEl.textContent = formatTime(totalSec);

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
    panelDirty.tools = true;
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
    panelDirty.tools = true;
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

function getUniqueIngredientCount() {
    const names = new Set();
    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            names.add(ing.name.toLowerCase().trim());
        });
    });
    return names.size;
}

function updateGlobalCount() {
    const el = document.getElementById('globalIngCount');
    if (el) el.textContent = getUniqueIngredientCount();
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
    migrateTaskTemplatesToV3();
    loadDayChecklists();
    loadCompletedHistory();
    migrateMlDayStates();
    processCarryOver();
    cleanOldDayChecklists();
    cleanOldCompletedHistory();
    if (!dayChecklists[getActiveDay()]) dayChecklists[getActiveDay()] = [];
    updateHeader();
    updateGlobalCount();

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
    // Legacy redirects
    if (currentView === 'timer' || currentView === 'summary' || currentView === 'logs' || currentView === 'history') currentView = 'home';
    if (OVERLAY_VIEWS.includes(currentView)) currentView = 'home';
    if (currentView === 'home') navItems[0].classList.add('active');
    else if (currentView === 'tools') navItems[1].classList.add('active');
    else if (currentView === 'library') navItems[2].classList.add('active');
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
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const d = days[today.getDay()];
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const yy = String(today.getFullYear()).slice(-2);
    const el = document.getElementById('dateDisplay');
    if (el) el.textContent = `${d} ${mm}/${dd}/${yy}`;
}

// ==================== DATA PERSISTENCE ====================

function buildSeafoodStation() {
    let nextId = 1;
    const id = () => nextId++;

    function dish(name, ings) {
        const dishId = id();
        const ingredients = ings.map(i => ({ id: id(), name: i.name }));
        return { obj: { id: dishId, name, sortOrder: 0, expanded: true, ingredients }, parData: ings };
    }

    const dishes = [
        dish('Gambas al Gochujang', [
            { name: 'Split prawn', unit: 'each', qty: 1 },
            { name: 'Gochujang-Infused Garlic Oil', unit: 'quart', qty: 1 },
            { name: 'Shaved fennel', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'Fried Bao (2 pz)', unit: 'each', qty: 1 },
            { name: 'Arugula', unit: '1/6pan', qty: 1, depth: 4 },
            { name: 'Crispy shallot', unit: 'pint', qty: 1 },
            { name: 'Lemon juice', unit: 'each', qty: 1 },
            { name: 'Pickled fresno', unit: 'cup', qty: 1 },
            { name: 'Olive oil', unit: 'each', qty: 1 },
            { name: 'Gochujang sauce', unit: '1/6pan', qty: 1, depth: 4 }
        ]),
        dish("Butcher's Cut of the Day", [
            { name: 'Demi', unit: 'quart', qty: 1 },
            { name: 'Brocoli', unit: 'each', qty: 1 },
            { name: 'Potato pave', unit: 'each', qty: 1 },
            { name: 'Pistachio', unit: 'quart', qty: 1 },
            { name: 'Cut of the day', unit: 'each', qty: 1 }
        ]),
        dish('Chicken Breast', [
            { name: 'Chicken breast', unit: 'each', qty: 1 },
            { name: 'Pomme puree', unit: 'quart', qty: 1 },
            { name: 'Caramelized pearl onion', unit: 'pint', qty: 1 },
            { name: 'Mushroom marsala', unit: 'quart', qty: 1 },
            { name: 'Fennel', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'King trumpet', unit: '1/9pan', qty: 1, depth: 4 }
        ]),
        dish('Surf & Turf', [
            { name: 'A5 Wagyu (3 oz)', unit: 'each', qty: 1 },
            { name: 'Alaskan King Crab (3 oz)', unit: 'each', qty: 1 },
            { name: 'Yuzukosho Miso Kabocha (3)', unit: 'each', qty: 1 },
            { name: 'Asparagus (2)', unit: 'each', qty: 1 },
            { name: 'Demi', unit: 'quart', qty: 1 },
            { name: 'Butter', unit: '1/6pan', qty: 1, depth: 4 }
        ]),
        dish('Wok-Fried Filet Mignon & Chicken', [
            { name: 'Filet Mignon', unit: 'each', qty: 1 },
            { name: 'Chicken', unit: 'each', qty: 1 },
            { name: 'Stir-fried sauce', unit: 'recipe', qty: 1 },
            { name: 'Lemongrass jazmin rice (200gr)', unit: 'each', qty: 1 },
            { name: 'Onion', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'Bell peppers', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'Sliced garlic', unit: 'cup', qty: 1 },
            { name: 'Ginger', unit: 'cup', qty: 1 },
            { name: 'Asparagus', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'Baby bok choy', unit: '1/6pan', qty: 1, depth: 4 },
            { name: 'Snow peas', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'Scallions', unit: 'cup', qty: 1 }
        ]),
        dish('Yuzukosho Miso Kabocha (sub-recipe)', [
            { name: 'Kabocha', unit: '', qty: null },
            { name: 'Kyoto Sweet Miso', unit: '', qty: null },
            { name: 'Yuzukosho', unit: '', qty: null }
        ]),
        dish('Enhancement', [
            { name: 'Shrimp', unit: 'each', qty: 1 },
            { name: 'Pomme puree', unit: 'quart', qty: 1 }
        ])
    ];

    const stationId = 1000;
    const status = {};
    const dishObjs = [];

    dishes.forEach(d => {
        dishObjs.push(d.obj);
        d.obj.ingredients.forEach((ing, i) => {
            const par = d.parData[i];
            const parUnit = par.unit || '';
            const parQty = par.qty || null;
            const depth = par.depth || null;
            const parLevel = parQty && parUnit ? `${parQty} ${parUnit}` : '';
            status[ing.id] = {
                low: false, priority: null, parLevel,
                parQty, parUnit, parDepth: depth, parNotes: '', completed: false
            };
        });
    });

    return { id: stationId, name: 'SEAFOOD PREP-LIST', dishes: dishObjs, status, expanded: true };
}

function buildSauteStation() {
    let nextId = 2000;
    const id = () => nextId++;

    function dish(name, ings) {
        const dishId = id();
        const ingredients = ings.map(i => ({ id: id(), name: i.name }));
        return { obj: { id: dishId, name, sortOrder: 0, expanded: true, ingredients }, parData: ings };
    }

    const dishes = [
        dish('Lobster Cappuccino', [
            { name: 'Lobster Bisque', unit: 'recipe', qty: 1 },
            { name: 'Croissant', unit: 'each', qty: 1 },
            { name: 'Crème Fraîche foam', unit: 'recipe', qty: 1 },
            { name: 'Lobster meat', unit: 'bag', qty: 1 },
            { name: 'Smoked paprika', unit: 'cup', qty: 1 }
        ]),
        dish('Branzino', [
            { name: 'Branzino', unit: 'each', qty: 1 },
            { name: 'Mixed Rice (120gr)', unit: 'order', qty: 1 },
            { name: 'Bubu Arare', unit: 'cup', qty: 1 },
            { name: 'Szechuan Pepper', unit: 'recipe', qty: 1 },
            { name: 'Julienne bell peppers', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'Julienne apple', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'Mix green', unit: '1/3pan', qty: 1, depth: 4 },
            { name: 'Pickled red onion', unit: '1/9pan', qty: 1, depth: 4 }
        ]),
        dish('Lobster Mac & Cheese', [
            { name: 'Heavy cream', unit: 'quart', qty: 1 },
            { name: 'Pasta', unit: '1/3pan', qty: 1, depth: 4 },
            { name: 'Lobster meat', unit: 'bag', qty: 1 },
            { name: 'Shredded cheese', unit: 'bag', qty: 1 }
        ]),
        dish('Nemacolin Honey Carrots', [
            { name: 'Honey', unit: 'sq btl', qty: 1 },
            { name: 'Pink pepper', unit: '1/9pan', qty: 1, depth: 4 },
            { name: 'Baby Carrots', unit: '1/6pan', qty: 1, depth: 4 }
        ])
    ];

    const stationId = 2000;
    const status = {};
    const dishObjs = [];
    dishes.forEach(d => {
        dishObjs.push(d.obj);
        d.obj.ingredients.forEach((ing, i) => {
            const par = d.parData[i];
            const parUnit = par.unit || '';
            const parQty = par.qty || null;
            const depth = par.depth || null;
            const parLevel = parQty && parUnit ? `${parQty} ${parUnit}` : '';
            status[ing.id] = {
                low: false, priority: null, parLevel,
                parQty, parUnit, parDepth: depth, parNotes: '', completed: false
            };
        });
    });

    return { id: stationId, name: 'SAUTE', dishes: dishObjs, status, expanded: true };
}

function buildSushiStation() {
    let nextId = 3000;
    const id = () => nextId++;

    const items = [
        { name: 'Hamachi Slice', unit: 'order', qty: 1 },
        { name: 'Salmon Tartare', unit: 'recipe', qty: 1 },
        { name: 'King Crab Mix', unit: 'recipe', qty: 1 },
        { name: 'Spicy Tuna', unit: 'recipe', qty: 1 },
        { name: 'Lobster mix', unit: 'recipe', qty: 1 },
        { name: 'Seabass for tempura', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Ahi Tuna Slice', unit: 'block', qty: 1 },
        { name: 'Ora King Salmon Slice', unit: 'block', qty: 1 },
        { name: 'Smoked paprika aioli', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Orange Tobiko', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Yuzu Tobiko', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Ikura', unit: 'each', qty: 1 },
        { name: 'Serrano thin slice', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Micro Cilantro (Cilantro)', unit: 'cup', qty: 1 },
        { name: 'Avocado', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Jalapeno Julienne', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Chive fine chop', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Wagyu A5', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Takuan Julienne', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Caviar', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Kizami wasabi', unit: 'cup', qty: 1 },
        { name: 'Green Onion fine chop', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Micro Herb', unit: 'cup', qty: 1 },
        { name: 'Yuzu Shoyu', unit: 'sq btl', qty: 1 },
        { name: 'Kimchi Aioli', unit: 'sq btl', qty: 1 },
        { name: 'Sun-dried Tomato Pesto', unit: 'recipe', qty: 1 },
        { name: 'Yuzu kosho aioli', unit: 'sq btl', qty: 1 },
        { name: 'Crème Fraiche', unit: 'sq btl', qty: 1 },
        { name: 'Sweet Shoyu', unit: 'sq btl', qty: 1 },
        { name: 'Aka yuzu kosho aioli', unit: 'recipe', qty: 1 },
        { name: 'Sriracha', unit: 'sq btl', qty: 1 },
        { name: 'Temaki Nori', unit: 'sq btl', qty: 1 },
        { name: 'Sushi Rice', unit: 'recipe', qty: 1 },
        { name: 'Crispy Sushi Rice', unit: 'each', qty: 1 },
        { name: 'Pickled shiso relish', unit: 'pint', qty: 1 },
        { name: 'Toasted Sesame seeds', unit: 'cup', qty: 1 },
        { name: 'Wasabi', unit: 'recipe', qty: 1 },
        { name: 'Sushi Ginger', unit: '1/9pan', qty: 1, depth: 4 }
    ];

    const stationId = 3000;
    const dishId = id();
    const ingredients = items.map(i => ({ id: id(), name: i.name }));
    const status = {};
    ingredients.forEach((ing, i) => {
        const par = items[i];
        const parUnit = par.unit || '';
        const parQty = par.qty || null;
        const depth = par.depth || null;
        const parLevel = parQty && parUnit ? `${parQty} ${parUnit}` : '';
        status[ing.id] = {
            low: false, priority: null, parLevel,
            parQty, parUnit, parDepth: depth, parNotes: '', completed: false
        };
    });

    const dish = { id: dishId, name: 'Items', sortOrder: 0, expanded: true, ingredients };
    return { id: stationId, name: 'SUSHI', dishes: [dish], status, expanded: true };
}

function buildAmberBarStation() {
    let nextId = 4000;
    const id = () => nextId++;

    const items = [
        { name: 'Rainbow Carrots', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Mini Sweet Pepper', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Cucumber', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Micro Crudites Mix', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Celery', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Asparagus', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Classic hummus', unit: 'quart', qty: 1 },
        { name: 'Tzatziki', unit: 'recipe', qty: 1 },
        { name: 'Dehydrated Black Olive', unit: 'pint', qty: 1 },
        { name: 'Grilled pita', unit: 'bag', qty: 1 },
        { name: 'Dry Salami', unit: 'each', qty: 1 },
        { name: 'Hot Sopressata', unit: 'each', qty: 1 },
        { name: 'Italian Salami', unit: 'each', qty: 1 },
        { name: 'Prosciutto', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Parmigiano Reggiano', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Cheddar', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Brie', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Stilton', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Apricot Jam', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Grape', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Candied nuts', unit: 'quart', qty: 1 },
        { name: 'GF Grissini (3 EA)', unit: 'order', qty: 1 },
        { name: 'Artichokes', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Salsa verde', unit: 'recipe', qty: 1 },
        { name: 'Pecorino', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Lemon Wedge', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Yuzu aioli', unit: 'recipe', qty: 1 },
        { name: 'Romesco sauce', unit: 'recipe', qty: 1 },
        { name: 'Red bell pepper brunoise', unit: 'cup', qty: 1 },
        { name: 'Spring roll order (2 each)', unit: 'order', qty: 1 },
        { name: 'Micro herbs', unit: 'cup', qty: 1 },
        { name: 'Fennel saved for salad', unit: 'quart', qty: 1 },
        { name: 'Pickled fresno', unit: 'quart', qty: 1 },
        { name: 'Red chili sauce', unit: 'recipe', qty: 1 },
        { name: 'Kabocha crisp', unit: 'quart', qty: 1 },
        { name: 'Kabocha sous vide', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Sage Crisps', unit: 'pint', qty: 1 },
        { name: 'Kabocha bisque', unit: 'recipe', qty: 1 },
        { name: 'Yellow tomato', unit: 'each', qty: 1 },
        { name: 'Balsamic pearls', unit: 'jar', qty: 1 },
        { name: 'Basil-citrus vinaigrette', unit: 'recipe', qty: 1 },
        { name: 'Burrata', unit: 'each', qty: 1 },
        { name: 'Yuzu glaze', unit: 'recipe', qty: 1 },
        { name: 'Yuzu syrup', unit: 'recipe', qty: 1 },
        { name: 'Basil baby leaf', unit: 'cup', qty: 1 },
        { name: 'Little gem lettuce', unit: '1/3pan', qty: 1, depth: 4 },
        { name: 'Radicchio', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Focaccia croutons', unit: 'quart', qty: 1 },
        { name: 'Parmigiano reggiano', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Crispy prosciutto', unit: 'quart', qty: 1 },
        { name: 'Cherry Tomatoes', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Caesar dressing', unit: 'recipe', qty: 1 },
        { name: 'Sushi rice', unit: 'recipe', qty: 1 },
        { name: 'Tuna', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Furikake', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Mango', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Tosaka nori', unit: 'quart', qty: 1 },
        { name: 'Edamame', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Cucumber (poke)', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Avocado', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Seaweed salad', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Kimchi aioli', unit: 'recipe', qty: 1 },
        { name: 'Chicken broth', unit: 'recipe', qty: 1 },
        { name: 'Chashu chicken', unit: 'each', qty: 1 },
        { name: 'Sous vide Corn', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Shimeji mushrooms', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Black Fungus', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Bamboo shoots', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Chicken Chicharron', unit: 'quart', qty: 1 },
        { name: 'Crispy Shallot', unit: 'pint', qty: 1 },
        { name: 'Black garlic oil', unit: 'pint', qty: 1 },
        { name: 'Roasted garlic oil', unit: 'pint', qty: 1 },
        { name: 'Sesame chili oil', unit: 'sq btl', qty: 1 },
        { name: 'Lime Wedge', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Scallions', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Tamago egg', unit: 'each', qty: 1 },
        { name: 'Allen bros beef patty (2 EACH)', unit: 'order', qty: 1 },
        { name: 'American cheese', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Brioche bun', unit: 'each', qty: 1 },
        { name: 'Black bean patty', unit: 'recipe', qty: 1 },
        { name: 'Amber aioli', unit: 'recipe', qty: 1 },
        { name: 'Caramelized onion', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Tomato sliced', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Arugula', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Fries', unit: 'hotel pan', qty: 1 },
        { name: 'Korean BBQ short rib', unit: 'order', qty: 1 },
        { name: 'Gochujang butter', unit: 'recipe', qty: 1 },
        { name: 'Mozzarella cheese shredded', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Kimchi aioli (sandwich)', unit: 'recipe', qty: 1 },
        { name: 'Kimchi Julienne', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Sourdough', unit: 'order', qty: 1 },
        { name: 'Wagyu brisket', unit: 'order', qty: 1 },
        { name: 'Sweet-soy glaze', unit: 'recipe', qty: 1 },
        { name: 'Pickled cabbage', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Cucumber (bao)', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Pickled Mini sweet pepper', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Bao bun (4 each)', unit: 'order', qty: 1 },
        { name: 'Cherry tomatoes pickled', unit: 'quart', qty: 1 },
        { name: 'Milk bread', unit: 'order', qty: 1 },
        { name: 'Katsu sando sauce', unit: 'sq btl', qty: 1 },
        { name: 'Kappa pickle brunoise', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Pork katsu', unit: 'order', qty: 1 },
        { name: 'Shaved little gem', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Kappa pickle', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Lemongrass Rice (200 GR)', unit: 'pint', qty: 1 },
        { name: 'Chicken Sousvide dinner', unit: 'each', qty: 1 },
        { name: 'Baby Bokchoy', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Asparagus (stir-fry)', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Yellow bell pepper julienne', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Red bell pepper julienne', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Yellow onion julienne', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Snow peas', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Ginger fine julienne', unit: 'cup', qty: 1 },
        { name: 'Garlic slice', unit: 'cup', qty: 1 },
        { name: 'Stir-fry sauce', unit: 'recipe', qty: 1 },
        { name: 'Scallion', unit: 'cup', qty: 1 },
        { name: 'Elotes (8 pz)', unit: 'order', qty: 1 },
        { name: 'Yuzu kosho aioli', unit: 'recipe', qty: 1 },
        { name: 'Lime cream', unit: 'recipe', qty: 1 },
        { name: 'Togarashi aioli', unit: 'recipe', qty: 1 },
        { name: 'Lime wedge', unit: '1/9pan', qty: 1, depth: 4 }
    ];

    const stationId = 4000;
    const dishId = id();
    const ingredients = items.map(i => ({ id: id(), name: i.name }));
    const status = {};
    ingredients.forEach((ing, i) => {
        const par = items[i];
        const parUnit = par.unit || '';
        const parQty = par.qty || null;
        const depth = par.depth || null;
        const parLevel = parQty && parUnit ? `${parQty} ${parUnit}` : '';
        status[ing.id] = {
            low: false, priority: null, parLevel,
            parQty, parUnit, parDepth: depth, parNotes: '', completed: false
        };
    });

    const dish = { id: dishId, name: 'Items', sortOrder: 0, expanded: true, ingredients };
    return { id: stationId, name: 'AMBER BAR', dishes: [dish], status, expanded: true };
}

function buildGardeMangerStation() {
    let nextId = 5000;
    const id = () => nextId++;

    const items = [
        { name: 'Smoked Salmon Mousse', unit: 'recipe', qty: 1 },
        { name: 'Ossetra caviar', unit: 'each', qty: 1 },
        { name: 'Red onion', unit: 'cup', qty: 1 },
        { name: 'Chives', unit: 'cup', qty: 1 },
        { name: 'Egg White', unit: 'each', qty: 1 },
        { name: 'Egg Yolk', unit: 'each', qty: 1 },
        { name: 'Potato Chips', unit: 'order', qty: 1 },
        { name: 'Sour Cream', unit: 'sq btl', qty: 1 },
        { name: 'Gremolata', unit: 'pint', qty: 1 },
        { name: 'Sliced meat', unit: 'each', qty: 1 },
        { name: 'Arugula', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Cucumber', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Parmesan cheese', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Tortilla strips', unit: 'quart', qty: 1 },
        { name: 'Cucumber julienne', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Pickled carrot', unit: 'recipe', qty: 1 },
        { name: 'Watermelon', unit: 'each', qty: 1 },
        { name: 'Watermelon citrus ponzu', unit: 'recipe', qty: 1 },
        { name: 'Pickled onion', unit: 'recipe', qty: 1 },
        { name: 'Peach marinated', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Plum marinated', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'White balsamic dressing', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Burrata cheese', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Mint', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Prosciutto', unit: 'recipe', qty: 1 },
        { name: 'Matcha mayo', unit: 'recipe', qty: 1 },
        { name: 'Tempura-togarashi crumbs', unit: 'pint', qty: 1 },
        { name: 'Ginger Brunoise', unit: 'cup', qty: 1 },
        { name: 'Scallions', unit: 'cup', qty: 1 },
        { name: 'Tuna diced', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Shrimp u-8 (6)', unit: 'bag', qty: 1 },
        { name: 'Greens', unit: '1/3pan', qty: 1, depth: 4 },
        { name: 'Orange segments', unit: 'each', qty: 1 },
        { name: 'Lemon', unit: 'each', qty: 1 },
        { name: 'Lime', unit: 'each', qty: 1 },
        { name: 'Horseradish quenelle', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Aqueous cocktail sauce', unit: 'recipe', qty: 1 },
        { name: 'Oysters (6)', unit: 'each', qty: 1 },
        { name: 'Romaine', unit: 'hotel pan', qty: 1 },
        { name: 'Lemon-togarashi croutons', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Creamy parmesan dressing', unit: 'recipe', qty: 1 },
        { name: 'Roasted broccoli', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Grana Padano', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Apple', unit: 'each', qty: 1 },
        { name: 'Lobster sous vide (1)', unit: 'each', qty: 1 },
        { name: 'Scallops', unit: 'each', qty: 1 },
        { name: 'Sashimi (3 oz)', unit: 'portion', qty: 1 },
        { name: 'Crab claws', unit: 'bag', qty: 1 },
        { name: 'Lump crab', unit: 'each', qty: 1 },
        { name: 'Garlic Oil', unit: 'quart', qty: 1 },
        { name: 'Bamboo leaves', unit: 'each', qty: 1 },
        { name: 'Butter plates', unit: 'each', qty: 1 },
        { name: 'Cookies', unit: 'recipe', qty: 1 },
        { name: 'Jam', unit: 'recipe', qty: 1 }
    ];

    const stationId = 5000;
    const dishId = id();
    const ingredients = items.map(i => ({ id: id(), name: i.name }));
    const status = {};
    ingredients.forEach((ing, i) => {
        const par = items[i];
        const parUnit = par.unit || '';
        const parQty = par.qty || null;
        const depth = par.depth || null;
        const parLevel = parQty && parUnit ? `${parQty} ${parUnit}` : '';
        status[ing.id] = {
            low: false, priority: null, parLevel,
            parQty, parUnit, parDepth: depth, parNotes: '', completed: false
        };
    });

    const dish = { id: dishId, name: 'Items', sortOrder: 0, expanded: true, ingredients };
    return { id: stationId, name: 'GARDE MANGER', dishes: [dish], status, expanded: true };
}

function buildOvernightStation() {
    let nextId = 6000;
    const id = () => nextId++;

    const items = [
        { name: 'Crack Eggs', unit: '10 qt', qty: 1 },
        { name: 'Plate Fruit', unit: 'each', qty: 1 },
        { name: 'Pancake Mix', unit: 'recipe', qty: 1 },
        { name: 'Cut Fruit', unit: 'hotel pan', qty: 1 },
        { name: 'Carrots Shredded', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Cucumber', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Orange Segments', unit: 'each', qty: 1 },
        { name: 'Cherry Tomatoes', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Baby Gem Lettuce', unit: 'hotel pan', qty: 1 },
        { name: 'Mix Greens', unit: '1/3pan', qty: 1, depth: 4 },
        { name: 'Parmesan Cheese', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Caesar Dressing', unit: 'recipe', qty: 1 },
        { name: 'Italian Dressing', unit: 'recipe', qty: 1 },
        { name: 'Blue Cheese Dressing', unit: 'recipe', qty: 1 },
        { name: 'White Balsamic Dressing', unit: 'recipe', qty: 1 },
        { name: 'Ranch Dressing', unit: 'recipe', qty: 1 },
        { name: 'Yuzu Ponzu', unit: 'recipe', qty: 1 },
        { name: 'Cocktail Sauce', unit: 'recipe', qty: 1 },
        { name: 'Butter Mold', unit: 'each', qty: 1 },
        { name: 'Scoop Cookies', unit: 'batch', qty: 1 },
        { name: 'Clean Lobster', unit: 'each', qty: 1 },
        { name: 'Clean King Crab', unit: 'batch', qty: 1 },
        { name: 'Focaccia for Croutons', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Scrub Oysters', unit: 'case', qty: 1 },
        { name: 'Cook Pasta', unit: 'quart', qty: 1 },
        { name: 'Lobster Stock', unit: 'recipe', qty: 1 },
        { name: 'Blanch Baby Carrots', unit: '1/6pan', qty: 1, depth: 4 },
        { name: 'Snow Peas', unit: '1/9pan', qty: 1, depth: 4 },
        { name: 'Peel Potato', unit: '22 qt', qty: 1 },
        { name: 'Open Filet', unit: 'each', qty: 1 },
        { name: 'Hummus', unit: 'recipe', qty: 1 },
        { name: 'Asparagus', unit: 'orders', qty: 1 },
        { name: 'Blanch Fries Gluten Free', unit: 'case', qty: 1 },
        { name: 'Mirepoix', unit: 'hotel pan', qty: 1 },
        { name: 'Change Oil', unit: '(task)', qty: null },
        { name: 'Wash Frier', unit: '(task)', qty: null },
        { name: 'Shari-Zu', unit: 'recipe', qty: 1 }
    ];

    const stationId = 6000;
    const dishId = id();
    const ingredients = items.map(i => ({ id: id(), name: i.name }));
    const status = {};
    ingredients.forEach((ing, i) => {
        const par = items[i];
        const parUnit = par.unit || '';
        const parQty = par.qty || null;
        const depth = par.depth || null;
        const parLevel = parQty && parUnit ? `${parQty} ${parUnit}` : '';
        status[ing.id] = {
            low: false, priority: null, parLevel,
            parQty, parUnit, parDepth: depth, parNotes: '', completed: false
        };
    });

    const dish = { id: dishId, name: 'Items', sortOrder: 0, expanded: true, ingredients };
    return { id: stationId, name: 'OVERNIGHT', dishes: [dish], status, expanded: true };
}

function loadData() {
    // One-time reset for all stations data load (Build 132)
    const dataVersion = localStorage.getItem('aqueous_data_version');
    if (dataVersion !== '132') {
        localStorage.removeItem('aqueous_stations');
        localStorage.removeItem('aqueous_globalIngredients');
        localStorage.removeItem('aqueous_dayChecklists');
        localStorage.removeItem('aqueous_completedHistory');
        localStorage.removeItem('aqueous_mlDayStates');
        localStorage.removeItem('aqueous_activityLog');
        localStorage.removeItem('aqueous_prep_times');
        localStorage.removeItem('aqueous_taskTemplates');
        localStorage.removeItem('aqueous_ingredient_defaults');
        localStorage.removeItem('aqueous_history');
        activityLog = [];
        dayChecklists = {};
        completedHistory = {};
        history = [];
        prepTimes = {};
        taskTemplates = {};
        ingredientDefaults = {};
        localStorage.setItem('aqueous_data_version', '132');
    }

    const saved = localStorage.getItem('aqueous_stations');
    if (saved) {
        stations = JSON.parse(saved);
    } else {
        stations = [
            buildSeafoodStation(),
            buildSauteStation(),
            buildSushiStation(),
            buildAmberBarStation(),
            buildGardeMangerStation(),
            buildOvernightStation()
        ];
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
        settings = { vibration: true, sound: true, cookName: '', mascot: 'mascot', numCooks: 1, ...s };
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

    // One-time bulk timing load (Build 149)
    if (!localStorage.getItem('aqueous_timing_bulk_v1')) {
        bulkLoadTimingData();
        localStorage.setItem('aqueous_timing_bulk_v1', '1');
    }

    // Load recipes
    const savedRecipes = localStorage.getItem('aqueous_recipes');
    if (savedRecipes) {
        recipes = JSON.parse(savedRecipes);
        // Merge new default recipes that don't exist yet (by id)
        var defaults = getDefaultRecipes();
        var existingIds = new Set(recipes.map(function(r) { return r.id; }));
        var added = 0;
        defaults.forEach(function(d) {
            if (!existingIds.has(d.id)) { recipes.push(d); added++; }
        });
        if (added > 0) saveRecipes();
    } else {
        recipes = getDefaultRecipes();
        saveRecipes();
    }

    // Init Recipe V2 system
    loadRecipesV2();
    migrateRecipesMetadata();
}

function savePrepTimes() {
    localStorage.setItem('aqueous_prep_times', JSON.stringify(prepTimes));
}

function saveTaskTemplates() {
    localStorage.setItem('aqueous_taskTemplates', JSON.stringify(taskTemplates));
}

function bulkLoadTimingData() {
    // Unit abbreviation map: file abbrev → app unit name
    const U = {
        'qt': 'quart', 'pint': 'pint', 'cup': 'cup', 'oz': 'oz', 'sq btl': 'sq btl',
        'squeeze': 'sq btl',
        '1/9 pan': '1/9pan', '1/6 pan': '1/6pan', '1/3 pan': '1/3pan', '1/2 pan': '1/2pan', 'full pan': 'fullpan',
        'hotel pan': 'hotel pan', '10 qt': '10 qt', '22 qt': '22 qt',
        'kg': 'kg', 'lb': 'lb', 'g': 'g',
        'ea': 'each', 'each': 'each', 'recipe': 'recipe', 'order': 'order', 'bag': 'bag',
        'block': 'block', 'batch': 'batch', 'case': 'case', 'jar': 'jar',
        'portion': 'portion', 'orders': 'orders', 'task': '(task)'
    };

    // Raw data: [name, unitAbbrev, family, totalSeconds]
    const data = [
        // SEAFOOD PREP-LIST
        ['Split prawn','ea','count',90],['Gochujang-Infused Garlic Oil','qt','volume',900],
        ['Shaved fennel','1/9 pan','volume',300],['Fried Bao (2 pz)','order','count',240],
        ['Arugula','1/6 pan','volume',120],['Crispy shallot','pint','volume',600],
        ['Lemon juice','ea','count',30],['Pickled fresno','cup','volume',300],
        ['Olive oil','squeeze','volume',60],['Gochujang sauce','1/6 pan','volume',600],
        ['Demi (Butcher\'s)','qt','volume',1800],['Brocoli','ea','count',180],
        ['Potato pave','ea','count',2400],['Pistachio','qt','volume',300],
        ['Cut of the day','ea','count',300],['CHICKEN BREAST','ea','count',180],
        ['Pomme puree','qt','volume',1800],['CARAMELIZED PEARL ONION','pint','volume',900],
        ['MUSHROOM MARSALA','qt','volume',1200],['FENNEL','1/9 pan','volume',240],
        ['KING TRUMPET','1/9 pan','volume',300],['A5 Wagyu (3 oz)','ea','count',120],
        ['Alaskan King Crab (3 oz)','ea','count',180],['Yuzukoshō Miso Kabocha (3)','order','count',300],
        ['Asparagus (2)','ea','count',60],['Demi (Surf&Turf)','qt','volume',1800],
        ['Butter','1/6 pan','volume',60],['Filet Mignon','ea','count',180],
        ['Chicken (Wok)','ea','count',180],['Stir-fried sauce','recipe','count',900],
        ['Lemongrass jazmin rice (200gr)','order','count',300],['Onion','1/9 pan','volume',240],
        ['Bell peppers','1/9 pan','volume',240],['Sliced garlic','cup','volume',300],
        ['Ginger','cup','volume',300],['Asparagus (Wok)','1/9 pan','volume',240],
        ['Baby bok choy','1/6 pan','volume',180],['Snow peas','1/9 pan','volume',180],
        ['Scallions','cup','volume',180],['Shrimp','ea','count',90],
        ['Pomme puree (Enhancement)','qt','volume',1800],
        // SAUTE
        ['Lobster Bisque','recipe','count',3600],['Croissant','ea','count',30],
        ['Crème Fraîche foam','recipe','count',600],['Lobster meat','bag','count',900],
        ['Smoked paprika','cup','volume',60],['Branzino','ea','count',300],
        ['Mixed Rice (120gr)','order','count',300],['Bubu Arare','cup','volume',60],
        ['Szechuan Pepper','recipe','count',300],['Julienne bell peppers','1/9 pan','volume',360],
        ['Julienne apple','1/9 pan','volume',300],['Mix green','1/3 pan','volume',180],
        ['Pickled red onion','1/9 pan','volume',360],['Heavy cream','qt','volume',60],
        ['Pasta','1/3 pan','volume',600],['Lobster meat (Mac)','bag','count',900],
        ['Shredded cheese','bag','count',60],['Honey','squeeze','volume',60],
        ['Pink pepper','1/9 pan','volume',120],['Baby Carrots','1/6 pan','volume',360],
        // SUSHI
        ['Hamachi Slice','order','count',180],['Salmon Tartare','recipe','count',900],
        ['King Crab Mix','recipe','count',900],['Spicy Tuna','recipe','count',600],
        ['Lobster mix','recipe','count',900],['Seabass for tempura','1/9 pan','volume',360],
        ['Ahi Tuna Slice','block','count',600],['Ora King Salmon Slice','block','count',600],
        ['Smoked paprika aioli','1/9 pan','volume',600],['Orange Tobiko','1/6 pan','volume',60],
        ['Yuzu Tobiko','1/6 pan','volume',60],['Ikura','ea','count',60],
        ['Serrano thin slice','1/9 pan','volume',300],['Micro Cilantro (Cilantro)','cup','volume',120],
        ['Avocado','1/9 pan','volume',300],['Jalapeno Julienne','1/9 pan','volume',300],
        ['Chive fine chop','1/9 pan','volume',300],['Wagyu A5','1/9 pan','volume',300],
        ['Takuan Julienne','1/9 pan','volume',240],['Caviar','1/9 pan','volume',60],
        ['Kizami wasabi','cup','volume',60],['Green Onion fine chop','1/9 pan','volume',240],
        ['Micro Herb','cup','volume',120],['Yuzu Shoyu','sq btl','volume',300],
        ['Kimchi Aioli','sq btl','volume',600],['Sun-dried Tomato Pesto','recipe','count',900],
        ['Yuzu kosho aioli','sq btl','volume',600],['Crème Fraiche','sq btl','volume',120],
        ['Sweet Shoyu','sq btl','volume',300],['Aka yuzu kosho aioli','recipe','count',600],
        ['Sriracha','sq btl','volume',60],['Temaki Nori','sq btl','volume',60],
        ['Sushi Rice','recipe','count',2400],['Crispy Sushi Rice','ea','count',600],
        ['Pickled shiso relish','pint','volume',600],['Toasted Sesame seeds','cup','volume',180],
        ['Wasabi','recipe','count',120],['Sushi Ginger','1/9 pan','volume',60],
        // AMBER BAR
        ['Rainbow Carrots','1/9 pan','volume',300],['Mini Sweet Pepper','1/9 pan','volume',240],
        ['Cucumber','1/9 pan','volume',180],['Micro Crudites Mix','1/9 pan','volume',300],
        ['Celery','1/9 pan','volume',180],['Asparagus','1/9 pan','volume',240],
        ['Classic hummus','qt','volume',1200],
        ['Tzatziki','recipe','count',900],['Dehydrated Black Olive','pint','volume',1800],
        ['Grilled pita','bag','count',300],['Dry Salami','ea','count',180],
        ['Hot Sopressata','ea','count',180],['Italian Salami','ea','count',180],
        ['Prosciutto','1/6 pan','volume',240],['Parmigiano Reggiano','1/9 pan','volume',300],
        ['Cheddar','1/9 pan','volume',180],['Brie','1/9 pan','volume',120],
        ['Stilton','1/9 pan','volume',120],['Apricot Jam','1/9 pan','volume',60],
        ['Grape','1/9 pan','volume',120],['Candied nuts','qt','volume',900],
        ['GF Grissini (3 EA)','order','count',60],['Artichokes','1/6 pan','volume',600],
        ['Salsa verde','recipe','count',900],['Pecorino','1/9 pan','volume',240],
        ['Lemon Wedge','1/9 pan','volume',180],['Yuzu aioli','recipe','count',600],
        ['Romesco sauce','recipe','count',1200],['Red bell pepper brunoise','cup','volume',360],
        ['Spring roll order (2 each)','order','count',300],['Micro herbs','cup','volume',120],
        ['Fennel saved for salad','qt','volume',360],['Red chili sauce','recipe','count',900],
        ['Kabocha crisp','qt','volume',1200],['Kabocha sous vide','1/9 pan','volume',1800],
        ['Sage Crisps','pint','volume',600],['Kabocha bisque','recipe','count',2400],
        ['Yellow tomato','ea','count',120],['Balsamic pearls','jar','count',60],
        ['Basil-citrus vinaigrette','recipe','count',600],['Burrata','ea','count',60],
        ['Yuzu glaze','recipe','count',900],['Yuzu syrup','recipe','count',600],
        ['Basil baby leaf','cup','volume',120],['Little gem lettuce','1/3 pan','volume',240],
        ['Radicchio','1/9 pan','volume',180],['Focaccia croutons','qt','volume',600],
        ['Parmigiano reggiano (Caesar)','1/9 pan','volume',240],['Crispy prosciutto','qt','volume',900],
        ['Cherry Tomatoes','1/9 pan','volume',180],['Caesar dressing','recipe','count',600],
        ['Sushi rice (Amber)','recipe','count',2400],['Tuna','1/6 pan','volume',300],
        ['Furikake','1/9 pan','volume',60],['Mango','1/9 pan','volume',300],
        ['Tosaka nori','qt','volume',60],['Edamame','1/9 pan','volume',300],
        ['Cucumber (Poke)','1/9 pan','volume',180],['Avocado (Amber)','1/9 pan','volume',300],
        ['Seaweed salad','1/9 pan','volume',120],['Kimchi aioli','recipe','count',600],
        ['Chicken broth','recipe','count',3600],['Chashu chicken','ea','count',1800],
        ['Sous vide Corn','1/9 pan','volume',600],['Shimeji mushrooms','1/9 pan','volume',240],
        ['Black Fungus','1/9 pan','volume',180],['Bamboo shoots','1/9 pan','volume',120],
        ['Chicken Chicharron','qt','volume',1200],['Crispy Shallot','pint','volume',600],
        ['Black garlic oil','pint','volume',1800],['Roasted garlic oil','pint','volume',1200],
        ['Sesame chili oil','sq btl','volume',600],['Lime Wedge','1/9 pan','volume',180],
        ['Scallions (Amber)','1/9 pan','volume',180],['Tamago egg','ea','count',300],
        ['Allen bros beef patty (2 EACH)','order','count',120],['American cheese','1/9 pan','volume',60],
        ['Brioche bun','each','count',30],['Black bean patty','recipe','count',1800],
        ['Amber aioli','recipe','count',600],['Caramelized onion','1/9 pan','volume',900],
        ['Tomato sliced','1/6 pan','volume',180],['Arugula (Amber)','1/6 pan','volume',120],
        ['Fries','hotel pan','volume',900],['Korean BBQ short rib','order','count',1800],
        ['Gochujang butter','recipe','count',600],['Mozzarella cheese shredded','1/9 pan','volume',120],
        ['Kimchi aioli (Sandwich)','recipe','count',600],['Kimchi Julienne','1/9 pan','volume',300],
        ['Sourdough','order','count',60],['Wagyu brisket','order','count',1800],
        ['Sweet-soy glaze','recipe','count',600],['Pickled cabbage','1/9 pan','volume',600],
        ['Cucumber (Bao)','1/9 pan','volume',180],['Pickled Mini sweet pepper','1/9 pan','volume',360],
        ['Bao bun (4 each)','order','count',240],['Cherry tomatoes pickled','qt','volume',600],
        ['Milk bread','order','count',60],['Katsu sando sauce','sq btl','volume',600],
        ['Kappa pickle brunoise','1/9 pan','volume',360],['Pork katsu','order','count',900],
        ['Shaved little gem','1/9 pan','volume',180],['Kappa pickle','1/9 pan','volume',240],
        ['Lemongrass Rice (200 GR)','pint','volume',300],['Chicken Sousvide dinner','each','count',1800],
        ['Baby Bokchoy','1/6 pan','volume',180],['Asparagus (Amber)','1/9 pan','volume',240],
        ['Yellow bell pepper julienne','1/9 pan','volume',360],['Red bell pepper julienne','1/9 pan','volume',360],
        ['Yellow onion julienne','1/9 pan','volume',360],['Snow peas (Amber)','1/9 pan','volume',180],
        ['Ginger fine julienne','cup','volume',360],['Garlic slice','cup','volume',300],
        ['Stir-fry sauce','recipe','count',900],['Scallion (Stir-fry)','cup','volume',180],
        ['Elotes (8 pz)','order','count',600],['Yuzu kosho aioli (Amber)','recipe','count',600],
        ['Lime cream','recipe','count',600],['Togarashi aioli','recipe','count',600],
        ['Lime wedge (Amber)','1/9 pan','volume',180],
        // GARDE MANGER
        ['Smoked Salmon Mousse','recipe','count',1800],['Ossetra caviar','ea','count',60],
        ['Red onion','cup','volume',240],['Chives','cup','volume',180],
        ['Egg White','ea','count',30],['Egg Yolk','ea','count',30],
        ['Potato Chips','order','count',60],['Sour Cream','sq btl','volume',60],
        ['Gremolata','pint','volume',600],['Sliced meat','ea','count',180],
        ['Arugula (GM)','1/6 pan','volume',120],['Cucumber (GM)','1/9 pan','volume',180],
        ['Parmesan cheese','1/9 pan','volume',240],['Tortilla strips','qt','volume',600],
        ['Cucumber julienne','1/9 pan','volume',300],['Pickled carrot','recipe','count',600],
        ['Watermelon','ea','count',300],['Watermelon citrus ponzu','recipe','count',600],
        ['Pickled onion','recipe','count',360],['Peach marinated','1/6 pan','volume',300],
        ['Plum marinated','1/6 pan','volume',300],['White balsamic dressing','1/6 pan','volume',300],
        ['Burrata cheese','1/6 pan','volume',60],['Mint','1/9 pan','volume',120],
        ['Prosciutto (GM)','recipe','count',240],['Matcha mayo','recipe','count',600],
        ['Tempura-togarashi crumbs','pint','volume',900],['Ginger Brunoise','cup','volume',360],
        ['Scallions (GM)','cup','volume',180],['Tuna diced','1/6 pan','volume',360],
        ['Shrimp u-8 (6)','bag','count',600],['Greens','1/3 pan','volume',180],
        ['Orange segments','ea','count',300],['Lemon','ea','count',30],
        ['Lime','ea','count',30],['Horseradish quenelle','1/9 pan','volume',600],
        ['Aqueous cocktail sauce','recipe','count',600],['Oysters (6)','ea','count',360],
        ['Romaine','hotel pan','volume',300],['Lemon-togarashi croutons','1/6 pan','volume',600],
        ['Creamy parmesan dressing','recipe','count',600],['Roasted broccoli','1/6 pan','volume',480],
        ['Grana Padano','1/9 pan','volume',240],['Apple','ea','count',180],
        ['Lobster sous vide (1)','ea','count',1800],['Scallops','ea','count',60],
        ['Sashimi (3 oz)','portion','count',180],['Crab claws','bag','count',600],
        ['Lump crab','ea','count',600],['Garlic Oil','qt','volume',900],
        ['Bamboo leaves','ea','count',30],['Butter plates','ea','count',120],
        ['Cookies','recipe','count',1800],['Jam','recipe','count',1200],
        // OVERNIGHT
        ['Crack Eggs','10 qt','volume',1200],['Plate Fruit','ea','count',300],
        ['Pancake Mix','recipe','count',600],['Cut Fruit','hotel pan','volume',1800],
        ['Carrots Shredded','1/9 pan','volume',360],['Cucumber (ON)','1/9 pan','volume',180],
        ['Orange Segments','ea','count',300],['Cherry Tomatoes (ON)','1/9 pan','volume',180],
        ['Baby Gem Lettuce','hotel pan','volume',600],['Mix Greens','1/3 pan','volume',300],
        ['Parmesan Cheese (ON)','1/9 pan','volume',240],['Caesar Dressing','recipe','count',600],
        ['Italian Dressing','recipe','count',600],['Blue Cheese Dressing','recipe','count',600],
        ['White Balsamic Dressing','recipe','count',300],['Ranch Dressing','recipe','count',600],
        ['Yuzu Ponzu','recipe','count',300],['Cocktail Sauce','recipe','count',600],
        ['Butter Mold','ea','count',120],['Scoop Cookies','batch','count',1200],
        ['Clean Lobster','ea','count',900],['Clean King Crab','batch','count',1200],
        ['Focaccia for Croutons','1/6 pan','volume',600],['Scrub Oysters','case','count',1200],
        ['Cook Pasta','qt','volume',600],['Lobster Stock','recipe','count',3600],
        ['Blanch Baby Carrots','1/6 pan','volume',360],['Snow Peas (ON)','1/9 pan','volume',180],
        ['Peel Potato','22 qt','volume',2400],['Open Filet','ea','count',300],
        ['Hummus','recipe','count',1200],['Asparagus (ON)','orders','count',240],
        ['Blanch Fries Gluten Free','case','count',1200],['Mirepoix','hotel pan','volume',1800],
        ['Change Oil','task','count',1200],['Wash Frier','task','count',1800],
        ['Shari-Zu','recipe','count',900]
    ];

    let loaded = 0;
    data.forEach(([name, unitAbbrev, family, totalSec]) => {
        const key = name.toLowerCase();
        const unit = U[unitAbbrev] || unitAbbrev;
        const depth = PAN_UNITS.includes(unit) ? 4 : null;
        const baseQty = convertToBase(1, unit, depth);
        const secPerBase = baseQty > 0 ? totalSec / baseQty : 0;

        if (!taskTemplates[key]) taskTemplates[key] = { templateVersion: 3 };
        taskTemplates[key][family] = {
            secPerBaseUnit: secPerBase,
            refSeconds: totalSec,
            refQty: 1,
            refUnit: unit,
            refDepth: depth,
            date: Date.now()
        };
        taskTemplates[key].templateVersion = 3;
        loaded++;
    });

    saveTaskTemplates();
    showToast(`Timing loaded: ${loaded} ingredients`);
    panelDirty.home = true;
    panelDirty.tools = true;
    renderPanel(currentView);
    return loaded;
}

function migrateTaskTemplatesToV3() {
    let changed = false;
    Object.keys(taskTemplates).forEach(key => {
        const tmpl = taskTemplates[key];
        if (tmpl.templateVersion >= 3) return;
        if (tmpl.secPerBaseUnit > 0 && tmpl.baseFamily) {
            const fam = tmpl.baseFamily;
            if (!tmpl[fam]) {
                tmpl[fam] = {
                    secPerBaseUnit: tmpl.secPerBaseUnit,
                    refSeconds: tmpl.refSeconds || 0,
                    refQty: tmpl.refQty || 1,
                    refUnit: tmpl.refUnit || 'each',
                    refDepth: tmpl.refDepth || null,
                    date: tmpl.lastUpdatedAt || Date.now()
                };
                changed = true;
            }
        }
        if (tmpl.manualSeconds > 0 && !tmpl.volume && !tmpl.weight) {
            tmpl.manual = { seconds: tmpl.manualSeconds, date: tmpl.lastUpdatedAt || Date.now() };
            changed = true;
        }
        tmpl.templateVersion = 3;
        changed = true;
    });
    if (changed) saveTaskTemplates();
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
        saveSnapshotToHistory(lastDate);

        // Auto-close yesterday's day checklist
        const yesterdayKey = new Date(lastDate).toISOString().slice(0, 10);
        if (dayChecklists[yesterdayKey] && dayChecklists[yesterdayKey].length > 0) {
            const list = dayChecklists[yesterdayKey];
            const nextDay = getTodayKey();

            // Save completed items to history
            const struckItems = list.filter(x => x.struck);
            if (struckItems.length > 0) {
                saveCompletedItems(yesterdayKey, struckItems);
            }

            // Clear station.status for completed items
            struckItems.forEach(item => {
                const station = stations.find(s => s.id === item.stationId);
                if (station && station.status[item.ingredientId]) {
                    station.status[item.ingredientId].completed = false;
                    station.status[item.ingredientId].priority = null;
                    station.status[item.ingredientId].low = false;
                }
            });

            // Carry over non-struck to today with high priority
            const carryOver = list.filter(x => !x.struck).map(item => ({
                ...item, priority: 'high', struck: false
            }));
            if (!dayChecklists[nextDay]) dayChecklists[nextDay] = [];
            carryOver.forEach(item => {
                const exists = dayChecklists[nextDay].findIndex(
                    x => x.stationId === item.stationId && x.ingredientId === item.ingredientId
                );
                if (exists >= 0) dayChecklists[nextDay][exists] = item;
                else dayChecklists[nextDay].push(item);
            });

            dayChecklists[yesterdayKey] = [];
            saveDayChecklists();
        }

        saveData(true);
        cleanOldHistory();
    }

    // Reset activeDay to today on new day
    if (settings.activeDay && settings.activeDay < getTodayKey()) {
        settings.activeDay = null;
        saveSettings();
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

const SWIPE_VIEW_ORDER = ['home', 'tools', 'library'];
const SWIPE_PANELS = { home: 'panelHome', tools: 'panelTools', library: 'panelLibrary' };
const OVERLAY_VIEWS = ['settings', 'logDetail'];
// Track which panels have been rendered at least once
const panelDirty = { home: true, tools: true, library: true };

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
    track.style.transform = `translateX(-${idx * 33.3333}%)`;
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
        updateFab();
    });
}

function markAllPanelsDirty() {
    panelDirty.home = true;
    panelDirty.tools = true;
    panelDirty.library = true;
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

    // Legacy redirects
    if (view === 'timer') view = 'tools';
    if (view === 'summary') view = 'tools';
    if (view === 'logs') { toolsSubTab = 'logs'; view = 'tools'; }
    if (view === 'history') { toolsSubTab = 'history'; view = 'tools'; }
    currentView = view;
    sessionStorage.setItem('aqueous_currentView', view);

    // Close Home station picker when leaving Home
    if (view !== 'home' && homeStationPickerOpen) {
        homeStationPickerOpen = false;
        panelDirty.home = true;
    }

    // Nav highlight
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const navItems = document.querySelectorAll('.nav-item');
    if (view === 'home') navItems[0].classList.add('active');
    else if (view === 'tools') navItems[1].classList.add('active');
    else if (view === 'library') navItems[2].classList.add('active');
    else if (view === 'settings') { window.history.pushState({ view: 'settings' }, ''); }
    else if (view === 'logDetail') navItems[1].classList.add('active');

    // Overlay views (settings, logDetail)
    if (OVERLAY_VIEWS.includes(view)) {
        const overlay = document.getElementById('panelOverlay');
        updateFab();
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

    // Swipe views — render target BEFORE sliding, then slide
    renderPanel(view);
    // Also pre-render panels between current and target to avoid blanks during slide
    const fromIdx = SWIPE_VIEW_ORDER.indexOf(previousView || 'home');
    const toIdx = SWIPE_VIEW_ORDER.indexOf(view);
    if (fromIdx >= 0 && toIdx >= 0) {
        const lo = Math.min(fromIdx, toIdx);
        const hi = Math.max(fromIdx, toIdx);
        for (let i = lo; i <= hi; i++) {
            renderPanel(SWIPE_VIEW_ORDER[i]);
        }
    }
    updateFab();
    if (!skipSlide) slideTrackTo(view, true);
}

function updateFab() {
    const fab = document.getElementById('fab');
    if (currentView === 'home') {
        fab.style.display = 'flex';
        fab.textContent = homeStationPickerOpen ? '\u00d7' : '+';
        fab.classList.toggle('fab-close', homeStationPickerOpen);
    } else {
        fab.style.display = 'none';
    }
}

function renderPanel(view) {
    const panel = getPanel(view);
    if (!panel) return;
    updateFab();

    // Only re-render if dirty (data changed) or never rendered
    if (!panelDirty[view]) return;
    panelDirty[view] = false;

    const scrollBefore = panel.scrollTop;
    if (view === 'home') renderHome(panel);
    else if (view === 'tools') renderTools(panel);
    else if (view === 'library') renderLibrary(panel);
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

// ==================== HOME VIEW (Master List) ====================

function renderHome(container) {
    autoCalcPrepWindow();
    const timerOn = !!settings.shiftStart;

    let contentHtml;
    if (homeStationPickerOpen) {
        contentHtml = renderStationsView({ showPriority: true, mode: 'picker' });
    } else {
        contentHtml = renderMasterListView();
    }

    // Check if all ML items have timing for timer gate
    let timerGateHtml = '';
    const dayItems = dayChecklists[getActiveDay()] || [];
    const missingTimingCount = dayItems.filter(item => {
        const fam = getTimingFamily(item.parUnit);
        const ingFam = getIngTimingFamilies(item.name);
        return !ingFam[fam];
    }).length;
    if (missingTimingCount > 0) {
        timerGateHtml = `<span class="timer-gate-msg">${missingTimingCount} missing timing</span>`;
    }

    const isToday = getActiveDay() === getTodayKey();
    const cooks = settings.numCooks || 1;
    const totalSec = getCountdownTotalSeconds();
    const dividedSec = totalSec > 0 ? Math.ceil(totalSec / cooks) : 0;
    const dividedDisplay = dividedSec > 0 ? formatTime(dividedSec) : '--:--';

    container.innerHTML = `
        <div class="home-tab-sticky">
            <div class="day-selector-row">
                <button class="day-chip ${getActiveDay() === getTodayKey() ? 'active' : ''}" onclick="setActiveDay(null)">Today</button>
                <button class="day-chip ${getActiveDay() === getNextDayKey(getTodayKey()) ? 'active' : ''}" onclick="setActiveDay('${getNextDayKey(getTodayKey())}')">Tomorrow</button>
                <button class="day-chip day-chip-pick" onclick="showDayPicker()">+ Set Date</button>
                ${isToday ? '<button class="close-day-btn" onclick="confirmCloseDay()">Close Day</button>' : ''}
            </div>
            <div class="home-timer-row">
                <span class="timer-label" onclick="${timerGateHtml && !timerOn ? '' : (timerOn ? 'clockOut()' : 'clockIn()')}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </span>
                <span class="timer-total-display" id="timerTotalDisplay">${dividedDisplay}</span>
                ${timerGateHtml}
                <span class="countdown-label" id="countdownLabel"></span>
                <div class="cook-controls">
                    <button class="cook-btn" onclick="adjustCooks(-1)" ${cooks <= 1 ? 'disabled' : ''}>−</button>
                    <span class="cook-count-wrap">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
                        <span id="cookCountDisplay">${cooks}</span>
                    </span>
                    <button class="cook-btn" onclick="adjustCooks(1)" ${cooks >= 10 ? 'disabled' : ''}>+</button>
                </div>
                <button class="neu-toggle neu-toggle-sm ${timerOn ? 'active' : ''}${timerGateHtml && !timerOn ? ' disabled' : ''}"
                    onclick="${timerGateHtml && !timerOn ? '' : (timerOn ? 'clockOut()' : 'clockIn()')}"></button>
            </div>
            <div class="countdown-bar-container">
                <div class="countdown-bar" id="countdownBar" style="width: 100%"></div>
            </div>
        </div>
        ${homeStationPickerOpen ? `<div class="station-picker-banner">Select ingredients for ${formatDayLabel(getActiveDay())}'s checklist</div>` : ''}
        <div class="home-tab-content">${contentHtml}</div>`;

    // Kick off countdown bar if shift is active
    if (settings.clockInTimestamp) {
        updateCountdownBar();
        startCountdownBar();
    }
}

function handleFabClick() {
    handleClick();
    toggleHomeStationPicker();
}

function toggleHomeStationPicker() {
    homeStationPickerOpen = !homeStationPickerOpen;
    updateFab();
    panelDirty.home = true;
    renderPanel('home');
    // Scroll to top when closing station picker to show Master List
    if (!homeStationPickerOpen) {
        const panel = getPanel('home');
        if (panel) panel.scrollTop = 0;
    }
}

function renderStationsView(opts) {
    opts = opts || {};
    if (stations.length === 0) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <p>No stations created</p>
                <p class="empty-sub">Tap "+ New Station" below to get started</p>
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
                ${renderIngredients(station, opts)}
                ${stationFooter(station.id, opts)}
            </div>
        </div>`;
    });
    return html;
}

// ==================== TOOLS VIEW ====================

function switchToolsSubTab(tab) {
    handleClick();
    toolsSubTab = tab;
    stationSearchQuery = '';
    panelDirty.tools = true;
    renderPanel('tools');
}

let stationSearchQuery = '';

function renderTools(container) {
    let content = '';
    if (toolsSubTab === 'stations') {
        if (stationSearchQuery.length > 0) {
            content = renderStationSearchResults(stationSearchQuery);
        } else {
            content = renderStationsView({ showPriority: false, mode: 'database' });
            content += `<button class="add-action-btn squishy" onclick="handleClick(); showNewStationModal()">+ New Station</button>`;
        }
    } else if (toolsSubTab === 'logs') {
        content = renderLogsContent();
    } else if (toolsSubTab === 'history') {
        content = renderHistoryContent();
    }

    var searchBar = toolsSubTab === 'stations' ? `
        <div class="station-search-row">
            <svg class="station-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" class="station-search-input" id="stationSearchInput" placeholder="Search ingredients..." value="${stationSearchQuery}" oninput="onStationSearch(this.value)">
            ${stationSearchQuery ? '<button class="station-search-clear" onclick="clearStationSearch()">✕</button>' : ''}
        </div>` : '';

    container.innerHTML = `
        <div class="sub-pill-row">
            <button class="day-chip ${toolsSubTab === 'stations' ? 'active' : ''}" onclick="switchToolsSubTab('stations')">Stations</button>
            <button class="day-chip ${toolsSubTab === 'logs' ? 'active' : ''}" onclick="switchToolsSubTab('logs')">Logs</button>
            <button class="day-chip ${toolsSubTab === 'history' ? 'active' : ''}" onclick="switchToolsSubTab('history')">History</button>
        </div>
        ${searchBar}
        <div class="tools-content-area">${content}</div>`;

    if (toolsSubTab === 'stations' && stationSearchQuery) {
        var inp = document.getElementById('stationSearchInput');
        if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
}

function onStationSearch(val) {
    stationSearchQuery = val;
    panelDirty.tools = true;
    renderPanel('tools');
}

function clearStationSearch() {
    handleClick();
    stationSearchQuery = '';
    panelDirty.tools = true;
    renderPanel('tools');
}

function renderStationSearchResults(query) {
    var q = query.toLowerCase().trim();
    if (!q) return '';
    var results = [];
    stations.forEach(function(station) {
        (station.dishes || []).forEach(function(dish) {
            (dish.ingredients || []).forEach(function(ing) {
                if (ing.name.toLowerCase().indexOf(q) >= 0) {
                    results.push({ ing: ing, dish: dish, station: station });
                }
            });
        });
    });
    if (results.length === 0) {
        return '<div class="empty-state"><div class="empty-state-icon">🔍</div><p>No ingredients found</p><p class="empty-sub">Try a different search</p></div>';
    }
    var html = '';
    results.forEach(function(r) {
        var dishLabel = r.station.dishes.length > 1 ? r.dish.name + ' · ' : '';
        html += '<div class="search-result-row squishy" onclick="handleClick(); navigateToIngredient(' + r.station.id + ', ' + r.ing.id + ')">' +
            '<span class="search-result-name">' + r.ing.name + '</span>' +
            '<span class="search-result-meta">' + dishLabel + r.station.name + '</span>' +
            '</div>';
    });
    return html;
}

function navigateToIngredient(stationId, ingId) {
    stationSearchQuery = '';
    var station = stations.find(function(s) { return s.id === stationId; });
    if (station) station.expanded = true;
    if (station) {
        station.dishes.forEach(function(d) {
            var hasIng = (d.ingredients || []).some(function(i) { return i.id === ingId; });
            if (hasIng) d.expanded = true;
        });
    }
    if (currentView !== 'tools') switchView('tools');
    if (toolsSubTab !== 'stations') toolsSubTab = 'stations';
    panelDirty.tools = true;
    renderPanel('tools');
    setTimeout(function() {
        var el = document.getElementById('ing-' + stationId + '-' + ingId);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('search-highlight');
            setTimeout(function() { el.classList.remove('search-highlight'); }, 1500);
        }
    }, 100);
}

// ==================== LIBRARY VIEW ====================

function switchLibrarySubTab(tab) {
    handleClick();
    librarySubTab = tab;
    if (tab !== 'bible') { bibleView = 'list'; bibleOpenPdfId = null; }
    panelDirty.library = true;
    renderPanel('library');
}

function saveRecipes() {
    localStorage.setItem('aqueous_recipes', JSON.stringify(recipes));
}

function getDefaultRecipes() {
    return [
        // ── Dinner (Aqueous) ──
        { id: 1, name: 'Ora King Salmon', category: 'Dinner', ingredients: [
            { name: 'Truffles', qty: 4, unit: 'slice' }, { name: 'Pickled Fresno', qty: 3, unit: 'gram' },
            { name: 'Cauliflower', qty: 15, unit: 'gram' }, { name: 'Bonito dashi', qty: 120, unit: 'ml' },
            { name: 'Ora king salmon', qty: 170, unit: 'gram' }, { name: 'Shitake', qty: 20, unit: 'gram' },
            { name: 'Shimeji (beech mushroom)', qty: 20, unit: 'gram' }, { name: 'Snow pea', qty: 30, unit: 'gram' },
            { name: 'Rice flour', qty: 10, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 2, name: 'Pirikara Ahi Tartare Crispy Rice', category: 'Dinner', ingredients: [
            { name: 'Yuzu tobiko', qty: 10, unit: 'gram' }, { name: 'Kimchi aioli', qty: 10, unit: 'gram' },
            { name: 'Micro herb', qty: null, unit: '-' }, { name: 'Crispy Rice 3oz', qty: 180, unit: 'gram' },
            { name: 'Ahi tuna tartare', qty: 85, unit: 'gram' }, { name: 'Pirikara sauce', qty: 10, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 3, name: 'Ora King Salmon Flame Maki', category: 'Dinner', ingredients: [], steps: [], subRecipes: [] },
        { id: 4, name: "Robin's Holistic Garden Red Curry", category: 'Dinner', ingredients: [
            { name: 'Koshi Hikari rice', qty: 200, unit: 'gram' }, { name: 'Carnival cauliflower', qty: 50, unit: 'gram' },
            { name: 'Red curry broth', qty: 240, unit: 'ml' }, { name: 'Broccoli', qty: 25, unit: 'gram' },
            { name: 'Micro herb', qty: 20, unit: 'gram' }, { name: 'Thai basil', qty: 5, unit: 'gram' },
            { name: 'Shallot crisps', qty: 10, unit: 'gram' }, { name: 'Pickled fresno', qty: 3, unit: 'gram' },
            { name: 'Corn', qty: 10, unit: 'gram' }, { name: 'Butternut squash confit', qty: 10, unit: 'gram' },
            { name: 'Tepary beans', qty: 10, unit: 'gram' }
        ], steps: [
            'Mixed vegetables: equal parts, cut into florets: cauliflower, broccolini, butternut squash, black, white, and brown tepary beans, yellow corn',
            'Saute Cruciferous: saute romanesco, cauliflower until lightly browned. Add broccolini and finish cooking until tender',
            'To make Panang curry: In a pot over medium heat, saute curry paste stirring often until brick red and aromatic. Add coconut milk and let simmer. Add tamari, sugar, and kaffir lime. Simmer on medium low heat for 20 minutes',
            'Once done cooking, transfer to a 600 hotel pan and place in the chiller to cool'
        ], subRecipes: [{ name: 'Red Curry Broth', ingredients: [
            { name: 'Maesri Red Curry Paste', qty: 800, unit: 'gram' }, { name: 'Cooking oil', qty: 60, unit: 'ml' },
            { name: 'Coconut milk', qty: 5678, unit: 'ml' }, { name: 'Tamari soy sauce', qty: 355, unit: 'ml' },
            { name: 'Cane sugar', qty: 300, unit: 'gram' }, { name: 'Kaffir lime leaf', qty: 2, unit: 'cup' }
        ]}] },
        // ── Dinner (Aqueous) — New Menu ──
        { id: 300, name: 'Aka Yuzu Kosho Aioli', category: 'Dinner', ingredients: [
            { name: 'Aka Yuzu kosho', qty: 80, unit: 'gram' }, { name: 'Vegan mayonnaise', qty: 500, unit: 'gram' }
        ], steps: ['All ingredients incorporated'], subRecipes: [] },
        { id: 301, name: 'Balsamic Pearls', category: 'Dinner', ingredients: [
            { name: 'High-quality balsamic vinegar', qty: 200, unit: 'gram' }, { name: 'Sodium alginate', qty: 2, unit: 'gram' },
            { name: 'Cold water (for calcium bath)', qty: 500, unit: 'gram' }, { name: 'Calcium chloride', qty: 5, unit: 'gram' }
        ], steps: ['Blend balsamic + sodium alginate using immersion blender.', 'Blend fully until smooth (no powder specks).', 'Rest 20-30 minutes to remove air bubbles.', 'Strain through chinois for ultra-fine pearls.', 'Fill syringe or squeeze bottle with balsamic mixture.', 'Drop small droplets into calcium bath.', 'Let sit 45-60 seconds.', 'Remove pearls with slotted spoon.', 'Rinse in clean water bath to stop reaction.'], subRecipes: [
            { name: 'Calcium Bath', ingredients: [
                { name: 'Cold water', qty: 500, unit: 'gram' }, { name: 'Calcium chloride', qty: 5, unit: 'gram' }
        ] }] },
        { id: 302, name: 'Branzino', category: 'Dinner', ingredients: [
            { name: 'Forbidden rice', qty: 180, unit: 'gram' }, { name: 'Bubu arare', qty: 10, unit: 'gram' },
            { name: 'Szechuan pepper', qty: null, unit: '-' }, { name: 'Ginger', qty: 20, unit: 'gram' },
            { name: 'Branzino', qty: 170, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 303, name: 'Burnt Cheesecake', category: 'Dinner', ingredients: [
            { name: 'Caramel', qty: null, unit: '-' }, { name: 'Raspberry', qty: null, unit: '-' },
            { name: 'Tonka cream', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 304, name: 'Caprese Burrata (Dinner)', category: 'Dinner', ingredients: [], steps: ['Mix yuzu with simple syrup, hollow out the inside of the tomato from the bottom, and marinate it in the liquid for 8 hours.', 'For the yuzu glaze, put all the ingredients into a pot. Once it comes to boiling, remove from heat, blend until smooth, cool it down, and transfer to a squeeze bottle.', 'Stuff the marinated tomato with burrata, then dress the top of the tomato with the yuzu glaze.', 'Place basil citrus dressing in the center of the plate.', 'Set the dressed tomato on top of arugula dressed with olive oil.', 'Arrange cherry tomatoes around the main tomato.', 'Garnish with edible flowers and balsamic pearls.'], subRecipes: [
            { name: 'Yuzu Marination', ingredients: [
                { name: 'Yuzu', qty: 500, unit: 'gram' }, { name: 'Simple syrup', qty: 830, unit: 'gram' }
            ] },
            { name: 'Yuzu Glaze', ingredients: [
                { name: 'Sugar', qty: 1, unit: 'pint' }, { name: 'Rice vinegar', qty: 3, unit: 'cup' },
                { name: 'Ginger', qty: 15, unit: 'gram' }, { name: 'Thai chili', qty: 2, unit: 'ea' },
                { name: 'Yuzu', qty: 1, unit: 'cup' }, { name: 'Agar agar', qty: 10, unit: 'gram' }
            ] },
            { name: 'Caprese Burrata Plating', ingredients: [
                { name: '5x6 yellow tomato', qty: 1, unit: 'ea' }, { name: 'Burrata 2oz', qty: 1, unit: 'ea' },
                { name: 'Arugula', qty: 20, unit: 'gram' }, { name: 'Basil-citrus vinaigrette', qty: 42, unit: 'gram' },
                { name: 'Balsamic pearls', qty: 5, unit: 'gram' }
        ] }] },
        { id: 305, name: 'Caramelized Pineapple', category: 'Dinner', ingredients: [
            { name: 'Rum', qty: 750, unit: 'ml' }, { name: 'Cane sugar', qty: 1000, unit: 'gram' },
            { name: 'Pineapple', qty: 3, unit: 'ea' }, { name: 'Whole cloves', qty: 4, unit: 'gram' },
            { name: 'Star anise', qty: 5, unit: 'gram' }, { name: 'Cardamon green crushed', qty: 4, unit: 'gram' },
            { name: 'Ground nutmeg', qty: 5, unit: 'gram' }, { name: 'Salt', qty: 15, unit: 'gram' },
            { name: 'Orange juice', qty: 250, unit: 'ml' }, { name: 'Apple cider vinegar', qty: 125, unit: 'ml' }
        ], steps: ['Flame the rum to reduce it by half. Add the sugar and stir until fully dissolved.', 'Add the pineapple along with all ingredients except the apple cider vinegar.', 'Cook until the mixture turns brown and caramelize, then add the apple cider vinegar.'], subRecipes: [] },
        { id: 306, name: 'Caviar 30g, 50g', category: 'Dinner', ingredients: [
            { name: 'Ossetra caviar 30g', qty: 30, unit: 'gram' }, { name: 'Ossetra caviar 50g', qty: 50, unit: 'gram' },
            { name: 'Blini', qty: 8, unit: 'ea' }, { name: 'Shallot ciseler', qty: 20, unit: 'gram' },
            { name: 'Egg white', qty: 1, unit: 'ea' }, { name: 'Egg yolk', qty: 1, unit: 'ea' },
            { name: 'Chive', qty: 10, unit: 'gram' }, { name: 'Creme fraiche', qty: 20, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 307, name: 'Charred Octopus', category: 'Dinner', ingredients: [], steps: [], subRecipes: [] },
        { id: 308, name: 'Chicken', category: 'Dinner', ingredients: [
            { name: 'Pomme puree', qty: 113, unit: 'gram' }, { name: 'Caramelized pearl onion', qty: 15, unit: 'gram' },
            { name: 'Wild mushroom marsala sauce', qty: 60, unit: 'ml' }, { name: 'Chicken breast', qty: 200, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 309, name: 'Chilean Sea Bass', category: 'Dinner', ingredients: [], steps: [], subRecipes: [] },
        { id: 310, name: 'Chilean Seabass', category: 'Dinner', ingredients: [
            { name: 'Mushroom rice', qty: 180, unit: 'gram' }, { name: 'Green bean & pea tendrils salad', qty: 10, unit: 'gram' },
            { name: 'Yuzu miso seabass', qty: 198, unit: 'gram' }
        ], steps: ['Thinly spread the mushroom rice onto the clay plate and heat until crispy and sizzling.', 'Cook the seabass at 400F for 8 minutes.', 'Place the cooked seabass on the heated plate and add the green bean & pea tendril salad.', 'Add the seared maitake on the side.', 'Serve the plate on a napkin.'], subRecipes: [
            { name: 'Mushroom Rice (30 Portions)', ingredients: [
                { name: 'Shitake', qty: null, unit: '-' }, { name: 'Shimeji (beech mushroom)', qty: 50, unit: 'gram' },
                { name: 'Maitake (hen of the woods)', qty: 15, unit: 'gram' }, { name: 'Trumpet mushroom', qty: null, unit: '-' },
                { name: 'Rice', qty: 180, unit: 'gram' }
        ] }] },
        { id: 311, name: 'Forbidden Rice', category: 'Dinner', ingredients: [], steps: [], subRecipes: [] },
        { id: 312, name: 'Gambas Dressing', category: 'Dinner', ingredients: [
            { name: 'Brown sugar', qty: 113, unit: 'gram' }, { name: 'Fish sauce', qty: 336, unit: 'gram' },
            { name: 'Gochujang chili garlic', qty: 213, unit: 'gram' }, { name: 'Fresh pressed lime juice', qty: 360, unit: 'gram' }
        ], steps: ['Combine all ingredients and whisk thoroughly until the sugar is completely dissolved and the mixture is smooth.'], subRecipes: [] },
        { id: 313, name: 'Gambas al Gochujang', category: 'Dinner', ingredients: [
            { name: 'Jumbo shrimp', qty: 6, unit: 'ea' }, { name: 'Gambas dressing', qty: 3, unit: 'fl.oz' },
            { name: 'Arugula', qty: null, unit: '-' }, { name: 'Mint', qty: null, unit: '-' },
            { name: 'Thai basil', qty: null, unit: '-' }, { name: 'Lemongrass chop', qty: null, unit: '-' }
        ], steps: ['Pan-sear the shrimp until cooked through and lightly golden.', 'Toss the shrimp with the gambas dressing.', 'Prepare the herb salad and lightly dress it with lime juice.', 'Place the shrimp on the plate and top with the dressed herb salad.', 'Garnish with lemongrass and crisp shallots.'], subRecipes: [] },
        { id: 314, name: 'Gochujang Chili Garlic', category: 'Dinner', ingredients: [
            { name: 'Gochujang', qty: 500, unit: 'gram' }, { name: 'Gochugaru', qty: 261, unit: 'gram' },
            { name: 'Tomato paste', qty: 300, unit: 'gram' }, { name: 'Spicy sesame oil', qty: 250, unit: 'ml' },
            { name: 'Sesame oil', qty: 250, unit: 'ml' }, { name: 'Blended oil', qty: 350, unit: 'ml' },
            { name: 'Crunchy garlic', qty: 1100, unit: 'gram' }, { name: 'Onion powder', qty: 50, unit: 'gram' },
            { name: 'Garlic powder', qty: 50, unit: 'gram' }, { name: 'Tamari soy sauce', qty: 100, unit: 'ml' },
            { name: 'Fish sauce', qty: 75, unit: 'ml' }
        ], steps: ['Heat the blended oil, then add the tomato paste and gochujang. Stir and allow it to caramelize.', 'Add the garlic powder, onion powder, and gochugaru, stirring to incorporate.', 'Turn off the heat and adjust the seasoning by adding a smaller amount of the remaining ingredients as needed.'], subRecipes: [] },
        { id: 315, name: 'Hotate Fume a la Truffle', category: 'Dinner', ingredients: [
            { name: 'U8 Hokkaido scallop', qty: 54, unit: 'gram' }, { name: 'Truffle', qty: 5, unit: 'gram' },
            { name: 'Seabass', qty: 54, unit: 'gram' }, { name: 'Green mustard', qty: 15, unit: 'gram' },
            { name: 'Sake', qty: 35, unit: 'ml' }, { name: 'Herb oil', qty: 60, unit: 'ml' },
            { name: 'Butter', qty: 30, unit: 'gram' }, { name: 'Black peppercorn', qty: 1, unit: 'gram' },
            { name: 'Shallot', qty: 10, unit: 'gram' }, { name: 'Lemon', qty: 0.25, unit: 'ea' },
            { name: 'Daikon radish', qty: 5, unit: 'gram' }, { name: 'Carrot', qty: 5, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 316, name: 'Kabocha Creme Brulee', category: 'Dinner', ingredients: [], steps: ['Gently flame the rum. Add sugar and stir until fully dissolved.', 'Add miso and whisk until completely incorporated. Place the kabocha in a vacuum sealer bag.', 'Add the miso-rum mixture to the bag. Seal, and sous vide at 86C for 1 hour.', 'After cooking, shock in ice water to cool down completely, then blend until smooth.', 'Strain through a fine mesh sieve to ensure no lumps remain.', 'Preheat oven to 325F (163C).', 'In a pot, combine heavy cream and raw sugar. Heat gently until the sugar dissolves. Do not bring to a boil.', 'Whisk together egg yolks and kabocha puree until smooth.', 'Slowly pour the warm cream mixture over the yolk-kabocha mixture, whisking continuously to temper.', 'Strain the custard through a fine strainer to remove any lumps.', 'Portion 200ml of custard mixture into each china bowl. Use a blowtorch to remove air bubbles.', 'Place bowls into a 400 hotel pan and add 500ml of water to create a water bath.', 'Cover the pan with double aluminum foil.', 'Bake at 325F for 18 minutes and 30 seconds with pan speed at 3.', 'Remove from oven, cool completely, then refrigerate until set.', 'Before serving, sprinkle sugar evenly and caramelize with a torch.'], subRecipes: [
            { name: 'Kabocha Miso Puree', ingredients: [
                { name: 'Kabocha', qty: 1000, unit: 'gram' }, { name: 'Sugar', qty: 500, unit: 'gram' },
                { name: 'Rum', qty: 200, unit: 'gram' }, { name: 'Miso', qty: 250, unit: 'gram' }
            ] },
            { name: 'Kabocha Creme Brulee Custard', ingredients: [
                { name: 'Kabocha puree', qty: 450, unit: 'gram' }, { name: 'Heavy cream', qty: 2, unit: 'qt' },
                { name: 'Raw sugar', qty: 40, unit: 'gram' }, { name: 'Yolk', qty: 18, unit: 'ea' },
                { name: 'Sugar', qty: 230, unit: 'gram' }
        ] }] },
        { id: 317, name: 'Kabocha Tempura', category: 'Dinner', ingredients: [], steps: [], subRecipes: [
            { name: 'Yuzu Kosho Maple Dip', ingredients: [
                { name: 'Yuzu kosho', qty: 72, unit: 'gram' }, { name: 'Maple syrup', qty: 720, unit: 'gram' }
            ] },
            { name: 'Kabocha Tempura', ingredients: [
                { name: 'Kabocha sliced', qty: 120, unit: 'gram' }, { name: 'Rice flour and corn starch (1:1)', qty: null, unit: '-' },
                { name: 'Salt', qty: null, unit: '-' }, { name: 'Ume creme fraiche', qty: 60, unit: 'gram' }
        ] }] },
        { id: 318, name: 'Kabocha Bingsu', category: 'Dinner', ingredients: [
            { name: 'Kinako mochi', qty: null, unit: '-' }, { name: 'Kabocha cheesecake', qty: null, unit: '-' },
            { name: 'Shaved milk ice', qty: null, unit: '-' }, { name: 'Pumpkin gelato', qty: null, unit: '-' },
            { name: 'Red bean paste', qty: null, unit: '-' }, { name: 'Sable cookies', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 319, name: 'Kabocha Squash Bisque (Dinner)', category: 'Dinner', ingredients: [
            { name: 'Kabocha bisque', qty: 296, unit: 'ml' }, { name: 'Kabocha crisps', qty: 10, unit: 'gram' },
            { name: 'Sage', qty: 1, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 320, name: 'Little Gem Caesar (Dinner)', category: 'Dinner', ingredients: [
            { name: 'Radicchio', qty: 50, unit: 'gram' }, { name: 'Focaccia croutons', qty: 10, unit: 'gram' },
            { name: 'Parmigiano Reggiano', qty: 10, unit: 'gram' }, { name: 'Crispy prosciutto', qty: 10, unit: 'gram' },
            { name: 'Little gem lettuce', qty: 180, unit: 'gram' }, { name: 'Caesar dressing', qty: 60, unit: 'ml' },
            { name: 'Cherry tomato', qty: 15, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 321, name: 'Lobster Cappuccino', category: 'Dinner', ingredients: [
            { name: 'Lobster bisque', qty: 237, unit: 'ml' }, { name: 'Croissant mini', qty: 1, unit: 'ea' },
            { name: 'Creme fraiche espuma', qty: 30, unit: 'ml' }
        ], steps: [], subRecipes: [] },
        { id: 322, name: 'Lobster', category: 'Dinner', ingredients: [], steps: [], subRecipes: [] },
        { id: 323, name: 'Maine Lobster', category: 'Dinner', ingredients: [
            { name: 'Pomme puree', qty: 113, unit: 'gram' }, { name: 'Sake', qty: 30, unit: 'ml' },
            { name: 'Rainbow chard', qty: 100, unit: 'gram' }, { name: 'Lobster', qty: 142, unit: 'gram' },
            { name: 'Butter', qty: 30, unit: 'gram' }, { name: 'Shallot', qty: 10, unit: 'gram' },
            { name: 'Black peppercorn', qty: 1, unit: 'gram' }, { name: 'Lemon', qty: 0.25, unit: 'ea' },
            { name: 'Heavy cream', qty: 30, unit: 'ml' }
        ], steps: [], subRecipes: [] },
        { id: 324, name: 'Matcha Bingsu', category: 'Dinner', ingredients: [
            { name: 'Matcha mochi', qty: null, unit: '-' }, { name: 'Shaved milk ice', qty: null, unit: '-' },
            { name: 'Red bean paste', qty: null, unit: '-' }, { name: 'Green tea ice cream', qty: null, unit: '-' },
            { name: 'Matcha cookies', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 325, name: 'Charred Mediterranean Octopus', category: 'Dinner', ingredients: [], steps: [], subRecipes: [
            { name: 'Brown Buttered Nduja', ingredients: [
                { name: 'Nduja', qty: 60, unit: 'gram' }, { name: 'Brown butter', qty: 10, unit: 'gram' },
                { name: 'Gochujang chili garlic', qty: 100, unit: 'gram' }
            ] },
            { name: 'Sofrito', ingredients: [
                { name: 'Shishito peppers', qty: 10, unit: 'gram' }, { name: 'Butter', qty: 30, unit: 'gram' },
                { name: 'Yellow onion', qty: 30, unit: 'gram' }, { name: 'Red bell pepper', qty: 30, unit: 'gram' },
                { name: 'Yellow or orange bell pepper', qty: 30, unit: 'gram' }, { name: 'Garlic slices', qty: 10, unit: 'gram' },
                { name: 'Marble potatoes', qty: 100, unit: 'gram' }, { name: 'Octopus 6-8 size', qty: 170, unit: 'gram' }
            ], steps: ['Brunoise the bell peppers and onions, thinly slice the garlic, and cut the shishito peppers into thick rounds. Sweat lightly in olive oil until just tender.'] }
        ] },
        { id: 326, name: 'Miyabi Maki', category: 'Dinner', ingredients: [], steps: [], subRecipes: [] },
        { id: 327, name: 'Miyazaki Wagyu Tataki', category: 'Dinner', ingredients: [
            { name: 'Caviar', qty: 10, unit: 'gram' }, { name: 'Pickled shiso relish', qty: 16, unit: 'gram' },
            { name: 'Yuzu shoyu', qty: 60, unit: 'ml' }, { name: 'Chives', qty: 2, unit: 'gram' },
            { name: 'Wagyu A5', qty: 60, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 328, name: 'Moules Frites', category: 'Dinner', ingredients: [
            { name: 'PEI mussels', qty: 900, unit: 'gram' }, { name: 'Chorizo', qty: 100, unit: 'gram' },
            { name: 'Red curry', qty: 150, unit: 'gram' }, { name: 'Shishito pepper', qty: 50, unit: 'gram' },
            { name: 'Thai basil', qty: 10, unit: 'gram' }, { name: 'Potato waffle', qty: 150, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 329, name: 'Ora King Salmon Maki', category: 'Dinner', ingredients: [
            { name: 'Pirikara tuna', qty: 70, unit: 'gram' }, { name: 'Avocado', qty: 0.125, unit: 'ea' },
            { name: 'Smoked paprika aioli', qty: 60, unit: 'ml' }, { name: 'Furikake', qty: 5, unit: 'gram' },
            { name: 'Ora king salmon', qty: 70, unit: 'gram' }, { name: 'Iodized salt', qty: 288, unit: 'gram' },
            { name: 'Flambe alcohol', qty: 75, unit: 'ml' }, { name: 'Sasa no ha (bamboo leaf)', qty: 1, unit: 'ea' }
        ], steps: [], subRecipes: [] },
        { id: 330, name: 'Smoked Paprika Aioli', category: 'Dinner', ingredients: [
            { name: 'Smoked paprika', qty: 80, unit: 'gram' }, { name: 'QP mayonnaise', qty: 1000, unit: 'gram' },
            { name: 'Roasted garlic oil', qty: 300, unit: 'gram' }, { name: 'Sriracha', qty: 80, unit: 'gram' },
            { name: 'Lemon juice', qty: 100, unit: 'gram' }
        ], steps: ['All ingredients incorporated'], subRecipes: [] },
        { id: 331, name: 'Surf & Turf', category: 'Dinner', ingredients: [
            { name: 'Miyazaki wagyu', qty: 85, unit: 'gram' }, { name: 'Alaskan king crab', qty: 85, unit: 'gram' },
            { name: 'Yuzu kosho miso kabocha', qty: 60, unit: 'gram' }, { name: 'Asparagus', qty: 15, unit: 'gram' },
            { name: 'Yuzu kosho', qty: 2, unit: 'gram' }, { name: 'Miso', qty: 5, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 332, name: 'Wagyu Tartare', category: 'Dinner', ingredients: [
            { name: 'Wagyu A5 ribeye cap', qty: 60, unit: 'gram' }, { name: 'Filet mignon', qty: 25, unit: 'gram' },
            { name: 'Shallot brunoised', qty: 8, unit: 'gram' }, { name: 'Asian pear diced', qty: 8, unit: 'gram' },
            { name: 'Chive', qty: 1, unit: 'gram' }, { name: 'Sanbaizu shallot cream', qty: 5, unit: 'gram' },
            { name: 'Tartare sauce', qty: 10, unit: 'gram' }, { name: 'Parsley dust', qty: null, unit: '-' }
        ], steps: [], subRecipes: [
            { name: 'Sanbaizu Shallot Cream', ingredients: [
                { name: 'Shallot', qty: 600, unit: 'gram' }, { name: 'Salt', qty: 6, unit: 'gram' },
                { name: 'Vegetable stock', qty: 200, unit: 'gram' }, { name: 'Sanbaizu', qty: 140, unit: 'gram' }
            ], steps: ['Clean and chop the shallots.', 'Caramelize the chopped shallots with salt, stirring to prevent burning.', 'Add vegetable stock and Sanbaizu. Let liquid evaporate until almost all moisture is gone.', 'Transfer to a blender and blend until smooth.', 'Add a knife tip of Xanthan gum and blend for another minute to prevent liquid leaking when plated.'] },
            { name: 'Egg Yolk Cream', ingredients: [
                { name: 'Egg yolk', qty: 400, unit: 'gram' }, { name: 'Salt', qty: 4, unit: 'gram' }
            ], steps: ['Mix the egg yolks with a whisk, add the salt while mixing.', 'Pass through a fine sieve for smooth texture.', 'Transfer to a vacuum cooking bag, seal, and immerse in 65C water for 1 hour 40 minutes.', 'Transfer bag to cold water and let it cool quickly.'] },
            { name: 'Tartare Sauce', ingredients: [
                { name: 'Worcestershire sauce', qty: 80, unit: 'gram' }, { name: 'Salt', qty: 60, unit: 'gram' },
                { name: 'Black pepper', qty: 20, unit: 'gram' }, { name: 'Extra virgin olive oil', qty: 400, unit: 'gram' }
            ] },
            { name: 'Parsley Emulsion', ingredients: [
                { name: 'Parsley green oil', qty: 270, unit: 'gram' }, { name: 'Egg white', qty: 60, unit: 'gram' },
                { name: 'Apple cider vinegar', qty: 36, unit: 'gram' }, { name: 'Salt', qty: 6, unit: 'gram' },
                { name: 'Ice cube', qty: 60, unit: 'gram' }
            ], steps: ['Put green oil in a blender with egg white, apple vinegar, and salt.', 'Add ice cubes and blend until smooth and perfectly emulsified.', 'Transfer to a piping bag and rest at least 1 hour in the fridge.'] }
        ] },
        { id: 333, name: 'Wagyu Ramen', category: 'Dinner', ingredients: [
            { name: 'Veal broth', qty: 355, unit: 'ml' }, { name: 'Wagyu A5', qty: 70, unit: 'gram' },
            { name: 'Kikurage', qty: 20, unit: 'gram' }, { name: 'Shimeji mushroom', qty: 30, unit: 'gram' },
            { name: 'Sesame', qty: 3, unit: 'gram' }, { name: 'Chili beef ragu (wagyu)', qty: 30, unit: 'gram' },
            { name: 'Scallion oil', qty: 30, unit: 'ml' }, { name: 'Black garlic', qty: 30, unit: 'ml' },
            { name: 'Chives', qty: 3, unit: 'gram' }, { name: 'Menma (bamboo shoot)', qty: 30, unit: 'gram' },
            { name: 'Shitake', qty: 30, unit: 'gram' }, { name: 'Umami chili garlic', qty: 10, unit: 'gram' },
            { name: 'Roasted garlic oil', qty: 30, unit: 'ml' }, { name: 'Ramen', qty: 200, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 334, name: 'Watermelon Carpaccio', category: 'Dinner', ingredients: [
            { name: 'Compressed watermelon', qty: null, unit: '-' }, { name: 'Arugula', qty: null, unit: '-' },
            { name: 'Orange segments', qty: null, unit: '-' }, { name: 'Feta pannacotta', qty: null, unit: '-' },
            { name: 'Olive oil', qty: null, unit: '-' }, { name: 'Candied pistachios', qty: null, unit: '-' },
            { name: 'Balsamic pearl', qty: null, unit: '-' }, { name: 'Mint', qty: null, unit: '-' }
        ], steps: ['Combine orange juice and sugar, vacuum compress with watermelon, keep in bag for 2 hours.', 'Boil water and sugar with pistachios until fully cooked, strain, deep fry at 300F until crispy. Cool and pulse in robot coupe.', 'Place all pannacotta ingredients in Thermomix, 3 minutes at 60C.', 'Transfer to quenelle mold and freeze, 12 minutes to temp.'], subRecipes: [
            { name: 'Compressed Watermelon Marination', ingredients: [
                { name: 'Orange juice', qty: 200, unit: 'gram' }, { name: 'Sugar', qty: 100, unit: 'gram' }
            ] },
            { name: 'Candied Pistachios', ingredients: [
                { name: 'Pistachio', qty: 200, unit: 'gram' }, { name: 'Water', qty: 100, unit: 'gram' },
                { name: 'Sugar', qty: 100, unit: 'gram' }
            ] },
            { name: 'Feta Cheese Pannacotta', ingredients: [
                { name: 'Feta cheese', qty: 400, unit: 'gram' }, { name: 'Heavy cream', qty: 200, unit: 'gram' }
        ] }] },
        { id: 335, name: 'Wok Fried Filet Mignon & Chicken', category: 'Dinner', ingredients: [
            { name: 'Stir fried sauce', qty: 118, unit: 'ml' }, { name: 'Lemongrass rice', qty: 200, unit: 'gram' },
            { name: 'Filet mignon', qty: 170, unit: 'gram' }, { name: 'Chicken', qty: 198, unit: 'gram' },
            { name: 'Baby bokchoy', qty: 50, unit: 'gram' }, { name: 'Asparagus', qty: 20, unit: 'gram' },
            { name: 'Snow peas', qty: 20, unit: 'gram' }, { name: 'Yellow onion', qty: 30, unit: 'gram' },
            { name: 'Red bell pepper', qty: 30, unit: 'gram' }, { name: 'Yellow bell pepper', qty: 30, unit: 'gram' },
            { name: 'Ginger', qty: 10, unit: 'gram' }, { name: 'Garlic', qty: 10, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 336, name: 'Yuzu Den Miso (Caramelized Miso)', category: 'Dinner', ingredients: [], steps: ['Combine the liquid and sugar, then add miso and mix until well incorporated.', 'Cook in a bain-marie for approximately 4 hours, until the color turns golden brown.', 'Once cooled, mix the miso with yuzu juice until fully incorporated.'], subRecipes: [
            { name: 'Den Miso', ingredients: [
                { name: 'White miso', qty: 1500, unit: 'gram' }, { name: 'Sugar', qty: 1100, unit: 'gram' },
                { name: 'Sake', qty: 400, unit: 'ml' }, { name: 'Mirin', qty: 400, unit: 'ml' }
            ] },
            { name: 'Yuzu Miso', ingredients: [
                { name: 'Den miso', qty: 1000, unit: 'gram' }, { name: 'Yuzu', qty: 100, unit: 'gram' }
        ] }] },
        { id: 337, name: 'Yuzu Kosho Miso', category: 'Dinner', ingredients: [
            { name: 'Yuzu Kosho', qty: 80, unit: 'gram' }, { name: 'Den Miso', qty: 300, unit: 'gram' },
            { name: 'Maple syrup', qty: 100, unit: 'gram' }
        ], steps: ['Mix the den miso with yuzu kosho and maple syrup until fully incorporated'], subRecipes: [] },
        { id: 338, name: 'Butcher\'s Cut of the Day', category: 'Dinner', ingredients: [
            { name: 'Potato pave', qty: 113, unit: 'gram' }, { name: 'Broccoli', qty: 113, unit: 'gram' },
            { name: 'Demi-glace', qty: 60, unit: 'ml' }, { name: 'Cut steak', qty: 10, unit: 'oz' }
        ], steps: [], subRecipes: [] },
        // ── Lunch (Amber Bar) ──
        { id: 100, name: 'Ajitsuke Tamago (Ramen Egg)', category: 'Lunch', ingredients: [
            { name: 'Large eggs', qty: 30, unit: 'ea' }, { name: 'GF soy sauce', qty: 1, unit: 'qt' },
            { name: 'Mirin', qty: 1, unit: 'qt' }, { name: 'Sake', qty: 2, unit: 'cup' },
            { name: 'Water', qty: 4, unit: 'qt' }, { name: 'Kawami dashi', qty: 1, unit: 'pk' }
        ], steps: [], subRecipes: [] },
        { id: 101, name: 'Amber Burger', category: 'Lunch', ingredients: [], steps: [], subRecipes: [] },
        { id: 102, name: 'Angus Cheek Spring Roll', category: 'Lunch', ingredients: [
            { name: 'Braised angus cheek', qty: 4, unit: 'kg' }, { name: 'Mungbean noodles', qty: 500, unit: 'gram' },
            { name: 'Tamari', qty: 250, unit: 'ml' }, { name: 'Black pepper ground', qty: 8, unit: 'gram' },
            { name: 'Garlic clove chopped', qty: 300, unit: 'gram' }, { name: 'Shiitake mushroom', qty: 1, unit: 'kg' },
            { name: 'Green cabbage', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 103, name: 'Artichoke Fritti', category: 'Lunch', ingredients: [
            { name: 'Artichoke halves', qty: 4, unit: 'ea' }, { name: 'Cornstarch and rice flour mix (1:1)', qty: null, unit: '-' },
            { name: 'Romesco salsa', qty: 2.5, unit: 'oz' }, { name: 'Salsa verde', qty: 2.5, unit: 'oz' },
            { name: 'Pecorino cheese', qty: null, unit: '-' }, { name: 'Lemon wedge', qty: 1, unit: 'ea' }
        ], steps: ['Cut artichokes in half. Pat dry to remove excess moisture.', 'Dredge artichoke halves in starch mix and fry.'], subRecipes: [] },
        { id: 104, name: 'Basil-Citrus Vinaigrette', category: 'Lunch', ingredients: [
            { name: 'Fresh basil leaves', qty: 115, unit: 'gram' }, { name: 'Dijon mustard', qty: 50, unit: 'gram' },
            { name: 'EVOO', qty: 150, unit: 'gram' }, { name: 'Orange juice', qty: 185, unit: 'gram' },
            { name: 'Lime juice', qty: 108, unit: 'gram' }, { name: 'Salt', qty: 1.5, unit: 'tbsp' }
        ], steps: [], subRecipes: [] },
        { id: 105, name: 'BBQ Brisket', category: 'Lunch', ingredients: [
            { name: 'Cold Water', qty: 8, unit: 'kg' }, { name: 'Kosher Salt', qty: 240, unit: 'gram' },
            { name: 'Brown Sugar', qty: 160, unit: 'gram' }, { name: 'Liquid Smoke', qty: 120, unit: 'gram' }
        ], steps: [], subRecipes: [{ name: 'The Glaze', ingredients: [
            { name: 'Molasses', qty: 240, unit: 'gram' }, { name: 'Liquid Smoke', qty: 120, unit: 'gram' },
            { name: 'GF Soy Sauce', qty: null, unit: '-' }
        ]}] },
        { id: 106, name: 'Black Bean Burger', category: 'Lunch', ingredients: [
            { name: 'Black bean patty', qty: 1510, unit: 'gram' }, { name: 'Hydrated shiitake mushroom', qty: 1450, unit: 'gram' }
        ], steps: ['Shiitake mushroom fine chop in the robocoupe', 'Combine with black bean patty to make a dough'], subRecipes: [] },
        { id: 107, name: 'Caprese Burrata', category: 'Lunch', ingredients: [
            { name: 'Yuzu', qty: 500, unit: 'gram' }, { name: 'Simple syrup', qty: 830, unit: 'gram' },
            { name: 'Sugar', qty: 1, unit: 'pint' }, { name: 'Rice vinegar', qty: 3, unit: 'cup' },
            { name: 'Ginger', qty: 15, unit: 'gram' }, { name: 'Thai chili', qty: 2, unit: 'ea' }
        ], steps: [], subRecipes: [] },
        { id: 108, name: 'Charcuterie', category: 'Lunch', ingredients: [
            { name: 'Italian salami', qty: null, unit: '-' }, { name: 'Hot sopressata', qty: 12.5, unit: 'gram' },
            { name: 'Dry salami', qty: null, unit: '-' }, { name: 'Prosciutto', qty: null, unit: '-' },
            { name: 'Pecorino romano', qty: null, unit: '-' }, { name: 'White cheddar', qty: null, unit: '-' },
            { name: 'Brie cheese', qty: 40, unit: 'gram' }, { name: 'Apricot jam', qty: 30, unit: 'gram' },
            { name: 'Olives', qty: 11, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 109, name: 'Chicken Broth', category: 'Lunch', ingredients: [
            { name: 'Yellow onion', qty: 7266, unit: 'gram' }, { name: 'Leek white part', qty: 2031, unit: 'gram' },
            { name: 'Ginger', qty: 1160, unit: 'gram' }, { name: 'Daikon radish', qty: 2832, unit: 'gram' },
            { name: 'Bay leaf', qty: 5, unit: 'gram' }, { name: 'Pepper corn', qty: 100, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 110, name: 'Chicken Chashu Ramen', category: 'Lunch', ingredients: [
            { name: 'Creamy chicken ramen base', qty: 2250, unit: 'ml' }, { name: 'Chicken broth', qty: 18, unit: 'liter' },
            { name: 'Kawami Dashi', qty: 2, unit: 'bag' }, { name: 'Sous vide chicken breast', qty: 15, unit: 'portion' },
            { name: '60 days corn', qty: null, unit: '-' }, { name: 'Beech mushroom', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 111, name: 'Classic Hummus', category: 'Lunch', ingredients: [], steps: [], subRecipes: [] },
        { id: 112, name: 'Crudites', category: 'Lunch', ingredients: [
            { name: 'Hummus', qty: null, unit: '-' }, { name: 'Tzatziki', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 113, name: 'Galbi Sauce', category: 'Lunch', ingredients: [
            { name: 'Ginger', qty: 113, unit: 'gram' }, { name: 'Garlic', qty: 113, unit: 'gram' },
            { name: 'Tamari', qty: 1150, unit: 'ml' }, { name: 'Corn syrup', qty: 2200, unit: 'ml' },
            { name: 'Sugar', qty: 100, unit: 'gram' }, { name: 'Black pepper ground', qty: 6, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 114, name: 'Heirloom Carrot Bisque', category: 'Lunch', ingredients: [
            { name: 'Jumbo Carrots', qty: 1800, unit: 'gram' }, { name: 'Vegetable stock', qty: 5, unit: 'qt' },
            { name: 'Kabocha Squash', qty: 1400, unit: 'gram' }, { name: 'Coconut milk', qty: 3.5, unit: 'qt' },
            { name: 'Kosher Salt', qty: 40, unit: 'gram' }, { name: 'Lemongrass', qty: 150, unit: 'gram' },
            { name: 'Ginger', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 115, name: 'Hoisin Bao Sauce', category: 'Lunch', ingredients: [
            { name: 'Hoisin sauce', qty: 1600, unit: 'gram' }, { name: 'Molasses', qty: 500, unit: 'gram' },
            { name: 'Tamari Soy sauce', qty: 400, unit: 'gram' }, { name: 'Worcestershire', qty: 50, unit: 'gram' },
            { name: 'Shio Koji', qty: 50, unit: 'gram' }, { name: 'Balsamic di Modena', qty: 50, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 116, name: 'Kabocha Squash Bisque', category: 'Lunch', ingredients: [
            { name: 'Kabocha squash', qty: 3000, unit: 'gram' }, { name: 'Butternut squash', qty: 2000, unit: 'gram' },
            { name: 'Yellow onions', qty: 1000, unit: 'gram' }, { name: 'Garlic minced', qty: 50, unit: 'gram' },
            { name: 'Fresh ginger minced', qty: 25, unit: 'gram' }, { name: 'Carrots', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 117, name: 'Katsu Sando', category: 'Lunch', ingredients: [
            { name: 'Pork loin', qty: 10, unit: 'lb' }, { name: 'Creamy shio koji', qty: null, unit: '10% of meat weight' },
            { name: 'Bay leaf', qty: 1, unit: 'ea' }, { name: 'Black peppercorn', qty: 10, unit: 'piece' },
            { name: 'EVOO', qty: 4, unit: 'fl.oz' }
        ], steps: ['After trimming, marinate the meat in creamy shio koji for 6 hours.'], subRecipes: [] },
        { id: 118, name: 'Kimchi Aioli', category: 'Lunch', ingredients: [
            { name: 'Kimchi no moto', qty: 35, unit: 'gram' }, { name: 'Heavy mayonnaise', qty: 200, unit: 'gram' }
        ], steps: ['Mix all listed ingredients together thoroughly until fully incorporated.'], subRecipes: [] },
        { id: 119, name: 'Kimchi Panini', category: 'Lunch', ingredients: [
            { name: 'Sourdough', qty: 2, unit: 'piece' }, { name: 'Kimchi', qty: null, unit: '-' },
            { name: 'Gochujang butter', qty: null, unit: '-' }, { name: 'Kimchi aioli', qty: null, unit: '-' },
            { name: 'Galbi short rib', qty: null, unit: '-' }, { name: 'Galbi sauce', qty: null, unit: '-' }
        ], steps: ['Soak short ribs under running cold water for about 3 hours until water runs clear.', 'Marinate in galbi sauce.'], subRecipes: [] },
        { id: 120, name: 'Kimchi', category: 'Lunch', ingredients: [
            { name: 'Napa cabbage', qty: 14, unit: 'ea' }, { name: 'Kosher salt', qty: 4032, unit: 'gram' },
            { name: 'Water', qty: 15200, unit: 'ml' }, { name: 'Rice flour', qty: 100, unit: 'gram' },
            { name: 'Gochugaru (coarse)', qty: 680, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 121, name: 'Lemongrass Rice', category: 'Lunch', ingredients: [
            { name: 'Lemongrass white part', qty: 2, unit: 'ea' }, { name: 'Cilantro', qty: 3, unit: 'cup' },
            { name: 'Chive', qty: 3, unit: 'cup' }, { name: 'Italian parsley', qty: 3, unit: 'cup' },
            { name: 'Water', qty: 1, unit: 'cup' }, { name: 'Jasmin steamed rice', qty: 6600, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 122, name: 'Little Gem Caesar', category: 'Lunch', ingredients: [], steps: [], subRecipes: [] },
        { id: 123, name: 'Pickled Cabbage', category: 'Lunch', ingredients: [
            { name: 'Water', qty: 3, unit: 'cup' }, { name: 'Rice Vinegar', qty: 3, unit: 'cup' },
            { name: 'Sugar', qty: 2, unit: 'oz' }, { name: 'Black peppercorn', qty: 1, unit: 'tbsp' },
            { name: 'Coriander seed', qty: 1.5, unit: 'tbsp' }, { name: 'Salt', qty: null, unit: '-' },
            { name: 'Red Cabbage', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 124, name: 'Pickled Cherry Tomato', category: 'Lunch', ingredients: [
            { name: 'Rice vinegar', qty: 212, unit: 'gram' }, { name: 'Water', qty: 250, unit: 'gram' },
            { name: 'Sugar', qty: 65, unit: 'gram' }, { name: 'Black pepper corn', qty: 5, unit: 'gram' },
            { name: 'Rosemary', qty: 10, unit: 'gram' }, { name: 'Salt', qty: 6, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 125, name: 'Pickled Fresno Pepper', category: 'Lunch', ingredients: [
            { name: 'Water', qty: 400, unit: 'gram' }, { name: 'White Vinegar', qty: 400, unit: 'gram' },
            { name: 'Sugar', qty: 80, unit: 'gram' }, { name: 'Kosher Salt', qty: 20, unit: 'gram' },
            { name: 'Black Peppercorn', qty: 4, unit: 'gram' }, { name: 'Fresno pepper', qty: 300, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 126, name: 'Pickled Sweet Pepper', category: 'Lunch', ingredients: [
            { name: 'Water', qty: 400, unit: 'gram' }, { name: 'White Vinegar', qty: 400, unit: 'gram' },
            { name: 'Sugar', qty: 80, unit: 'gram' }, { name: 'Kosher Salt', qty: 20, unit: 'gram' },
            { name: 'Black Peppercorn', qty: 4, unit: 'gram' }, { name: 'Mini sweet pepper', qty: 300, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 127, name: 'Pickled Red Chili Sauce', category: 'Lunch', ingredients: [
            { name: 'Mae ploy', qty: 500, unit: 'ml' }, { name: 'Honey', qty: 250, unit: 'ml' },
            { name: 'Fish sauce', qty: 50, unit: 'ml' }, { name: 'Tamari', qty: 50, unit: 'ml' },
            { name: 'Sesame oil', qty: 25, unit: 'ml' }, { name: 'Sesame seeds (black and white)', qty: 1, unit: 'cup' }
        ], steps: [], subRecipes: [] },
        { id: 128, name: 'Romesco Salsa', category: 'Lunch', ingredients: [
            { name: 'Fresno pepper', qty: 200, unit: 'gram' }, { name: 'Garlic', qty: 240, unit: 'gram' },
            { name: 'Chipotle', qty: 66, unit: 'gram' }, { name: 'Fire roasted tomato', qty: 1, unit: 'can' },
            { name: 'Grilled Red bell pepper', qty: 1000, unit: 'gram' }, { name: 'Yellow onion', qty: 400, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 129, name: 'Salsa Verde', category: 'Lunch', ingredients: [
            { name: 'Cilantro', qty: 350, unit: 'gram' }, { name: 'Italian parsley', qty: 350, unit: 'gram' },
            { name: 'Garlic', qty: 175, unit: 'gram' }, { name: 'Serrano pepper', qty: 100, unit: 'gram' },
            { name: 'Anchovy', qty: 120, unit: 'gram' }, { name: 'Caper', qty: 150, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 130, name: 'Shio Tare', category: 'Lunch', ingredients: [
            { name: 'Mirin', qty: 1500, unit: 'gram' }, { name: 'Sake', qty: 1000, unit: 'gram' },
            { name: 'White wine', qty: 500, unit: 'gram' }, { name: 'White shoyu', qty: 1500, unit: 'gram' },
            { name: 'Kosher Salt', qty: 200, unit: 'gram' }, { name: 'Chicken base', qty: 50, unit: 'gram' },
            { name: 'Kawami Dashi', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 131, name: 'Stir-Fry Sauce', category: 'Lunch', ingredients: [
            { name: 'Mirin', qty: 70, unit: 'gram' }, { name: 'Sake', qty: 160, unit: 'gram' },
            { name: 'Shio koji', qty: 85, unit: 'gram' }, { name: 'Hoisin', qty: 200, unit: 'gram' },
            { name: 'Black vinegar', qty: 80, unit: 'gram' }, { name: 'Sesame oil', qty: 50, unit: 'gram' },
            { name: 'Fish sauce', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 132, name: 'Poke Sauce', category: 'Lunch', ingredients: [
            { name: 'GF Soy Sauce', qty: 1, unit: 'qt' }, { name: 'Mirin', qty: 2, unit: 'cup' },
            { name: 'Sesame oil', qty: 1, unit: 'cup' }, { name: 'Wasabi powder', qty: 5, unit: 'tbsp' },
            { name: 'Garlic clove', qty: 180, unit: 'gram' }, { name: 'Onion saute cut', qty: null, unit: '-' }
        ], steps: [], subRecipes: [] },
        { id: 133, name: 'Tzatziki', category: 'Lunch', ingredients: [
            { name: 'Greek yogurt', qty: 500, unit: 'gram' }, { name: 'Cucumber brunoise', qty: 0.5, unit: 'ea' },
            { name: 'Garlic mince', qty: 2, unit: 'clove' }, { name: 'Extra virgin olive oil', qty: 1.5, unit: 'fl.oz' },
            { name: 'Fresh lemon juice', qty: 1, unit: 'fl.oz' }, { name: 'Fresh dill mince', qty: 1, unit: 'tbsp' }
        ], steps: [], subRecipes: [] },
        { id: 134, name: 'Veal Ramen Broth', category: 'Lunch', ingredients: [
            { name: 'Veal bone', qty: 50, unit: 'lb' }, { name: 'Water', qty: 35, unit: 'gal' },
            { name: 'Yellow Onion', qty: 7, unit: 'kg' }, { name: 'Daikon Radish', qty: 3, unit: 'kg' },
            { name: 'Peeled garlic', qty: 2.4, unit: 'kg' }, { name: 'Ginger', qty: 1.5, unit: 'kg' }
        ], steps: [], subRecipes: [] },
        { id: 135, name: 'Wagyu Brisket Bao', category: 'Lunch', ingredients: [
            { name: 'Bao steamed', qty: 2, unit: 'ea' }, { name: 'BBQ brisket', qty: 4, unit: 'oz' },
            { name: 'Pickled Cabbage', qty: 1, unit: 'oz' }, { name: 'Hoisin bao sauce', qty: 1, unit: 'tbsp' },
            { name: 'Salted Cucumber', qty: 4, unit: 'slice' }, { name: 'Pickled sweet pepper', qty: 4, unit: 'slice' }
        ], steps: [], subRecipes: [] },
        { id: 136, name: 'Yuzu Aioli', category: 'Lunch', ingredients: [
            { name: 'Yuzu', qty: 20, unit: 'gram' }, { name: 'Vegan mayonnaise', qty: 200, unit: 'gram' },
            { name: 'Lemon zest', qty: 3, unit: 'ea' }, { name: 'Salt', qty: 0.5, unit: 'tsp' }
        ], steps: [], subRecipes: [] },
        // ── Sushi ──
        { id: 200, name: 'California Maki', category: 'Sushi', ingredients: [
            { name: 'Sushi rice', qty: 113.4, unit: 'gram' }, { name: 'Nori', qty: 0.5, unit: 'sheet' },
            { name: 'Sesame seeds', qty: 1, unit: 'gram' }, { name: 'King crab mix', qty: 70, unit: 'gram' },
            { name: 'Avocado', qty: 68, unit: 'gram' }, { name: 'Orange tobiko', qty: 28, unit: 'gram' },
            { name: 'Sushi ginger', qty: 3, unit: 'gram' }, { name: 'Wasabi', qty: 4, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 201, name: 'Hamachi Crudo', category: 'Sushi', ingredients: [
            { name: 'Hamachi (Yellowtail) sashimi-grade', qty: 85, unit: 'gram' }, { name: 'Fresh serrano thin rounds', qty: 6, unit: 'slices' },
            { name: 'Micro cilantro', qty: null, unit: '-' }, { name: 'Yuzu shoyu', qty: 2, unit: 'tbsp' },
            { name: 'Sriracha', qty: 6, unit: 'drop' }
        ], steps: ['Slice hamachi into thin sashimi-style pieces.', 'Arrange slices on a chilled plate.', 'Place one serrano slice on each piece.', 'Dot each slice with a drop of sriracha.', 'Pour yuzu shoyu evenly over the plate.', 'Finish with micro cilantro.'], subRecipes: [] },
        { id: 202, name: 'House Shoyu', category: 'Sushi', ingredients: [
            { name: 'Tamari soy sauce', qty: 9981, unit: 'gram' }, { name: 'Suiji Mirin', qty: 180, unit: 'gram' },
            { name: 'Nikiri sake', qty: 3327, unit: 'gram' }, { name: 'Kombu', qty: 150, unit: 'gram' }
        ], steps: ['Place nikiri sake and kombu in a pot, heat gently.', 'Heat no more than 60-70C and remove from heat.', 'Add tamari and mirin.', 'To make nikiri sake: set sake in a pot, heat and ignite briefly. After burning alcohol, turn off.'], subRecipes: [] },
        { id: 203, name: 'Ise Ebi Mix', category: 'Sushi', ingredients: [
            { name: 'Lobster meat shredded', qty: 200, unit: 'gram' }, { name: 'Creme fraiche', qty: 80, unit: 'gram' }
        ], steps: ['Combine all ingredients and mix.'], subRecipes: [] },
        { id: 204, name: 'Ise Ebi Tempura Roll', category: 'Sushi', ingredients: [
            { name: 'Sushi rice', qty: 113.4, unit: 'gram' }, { name: 'Nori', qty: 0.5, unit: 'sheet' },
            { name: 'Sesame seeds', qty: 1, unit: 'gram' }, { name: 'Lobster mix', qty: 113.4, unit: 'gram' },
            { name: 'Sea bass tempura', qty: 40, unit: 'gram' }, { name: 'Sun dried tomato pesto', qty: 5, unit: 'gram' },
            { name: 'Chive', qty: 0.5, unit: 'gram' }, { name: 'Sweet shoyu (ABC soy)', qty: 5, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 205, name: 'Kimchi Aioli (Sushi)', category: 'Sushi', ingredients: [
            { name: 'Kimchi no moto', qty: 160, unit: 'gram' }, { name: 'Vegan heavy mayonnaise', qty: 800, unit: 'gram' }
        ], steps: ['Mix all ingredients together thoroughly until fully incorporated.'], subRecipes: [] },
        { id: 206, name: 'King Crab Mix', category: 'Sushi', ingredients: [
            { name: 'King crab', qty: 200, unit: 'gram' }, { name: 'QP Mayonnaise', qty: 30, unit: 'gram' }
        ], steps: ['Combine all ingredients and mix.'], subRecipes: [] },
        { id: 207, name: 'Nikiri Shoyu', category: 'Sushi', ingredients: [
            { name: 'Tamari soy sauce', qty: 1093, unit: 'gram' }, { name: 'Mirin', qty: 1093, unit: 'gram' },
            { name: 'Sake', qty: 160, unit: 'ml' }, { name: 'Mushroom kombu powder', qty: 10, unit: 'gram' },
            { name: 'Shiro dashi', qty: 250, unit: 'gram' }
        ], steps: ['Place all ingredients in pot, heat gently.', 'Bring to a slight simmer over medium heat.', 'Turn down to low, evaporate 15-20 minutes.', 'Nikiri should be thickened but fluid, coating back of a spoon.', 'Fine strain.'], subRecipes: [] },
        { id: 208, name: 'Pirikara Maguro Maki', category: 'Sushi', ingredients: [
            { name: 'Sushi rice', qty: 113.4, unit: 'gram' }, { name: 'Nori', qty: 0.5, unit: 'sheet' },
            { name: 'Sesame seeds', qty: 1, unit: 'gram' }, { name: 'Spicy tuna mix', qty: 70, unit: 'gram' },
            { name: 'Serrano julienned', qty: 20, unit: 'gram' }, { name: 'Takuan', qty: 30, unit: 'gram' },
            { name: 'Yuzu tobiko', qty: 28, unit: 'gram' }, { name: 'Sushi ginger', qty: 3, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 209, name: 'Pirikara Sauce', category: 'Sushi', ingredients: [
            { name: 'Sriracha', qty: 1010, unit: 'gram' }, { name: 'Sesame oil', qty: 200, unit: 'gram' },
            { name: 'Togarashi', qty: 35, unit: 'gram' }, { name: 'Kimchi no moto', qty: 150, unit: 'gram' },
            { name: 'Vegan heavy-duty mayonnaise', qty: 500, unit: 'gram' }, { name: 'Corn syrup', qty: 350, unit: 'gram' },
            { name: 'Yuzukosho', qty: 100, unit: 'gram' }
        ], steps: ['Combine all ingredients and mix thoroughly until fully incorporated.'], subRecipes: [] },
        { id: 210, name: 'Pirikara Tuna Mix', category: 'Sushi', ingredients: [
            { name: 'Tuna scraped', qty: 200, unit: 'gram' }, { name: 'Pirikara sauce', qty: 30, unit: 'gram' },
            { name: 'Green onion chop', qty: 15, unit: 'gram' }
        ], steps: ['Combine all ingredients and mix.'], subRecipes: [] },
        { id: 211, name: 'Salmon Tartare Crispy Rice', category: 'Sushi', ingredients: [
            { name: 'Sushi rice (pressed and fried)', qty: 180, unit: 'gram' }, { name: 'Salmon finely diced', qty: 60, unit: 'gram' },
            { name: 'Kimchi aioli', qty: 3, unit: 'gram' }, { name: 'Ikura', qty: 1, unit: 'gram' },
            { name: 'Micro herb', qty: null, unit: '-' }
        ], steps: ['Press rice into mold, batter with rice flour.', 'Fry at 325F until golden and crispy. Drain and cool.', 'Cut into 6 bite-sized pieces.', 'Dice fresh salmon, season with kimchi aioli and yuzu kosho.', 'Keep in pastry piping bag. Assemble.'], subRecipes: [] },
        { id: 212, name: 'Salmon Tartare Mix', category: 'Sushi', ingredients: [
            { name: 'Salmon fine dices', qty: 400, unit: 'gram' }, { name: 'Kimchi aioli', qty: 80, unit: 'gram' },
            { name: 'Yuzu kosho', qty: 40, unit: 'gram' }
        ], steps: ['Combine all ingredients and mix.'], subRecipes: [] },
        { id: 213, name: 'Shari Zu', category: 'Sushi', ingredients: [
            { name: 'Rice vinegar', qty: 10, unit: 'liter' }, { name: 'Sugar', qty: 6736, unit: 'gram' },
            { name: 'Salt', qty: 1996, unit: 'gram' }, { name: 'Mirin', qty: 625, unit: 'ml' },
            { name: 'Kombu', qty: 200, unit: 'gram' }
        ], steps: ['Place vinegar (except 5L) and kombu in large pot, heat gently.', 'Add salt first, then sugar.', 'Heat no more than 60-70C to dissolve, stir constantly.', 'Remove to ice bath and cool, add remaining vinegar.'], subRecipes: [] },
        { id: 214, name: 'Sundried Tomato Pesto', category: 'Sushi', ingredients: [
            { name: 'Sun dried tomatoes', qty: 800, unit: 'gram' }, { name: 'Garlic confit', qty: 50, unit: 'gram' },
            { name: 'Basil', qty: 40, unit: 'gram' }, { name: 'Sun dried tomato oil', qty: 750, unit: 'gram' }
        ], steps: [], subRecipes: [{ name: 'Garlic Confit', ingredients: [
            { name: 'Garlic cloves', qty: 272, unit: 'gram' }, { name: 'Blended oil', qty: 384, unit: 'gram' },
            { name: 'Fresh thyme sprigs', qty: 2, unit: 'ea' }
        ]}] },
        { id: 215, name: 'Sushi Rice (Shari)', category: 'Sushi', ingredients: [
            { name: 'Nishiki rice', qty: 2700, unit: 'gram' }, { name: 'Water', qty: 2650, unit: 'gram' },
            { name: 'Shari Zu', qty: 876, unit: 'gram' }
        ], steps: ['Wash rice thoroughly and strain 5 times.', 'Strain completely.', 'Transfer to rice cooker, add water per recipe.', 'Cook, then rest 40 minutes before mixing with Shari Zu.'], subRecipes: [] },
        { id: 216, name: 'Temaki Trio', category: 'Sushi', ingredients: [
            { name: 'Ahi tuna', qty: 12.5, unit: 'gram' }, { name: 'Takuan', qty: 5, unit: 'gram' },
            { name: 'Nikiri shoyu', qty: 1, unit: 'gram' }, { name: 'Sushi rice', qty: 12.5, unit: 'gram' }
        ], steps: [], subRecipes: [] },
        { id: 217, name: 'Tempura Flour Mix', category: 'Sushi', ingredients: [
            { name: 'Rice flour', qty: 3, unit: 'cup' }, { name: 'AP flour', qty: 1, unit: 'cup' }
        ], steps: ['Combine all ingredients and mix thoroughly.'], subRecipes: [] },
        { id: 218, name: 'Wasabi', category: 'Sushi', ingredients: [
            { name: 'Wasabi powder', qty: 250, unit: 'gram' }, { name: 'Distilled water', qty: 320, unit: 'gram' }
        ], steps: ['Mix in a small bowl until a smooth paste forms.', 'Rest 5 minutes uncovered to develop flavor.', 'Cover with plastic wrap or store in airtight container.'], subRecipes: [] },
        { id: 219, name: 'Yuzu Kosho Aioli', category: 'Sushi', ingredients: [
            { name: 'Yuzu kosho', qty: 150, unit: 'gram' }, { name: 'Vegan mayonnaise', qty: 920, unit: 'gram' }
        ], steps: ['Finely blend yuzu kosho until smooth.', 'Combine with mayonnaise and mix thoroughly.'], subRecipes: [] },
        { id: 220, name: 'Yuzu Shoyu', category: 'Sushi', ingredients: [
            { name: 'Yuzu juice', qty: 420, unit: 'gram' }, { name: 'Tamari soy sauce', qty: 824, unit: 'gram' },
            { name: 'Mirin', qty: 83, unit: 'gram' }
        ], steps: ['Mix all ingredients together thoroughly.'], subRecipes: [] }
    ];
}

function nextRecipeId() {
    return recipes.reduce(function(mx, r) { return Math.max(mx, r.id || 0); }, 0) + 1;
}

// ── Recipe V2 (Visual Document Viewer with IndexedDB) ──

function openRecipeDB() {
    return new Promise(function(resolve, reject) {
        var req = indexedDB.open('aqueous_recipes_v2', 1);
        req.onupgradeneeded = function() {
            var db = req.result;
            if (!db.objectStoreNames.contains('recipeFiles')) db.createObjectStore('recipeFiles', { keyPath: 'id' });
        };
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
    });
}

function saveRecipeFile(id, pages, rawPdf) {
    return openRecipeDB().then(function(db) {
        var tx = db.transaction('recipeFiles', 'readwrite');
        tx.objectStore('recipeFiles').put({ id: id, pages: pages, rawPdf: rawPdf || null });
        return new Promise(function(resolve) { tx.oncomplete = resolve; });
    });
}

function loadRecipeFileById(id) {
    return openRecipeDB().then(function(db) {
        var tx = db.transaction('recipeFiles', 'readonly');
        var req = tx.objectStore('recipeFiles').get(id);
        return new Promise(function(resolve) { req.onsuccess = function() { resolve(req.result); }; });
    });
}

function deleteRecipeFile(id) {
    return openRecipeDB().then(function(db) {
        var tx = db.transaction('recipeFiles', 'readwrite');
        tx.objectStore('recipeFiles').delete(id);
        return new Promise(function(resolve) { tx.oncomplete = resolve; });
    });
}

function loadRecipesV2() {
    var saved = localStorage.getItem('aq_recipes_v2');
    recipesV2 = saved ? JSON.parse(saved) : [];
}

function saveRecipesV2() {
    localStorage.setItem('aq_recipes_v2', JSON.stringify(recipesV2));
}

function migrateRecipesMetadata() {
    if (recipesV2.length > 0) return; // already migrated
    var old = JSON.parse(localStorage.getItem('aqueous_recipes') || '[]');
    if (old.length === 0) {
        // No old recipes - load defaults
        old = getDefaultRecipes();
    }
    old.forEach(function(r) {
        recipesV2.push({
            id: 'legacy_' + r.id,
            name: r.name,
            category: r.category || 'Dinner',
            type: 'migrated',
            pageCount: 1,
            dateAdded: Date.now(),
            migrated: false
        });
    });
    saveRecipesV2();
}

function buildRecipeHtml(recipe) {
    var html = '<div style="width:380px;padding:24px 20px;background:#fff;font-family:Inter,system-ui,sans-serif;color:#1a1a1a;line-height:1.5;">';
    html += '<h2 style="font-size:20px;font-weight:800;margin:0 0 4px;color:#1a1a1a;">' + recipe.name + '</h2>';
    html += '<div style="font-size:12px;font-weight:600;color:#e8813a;margin-bottom:16px;">' + (recipe.category || 'Dinner') + '</div>';
    if (recipe.ingredients && recipe.ingredients.length > 0) {
        html += '<h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin:0 0 8px;">Ingredients</h3>';
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">';
        recipe.ingredients.forEach(function(ing) {
            html += '<tr style="border-bottom:1px solid #f0f0f0;">';
            html += '<td style="padding:5px 0;font-size:13px;font-weight:600;">' + ing.name + '</td>';
            html += '<td style="padding:5px 8px;font-size:13px;font-weight:700;text-align:right;width:60px;">' + (ing.qty != null ? ing.qty : '') + '</td>';
            html += '<td style="padding:5px 0;font-size:12px;color:#888;text-align:right;width:50px;">' + (ing.unit && ing.unit !== '-' ? ing.unit : '') + '</td>';
            html += '</tr>';
        });
        html += '</table>';
    }
    if (recipe.steps && recipe.steps.length > 0) {
        html += '<h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin:0 0 8px;">Preparation</h3>';
        html += '<ol style="padding-left:20px;margin:0 0 16px;">';
        recipe.steps.forEach(function(s) { html += '<li style="font-size:13px;margin-bottom:6px;">' + s + '</li>'; });
        html += '</ol>';
    }
    if (recipe.subRecipes && recipe.subRecipes.length > 0) {
        recipe.subRecipes.forEach(function(sub) {
            html += '<div style="margin-top:12px;padding:12px;background:#fafafa;border-radius:8px;border-left:3px solid #e8813a;">';
            html += '<h4 style="font-size:14px;font-weight:700;margin:0 0 8px;color:#e8813a;">' + sub.name + '</h4>';
            if (sub.ingredients && sub.ingredients.length > 0) {
                html += '<table style="width:100%;border-collapse:collapse;">';
                sub.ingredients.forEach(function(ing) {
                    html += '<tr style="border-bottom:1px solid #eee;">';
                    html += '<td style="padding:4px 0;font-size:12px;font-weight:600;">' + ing.name + '</td>';
                    html += '<td style="padding:4px 8px;font-size:12px;font-weight:700;text-align:right;width:50px;">' + (ing.qty != null ? ing.qty : '') + '</td>';
                    html += '<td style="padding:4px 0;font-size:11px;color:#888;text-align:right;width:45px;">' + (ing.unit && ing.unit !== '-' ? ing.unit : '') + '</td>';
                    html += '</tr>';
                });
                html += '</table>';
            }
            if (sub.steps && sub.steps.length > 0) {
                html += '<ol style="padding-left:18px;margin:8px 0 0;">';
                sub.steps.forEach(function(s) { html += '<li style="font-size:12px;margin-bottom:4px;">' + s + '</li>'; });
                html += '</ol>';
            }
            html += '</div>';
        });
    }
    html += '</div>';
    return html;
}

function migrateRecipeToImage(recipeV2Entry) {
    var legacyId = parseInt(recipeV2Entry.id.replace('legacy_', ''));
    var old = recipes.find(function(r) { return r.id === legacyId; });
    if (!old) {
        // Try defaults
        var defs = getDefaultRecipes();
        old = defs.find(function(r) { return r.id === legacyId; });
    }
    if (!old) return Promise.reject('Recipe not found');

    var container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1;';
    container.innerHTML = buildRecipeHtml(old);
    document.body.appendChild(container);

    return html2canvas(container.firstChild, { scale: 2, useCORS: true, backgroundColor: '#ffffff' }).then(function(canvas) {
        document.body.removeChild(container);
        return new Promise(function(resolve) {
            canvas.toBlob(function(blob) { resolve(blob); }, 'image/png');
        });
    }).then(function(blob) {
        return saveRecipeFile(recipeV2Entry.id, [blob]).then(function() {
            recipeV2Entry.migrated = true;
            saveRecipesV2();
            return blob;
        });
    });
}

// ── Bible (Multi-PDF Library with IndexedDB + pdf.js) ──

let bibleView = 'list'; // 'list' | 'pages'
let bibleOpenPdfId = null;
let bibleLongPressTimer = null;

function openBibleDB() {
    return new Promise(function(resolve, reject) {
        var req = indexedDB.open('aqueous_bible', 2);
        req.onupgradeneeded = function(e) {
            var db = req.result;
            if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
            if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs', { keyPath: 'id' });
        };
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
    });
}

function saveBiblePdfMulti(id, name, arrayBuffer) {
    return openBibleDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction('pdfs', 'readwrite');
            tx.objectStore('pdfs').put({ id: id, name: name, data: arrayBuffer, addedAt: Date.now() });
            tx.oncomplete = function() { resolve(); };
            tx.onerror = function() { reject(tx.error); };
        });
    });
}

function loadAllBiblePdfs() {
    return openBibleDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction('pdfs', 'readonly');
            var req = tx.objectStore('pdfs').getAll();
            req.onsuccess = function() { resolve(req.result || []); };
            req.onerror = function() { reject(req.error); };
        });
    });
}

function loadBiblePdfById(id) {
    return openBibleDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction('pdfs', 'readonly');
            var req = tx.objectStore('pdfs').get(id);
            req.onsuccess = function() { resolve(req.result || null); };
            req.onerror = function() { reject(req.error); };
        });
    });
}

function deleteBiblePdf(id) {
    return openBibleDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction('pdfs', 'readwrite');
            tx.objectStore('pdfs').delete(id);
            tx.oncomplete = function() { resolve(); };
            tx.onerror = function() { reject(tx.error); };
        });
    });
}

function migrateBibleOldPdf() {
    return openBibleDB().then(function(db) {
        return new Promise(function(resolve) {
            if (!db.objectStoreNames.contains('files')) { resolve(); return; }
            var tx = db.transaction('files', 'readonly');
            var req = tx.objectStore('files').get('bible_pdf');
            req.onsuccess = function() {
                if (!req.result) { resolve(); return; }
                var data = req.result;
                saveBiblePdfMulti('migrated_bible', 'Bible', data).then(function() {
                    openBibleDB().then(function(db2) {
                        var tx2 = db2.transaction('files', 'readwrite');
                        tx2.objectStore('files').delete('bible_pdf');
                        tx2.oncomplete = function() { resolve(); };
                    });
                });
            };
            req.onerror = function() { resolve(); };
        });
    }).catch(function() {});
}

function renderBibleContent() {
    if (bibleView === 'pages' && bibleOpenPdfId) {
        return '<div id="biblePageList" class="bible-page-list"></div>';
    }
    return '<div id="bibleList" class="bible-list"></div>' +
        '<button class="add-action-btn squishy" onclick="triggerBibleUpload()">+ Upload PDF</button>' +
        '<input type="file" id="bibleFileInput" accept=".pdf" multiple style="display:none" onchange="handleBibleUpload(this)">';
}

function triggerBibleUpload() {
    handleClick();
    document.getElementById('bibleFileInput').click();
}

function handleBibleUpload(input) {
    if (!input.files || !input.files.length) return;
    var files = Array.from(input.files);
    var count = 0;
    files.forEach(function(file) {
        if (file.type !== 'application/pdf') return;
        var reader = new FileReader();
        reader.onload = function() {
            var id = 'pdf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            var name = file.name.replace(/\.pdf$/i, '');
            saveBiblePdfMulti(id, name, reader.result).then(function() {
                count++;
                if (count === files.length) {
                    showToast(count === 1 ? 'PDF saved' : count + ' PDFs saved');
                    panelDirty.library = true;
                    renderPanel('library');
                }
            });
        };
        reader.readAsArrayBuffer(file);
    });
    input.value = '';
}

function initBibleViewer() {
    migrateBibleOldPdf().then(function() {
        if (bibleView === 'pages' && bibleOpenPdfId) {
            loadBiblePdfById(bibleOpenPdfId).then(function(pdf) {
                if (pdf) renderBiblePageList(pdf.data);
                else { bibleView = 'list'; bibleOpenPdfId = null; initBibleViewer(); }
            });
        } else {
            renderBibleList();
        }
    });
}

function renderBibleList() {
    var container = document.getElementById('bibleList');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">Loading...</div>';

    loadAllBiblePdfs().then(function(pdfs) {
        if (!pdfs.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📄</div><p>No PDFs yet</p><p class="empty-sub">Upload your first PDF below</p></div>';
            return;
        }
        pdfs.sort(function(a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
        container.innerHTML = '';
        pdfs.forEach(function(pdf) {
            var card = document.createElement('div');
            card.className = 'bible-pdf-card squishy';
            card.innerHTML = '<div class="bible-pdf-icon">📄</div>' +
                '<div class="bible-pdf-name">' + (pdf.name || 'Untitled') + '</div>' +
                '<svg class="bible-pdf-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>';
            card.addEventListener('click', function() { handleClick(); bibleOpenPdf(pdf.id); });
            card.addEventListener('touchstart', function(e) {
                bibleLongPressTimer = setTimeout(function() {
                    bibleLongPressTimer = null;
                    showBiblePdfMenu(pdf.id, pdf.name);
                }, 600);
            }, { passive: true });
            card.addEventListener('touchend', function() { if (bibleLongPressTimer) { clearTimeout(bibleLongPressTimer); bibleLongPressTimer = null; } });
            card.addEventListener('touchmove', function() { if (bibleLongPressTimer) { clearTimeout(bibleLongPressTimer); bibleLongPressTimer = null; } });
            container.appendChild(card);
        });
    });
}

function showBiblePdfMenu(id, name) {
    handleClick();
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = '<div class="confirm-box">' +
        '<p style="font-size:14px;font-weight:700;margin-bottom:14px;">' + (name || 'Untitled') + '</p>' +
        '<button class="bible-menu-btn squishy" id="bibleMenuRename">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:10px;"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
        'Rename</button>' +
        '<button class="bible-menu-btn bible-menu-btn-danger squishy" id="bibleMenuDelete">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:10px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
        'Delete</button>' +
        '</div>';
    document.body.appendChild(overlay);
    document.getElementById('bibleMenuRename').addEventListener('click', function() {
        overlay.remove();
        showRenameBiblePdf(id, name);
    });
    document.getElementById('bibleMenuDelete').addEventListener('click', function() {
        overlay.remove();
        confirmDeleteBiblePdf(id, name);
    });
}

function showRenameBiblePdf(id, currentName) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = '<div class="confirm-box">' +
        '<p style="font-size:14px;font-weight:700;margin-bottom:12px;">Rename PDF</p>' +
        '<input type="text" id="bibleRenameInput" class="bible-rename-input" value="' + (currentName || '').replace(/"/g, '&quot;') + '" placeholder="PDF name...">' +
        '<div style="display:flex;gap:10px;margin-top:14px;">' +
        '<button class="btn squishy" style="flex:1;height:40px;font-size:13px;background:var(--surface);color:var(--text-primary);border:1px solid var(--border);" onclick="this.closest(\'.confirm-overlay\').remove()">Cancel</button>' +
        '<button class="btn squishy" style="flex:1;height:40px;font-size:13px;background:var(--accent);color:#fff;border:none;" id="bibleRenameSave">Save</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    var inp = document.getElementById('bibleRenameInput');
    setTimeout(function() { inp.focus(); inp.select(); }, 100);
    document.getElementById('bibleRenameSave').addEventListener('click', function() {
        var newName = inp.value.trim();
        if (!newName) { showToast('Enter a name'); return; }
        renameBiblePdf(id, newName).then(function() {
            showToast('Renamed');
            overlay.remove();
            panelDirty.library = true;
            renderPanel('library');
        });
    });
}

function renameBiblePdf(id, newName) {
    return openBibleDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction('pdfs', 'readwrite');
            var store = tx.objectStore('pdfs');
            var req = store.get(id);
            req.onsuccess = function() {
                var pdf = req.result;
                if (pdf) {
                    pdf.name = newName;
                    store.put(pdf);
                }
                tx.oncomplete = function() { resolve(); };
            };
            req.onerror = function() { reject(req.error); };
        });
    });
}

function confirmDeleteBiblePdf(id, name) {
    handleClick();
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = '<div class="confirm-box">' +
        '<p style="font-size:14px;font-weight:700;margin-bottom:12px;">Delete PDF?</p>' +
        '<p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">"' + (name || 'Untitled') + '" will be permanently removed.</p>' +
        '<div style="display:flex;gap:10px;">' +
        '<button class="btn squishy" style="flex:1;height:40px;font-size:13px;background:var(--surface);color:var(--text-primary);border:1px solid var(--border);" onclick="this.closest(\'.confirm-overlay\').remove()">Cancel</button>' +
        '<button class="btn squishy" style="flex:1;height:40px;font-size:13px;background:var(--high);color:#fff;border:none;" id="confirmDelBibleBtn">Delete</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    document.getElementById('confirmDelBibleBtn').addEventListener('click', function() {
        deleteBiblePdf(id).then(function() {
            showToast('PDF deleted');
            overlay.remove();
            panelDirty.library = true;
            renderPanel('library');
        });
    });
}

function bibleOpenPdf(id) {
    bibleView = 'pages';
    bibleOpenPdfId = id;
    panelDirty.library = true;
    renderPanel('library');
}

function bibleBackToList() {
    bibleView = 'list';
    bibleOpenPdfId = null;
    panelDirty.library = true;
    renderPanel('library');
}

function renderBiblePageList(arrayBuffer) {
    var container = document.getElementById('biblePageList');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">Loading pages...</div>';

    if (typeof pdfjsLib === 'undefined') {
        container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--high);font-size:13px;">PDF viewer not loaded</div>';
        return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    pdfjsLib.getDocument({ data: arrayBuffer }).promise.then(function(pdf) {
        container.innerHTML = '';
        var numPages = pdf.numPages;
        var containerW = container.clientWidth || 320;

        // Back row
        var backRow = document.createElement('div');
        backRow.className = 'bible-back-row';
        backRow.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg> <span style="font-size:13px;font-weight:600;">Back</span>';
        backRow.addEventListener('click', function() { handleClick(); bibleBackToList(); });
        container.appendChild(backRow);

        var renderPage = function(pageNum) {
            if (pageNum > numPages) return;
            pdf.getPage(pageNum).then(function(page) {
                var vp = page.getViewport({ scale: 1 });
                var thumbW = containerW * 0.55;
                var thumbScale = thumbW / vp.width;
                var thumbVp = page.getViewport({ scale: thumbScale * 2 });
                var fullW = containerW;
                var fullScale = fullW / vp.width;
                var fullVp = page.getViewport({ scale: fullScale * 2 });

                var wrap = document.createElement('div');
                wrap.className = 'bible-page-item bible-page-collapsed';
                wrap.dataset.page = pageNum;

                var canvas = document.createElement('canvas');
                canvas.width = thumbVp.width;
                canvas.height = thumbVp.height;
                canvas.style.width = thumbW + 'px';
                canvas.style.height = (thumbW * vp.height / vp.width) + 'px';
                wrap.appendChild(canvas);

                var pageLabel = document.createElement('div');
                pageLabel.className = 'bible-page-label';
                pageLabel.textContent = pageNum;
                wrap.appendChild(pageLabel);

                wrap.addEventListener('click', function(e) {
                    handleClick();
                    e.stopPropagation();
                    var isExpanded = wrap.classList.contains('bible-page-open');
                    if (isExpanded) {
                        wrap.classList.remove('bible-page-open');
                        wrap.classList.add('bible-page-collapsed');
                        canvas.style.width = thumbW + 'px';
                        canvas.style.height = (thumbW * vp.height / vp.width) + 'px';
                        canvas.width = thumbVp.width;
                        canvas.height = thumbVp.height;
                        page.render({ canvasContext: canvas.getContext('2d'), viewport: thumbVp });
                    } else {
                        wrap.classList.remove('bible-page-collapsed');
                        wrap.classList.add('bible-page-open');
                        canvas.style.width = fullW + 'px';
                        canvas.style.height = (fullW * vp.height / vp.width) + 'px';
                        canvas.width = fullVp.width;
                        canvas.height = fullVp.height;
                        page.render({ canvasContext: canvas.getContext('2d'), viewport: fullVp });
                        setTimeout(function() { wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
                    }
                });

                container.appendChild(wrap);
                page.render({ canvasContext: canvas.getContext('2d'), viewport: thumbVp }).promise.then(function() {
                    renderPage(pageNum + 1);
                });
            });
        };
        renderPage(1);
    }).catch(function() {
        container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--high);font-size:13px;">Failed to load PDF</div>';
    });
}

// ── Recipes V2 (Visual Document Viewer) ──

function renderRecipesContent() {
    var cats = ['All', 'Dinner', 'Breakfast', 'Lunch', 'Sushi', 'Other'];
    var pillsHtml = cats.map(function(cat) {
        var val = cat === 'All' ? 'all' : cat;
        var active = recipeFilterCat === val ? ' active' : '';
        return '<button class="rv2-pill' + active + '" onclick="filterRecipesV2(\'' + val + '\')">' + cat + '</button>';
    }).join('');

    var searchVal = recipeSearchTerm ? ' value="' + recipeSearchTerm.replace(/"/g, '&quot;') + '"' : '';
    var clearBtn = recipeSearchTerm ? '<button class="rv2-search-clear" onclick="clearRecipeSearch()">&#x2715;</button>' : '';

    return '<div class="rv2-filter-row">' + pillsHtml + '</div>' +
        '<div class="rv2-search-row"><div class="rv2-search-wrap">' +
            '<svg class="rv2-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
            '<input class="rv2-search-input" type="text" placeholder="Search recipes..."' + searchVal + ' oninput="searchRecipesV2(this.value)">' +
            clearBtn +
        '</div></div>' +
        '<div id="rv2CardList" class="rv2-card-list"></div>' +
        '<button class="add-action-btn squishy" onclick="triggerRecipeUploadV2()">+ Upload Recipe</button>' +
        '<input type="file" id="rv2FileInput" accept=".pdf,.docx,.jpg,.jpeg,.png" multiple style="display:none" onchange="handleRecipeUploadV2(this)">';
}

function initRecipeCards() {
    var container = document.getElementById('rv2CardList');
    if (!container) return;

    var filtered = recipesV2.slice();
    if (recipeFilterCat !== 'all') {
        filtered = filtered.filter(function(r) { return r.category === recipeFilterCat; });
    }
    if (recipeSearchTerm) {
        var term = recipeSearchTerm.toLowerCase();
        filtered = filtered.filter(function(r) { return r.name.toLowerCase().indexOf(term) >= 0; });
    }

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📖</div><p>No recipes</p><p class="empty-sub">' +
            (recipeSearchTerm || recipeFilterCat !== 'all' ? 'Try a different filter' : 'Upload a recipe to get started') + '</p></div>';
        return;
    }

    var html = '';
    filtered.forEach(function(r) {
        html += '<div class="rv2-card squishy" data-id="' + r.id + '" onclick="openRecipeViewer(\'' + r.id + '\')">' +
            '<div class="rv2-card-thumb" id="rv2thumb_' + r.id.replace(/[^a-zA-Z0-9_]/g, '_') + '">' +
                '<div class="rv2-thumb-placeholder">' + (r.name ? r.name.charAt(0).toUpperCase() : '?') + '</div>' +
            '</div>' +
            '<div class="rv2-card-info">' +
                '<div class="rv2-card-name">' + r.name + '</div>' +
                '<div class="rv2-card-cat">' + (r.category || 'Dinner') + '</div>' +
            '</div>' +
            '<svg class="rv2-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>' +
        '</div>';
    });
    container.innerHTML = html;

    // Attach long-press handlers
    container.querySelectorAll('.rv2-card').forEach(function(card) {
        var rid = card.dataset.id;
        var timer = null;
        card.addEventListener('touchstart', function(e) {
            timer = setTimeout(function() {
                timer = null;
                e.preventDefault();
                var r = recipesV2.find(function(x) { return x.id === rid; });
                if (r) showRecipeV2Menu(r);
            }, 600);
        }, { passive: false });
        card.addEventListener('touchend', function() { if (timer) clearTimeout(timer); });
        card.addEventListener('touchmove', function() { if (timer) { clearTimeout(timer); timer = null; } });
    });

    // Load thumbnails lazily
    loadRecipeCardThumbnails(filtered);
}

function loadRecipeCardThumbnails(list) {
    list.forEach(function(r) {
        var el = document.getElementById('rv2thumb_' + r.id.replace(/[^a-zA-Z0-9_]/g, '_'));
        if (!el) return;
        loadRecipeFileById(r.id).then(function(file) {
            if (!file || !file.pages || file.pages.length === 0) return;
            if (r.type === 'pdf' && file.rawPdf) {
                // Render first page of PDF as thumbnail
                rv2RenderPdfPageAsBlob(file.rawPdf, 1, 140).then(function(blob) {
                    if (blob) {
                        var url = URL.createObjectURL(blob);
                        el.innerHTML = '<img src="' + url + '" alt="">';
                    }
                });
            } else {
                var blob = file.pages[0];
                var url = URL.createObjectURL(blob);
                el.innerHTML = '<img src="' + url + '" alt="">';
            }
        });
    });
}

function filterRecipesV2(cat) {
    handleClick();
    recipeFilterCat = cat;
    panelDirty.library = true;
    renderPanel('library');
}

function searchRecipesV2(term) {
    recipeSearchTerm = term;
    initRecipeCards();
}

function clearRecipeSearch() {
    recipeSearchTerm = '';
    panelDirty.library = true;
    renderPanel('library');
}

// ── Recipe V2 Context Menu (Long Press) ──

function showRecipeV2Menu(r) {
    handleClick();
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = '<div class="confirm-box" style="min-width:260px;">' +
        '<div style="font-size:15px;font-weight:700;margin-bottom:14px;text-align:center;">' + r.name + '</div>' +
        '<button class="bible-menu-btn squishy" id="rv2MenuRename"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Rename</button>' +
        '<button class="bible-menu-btn squishy" id="rv2MenuCat"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h7"/></svg> Change Category</button>' +
        '<button class="bible-menu-btn bible-menu-btn-danger squishy" id="rv2MenuDel"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> Delete</button>' +
    '</div>';
    document.body.appendChild(overlay);
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    document.getElementById('rv2MenuRename').onclick = function() { overlay.remove(); showRenameRecipeV2(r); };
    document.getElementById('rv2MenuCat').onclick = function() { overlay.remove(); showChangeCatRecipeV2(r); };
    document.getElementById('rv2MenuDel').onclick = function() { overlay.remove(); confirmDeleteRecipeV2(r); };
}

function showRenameRecipeV2(r) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = '<div class="confirm-box" style="min-width:280px;">' +
        '<div style="font-size:15px;font-weight:700;margin-bottom:12px;">Rename</div>' +
        '<input type="text" class="bible-rename-input" id="rv2RenameInput" value="' + r.name.replace(/"/g, '&quot;') + '">' +
        '<div class="btn-group" style="margin-top:14px;">' +
            '<button class="btn btn-secondary squishy" id="rv2RenameCancel">Cancel</button>' +
            '<button class="btn btn-primary squishy" id="rv2RenameSave">Save</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    var inp = document.getElementById('rv2RenameInput');
    setTimeout(function() { inp.focus(); inp.select(); }, 100);
    document.getElementById('rv2RenameCancel').onclick = function() { overlay.remove(); };
    document.getElementById('rv2RenameSave').onclick = function() {
        var val = inp.value.trim();
        if (!val) return;
        r.name = val;
        saveRecipesV2();
        overlay.remove();
        panelDirty.library = true;
        renderPanel('library');
        showToast('Renamed');
    };
}

function showChangeCatRecipeV2(r) {
    var cats = ['Dinner', 'Lunch', 'Breakfast', 'Sushi', 'Other'];
    var opts = cats.map(function(c) { return '<option' + (r.category === c ? ' selected' : '') + '>' + c + '</option>'; }).join('');
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = '<div class="confirm-box" style="min-width:280px;">' +
        '<div style="font-size:15px;font-weight:700;margin-bottom:12px;">Change Category</div>' +
        '<select class="bible-rename-input" id="rv2CatSelect" style="height:42px;">' + opts + '</select>' +
        '<div class="btn-group" style="margin-top:14px;">' +
            '<button class="btn btn-secondary squishy" id="rv2CatCancel">Cancel</button>' +
            '<button class="btn btn-primary squishy" id="rv2CatSave">Save</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    document.getElementById('rv2CatCancel').onclick = function() { overlay.remove(); };
    document.getElementById('rv2CatSave').onclick = function() {
        r.category = document.getElementById('rv2CatSelect').value;
        saveRecipesV2();
        overlay.remove();
        panelDirty.library = true;
        renderPanel('library');
        showToast('Category: ' + r.category);
    };
}

function confirmDeleteRecipeV2(r) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = '<div class="confirm-box" style="text-align:center;">' +
        '<div style="font-size:15px;font-weight:700;margin-bottom:8px;">Delete Recipe</div>' +
        '<p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Delete "' + r.name + '"?</p>' +
        '<div class="btn-group">' +
            '<button class="btn btn-secondary squishy" id="rv2DelCancel">Cancel</button>' +
            '<button class="btn squishy" style="background:var(--high);color:#fff;" id="rv2DelConfirm">Delete</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    document.getElementById('rv2DelCancel').onclick = function() { overlay.remove(); };
    document.getElementById('rv2DelConfirm').onclick = function() {
        recipesV2 = recipesV2.filter(function(x) { return x.id !== r.id; });
        saveRecipesV2();
        deleteRecipeFile(r.id);
        overlay.remove();
        panelDirty.library = true;
        renderPanel('library');
        showToast('Recipe deleted');
    };
}

// ── Recipe V2 Full-Screen Viewer ──

function openRecipeViewer(id) {
    handleClick();
    var r = recipesV2.find(function(x) { return x.id === id; });
    if (!r) return;

    // If legacy recipe not yet migrated, migrate first
    if (r.type === 'migrated' && !r.migrated) {
        showToast('Generating image...');
        migrateRecipeToImage(r).then(function() {
            openRecipeViewerWithFile(r);
        }).catch(function() {
            showToast('Could not generate image');
        });
        return;
    }
    openRecipeViewerWithFile(r);
}

function openRecipeViewerWithFile(r) {
    loadRecipeFileById(r.id).then(function(file) {
        if (!file) { showToast('Recipe file not found'); return; }

        recipeViewerOpen = true;
        recipeViewerRecipeId = r.id;
        recipeViewerPage = 0;
        recipeViewerPages = [];

        if (r.type === 'pdf' && file.rawPdf) {
            // PDF: render pages on demand
            rv2ShowViewer(r, null, file.rawPdf);
        } else {
            // Image pages
            recipeViewerPages = (file.pages || []).map(function(blob) { return URL.createObjectURL(blob); });
            rv2ShowViewer(r, recipeViewerPages, null);
        }
    });
}

function rv2ShowViewer(r, imageUrls, rawPdf) {
    var existing = document.getElementById('rv2Viewer');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'rv2Viewer';
    overlay.className = 'rv2-viewer-overlay';

    overlay.innerHTML = '<div class="rv2-viewer-header">' +
        '<button class="rv2-viewer-close squishy" onclick="closeRecipeViewer()">&#x2715;</button>' +
        '<div class="rv2-viewer-title">' + r.name + '</div>' +
        '<div class="rv2-viewer-indicator" id="rv2PageIndicator"></div>' +
    '</div>' +
    '<div class="rv2-viewer-body" id="rv2ViewerBody">' +
        '<img class="rv2-viewer-img" id="rv2ViewerImg" draggable="false">' +
    '</div>';

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function() { overlay.classList.add('rv2-viewer-visible'); });

    if (rawPdf) {
        // PDF: count pages first, then show page 1
        if (typeof pdfjsLib === 'undefined') { showToast('PDF viewer not loaded'); return; }
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        pdfjsLib.getDocument({ data: rawPdf }).promise.then(function(pdf) {
            overlay.dataset.pdfPages = pdf.numPages;
            overlay.dataset.pdfMode = 'true';
            overlay._pdfData = rawPdf;
            rv2UpdateIndicator(0, pdf.numPages);
            var w = overlay.querySelector('.rv2-viewer-body').clientWidth || 380;
            rv2RenderPdfPageAsBlob(rawPdf, 1, w).then(function(blob) {
                if (blob) {
                    var url = URL.createObjectURL(blob);
                    recipeViewerPages = [url];
                    document.getElementById('rv2ViewerImg').src = url;
                }
            });
        });
    } else if (imageUrls && imageUrls.length > 0) {
        document.getElementById('rv2ViewerImg').src = imageUrls[0];
        rv2UpdateIndicator(0, imageUrls.length);
    }

    // Touch gestures
    rv2InitGestures(overlay);
}

function rv2UpdateIndicator(page, total) {
    var el = document.getElementById('rv2PageIndicator');
    if (el) el.textContent = total > 1 ? (page + 1) + ' / ' + total : '';
}

function rv2RenderPdfPageAsBlob(rawPdf, pageNum, width) {
    if (typeof pdfjsLib === 'undefined') return Promise.resolve(null);
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return pdfjsLib.getDocument({ data: rawPdf }).promise.then(function(pdf) {
        return pdf.getPage(pageNum);
    }).then(function(page) {
        var vp = page.getViewport({ scale: 1 });
        var scale = (width / vp.width) * 2; // 2x for retina
        var scaledVp = page.getViewport({ scale: scale });
        var canvas = document.createElement('canvas');
        canvas.width = scaledVp.width;
        canvas.height = scaledVp.height;
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledVp }).promise.then(function() {
            return new Promise(function(resolve) {
                canvas.toBlob(function(blob) { resolve(blob); }, 'image/png');
            });
        });
    }).catch(function() { return null; });
}

function closeRecipeViewer() {
    var overlay = document.getElementById('rv2Viewer');
    if (overlay) {
        overlay.classList.remove('rv2-viewer-visible');
        setTimeout(function() { overlay.remove(); }, 250);
    }
    document.body.style.overflow = '';
    recipeViewerOpen = false;
    recipeViewerPages.forEach(function(url) { if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); });
    recipeViewerPages = [];
}

// ── Viewer Gestures (pinch-zoom, pan, swipe, double-tap) ──

function rv2InitGestures(overlay) {
    var body = overlay.querySelector('.rv2-viewer-body');
    var img = overlay.querySelector('.rv2-viewer-img');
    var scale = 1, tx = 0, ty = 0;
    var startDist = 0, startScale = 1;
    var startX = 0, startY = 0, startTx = 0, startTy = 0;
    var lastTap = 0;
    var isPinching = false;
    var isSwiping = false;

    function applyTransform() {
        img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }

    function clampPan() {
        if (scale <= 1) { tx = 0; ty = 0; return; }
        var maxTx = (img.naturalWidth * scale - body.clientWidth) / 2;
        var maxTy = (img.naturalHeight * scale - body.clientHeight) / 2;
        if (maxTx < 0) maxTx = 0;
        if (maxTy < 0) maxTy = 0;
        tx = Math.max(-maxTx, Math.min(maxTx, tx));
        ty = Math.max(-maxTy, Math.min(maxTy, ty));
    }

    function getTotalPages() {
        if (overlay.dataset.pdfMode === 'true') return parseInt(overlay.dataset.pdfPages) || 1;
        return recipeViewerPages.length;
    }

    function goToPage(idx) {
        var total = getTotalPages();
        if (idx < 0 || idx >= total) return;
        recipeViewerPage = idx;
        scale = 1; tx = 0; ty = 0;
        applyTransform();
        rv2UpdateIndicator(idx, total);

        if (overlay.dataset.pdfMode === 'true') {
            var w = body.clientWidth || 380;
            rv2RenderPdfPageAsBlob(overlay._pdfData, idx + 1, w).then(function(blob) {
                if (blob) {
                    var url = URL.createObjectURL(blob);
                    recipeViewerPages[idx] = url;
                    img.src = url;
                }
            });
        } else if (recipeViewerPages[idx]) {
            img.src = recipeViewerPages[idx];
        }
    }

    body.addEventListener('touchstart', function(e) {
        if (e.touches.length === 2) {
            isPinching = true;
            var dx = e.touches[0].clientX - e.touches[1].clientX;
            var dy = e.touches[0].clientY - e.touches[1].clientY;
            startDist = Math.sqrt(dx * dx + dy * dy);
            startScale = scale;
        } else if (e.touches.length === 1) {
            isPinching = false;
            isSwiping = false;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startTx = tx;
            startTy = ty;

            // Double-tap detection
            var now = Date.now();
            if (now - lastTap < 300) {
                e.preventDefault();
                if (scale > 1.5) {
                    scale = 1; tx = 0; ty = 0;
                } else {
                    scale = 2.5;
                }
                applyTransform();
                lastTap = 0;
                return;
            }
            lastTap = now;
        }
    }, { passive: false });

    body.addEventListener('touchmove', function(e) {
        e.preventDefault();
        if (e.touches.length === 2 && isPinching) {
            var dx = e.touches[0].clientX - e.touches[1].clientX;
            var dy = e.touches[0].clientY - e.touches[1].clientY;
            var dist = Math.sqrt(dx * dx + dy * dy);
            scale = Math.max(1, Math.min(5, startScale * (dist / startDist)));
            clampPan();
            applyTransform();
        } else if (e.touches.length === 1 && !isPinching) {
            var mx = e.touches[0].clientX - startX;
            var my = e.touches[0].clientY - startY;
            if (scale > 1) {
                tx = startTx + mx;
                ty = startTy + my;
                clampPan();
                applyTransform();
            } else {
                isSwiping = true;
            }
        }
    }, { passive: false });

    body.addEventListener('touchend', function(e) {
        if (isPinching && e.touches.length < 2) {
            isPinching = false;
            if (scale < 1.05) { scale = 1; tx = 0; ty = 0; applyTransform(); }
            return;
        }
        if (isSwiping && scale <= 1) {
            var endX = e.changedTouches[0].clientX;
            var dx = endX - startX;
            if (Math.abs(dx) > 60) {
                if (dx < 0) goToPage(recipeViewerPage + 1); // swipe left = next
                else goToPage(recipeViewerPage - 1); // swipe right = prev
            }
            isSwiping = false;
        }
    });
}

// ── Recipe V2 Upload ──

function triggerRecipeUploadV2() {
    handleClick();
    document.getElementById('rv2FileInput').click();
}

function handleRecipeUploadV2(input) {
    if (!input.files || input.files.length === 0) return;
    var files = Array.from(input.files);
    input.value = '';

    if (files.length === 1) {
        showRecipeUploadModal(files[0]);
    } else {
        // Multiple files: batch upload with auto-naming
        var count = 0;
        files.forEach(function(file) {
            processRecipeFile(file, file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '), 'Dinner').then(function() {
                count++;
                if (count === files.length) {
                    panelDirty.library = true;
                    renderPanel('library');
                    showToast(count + ' recipes uploaded');
                }
            });
        });
    }
}

function showRecipeUploadModal(file) {
    var name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    var cats = ['Dinner', 'Lunch', 'Breakfast', 'Sushi', 'Other'];
    var opts = cats.map(function(c) { return '<option' + (c === 'Dinner' ? ' selected' : '') + '>' + c + '</option>'; }).join('');

    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = '<div class="confirm-box" style="min-width:300px;text-align:left;">' +
        '<div style="font-size:15px;font-weight:700;margin-bottom:12px;">Upload Recipe</div>' +
        '<div class="te-section-label">NAME</div>' +
        '<input type="text" class="bible-rename-input" id="rv2UpName" value="' + name.replace(/"/g, '&quot;') + '">' +
        '<div class="te-section-label" style="margin-top:12px;">CATEGORY</div>' +
        '<select class="bible-rename-input" id="rv2UpCat" style="height:42px;">' + opts + '</select>' +
        '<div class="btn-group" style="margin-top:16px;">' +
            '<button class="btn btn-secondary squishy" id="rv2UpCancel">Cancel</button>' +
            '<button class="btn btn-primary squishy" id="rv2UpSave">Upload</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    setTimeout(function() { var inp = document.getElementById('rv2UpName'); inp.focus(); inp.select(); }, 100);
    document.getElementById('rv2UpCancel').onclick = function() { overlay.remove(); };
    document.getElementById('rv2UpSave').onclick = function() {
        var n = document.getElementById('rv2UpName').value.trim();
        var c = document.getElementById('rv2UpCat').value;
        if (!n) { showToast('Enter a name'); return; }
        overlay.remove();
        showToast('Processing...');
        processRecipeFile(file, n, c).then(function() {
            panelDirty.library = true;
            renderPanel('library');
            showToast('Recipe uploaded');
        }).catch(function(err) {
            showToast('Upload failed: ' + (err || 'unknown error'));
        });
    };
}

function processRecipeFile(file, name, category) {
    var ext = file.name.split('.').pop().toLowerCase();
    var id = 'recipe_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') {
        return new Promise(function(resolve) {
            var reader = new FileReader();
            reader.onload = function() {
                var blob = new Blob([reader.result], { type: file.type });
                saveRecipeFile(id, [blob]).then(function() {
                    recipesV2.push({ id: id, name: name, category: category, type: 'image', pageCount: 1, dateAdded: Date.now(), migrated: true });
                    saveRecipesV2();
                    resolve();
                });
            };
            reader.readAsArrayBuffer(file);
        });
    } else if (ext === 'pdf') {
        return new Promise(function(resolve) {
            var reader = new FileReader();
            reader.onload = function() {
                var ab = reader.result;
                // Count pages
                if (typeof pdfjsLib !== 'undefined') {
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                    pdfjsLib.getDocument({ data: ab }).promise.then(function(pdf) {
                        saveRecipeFile(id, [], ab).then(function() {
                            recipesV2.push({ id: id, name: name, category: category, type: 'pdf', pageCount: pdf.numPages, dateAdded: Date.now(), migrated: true });
                            saveRecipesV2();
                            resolve();
                        });
                    });
                } else {
                    saveRecipeFile(id, [], ab).then(function() {
                        recipesV2.push({ id: id, name: name, category: category, type: 'pdf', pageCount: 1, dateAdded: Date.now(), migrated: true });
                        saveRecipesV2();
                        resolve();
                    });
                }
            };
            reader.readAsArrayBuffer(file);
        });
    } else if (ext === 'docx') {
        return new Promise(function(resolve, reject) {
            var reader = new FileReader();
            reader.onload = function() {
                if (typeof mammoth === 'undefined') { reject('Docx parser not loaded'); return; }
                if (typeof html2canvas === 'undefined') { reject('html2canvas not loaded'); return; }
                mammoth.convertToHtml({ arrayBuffer: reader.result }).then(function(result) {
                    var container = document.createElement('div');
                    container.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1;width:400px;padding:24px 20px;background:#fff;font-family:Inter,system-ui,sans-serif;font-size:13px;color:#1a1a1a;line-height:1.5;';
                    container.innerHTML = result.value;
                    document.body.appendChild(container);
                    html2canvas(container, { scale: 2, useCORS: true, backgroundColor: '#ffffff' }).then(function(canvas) {
                        document.body.removeChild(container);
                        canvas.toBlob(function(blob) {
                            saveRecipeFile(id, [blob]).then(function() {
                                recipesV2.push({ id: id, name: name, category: category, type: 'image', pageCount: 1, dateAdded: Date.now(), migrated: true });
                                saveRecipesV2();
                                resolve();
                            });
                        }, 'image/png');
                    }).catch(function() { document.body.removeChild(container); reject('Image capture failed'); });
                }).catch(function() { reject('Docx parse failed'); });
            };
            reader.readAsArrayBuffer(file);
        });
    }
    return Promise.reject('Unsupported format');
}

function renderLibrary(container) {
    var content = '';
    if (librarySubTab === 'bible') {
        content = renderBibleContent();
    } else if (librarySubTab === 'recipes') {
        content = renderRecipesContent();
    } else if (librarySubTab === 'tempLogs') {
        content = '<div class="empty-state"><div class="empty-state-icon">🌡️</div><p>Temp Logs</p><p class="empty-sub">Coming Soon</p></div>';
    }

    container.innerHTML = '<div class="sub-pill-row">' +
            '<button class="day-chip ' + (librarySubTab === 'bible' ? 'active' : '') + '" onclick="switchLibrarySubTab(\'bible\')">Bible</button>' +
            '<button class="day-chip ' + (librarySubTab === 'recipes' ? 'active' : '') + '" onclick="switchLibrarySubTab(\'recipes\')">Recipes</button>' +
            '<button class="day-chip ' + (librarySubTab === 'tempLogs' ? 'active' : '') + '" onclick="switchLibrarySubTab(\'tempLogs\')">Temp Logs</button>' +
        '</div>' +
        '<div class="tools-content-area">' + content + '</div>';

    if (librarySubTab === 'bible') {
        setTimeout(function() { initBibleViewer(); }, 50);
    } else if (librarySubTab === 'recipes') {
        setTimeout(function() { initRecipeCards(); }, 50);
    }
}

// ── Day Checklists (per-day independent checklists) ──

function migrateMlDayStates() {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (dayChecklists[todayKey] && dayChecklists[todayKey].length > 0) return;

    // Build today's checklist from station.status + old mlDayStates
    const oldSaved = localStorage.getItem('aqueous_mlDayStates');
    const oldStates = oldSaved ? JSON.parse(oldSaved) : {};
    const items = [];

    stations.forEach(station => {
        getAllIngredients(station).forEach(ing => {
            const st = station.status[ing.id];
            if (!st || !st.low || !st.priority) return;
            const oldKey = `${todayKey}_${station.id}_${ing.id}`;
            const wasStruck = oldStates[oldKey] ? oldStates[oldKey].struck : false;
            items.push({
                stationId: station.id,
                ingredientId: ing.id,
                name: ing.name,
                stationName: station.name,
                priority: st.priority,
                parQty: st.parQty,
                parUnit: st.parUnit,
                parDepth: st.parDepth,
                struck: wasStruck,
                timeEstimate: getTimeForMasterList(ing.name, st.parQty, st.parUnit, st.parDepth)
            });
        });
    });

    if (items.length > 0) {
        dayChecklists[todayKey] = items;
        saveDayChecklists();
    }
}

function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
}

function getNextDayKey(dateKey) {
    const d = new Date(dateKey + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
}

function getActiveDay() {
    return settings.activeDay || getTodayKey();
}

function formatDayLabel(dateKey) {
    const today = getTodayKey();
    const tomorrow = getNextDayKey(today);
    if (dateKey === today) return 'Today';
    if (dateKey === tomorrow) return 'Tomorrow';
    const d = new Date(dateKey + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function loadDayChecklists() {
    const saved = localStorage.getItem('aqueous_dayChecklists');
    dayChecklists = saved ? JSON.parse(saved) : {};
}

function saveDayChecklists() {
    localStorage.setItem('aqueous_dayChecklists', JSON.stringify(dayChecklists));
}

function loadCompletedHistory() {
    const saved = localStorage.getItem('aqueous_completedHistory');
    completedHistory = saved ? JSON.parse(saved) : {};
}

function saveCompletedHistory() {
    localStorage.setItem('aqueous_completedHistory', JSON.stringify(completedHistory));
}

function cleanOldCompletedHistory() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    Object.keys(completedHistory).forEach(key => {
        if (key < cutoffKey) delete completedHistory[key];
    });
    saveCompletedHistory();
}

function saveCompletedItems(dayKey, items) {
    if (!completedHistory[dayKey]) completedHistory[dayKey] = [];
    items.forEach(item => {
        completedHistory[dayKey].push({
            name: item.name,
            stationName: item.stationName,
            priority: item.priority,
            parQty: item.parQty,
            parUnit: item.parUnit,
            parDepth: item.parDepth,
            timeEstimate: getTimeForMasterList(item.name, item.parQty, item.parUnit, item.parDepth)
        });
    });
    saveCompletedHistory();
}

function cleanOldDayChecklists() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    Object.keys(dayChecklists).forEach(key => {
        if (key < cutoffKey) delete dayChecklists[key];
    });
    saveDayChecklists();
}

function syncItemToChecklist(stationId, ingredientId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const st = station.status[ingredientId];
    const ing = getAllIngredients(station).find(i => i.id === ingredientId);
    if (!ing) return;
    const day = getActiveDay();
    if (!dayChecklists[day]) dayChecklists[day] = [];
    const list = dayChecklists[day];
    const idx = list.findIndex(x => x.stationId === stationId && x.ingredientId === ingredientId);

    if (st && st.low && st.priority) {
        const item = {
            stationId, ingredientId,
            name: ing.name,
            stationName: station.name,
            priority: st.priority,
            parQty: st.parQty,
            parUnit: st.parUnit,
            parDepth: st.parDepth,
            parNotes: st.parNotes || '',
            struck: idx >= 0 ? list[idx].struck : false,
            timeEstimate: getTimeForMasterList(ing.name, st.parQty, st.parUnit, st.parDepth)
        };
        if (idx >= 0) list[idx] = item;
        else list.push(item);
    } else {
        if (idx >= 0) list.splice(idx, 1);
    }
    saveDayChecklists();
    panelDirty.home = true;
}

function setActiveDay(dateKey) {
    handleClick();
    settings.activeDay = dateKey;
    saveSettings();
    if (!dayChecklists[getActiveDay()]) {
        dayChecklists[getActiveDay()] = [];
    }
    panelDirty.home = true;
    renderPanel('home');
}

function showDayPicker() {
    handleClick();
    const overlay = document.createElement('div');
    overlay.className = 'time-picker-overlay';
    overlay.id = 'dayPickerOverlay';
    overlay.innerHTML = `
        <div class="time-picker-panel">
            <div class="tp-title">Pick a Day</div>
            <input type="date" id="dayPickerInput" value="${getActiveDay()}"
                style="width:100%;font-size:16px;padding:12px;border-radius:12px;border:1.5px solid var(--border);background:var(--bg);color:var(--text);margin:16px 0;">
            <div class="tp-actions">
                <button class="tp-btn tp-cancel" onclick="closeTimePicker()">Cancel</button>
                <button class="tp-btn tp-save" onclick="confirmDayPick()">Set</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
}

function confirmDayPick() {
    const input = document.getElementById('dayPickerInput');
    if (input && input.value) {
        setActiveDay(input.value);
    }
    closeTimePicker();
}

function confirmCloseDay() {
    handleClick();
    const overlay = document.createElement('div');
    overlay.className = 'time-picker-overlay';
    overlay.innerHTML = `
        <div class="time-picker-panel">
            <div class="tp-title">Close Day?</div>
            <p style="font-size:13px;color:var(--text-secondary);margin:16px 0;line-height:1.4;">
                Completed items will be archived. Pending items carry over to tomorrow with high priority.
            </p>
            <div class="tp-actions">
                <button class="tp-btn tp-cancel" onclick="closeTimePicker()">Cancel</button>
                <button class="tp-btn tp-save" onclick="closeDay()">Close Day</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
}

function closeDay() {
    const day = getActiveDay();
    const list = dayChecklists[day] || [];
    const nextDay = getNextDayKey(day);

    // Stop timer if running
    if (settings.clockInTimestamp) {
        settings.shiftStart = null;
        settings.clockInTimestamp = null;
        settings.prepWindowMinutes = null;
        stopCountdownBar();
        clearPrepNotification();
    }

    // Save completed (struck) items to completedHistory
    const struckItems = list.filter(x => x.struck);
    if (struckItems.length > 0) {
        saveCompletedItems(day, struckItems);
    }

    // Clear station.status for completed items
    struckItems.forEach(item => {
        const station = stations.find(s => s.id === item.stationId);
        if (station && station.status[item.ingredientId]) {
            station.status[item.ingredientId].completed = false;
            station.status[item.ingredientId].priority = null;
            station.status[item.ingredientId].low = false;
        }
    });

    // Carry over non-struck items to next day with escalated priority (one level up)
    const escalatePriority = (pri) => pri === 'low' ? 'medium' : 'high';
    const carryOver = list.filter(x => !x.struck).map(item => ({
        ...item,
        priority: escalatePriority(item.priority),
        struck: false
    }));

    if (!dayChecklists[nextDay]) dayChecklists[nextDay] = [];
    carryOver.forEach(item => {
        const exists = dayChecklists[nextDay].findIndex(
            x => x.stationId === item.stationId && x.ingredientId === item.ingredientId
        );
        if (exists >= 0) {
            dayChecklists[nextDay][exists] = item;
        } else {
            dayChecklists[nextDay].push(item);
        }
    });

    dayChecklists[day] = [];
    saveDayChecklists();
    saveData(true);
    saveSettings();
    panelDirty.tools = true;
    panelDirty.tools = true;

    closeTimePicker();
    setActiveDay(day === getTodayKey() ? null : nextDay);
}

// ── Master List Interactions ──

let mlSwipeState = null;

function mlToggleStrike(stationId, ingredientId) {
    handleClick();
    const day = getActiveDay();
    const list = dayChecklists[day] || [];
    const item = list.find(x => x.stationId === stationId && x.ingredientId === ingredientId);
    if (!item) return;
    item.struck = !item.struck;
    saveDayChecklists();
    const row = document.getElementById(`ml-${stationId}-${ingredientId}`);
    if (row) row.classList.toggle('ml-struck', item.struck);
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

    // Save to completed history
    const day = getActiveDay();
    const list = dayChecklists[day] || [];
    const checklistItem = list.find(x => x.stationId === stationId && x.ingredientId === ingredientId);
    if (checklistItem) {
        saveCompletedItems(day, [checklistItem]);
    }

    if (st) {
        const pLevel = st.priority || 'none';
        st.completed = false;
        st.priority = null;
        st.low = false;
        saveData(true);
        animateMascot();
        checkBlockCompletion(pLevel);
        panelDirty.tools = true;
    }

    // Remove from day checklist
    const idx = list.findIndex(x => x.stationId === stationId && x.ingredientId === ingredientId);
    if (idx >= 0) list.splice(idx, 1);
    saveDayChecklists();

    panelDirty.home = true;
    panelDirty.tools = true;
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
    const day = getActiveDay();
    const items = dayChecklists[day] || [];

    if (items.length === 0) {
        return `
            <div class="empty-state">
                <p style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px;">No checklist for ${formatDayLabel(day)}</p>
                <p class="empty-sub">Add ingredients from Stations to build your checklist</p>
                <button class="btn btn-primary squishy" style="margin-top:16px;font-size:15px;padding:14px 32px;" onclick="toggleHomeStationPicker()">+ Create Checklist</button>
            </div>`;
    }

    const groups = {};
    items.forEach(item => {
        if (!groups[item.stationName]) groups[item.stationName] = [];
        groups[item.stationName].push(item);
    });

    const priOrder = { high: 0, medium: 1, low: 2 };
    let html = '';
    Object.keys(groups).forEach(stationName => {
        const sorted = groups[stationName].sort((a, b) => {
            const pa = priOrder[a.priority] ?? 3;
            const pb = priOrder[b.priority] ?? 3;
            return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
        });
        html += `<div class="ml-station-label">${stationName}</div>`;
        sorted.forEach(item => { html += mlRenderRow(item); });
    });

    return html;
}

function mlRenderRow(item) {
    const dotClass = `priority-dot ${item.priority}`;
    const qtyDisplay = item.parQty && item.parUnit
        ? `${item.parQty} ${PAN_UNITS.includes(item.parUnit) ? (item.parDepth || 4) + '" ' + item.parUnit : item.parUnit}`
        : (item.parQty ? `${item.parQty}` : '');
    const struckClass = item.struck ? ' ml-struck' : '';

    const family = getTimingFamily(item.parUnit);
    const ingFamilies = getIngTimingFamilies(item.name);
    const hasFamilyTiming = ingFamilies[family];
    const freshTime = getTimeForMasterList(item.name, item.parQty, item.parUnit, item.parDepth);

    let timePill;
    if (!hasFamilyTiming) {
        const swKey = `${item.stationId}-${item.ingredientId}`;
        const isRunning = mlStopwatches[swKey];
        if (isRunning) {
            timePill = `<button class="ml-pill running" id="mlsw-${item.stationId}-${item.ingredientId}" onclick="event.stopPropagation(); mlStopwatchStop(${item.stationId}, ${item.ingredientId})">Stop ${formatTime(isRunning.elapsed)}</button>`;
        } else {
            timePill = `<button class="ml-pill" onclick="event.stopPropagation(); mlStopwatchStart(${item.stationId}, ${item.ingredientId})">Start</button>`;
        }
    } else if (freshTime) {
        timePill = `<span class="ml-time">${formatTime(freshTime)}</span>`;
    } else {
        timePill = `<span class="ml-time" style="color:var(--high);">no time</span>`;
    }

    const escapedName = item.name.replace(/'/g, "\\'");
    return `
    <div class="ml-row${struckClass}" id="ml-${item.stationId}-${item.ingredientId}"
         onclick="mlToggleStrike(${item.stationId}, ${item.ingredientId})"
         ontouchstart="mlSwipeStart(event, ${item.stationId}, ${item.ingredientId}); mlRowLongPressStart(event, ${item.stationId}, ${item.ingredientId})"
         ontouchend="mlRowLongPressCancel()" ontouchmove="mlRowLongPressCancel()"
         oncontextmenu="event.preventDefault(); mlOpenTimingEditor(${item.stationId}, ${item.ingredientId})">
        <span class="${dotClass}"></span>
        <div class="ml-name-col">
            <span class="ml-name">${item.name}</span>
            ${item.parNotes ? `<span class="ml-notes">${item.parNotes}</span>` : ''}
        </div>
        ${qtyDisplay ? `<span class="ml-qty">${qtyDisplay}</span>` : ''}
        ${timePill}
    </div>`;
}

function renderIngredients(station, opts) {
    opts = opts || {};
    if (!station.dishes || station.dishes.length === 0) return '';
    const singleDish = station.dishes.length === 1;
    const isPicker = opts.mode === 'picker';
    let html = '';
    station.dishes.forEach(dish => {
        const dishIngs = dish.ingredients || [];
        const dishLow = dishIngs.filter(ing => station.status[ing.id] && station.status[ing.id].low).length;
        const dishTotal = dishIngs.length;
        const isDishExpanded = dish.expanded !== false;
        if (singleDish) {
            html += renderDishIngredients(station, dish, opts);
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
                    ${renderDishIngredients(station, dish, opts)}
                    ${!isPicker ? `<div class="dish-quick-add">
                        <input type="text" class="quick-add-input" id="quickAdd_${station.id}_${dish.id}" placeholder="Add to ${dish.name}..." onkeydown="if(event.key==='Enter'){quickAddIngredient(${station.id}, ${dish.id})}">
                        <button class="quick-add-btn" onclick="quickAddIngredient(${station.id}, ${dish.id})">+</button>
                    </div>` : ''}
                </div>
            </div>`;
        }
    });
    return html;
}

function renderDishIngredients(station, dish, opts) {
    opts = opts || {};
    const showPriority = opts.showPriority !== false;
    let html = '';
    (dish.ingredients || []).forEach(ing => {
        const st = station.status[ing.id] || { low: false, priority: null, parLevel: '', parQty: null, parUnit: '', parNotes: '', completed: false };
        const escapedIngName = ing.name.replace(/'/g, "\\'");
        const isExpanded = expandedIngs.has(`${station.id}-${ing.id}`);
        const hasPri = st.priority && !st.completed;
        const inMl = hasPri;

        // Parse notes: separate presets from custom
        const notesList = (st.parNotes || '').split(',').map(n => n.trim()).filter(Boolean);
        const activePresets = new Set(notesList.filter(n => PRESET_NOTES.includes(n)));
        const customNote = notesList.filter(n => !PRESET_NOTES.includes(n)).join(', ');

        if (isExpanded) {
            html += `
            <div class="ingredient focused ${hasPri ? 'has-priority priority-' + st.priority : ''}" id="ing-${station.id}-${ing.id}">
                <div class="ingredient-header"
                     ontouchstart="startLongPress(event, ${station.id}, ${ing.id}, '${escapedIngName}')"
                     ontouchend="cancelLongPress()" ontouchmove="cancelLongPress()"
                     oncontextmenu="event.preventDefault(); showIngredientContextMenu(event, ${station.id}, ${ing.id}, '${escapedIngName}')">
                    <span class="ingredient-name ing-name-expanded" onclick="toggleIngExpand(${station.id}, ${ing.id})" style="flex:1;pointer-events:auto;">${ing.name}</span>
                </div>
                <div class="ing-expanded-card">
                    <div class="ing-qty-row">
                        <button class="ing-qty-btn" onclick="event.stopPropagation(); adjustParQty(${station.id}, ${ing.id}, -1)">−</button>
                        <input type="number" class="ing-qty-input"
                            value="${st.parQty || ''}"
                            placeholder="0"
                            min="0" step="1" inputmode="decimal"
                            oninput="debounce('parq_${station.id}_${ing.id}', () => setParQty(${station.id}, ${ing.id}, this.value), 400)"
                            onclick="event.stopPropagation()">
                        <button class="ing-qty-btn" onclick="event.stopPropagation(); adjustParQty(${station.id}, ${ing.id}, 1)">+</button>
                        <select class="ing-unit-select" onchange="event.stopPropagation(); setParUnit(${station.id}, ${ing.id}, this.value)">
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
                            <optgroup label="Containers">
                                ${CONTAINER_UNITS.map(u => `<option value="${u}" ${st.parUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
                            </optgroup>
                            <optgroup label="Task">
                                ${TASK_UNITS.map(u => `<option value="${u}" ${st.parUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
                            </optgroup>
                        </select>
                    </div>
                    ${PAN_UNITS.includes(st.parUnit) ? `
                    <div class="ing-depth-row">
                        <button class="depth-chip ${(st.parDepth || 4) == 2 ? 'active' : ''}" onclick="event.stopPropagation(); setParDepth(${station.id}, ${ing.id}, 2)">2"</button>
                        <button class="depth-chip ${(st.parDepth || 4) == 4 ? 'active' : ''}" onclick="event.stopPropagation(); setParDepth(${station.id}, ${ing.id}, 4)">4"</button>
                        <button class="depth-chip ${(st.parDepth || 4) == 6 ? 'active' : ''}" onclick="event.stopPropagation(); setParDepth(${station.id}, ${ing.id}, 6)">6"</button>
                    </div>
                    ` : ''}
                    <div class="ing-preset-row">
                        ${PRESET_NOTES.map(p => { const ep = p.replace(/'/g, "\\'"); return `<button class="preset-pill ${activePresets.has(p) ? 'active' : ''}" onclick="event.stopPropagation(); togglePresetNote(${station.id}, ${ing.id}, '${ep}')">${p}</button>`; }).join('')}
                    </div>
                    <input type="text" class="ing-custom-note" placeholder="Custom note..."
                        value="${customNote}"
                        oninput="debounce('parn_${station.id}_${ing.id}', () => setCustomNote(${station.id}, ${ing.id}, this.value), 600)"
                        onclick="event.stopPropagation()">
                    ${showPriority ? `<div class="ing-priority-row">
                        <button class="pri-btn high ${st.priority === 'high' ? 'active' : ''}" onclick="event.stopPropagation(); setPriorityAndCollapse(${station.id}, ${ing.id}, 'high')">HIGH</button>
                        <button class="pri-btn medium ${st.priority === 'medium' ? 'active' : ''}" onclick="event.stopPropagation(); setPriorityAndCollapse(${station.id}, ${ing.id}, 'medium')">MEDIUM</button>
                        <button class="pri-btn low ${st.priority === 'low' ? 'active' : ''}" onclick="event.stopPropagation(); setPriorityAndCollapse(${station.id}, ${ing.id}, 'low')">LOW</button>
                    </div>` : ''}
                </div>
            </div>`;
        } else {
            html += `
            <div class="ingredient ${st.low ? 'low' : ''} ${hasPri ? 'has-priority priority-' + st.priority : ''}" id="ing-${station.id}-${ing.id}">
                <div class="ingredient-header"
                     ontouchstart="startLongPress(event, ${station.id}, ${ing.id}, '${escapedIngName}')"
                     ontouchend="cancelLongPress()" ontouchmove="cancelLongPress()"
                     oncontextmenu="event.preventDefault(); showIngredientContextMenu(event, ${station.id}, ${ing.id}, '${escapedIngName}')">
                    ${hasPri ? `<span class="priority-dot ${st.priority}"></span>` : ''}
                    <span class="ingredient-name" onclick="toggleIngExpand(${station.id}, ${ing.id})" style="flex:1;pointer-events:auto;">${ing.name}</span>
                    ${taskTemplates[ing.name.toLowerCase()] ? '<span class="template-indicator">⏱</span>' : ''}
                </div>
            </div>`;
        }
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
    updateGlobalCount();
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
    updateDayChecklistName(stationId, ingId, newName);
    saveData(true);

    const modal = document.getElementById('modalEditIngredient');
    if (modal) modal.remove();

    rerenderStationBody(stationId);
    updateGlobalCount();
    showToast(`Renamed to ${newName}`);
}

// ==================== INLINE INGREDIENT NAME EDIT ====================

function inlineEditIngName(event, stationId, ingId) {
    event.stopPropagation();
    const span = event.target;
    if (span.tagName === 'INPUT') return;

    const currentName = span.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'inline-ing-edit';
    input.style.cssText = 'font-size:13px;font-weight:600;border:none;border-bottom:2px solid var(--accent);background:transparent;color:var(--text);outline:none;width:100%;padding:0;margin:0;';

    span.replaceWith(input);
    input.focus();
    input.select();

    let saved = false;
    function save() {
        if (saved) return;
        saved = true;
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
            const station = stations.find(s => s.id === stationId);
            if (station) {
                const ing = getAllIngredients(station).find(i => i.id === ingId);
                if (ing) {
                    ing.name = newName;
                    registerGlobalIngredient(ing.id, newName);
                    updateDayChecklistName(stationId, ingId, newName);
                    saveData(true);
                    updateGlobalCount();
                }
            }
        }
        rerenderStationBody(stationId);
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', function(e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { saved = true; rerenderStationBody(stationId); }
    });
}

function updateDayChecklistName(stationId, ingId, newName) {
    Object.keys(dayChecklists).forEach(day => {
        const list = dayChecklists[day] || [];
        list.forEach(item => {
            if (item.stationId === stationId && item.ingredientId === ingId) {
                item.name = newName;
            }
        });
    });
    saveDayChecklists();
}

// ==================== CALIBRATION WORKFLOW ====================

let calibrationState = null;

function getCalibrationTimerSeconds(timer) {
    if (!timer) return 0;
    if (timer.running) return timer.pausedElapsed + Math.floor((Date.now() - timer.startedAt) / 1000);
    return timer.pausedElapsed;
}

// ==================== TIMING EDITOR (Slide-Up Panel) ====================

function closeTimingEditor() {
    const overlay = document.getElementById('teOverlay');
    const panel = document.getElementById('tePanel');
    if (panel) {
        panel.classList.remove('show');
    }
    if (overlay) {
        overlay.classList.remove('show');
    }
    setTimeout(function() {
        if (overlay) overlay.remove();
        if (panel) panel.remove();
    }, 300);
}

function showTimingEditor(ingName, mlItem) {
    closeTimingEditor();

    const overlay = document.createElement('div');
    overlay.id = 'teOverlay';
    overlay.className = 'te-overlay';

    const panel = document.createElement('div');
    panel.id = 'tePanel';
    panel.className = 'te-panel';
    panel.dataset.ingName = ingName;

    if (mlItem) {
        panel.dataset.stationId = mlItem.stationId || '';
        panel.dataset.ingredientId = mlItem.ingredientId || '';
        panel.dataset.mlQty = mlItem.parQty || '';
        panel.dataset.mlUnit = mlItem.parUnit || '';
        panel.dataset.mlDepth = mlItem.parDepth || '';
        panel.dataset.originalQty = mlItem.parQty || '';
    }

    // Block context menu on entire panel
    panel.addEventListener('contextmenu', function(e) { e.preventDefault(); });

    if (mlItem && mlItem.parUnit) {
        renderTimingQtyTime(panel, ingName);
    } else {
        renderTimingUnitPicker(panel, ingName);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    // Tap overlay = close without saving
    overlay.onclick = function() { closeTimingEditor(); };

    // Animate in
    requestAnimationFrame(function() {
        overlay.classList.add('show');
        panel.classList.add('show');
    });
}

function renderTimingQtyTime(panel, ingName) {
    const key = ingName.toLowerCase();
    const tmpl = taskTemplates[key];
    const escapedName = ingName.replace(/'/g, "\\'");

    const parUnit = panel.dataset.mlUnit;
    const parDepth = parseInt(panel.dataset.mlDepth) || null;
    const parQty = parseFloat(panel.dataset.mlQty) || 1;
    const family = getTimingFamily(parUnit);

    panel.dataset.family = family;

    let refSeconds = 0;
    if (tmpl && tmpl[family] && tmpl[family].secPerBaseUnit > 0) {
        const baseQty = convertToBase(parQty, parUnit, parDepth);
        refSeconds = Math.round(tmpl[family].secPerBaseUnit * baseQty);
    } else if (tmpl && tmpl[family] && tmpl[family].refSeconds > 0) {
        refSeconds = tmpl[family].refSeconds;
    }

    const totalMin = Math.floor(refSeconds / 60);
    const sec = refSeconds % 60;

    // Build unit options with current unit selected
    const allUnits = [
        { label: 'Weight', units: WEIGHT_UNITS },
        { label: 'Volume', units: VOLUME_UNITS },
        { label: 'Pans', units: PAN_UNITS },
        { label: 'Count', units: COUNT_UNITS },
        { label: 'Containers', units: CONTAINER_UNITS },
        { label: 'Task', units: TASK_UNITS }
    ];
    let unitOptions = '';
    allUnits.forEach(function(group) {
        const opts = group.units.map(function(u) {
            const sel = u === parUnit ? ' selected' : '';
            return '<option value="' + u + '"' + sel + '>' + u + '</option>';
        }).join('');
        unitOptions += '<optgroup label="' + group.label + '">' + opts + '</optgroup>';
    });

    panel.innerHTML = `
        <div class="te-handle"></div>
        <div class="te-name" oncontextmenu="event.preventDefault()">${ingName}</div>
        <div class="te-subtitle">Edit Timing</div>

        <div class="te-section-label">QUANTITY & UNIT</div>
        <div class="te-row">
            <input type="number" id="teQtyInput" class="te-qty-input"
                value="${parQty}" min="0.1" step="1" inputmode="decimal"
                oncontextmenu="event.stopPropagation()"
                oninput="debounce('teQty', function(){ teQtyChanged('${escapedName}'); }, 300)">
            <select id="teUnitSelect" class="te-unit-select"
                onchange="teUnitChanged('${escapedName}')">
                ${unitOptions}
            </select>
        </div>

        <div class="te-section-label">TIME</div>
        <div class="te-time-row">
            <div class="te-time-col">
                <input type="number" id="tmM" class="te-time-input" min="0" max="999" value="${totalMin}" inputmode="numeric"
                    oncontextmenu="event.stopPropagation()">
                <span class="te-time-label">min</span>
            </div>
            <span class="te-time-sep">:</span>
            <div class="te-time-col">
                <input type="number" id="tmS" class="te-time-input" min="0" max="59" value="${sec}" inputmode="numeric"
                    oncontextmenu="event.stopPropagation()">
                <span class="te-time-label">sec</span>
            </div>
        </div>
        ${refSeconds > 0 ? '<div class="te-current">Current: ' + formatTime(refSeconds) + '</div>' : ''}

        <button class="te-done-btn squishy" onclick="handleClick(); saveTimingFromEditor('${escapedName}')">Done</button>`;
}

function renderTimingUnitPicker(panel, ingName) {
    const escapedName = ingName.replace(/'/g, "\\'");

    panel.innerHTML = `
        <div class="te-handle"></div>
        <div class="te-name" oncontextmenu="event.preventDefault()">${ingName}</div>
        <div class="te-subtitle">Select a unit to continue</div>

        <select id="teUnitPicker" class="te-unit-select" style="width:100%;margin-bottom:18px;">
            <option value="" selected>Choose unit...</option>
            <optgroup label="Weight">
                ${WEIGHT_UNITS.map(u => '<option value="' + u + '">' + u + '</option>').join('')}
            </optgroup>
            <optgroup label="Volume">
                ${VOLUME_UNITS.map(u => '<option value="' + u + '">' + u + '</option>').join('')}
            </optgroup>
            <optgroup label="Pans">
                ${PAN_UNITS.map(u => '<option value="' + u + '">' + u + '</option>').join('')}
            </optgroup>
            <optgroup label="Count">
                ${COUNT_UNITS.map(u => '<option value="' + u + '">' + u + '</option>').join('')}
            </optgroup>
            <optgroup label="Containers">
                ${CONTAINER_UNITS.map(u => '<option value="' + u + '">' + u + '</option>').join('')}
            </optgroup>
            <optgroup label="Task">
                ${TASK_UNITS.map(u => '<option value="' + u + '">' + u + '</option>').join('')}
            </optgroup>
        </select>

        <button class="te-done-btn squishy" onclick="handleClick(); teSelectUnitAndContinue('${escapedName}')">Next</button>`;
}

function teSelectUnitAndContinue(ingName) {
    const panel = document.getElementById('tePanel');
    if (!panel) return;

    const unit = document.getElementById('teUnitPicker').value;
    if (!unit) {
        showToast('Please select a unit');
        return;
    }

    const stationId = parseInt(panel.dataset.stationId);
    const ingredientId = parseInt(panel.dataset.ingredientId);

    if (stationId && ingredientId) {
        applyParUnit(stationId, ingredientId, unit);
    }

    panel.dataset.mlUnit = unit;
    if (PAN_UNITS.includes(unit)) {
        panel.dataset.mlDepth = '4';
    } else {
        panel.dataset.mlDepth = '';
    }
    panel.dataset.mlQty = '1';
    panel.dataset.originalQty = '1';

    renderTimingQtyTime(panel, ingName);
}

function teUnitChanged(ingName) {
    const panel = document.getElementById('tePanel');
    if (!panel) return;

    const newUnit = document.getElementById('teUnitSelect').value;
    const oldUnit = panel.dataset.mlUnit;
    if (newUnit === oldUnit) return;

    const stationId = parseInt(panel.dataset.stationId);
    const ingredientId = parseInt(panel.dataset.ingredientId);

    if (stationId && ingredientId) {
        applyParUnit(stationId, ingredientId, newUnit);
    }

    panel.dataset.mlUnit = newUnit;
    if (PAN_UNITS.includes(newUnit)) {
        panel.dataset.mlDepth = '4';
    } else {
        panel.dataset.mlDepth = '';
    }

    const newFamily = getTimingFamily(newUnit);
    panel.dataset.family = newFamily;

    // Recalculate time with new unit
    teQtyChanged(ingName);
}

function teQtyChanged(ingName) {
    const panel = document.getElementById('tePanel');
    if (!panel) return;

    const key = ingName.toLowerCase();
    const tmpl = taskTemplates[key];
    const family = panel.dataset.family;
    if (!tmpl || !tmpl[family] || !tmpl[family].secPerBaseUnit || tmpl[family].secPerBaseUnit <= 0) return;

    const newQty = parseFloat(document.getElementById('teQtyInput').value);
    if (!newQty || newQty <= 0) return;

    const parUnit = panel.dataset.mlUnit;
    const parDepth = parseInt(panel.dataset.mlDepth) || null;

    const baseQty = convertToBase(newQty, parUnit, parDepth);
    const newTotalSec = Math.max(Math.round(tmpl[family].secPerBaseUnit * baseQty), 0);

    const totalMin = Math.floor(newTotalSec / 60);
    const sec = newTotalSec % 60;

    document.getElementById('tmM').value = totalMin;
    document.getElementById('tmS').value = sec;
}

function saveTimingFromEditor(ingName) {
    const panel = document.getElementById('tePanel');
    if (!panel) return;

    const m = parseInt(document.getElementById('tmM').value) || 0;
    const s = parseInt(document.getElementById('tmS').value) || 0;
    const totalSec = m * 60 + s;

    const family = panel.dataset.family || 'volume';
    const key = ingName.toLowerCase();

    // 00:00 clears timing
    if (totalSec <= 0) {
        const tmpl = taskTemplates[key];
        if (tmpl && tmpl[family]) {
            delete tmpl[family];
            if (!tmpl.volume && !tmpl.weight && !tmpl.count) delete taskTemplates[key];
        }
        saveTaskTemplates();
        closeTimingEditor();
        panelDirty.tools = true;
        panelDirty.home = true;
        renderPanel('home');
        renderPanel('tools');
        showToast(`${ingName}: timing cleared`);
        return;
    }

    const refQty = parseFloat(document.getElementById('teQtyInput').value) || 1;
    const refUnit = panel.dataset.mlUnit;
    const depth = PAN_UNITS.includes(refUnit) ? (parseInt(panel.dataset.mlDepth) || 4) : null;
    const baseQty = convertToBase(refQty, refUnit, depth);
    const secPerBase = baseQty > 0 ? totalSec / baseQty : 0;

    if (!taskTemplates[key]) taskTemplates[key] = { templateVersion: 3 };
    taskTemplates[key][family] = {
        secPerBaseUnit: secPerBase,
        refSeconds: totalSec,
        refQty: refQty,
        refUnit: refUnit,
        refDepth: depth,
        date: Date.now()
    };
    taskTemplates[key].templateVersion = 3;
    saveTaskTemplates();

    // Sync qty + unit change back to station data if changed
    const originalQty = parseFloat(panel.dataset.originalQty) || 0;
    const stationId = parseInt(panel.dataset.stationId);
    const ingredientId = parseInt(panel.dataset.ingredientId);

    if (stationId && ingredientId) {
        const station = stations.find(st => st.id === stationId);
        if (station && station.status[ingredientId]) {
            if (refQty !== originalQty) {
                station.status[ingredientId].parQty = refQty;
            }
            station.status[ingredientId].parUnit = refUnit;
            if (depth) station.status[ingredientId].parDepth = depth;
            else station.status[ingredientId].parDepth = null;
            updateParLevel(station, ingredientId);
            saveIngredientDefault(station, ingredientId);
            saveData(true);
            syncItemToChecklist(stationId, ingredientId);
        }
    }

    closeTimingEditor();
    panelDirty.tools = true;
    panelDirty.home = true;
    renderPanel('home');
    renderPanel('tools');
    showToast(`${ingName}: ${formatTime(totalSec)}`);
}

// ==================== ML STOPWATCH (Start/Stop Pill) ====================

function mlStopwatchStart(stationId, ingredientId) {
    handleClick();
    const key = `${stationId}-${ingredientId}`;
    const now = Date.now();
    mlStopwatches[key] = { startedAt: now, elapsed: 0, interval: null };
    mlStopwatches[key].interval = setInterval(() => {
        mlStopwatches[key].elapsed = Math.floor((Date.now() - now) / 1000);
        const btn = document.getElementById(`mlsw-${stationId}-${ingredientId}`);
        if (btn) btn.textContent = `Stop ${formatTime(mlStopwatches[key].elapsed)}`;
    }, 200);
    panelDirty.home = true;
    renderPanel('home');
}

function mlStopwatchStop(stationId, ingredientId) {
    handleClick();
    const key = `${stationId}-${ingredientId}`;
    const sw = mlStopwatches[key];
    if (!sw) return;
    clearInterval(sw.interval);
    const elapsed = Math.floor((Date.now() - sw.startedAt) / 1000);
    delete mlStopwatches[key];

    if (elapsed < 1) { showToast('Too short'); panelDirty.home = true; renderPanel('home'); return; }

    const day = getActiveDay();
    const item = (dayChecklists[day] || []).find(x => x.stationId === stationId && x.ingredientId === ingredientId);
    if (!item) return;

    const family = getTimingFamily(item.parUnit);
    const depth = PAN_UNITS.includes(item.parUnit) ? (item.parDepth || 4) : null;
    const baseQty = convertToBase(item.parQty || 1, item.parUnit || 'each', depth);
    const secPerBase = baseQty > 0 ? elapsed / baseQty : 0;
    const ingKey = item.name.toLowerCase();

    if (!taskTemplates[ingKey]) taskTemplates[ingKey] = { templateVersion: 3 };
    taskTemplates[ingKey][family] = {
        secPerBaseUnit: secPerBase,
        refSeconds: elapsed,
        refQty: item.parQty || 1,
        refUnit: item.parUnit || 'each',
        refDepth: depth,
        date: Date.now()
    };
    taskTemplates[ingKey].templateVersion = 3;
    saveTaskTemplates();

    showToast(`${item.name}: ${formatTime(elapsed)}`);
    panelDirty.home = true;
    panelDirty.tools = true;
    renderPanel('home');
}

// ==================== ML LONG PRESS TO EDIT TIMING ====================

function mlRowLongPressStart(event, stationId, ingredientId) {
    mlLongPressTimer = setTimeout(() => {
        mlLongPressTimer = null;
        if (navigator.vibrate) navigator.vibrate(30);
        const day = getActiveDay();
        const item = (dayChecklists[day] || []).find(x => x.stationId === stationId && x.ingredientId === ingredientId);
        if (item) showTimingEditor(item.name, item);
    }, 600);
}

function mlRowLongPressCancel() {
    if (mlLongPressTimer) { clearTimeout(mlLongPressTimer); mlLongPressTimer = null; }
}

function mlOpenTimingEditor(stationId, ingredientId) {
    const day = getActiveDay();
    const item = (dayChecklists[day] || []).find(x => x.stationId === stationId && x.ingredientId === ingredientId);
    if (item) showTimingEditor(item.name, item);
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

    // Close all other expanded ingredients in this station
    const prefix = `${stationId}-`;
    expandedIngs.forEach(k => { if (k.startsWith(prefix)) expandedIngs.delete(k); });

    if (!wasOpen) {
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

    // Auto-scroll to focused ingredient
    if (!wasOpen) {
        setTimeout(() => {
            const el = document.getElementById(`ing-${stationId}-${ingredientId}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
    }
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
    syncItemToChecklist(stationId, ingredientId);
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
    syncItemToChecklist(stationId, ingredientId);
    rerenderStationBody(stationId);
}

function setPriorityAndCollapse(stationId, ingredientId, priority) {
    handleClick();
    animateMascot();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    const st = station.status[ingredientId];

    // Toggle: if same priority, remove it
    if (st.priority === priority) {
        st.priority = null;
        st.low = false;
        st.completed = false;
    } else {
        st.priority = priority;
        st.low = true;
    }

    saveData(true);
    syncItemToChecklist(stationId, ingredientId);

    // Flash animation then collapse
    const el = document.getElementById(`ing-${stationId}-${ingredientId}`);
    if (el) {
        el.classList.add('ing-confirm-flash');
        setTimeout(() => {
            expandedIngs.delete(`${stationId}-${ingredientId}`);
            rerenderStationBody(stationId);
        }, 400);
    } else {
        expandedIngs.delete(`${stationId}-${ingredientId}`);
        rerenderStationBody(stationId);
    }
}

function setParQty(stationId, ingredientId, value) {
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    station.status[ingredientId].parQty = parseFloat(value) || null;
    updateParLevel(station, ingredientId);
    saveIngredientDefault(station, ingredientId);
    saveData(true);
    syncItemToChecklist(stationId, ingredientId);
}

function setParUnit(stationId, ingredientId, value) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    const st = station.status[ingredientId];
    const ing = getAllIngredients(station).find(i => i.id === ingredientId);

    // Family change notification
    if (ing && st.parUnit) {
        const oldFamily = getTimingFamily(st.parUnit);
        const newFamily = getTimingFamily(value);
        const families = getIngTimingFamilies(ing.name);
        if (oldFamily !== newFamily && families[oldFamily] && !families[newFamily] && newFamily !== 'count') {
            showFamilyChangeNotification(stationId, ingredientId, value, oldFamily, newFamily);
            return;
        }
    }

    applyParUnit(stationId, ingredientId, value);
}

function applyParUnit(stationId, ingredientId, value) {
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
    syncItemToChecklist(stationId, ingredientId);
    rerenderStationBody(stationId);
}

function showFamilyChangeNotification(stationId, ingredientId, newUnit, oldFamily, newFamily) {
    const overlay = document.createElement('div');
    overlay.className = 'time-picker-overlay';
    overlay.innerHTML = `
        <div class="time-picker-panel">
            <div class="tp-title">Family Change</div>
            <p style="font-size:13px;color:var(--text-secondary);margin:12px 0;line-height:1.5;">
                This ingredient has timing calculated by <b>${oldFamily}</b>.
                To use <b>${newUnit}</b> you need to record timing by <b>${newFamily}</b>.
            </p>
            <div class="tp-actions">
                <button class="tp-btn tp-cancel" onclick="closeTimePicker()">Keep Pre-set</button>
                <button class="tp-btn tp-save" onclick="applyParUnit(${stationId}, ${ingredientId}, '${newUnit}'); closeTimePicker()">Continue</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
}

function setParDepth(stationId, ingredientId, value) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    station.status[ingredientId].parDepth = parseInt(value) || 4;
    updateParLevel(station, ingredientId);
    saveIngredientDefault(station, ingredientId);
    saveData(true);
    syncItemToChecklist(stationId, ingredientId);
    rerenderStationBody(stationId);
}

function setParNotes(stationId, ingredientId, value) {
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    station.status[ingredientId].parNotes = value;
    saveData(true);
    syncItemToChecklist(stationId, ingredientId);
}

function togglePresetNote(stationId, ingredientId, preset) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    const st = station.status[ingredientId];

    const notesList = (st.parNotes || '').split(',').map(n => n.trim()).filter(Boolean);
    const idx = notesList.indexOf(preset);
    if (idx >= 0) {
        notesList.splice(idx, 1);
    } else {
        notesList.push(preset);
    }
    st.parNotes = notesList.join(', ');
    saveData(true);
    syncItemToChecklist(stationId, ingredientId);
    rerenderStationBody(stationId);
}

function setCustomNote(stationId, ingredientId, value) {
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    const st = station.status[ingredientId];

    // Preserve preset notes, replace custom part
    const notesList = (st.parNotes || '').split(',').map(n => n.trim()).filter(Boolean);
    const presets = notesList.filter(n => PRESET_NOTES.includes(n));
    const customParts = value.trim() ? [value.trim()] : [];
    st.parNotes = [...presets, ...customParts].join(', ');
    saveData(true);
    syncItemToChecklist(stationId, ingredientId);
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
    syncItemToChecklist(stationId, ingredientId);
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

function stationFooter(stationId, opts) {
    opts = opts || {};
    const mode = opts.mode || 'database';

    // Picker mode: no footer
    if (mode === 'picker') return '';

    // Database mode: quick-add + New Dish (no Clear Checklist)
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
    updateGlobalCount();
    showToast(`${name} added`);

    setTimeout(() => {
        const newInput = document.getElementById(`quickAdd_${stationId}_${dishId}`);
        if (newInput) newInput.focus();
    }, 50);
}

function rerenderStationBody(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    const activePanel = currentView === 'home' ? getPanel('home') : getPanel('tools');
    const body = activePanel ? activePanel.querySelector(`#body-${stationId}`) : document.getElementById(`body-${stationId}`);
    if (body) {
        const panel = body.closest('.swipe-panel');
        const scrollBefore = panel ? panel.scrollTop : 0;

        const isHomePicker = panel && panel.id === 'panelHome';
        const opts = isHomePicker
            ? { showPriority: true, mode: 'picker' }
            : { showPriority: false, mode: 'database' };

        body.innerHTML = renderIngredients(station, opts) + stationFooter(stationId, opts);
        // Add dimming class when an ingredient is focused
        const hasFocus = [...expandedIngs].some(k => k.startsWith(`${stationId}-`));
        if (hasFocus) body.classList.add('has-focus');
        else body.classList.remove('has-focus');
        if (panel) panel.scrollTop = scrollBefore;
    }
    updateStationCount(stationId);
}

function rerenderHomePanel() {
    panelDirty.home = true;
    renderPanel('home');
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
        message = '';
    } else if (totalActive > prepWindowSec) {
        status = 'behind';
        message = 'Over time';
    } else if (totalActive > prepWindowSec * 0.8) {
        status = 'tight';
        message = 'Tight';
    } else {
        status = 'ahead';
        message = 'On track';
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
            panelDirty.tools = true;
            rerenderHomePanel();
        }
    } else {
        station.status[ingredientId].completed = false;
        saveData(true);
        panelDirty.tools = true;
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
    panelDirty.tools = true;
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
    panelDirty.tools = true;
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
    panelDirty.tools = true;
}

function resetTaskTimer(timerKey) {
    const t = taskTimers[timerKey];
    if (!t) return;
    if (t.interval) clearInterval(t.interval);
    delete taskTimers[timerKey];
    forceUpdateTimerNotification();

    checkAndManageWakeLock();
    panelDirty.tools = true;
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
    panelDirty.tools = true;
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
    panelDirty.tools = true;
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
    panelDirty.tools = true;
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
    panelDirty.tools = true;
}

function resetBlockTimer(level) {
    const bt = blockTimers[level];
    if (!bt) return;
    if (bt.interval) clearInterval(bt.interval);
    delete blockTimers[level];
    forceUpdateTimerNotification();
    checkAndManageWakeLock();
    panelDirty.tools = true;
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

    const msgs = { behind: 'Behind', ontime: 'On Time', ahead: 'Ahead' };
    showToast(`${label}: ${msgs[status] || 'Done'}`);
    panelDirty.tools = true;
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
        panelDirty.tools = true;
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
    panelDirty.tools = true;
    renderPanel('tools');
}

function toggleLogsStation(block, stationName) {
    handleClick();
    const key = block + '_' + stationName;
    logsStationCollapsed[key] = !logsStationCollapsed[key];
    panelDirty.tools = true;
    renderPanel('tools');
}

function renderLogsContent() {
    // Collect ingredients grouped by station (preserving station association)
    const stationIngMap = {}; // { stationName: [{ name, stationName }] }
    const seenPerStation = {};
    stations.forEach(station => {
        if (!stationIngMap[station.name]) stationIngMap[station.name] = [];
        if (!seenPerStation[station.name]) seenPerStation[station.name] = new Set();
        getAllIngredients(station).forEach(ing => {
            const key = ing.name.toLowerCase();
            if (seenPerStation[station.name].has(key)) return;
            seenPerStation[station.name].add(key);
            stationIngMap[station.name].push({ name: ing.name, stationName: station.name });
        });
    });

    // Count unique ingredients for progress
    const uniqueNames = new Set();
    Object.values(stationIngMap).forEach(list => list.forEach(i => uniqueNames.add(i.name.toLowerCase())));
    const total = uniqueNames.size;

    if (total === 0) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">📝</div>
                <p>No ingredients yet</p>
                <p class="empty-sub">Add ingredients to your stations first</p>
            </div>`;
    }

    // Count volume/weight/each coverage
    let volCount = 0, wtCount = 0, eachCount = 0;
    uniqueNames.forEach(key => {
        const f = getIngTimingFamilies(key);
        if (f.volume) volCount++;
        if (f.weight) wtCount++;
        if (f.count) eachCount++;
    });
    const volPct = total > 0 ? Math.round(volCount / total * 100) : 0;
    const wtPct = total > 0 ? Math.round(wtCount / total * 100) : 0;
    const eachPct = total > 0 ? Math.round(eachCount / total * 100) : 0;

    // Progress dashboard
    let html = `
        <div class="logs-progress">
            <div class="logs-progress-row">
                <span class="logs-prog-label">Volume</span>
                <div class="logs-prog-bar"><div class="logs-prog-fill" style="width:${volPct}%"></div></div>
                <span class="logs-prog-count">${volCount}/${total}</span>
            </div>
            <div class="logs-progress-row">
                <span class="logs-prog-label">Weight</span>
                <div class="logs-prog-bar"><div class="logs-prog-fill" style="width:${wtPct}%"></div></div>
                <span class="logs-prog-count">${wtCount}/${total}</span>
            </div>
            <div class="logs-progress-row">
                <span class="logs-prog-label">Each</span>
                <div class="logs-prog-bar"><div class="logs-prog-fill" style="width:${eachPct}%"></div></div>
                <span class="logs-prog-count">${eachCount}/${total}</span>
            </div>
        </div>`;

    // Partition into with/missing per station
    const withByStation = {};
    const missingByStation = {};
    let totalWith = 0, totalMissing = 0;
    const globalSeen = new Set();

    Object.keys(stationIngMap).forEach(sName => {
        stationIngMap[sName].forEach(ing => {
            const lk = ing.name.toLowerCase();
            if (globalSeen.has(lk)) return;
            globalSeen.add(lk);
            if (ingredientHasTimingData(ing.name)) {
                if (!withByStation[sName]) withByStation[sName] = [];
                withByStation[sName].push(ing);
                totalWith++;
            } else {
                if (!missingByStation[sName]) missingByStation[sName] = [];
                missingByStation[sName].push(ing);
                totalMissing++;
            }
        });
    });

    // Block 1: With Timing Data
    html += `
        <div class="logs-block-header" onclick="toggleLogsBlock('withData')">
            <span>With Timing Data (${totalWith})</span>
            <span class="summary-expand-icon">${logsBlockCollapsed.withData ? '+' : '\u2212'}</span>
        </div>
        <div class="logs-block-body${logsBlockCollapsed.withData ? ' collapsed' : ''}">`;

    if (totalWith === 0) {
        html += `<div style="padding:12px 4px;font-size:12px;color:var(--text-muted);">No timing data yet</div>`;
    } else {
        Object.keys(withByStation).forEach(sName => {
            const collapsed = logsStationCollapsed['with_' + sName];
            const safeSName = sName.replace(/'/g, "\\'");
            html += `
            <div class="logs-station-header" onclick="toggleLogsStation('with','${safeSName}')">
                <span>${sName} (${withByStation[sName].length})</span>
                <span class="summary-expand-icon">${collapsed ? '+' : '\u2212'}</span>
            </div>
            <div class="logs-station-body${collapsed ? ' collapsed' : ''}">`;
            withByStation[sName].forEach(ing => {
                const escapedName = ing.name.replace(/'/g, "\\'");
                const families = getIngTimingFamilies(ing.name);
                const tmpl = taskTemplates[ing.name.toLowerCase()];
                let refInfo = '';
                if (tmpl) {
                    if (tmpl.volume && tmpl.volume.refSeconds > 0) refInfo += formatTime(tmpl.volume.refSeconds) + ' (' + (tmpl.volume.refQty || 1) + ' ' + (tmpl.volume.refUnit || '') + ')';
                    if (tmpl.weight && tmpl.weight.refSeconds > 0) {
                        if (refInfo) refInfo += ' · ';
                        refInfo += formatTime(tmpl.weight.refSeconds) + ' (' + (tmpl.weight.refQty || 1) + ' ' + (tmpl.weight.refUnit || '') + ')';
                    }
                }
                html += `
                <div class="log-ingredient-card" onclick="showTimingEditor('${escapedName}')" oncontextmenu="event.preventDefault();">
                    <div class="log-ing-top">
                        <span class="log-ing-name">${ing.name}</span>
                        <div class="log-timing-indicators">
                            <span class="timing-dot ${families.volume ? 'active' : ''}">V</span>
                            <span class="timing-dot ${families.weight ? 'active' : ''}">W</span>
                            <span class="timing-dot ${families.count ? 'active' : ''}">E</span>
                        </div>
                    </div>
                    ${refInfo ? `<div class="log-ing-bottom"><span class="log-ing-station">${refInfo}</span></div>` : ''}
                </div>`;
            });
            html += `</div>`;
        });
    }
    html += `</div>`;

    // Block 2: Missing Timing Data
    html += `
        <div class="logs-block-header" onclick="toggleLogsBlock('missingData')">
            <span>Missing Timing Data (${totalMissing})</span>
            <span class="summary-expand-icon">${logsBlockCollapsed.missingData ? '+' : '\u2212'}</span>
        </div>
        <div class="logs-block-body${logsBlockCollapsed.missingData ? ' collapsed' : ''}">`;

    if (totalMissing === 0) {
        html += `<div style="padding:12px 4px;font-size:12px;color:var(--text-muted);">All ingredients have timing data!</div>`;
    } else {
        Object.keys(missingByStation).forEach(sName => {
            const collapsed = logsStationCollapsed['missing_' + sName];
            const safeSName = sName.replace(/'/g, "\\'");
            html += `
            <div class="logs-station-header" onclick="toggleLogsStation('missing','${safeSName}')">
                <span>${sName} (${missingByStation[sName].length})</span>
                <span class="summary-expand-icon">${collapsed ? '+' : '\u2212'}</span>
            </div>
            <div class="logs-station-body${collapsed ? ' collapsed' : ''}">`;
            missingByStation[sName].forEach(ing => {
                const escapedName = ing.name.replace(/'/g, "\\'");
                html += `
                <div class="logs-missing-card" onclick="showTimingEditor('${escapedName}')" oncontextmenu="event.preventDefault();">
                    <div class="logs-missing-name">${ing.name}</div>
                </div>`;
            });
            html += `</div>`;
        });
    }
    html += `</div>`;

    return html;
}

function renderLogs(container) {
    container.innerHTML = renderLogsContent();
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
    panelDirty.tools = true;
    renderPanel('tools');
}

function renderHistoryContent() {
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

    // Read completed items for selected date
    const items = completedHistory[historySelectedDate] || [];

    if (items.length === 0) {
        html += `<div class="history-day-status">
            <div class="history-day-label">No Data</div>
            <div class="history-day-sub">No completed tasks this day</div>
        </div>`;
        return html;
    }

    // Group by station
    const byStation = {};
    items.forEach(item => {
        const sName = item.stationName || 'Unknown';
        if (!byStation[sName]) byStation[sName] = [];
        byStation[sName].push(item);
    });

    // Summary
    const stationNames = Object.keys(byStation);
    html += `<div class="history-day-status">
        <div class="history-day-label">${items.length} task${items.length !== 1 ? 's' : ''} completed</div>
        <div class="history-day-sub">${stationNames.length} station${stationNames.length !== 1 ? 's' : ''}</div>
    </div>`;

    // Render each station as a card with ingredient rows (station-expand style)
    stationNames.forEach(sName => {
        const stationItems = byStation[sName];
        html += `<div class="neu-card station-card">
            <div class="station-header" style="cursor:default;">
                <div class="station-header-left">
                    <span class="station-name">${sName}</span>
                    <span class="station-count">${stationItems.length}</span>
                </div>
            </div>
            <div class="station-body">`;

        stationItems.forEach(item => {
            const freshTime = getTimeForMasterList(item.name, item.parQty, item.parUnit, item.parDepth);
            const qtyDisplay = item.parQty && item.parUnit
                ? `${item.parQty} ${PAN_UNITS.includes(item.parUnit) ? (item.parDepth || 4) + '" ' + item.parUnit : item.parUnit}`
                : (item.parQty ? `${item.parQty}` : '');

            html += `<div class="ingredient has-priority priority-${item.priority || 'low'}" style="border-left-color:var(--success);">
                <div class="ingredient-header" style="cursor:default;">
                    <span class="priority-dot ${item.priority || 'low'}"></span>
                    <span class="ingredient-name" style="flex:1;text-decoration:line-through;opacity:0.7;">${item.name}</span>
                    ${qtyDisplay ? `<span class="ml-qty">${qtyDisplay}</span>` : ''}
                    ${freshTime ? `<span class="ml-time">${formatTime(freshTime)}</span>` : ''}
                </div>
            </div>`;
        });

        html += `</div></div>`;
    });

    return html;
}

function renderHistoryTab(container) {
    container.innerHTML = renderHistoryContent();
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
    updateGlobalCount();
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
    updateGlobalCount();
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
    updateGlobalCount();
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

    // Gesture-driven swipe — 3 persistent panels
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
        const basePct = swBaseIdx * 33.3333;
        const offsetPct = (dx / swViewportW) * 33.3333;
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
