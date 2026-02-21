// ==================== AQUEOUS - Kitchen Station Manager ====================

const APP_VERSION = 'B2.0';
const APP_BUILD = 76;
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
let history = [];
let settings = { vibration: true, sound: true, cookName: '', mascot: 'mascot', wakeLock: true, timerNotifications: true };
let prepTimes = {}; // { "ingredientName": { avgSecPerUnit, bestSecPerUnit, count, baseUnit } }
let ingredientDefaults = {}; // { "ingredientname": { qty: N, unit: "quart" } }

// Mascot animation tracking
let checkCount = 0;
const mascotAnimations = ['mascot-wiggle', 'mascot-bounce', 'mascot-nod'];

// Multi-task timer state: { "stationId_ingredientId": { seconds, interval, running, ingName, stationId, ingredientId } }
let taskTimers = {};
let blockTimers = {}; // { "high": { seconds, running, interval }, "_all": { ... } }
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
    return { totalSeconds: estSeconds, bestPerDisplayUnit, displayUnit: parUnit };
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
        stations = [{
            id: Date.now(),
            name: 'My Station',
            ingredients: [
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
            ],
            status: {}
        }];
        stations[0].ingredients.forEach(ing => {
            stations[0].status[ing.id] = { low: false, priority: null, parLevel: '', completed: false };
        });
        saveData(true);
    }

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
}

function savePrepTimes() {
    localStorage.setItem('aqueous_prep_times', JSON.stringify(prepTimes));
}

function saveIngredientDefaults() {
    localStorage.setItem('aqueous_ingredient_defaults', JSON.stringify(ingredientDefaults));
}

function saveSettings() {
    localStorage.setItem('aqueous_settings', JSON.stringify(settings));
}

function saveData(silent) {
    localStorage.setItem('aqueous_stations', JSON.stringify(stations));
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
            station.ingredients.forEach(ing => {
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

function renderHome(container) {
    if (stations.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <p>No stations created</p>
                <p class="empty-sub">Go to Settings ⚙️ to add a station</p>
            </div>`;
        return;
    }

    let html = '';
    stations.forEach(station => {
        const lowCount = Object.values(station.status).filter(s => s.low).length;
        const totalCount = station.ingredients.length;
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

    container.innerHTML = html;
}

function renderIngredients(station) {
    let html = '';
    station.ingredients.forEach(ing => {
        const st = station.status[ing.id] || { low: false, priority: null, parLevel: '', parQty: null, parUnit: '', parNotes: '', completed: false };

        let parDisplay = '';
        if (st.low && st.parQty && st.parUnit) {
            parDisplay = `<span class="par-display">${formatParDisplay(st.parQty, st.parUnit, st.parDepth)}</span>`;
        } else if (st.low && st.parLevel) {
            parDisplay = `<span class="par-display">${st.parLevel}</span>`;
        }
        if (st.low && st.parNotes) {
            parDisplay += `<span class="par-display" style="font-style:italic;margin-left:4px;font-size:9px;">${st.parNotes}</span>`;
        }

        const unitOptions = ['quart','pint','cup','oz','1/9pan','1/6pan','1/3pan','1/2pan','fullpan','kg','lb','g','each','recipe'];

        const escapedIngName = ing.name.replace(/'/g, "\\'");
        html += `
        <div class="ingredient ${st.low ? 'low' : ''}">
            <div class="ingredient-header"
                 ontouchstart="startLongPress(event, ${station.id}, ${ing.id}, '${escapedIngName}')"
                 ontouchend="cancelLongPress()" ontouchmove="cancelLongPress()"
                 oncontextmenu="event.preventDefault(); showIngredientContextMenu(event, ${station.id}, ${ing.id}, '${escapedIngName}')">
                <label class="ingredient-label">
                    <input type="checkbox" class="neu-check"
                        ${st.low ? 'checked' : ''}
                        onchange="toggleLow(${station.id}, ${ing.id})">
                    <span class="ingredient-name">${ing.name}</span>
                </label>
                <div class="ingredient-badges">
                    ${parDisplay}
                </div>
            </div>
            <div class="ingredient-controls ${st.low ? '' : 'hidden'}">
                <div class="priority-row">
                    <button class="priority-btn ${st.priority === 'high' ? 'high' : ''}"
                        onclick="setPriority(${station.id}, ${ing.id}, 'high')">High</button>
                    <button class="priority-btn ${st.priority === 'medium' ? 'medium' : ''}"
                        onclick="setPriority(${station.id}, ${ing.id}, 'medium')">Medium</button>
                    <button class="priority-btn ${st.priority === 'low' ? 'low' : ''}"
                        onclick="setPriority(${station.id}, ${ing.id}, 'low')">Low</button>
                </div>
                <div class="par-row">
                    <div class="par-stepper">
                        <button class="stepper-btn" onclick="event.stopPropagation(); handleClick(); adjustParQty(${station.id}, ${ing.id}, -1)">−</button>
                        <input type="number" class="par-qty-input"
                            value="${st.parQty || ''}"
                            placeholder="0"
                            min="0" step="1" inputmode="decimal"
                            oninput="debounce('parq_${station.id}_${ing.id}', () => setParQty(${station.id}, ${ing.id}, this.value), 400)"
                            onclick="event.stopPropagation()">
                        <button class="stepper-btn" onclick="event.stopPropagation(); handleClick(); adjustParQty(${station.id}, ${ing.id}, 1)">+</button>
                    </div>
                    ${PAN_UNITS.includes(st.parUnit) ? `
                    <select class="par-select" onchange="event.stopPropagation(); setParDepth(${station.id}, ${ing.id}, this.value)" style="width:50px;">
                        <option value="2" ${st.parDepth == 2 ? 'selected' : ''}>2"</option>
                        <option value="4" ${st.parDepth == 4 || !st.parDepth ? 'selected' : ''}>4"</option>
                        <option value="6" ${st.parDepth == 6 ? 'selected' : ''}>6"</option>
                    </select>
                    ` : ''}
                    <select class="par-select" onchange="event.stopPropagation(); setParUnit(${station.id}, ${ing.id}, this.value)">
                        <option value="" ${!st.parUnit ? 'selected' : ''}>Unit</option>
                        ${unitOptions.map(u => `<option value="${u}" ${st.parUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
                    </select>
                </div>
                <div class="par-notes-row">
                    <input type="text" class="par-input par-notes-input" placeholder="Notes (descongelar, cocer...)"
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

function startLongPress(event, stationId, ingId, ingName) {
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (navigator.vibrate) navigator.vibrate(30);
        showIngredientContextMenu(event, stationId, ingId, ingName);
    }, 500);
}

function cancelLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
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
            <button class="context-menu-item delete" onclick="deleteIngredientFromHome(${stationId}, ${ingId})">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                Delete
            </button>
        </div>`;
    document.body.appendChild(menu);
    menu.onclick = function(e) { if (e.target === menu) menu.remove(); };
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
    const ing = station.ingredients.find(i => i.id === ingId);
    if (!ing) return;

    ing.name = newName;
    saveData(true);

    const modal = document.getElementById('modalEditIngredient');
    if (modal) modal.remove();

    rerenderStationBody(stationId);
    showToast(`Renamed to ${newName}`);
}

function deleteIngredientFromHome(stationId, ingId) {
    const menu = document.getElementById('ingredientContextMenu');
    if (menu) menu.remove();

    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const ing = station.ingredients.find(i => i.id === ingId);
    const name = ing ? ing.name : 'ingredient';

    station.ingredients = station.ingredients.filter(i => i.id !== ingId);
    delete station.status[ingId];
    if (taskTimers[`${stationId}_${ingId}`]) {
        clearInterval(taskTimers[`${stationId}_${ingId}`].interval);
        delete taskTimers[`${stationId}_${ingId}`];
    }

    saveData(true);
    rerenderStationBody(stationId);
    showToast(`${name} deleted`);
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

function toggleLow(stationId, ingredientId) {
    handleClick();
    animateMascot();
    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    if (!station.status[ingredientId]) {
        station.status[ingredientId] = { low: false, priority: null, parLevel: '', parQty: null, parUnit: '', parNotes: '', completed: false };
    }

    station.status[ingredientId].low = !station.status[ingredientId].low;

    if (station.status[ingredientId].low) {
        // Auto-fill from saved defaults
        const ing = station.ingredients.find(i => i.id === ingredientId);
        if (ing) {
            const key = ing.name.toLowerCase();
            const defaults = ingredientDefaults[key];
            if (defaults) {
                if (!station.status[ingredientId].parQty) station.status[ingredientId].parQty = defaults.qty;
                if (!station.status[ingredientId].parUnit) station.status[ingredientId].parUnit = defaults.unit;
                if (!station.status[ingredientId].parDepth && defaults.depth) station.status[ingredientId].parDepth = defaults.depth;
                updateParLevel(station, ingredientId);
            }
        }
    } else {
        station.status[ingredientId].priority = null;
        station.status[ingredientId].completed = false;
    }

    saveData(true);

    // Re-render only the station body to preserve scroll position
    rerenderStationBody(stationId);
}

function setPriority(stationId, ingredientId, priority) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;

    station.status[ingredientId].priority =
        station.status[ingredientId].priority === priority ? null : priority;

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
    const ing = station.ingredients.find(i => i.id === ingredientId);
    if (!ing) return;
    const key = ing.name.toLowerCase();
    if (st.parQty || st.parUnit) {
        ingredientDefaults[key] = { qty: st.parQty, unit: st.parUnit, depth: st.parDepth || null };
        saveIngredientDefaults();
    }
}

function stationFooter(stationId) {
    return `
        <div class="quick-add-row">
            <input type="text" class="quick-add-input" id="quickAdd_${stationId}" placeholder="Add ingredient..." onkeydown="if(event.key==='Enter'){quickAddIngredient(${stationId})}">
            <button class="quick-add-btn" onclick="quickAddIngredient(${stationId})">+</button>
        </div>
        <button class="btn btn-outline" onclick="resetStation(${stationId})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
            Clear Checklist
        </button>`;
}

function quickAddIngredient(stationId) {
    handleClick();
    const input = document.getElementById(`quickAdd_${stationId}`);
    if (!input) return;
    const name = input.value.trim();
    if (!name) { showToast('Enter an ingredient name'); return; }

    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    const newIng = { id: Date.now(), name };
    station.ingredients.push(newIng);
    station.status[newIng.id] = { low: false, priority: null, parLevel: '', parQty: null, parUnit: '', parNotes: '', completed: false };

    saveData(true);
    rerenderStationBody(stationId);
    showToast(`${name} added`);

    setTimeout(() => {
        const newInput = document.getElementById(`quickAdd_${stationId}`);
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
        if (panel) panel.scrollTop = scrollBefore;
    }
    updateStationCount(stationId);
}

function updateStationCount(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    const el = document.getElementById(`stationCount-${stationId}`);
    if (!el) return;
    const lowCount = Object.values(station.status).filter(s => s.low).length;
    const totalCount = station.ingredients.length;
    el.textContent = `${lowCount}/${totalCount}`;
    el.classList.toggle('all-done', lowCount > 0 && lowCount === totalCount);
}

// ==================== SUMMARY VIEW ====================

function renderSummary(container) {
    let allTasks = [];

    stations.forEach(station => {
        station.ingredients.forEach(ing => {
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
                <div class="empty-state-icon">✅</div>
                <p>All clear!</p>
                <p class="empty-sub">No items need attention right now</p>
            </div>`;
        return;
    }

    const highTasks = allTasks.filter(t => t.status.priority === 'high');
    const mediumTasks = allTasks.filter(t => t.status.priority === 'medium');
    const lowTasks = allTasks.filter(t => t.status.priority === 'low');
    const noPriority = allTasks.filter(t => !t.status.priority);

    const completedCount = allTasks.filter(t => t.status.completed).length;
    const totalCount = allTasks.length;
    const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    const today = new Date();
    const summaryDateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    let html = `
        <div class="summary-header-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="font-size:13px;font-weight:700;color:var(--text);">📅 ${summaryDateStr}</span>
            </div>
            <div class="progress-info">
                <span class="progress-text">${completedCount}/${totalCount} tasks done</span>
                <span class="progress-percent">${progress}%</span>
            </div>
            <div class="progress-bar-container">
                <div class="progress-bar" style="width: ${progress}%"></div>
            </div>
        </div>`;

    if (highTasks.length > 0) {
        html += renderSummaryGroup('Before Service', 'high', highTasks);
    }
    if (mediumTasks.length > 0) {
        html += renderSummaryGroup('Necessary, Not Urgent', 'medium', mediumTasks);
    }
    if (lowTasks.length > 0) {
        html += renderSummaryGroup('Backup for Next Days', 'low', lowTasks);
    }
    if (noPriority.length > 0) {
        html += renderSummaryGroup('No Priority Set', 'none', noPriority);
    }

    container.innerHTML = html;
}

function renderSummaryGroup(title, level, tasks) {
    const colorClass = level === 'none' ? '' : `summary-${level}`;

    // Block timer: only show if there's timing data for ingredients in this block
    const incompleteTasks = tasks.filter(t => !t.status.completed);
    const hasTimingData = blockHasTimingData(level);
    const totalEstSeconds = getBlockEstimateSeconds(level);

    // Block timer state
    const bt = blockTimers[level];
    const btRunning = bt && bt.running;
    const btPaused = bt && !bt.running;
    const btActive = btRunning || btPaused;
    const btRemaining = bt ? getBlockRemainingSeconds(bt) : 0;
    const btAbsTime = bt ? formatTime(Math.abs(btRemaining)) : '00:00';
    const btOvertime = bt && btRemaining < 0;

    // Block timer controls for header
    let blockTimerHTML = '';
    if (incompleteTasks.length > 0 && btActive) {
        blockTimerHTML = `
            <div class="block-timer-row">
                <span class="block-timer-clock ${btOvertime ? 'overtime' : ''}" id="blockClock_${level}">${btOvertime ? '-' : ''}${btAbsTime}</span>
                ${btRunning ? `
                    <button class="block-timer-ctrl pause" onclick="event.stopPropagation(); pauseBlockTimer('${level}')">⏸</button>
                ` : `
                    <button class="block-timer-ctrl resume" onclick="event.stopPropagation(); resumeBlockTimer('${level}')">▶</button>
                `}
                <button class="block-timer-ctrl reset" onclick="event.stopPropagation(); resetBlockTimer('${level}')">✕</button>
            </div>`;
    } else if (incompleteTasks.length > 0 && hasTimingData) {
        blockTimerHTML = `
            <button class="block-timer-start" onclick="event.stopPropagation(); toggleBlockTimer('${level}')">
                ⏱ ~${formatEstimate(totalEstSeconds)}
            </button>`;
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

        // Per-ingredient time goal
        const est = getIngredientEstimate(task.ingredient.name, task.status.parQty, task.status.parUnit, task.status.parDepth);
        const goalInfo = est
            ? `<span style="font-size:9px;color:var(--accent);">🏆 Best: ${formatEstimate(est.bestPerDisplayUnit)} per ${task.status.parUnit}</span>`
            : '';

        // Par display
        const parTag = task.status.parQty && task.status.parUnit
            ? `<span class="par-tag">${formatParDisplay(task.status.parQty, task.status.parUnit, task.status.parDepth)}</span>`
            : (task.status.parLevel ? `<span class="par-tag">${task.status.parLevel}</span>` : '');

        html += `
            <div class="summary-item ${task.status.completed ? 'done' : ''}">
                <label class="summary-check-label">
                    <input type="checkbox" class="neu-check"
                        ${task.status.completed ? 'checked' : ''}
                        onchange="toggleCompleted(${task.stationId}, ${task.ingredient.id})">
                    <div class="summary-item-info">
                        <span class="summary-item-name">${task.ingredient.name}</span>
                        <span class="summary-item-station">${task.stationName}</span>
                        ${goalInfo}
                    </div>
                </label>
                <div class="summary-item-actions">
                    ${parTag}
                    ${!task.status.completed ? `
                        <button class="task-timer-btn ${isRunning ? 'active' : ''} ${isPaused ? 'paused' : ''}" onclick="event.stopPropagation(); handleClick(); toggleTaskTimer('${timerKey}', ${task.stationId}, ${task.ingredient.id}, '${escapedName}')">
                            ⏱
                        </button>
                    ` : ''}
                </div>
            </div>`;

        // Inline timer row (shown when timer is active or paused)
        if (hasTimer && !task.status.completed) {
            html += `
                <div class="inline-timer-row" id="timer_${timerKey}">
                    <span class="inline-timer-clock" id="clock_${timerKey}">${formatTime(getTimerSeconds(timer))}</span>
                    <div class="inline-timer-controls">
                        ${isRunning ? `
                            <button class="inline-timer-btn pause" onclick="handleClick(); pauseTaskTimer('${timerKey}')">⏸</button>
                        ` : `
                            <button class="inline-timer-btn resume" onclick="handleClick(); resumeTaskTimer('${timerKey}')">▶</button>
                        `}
                        <button class="inline-timer-btn reset" onclick="handleClick(); resetTaskTimer('${timerKey}')">✕</button>
                    </div>
                </div>`;
        }
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
            // Timer was running — show confirmation with time
            showTaskCompleteConfirm(stationId, ingredientId);
        } else {
            // No timer — just complete directly, no popup
            if (t) { if (t.interval) clearInterval(t.interval); delete taskTimers[timerKey]; }
            station.status[ingredientId].completed = true;
            saveData(true);
            animateMascot();
            logActivity('task_complete', {
                ingredient: station.ingredients.find(i => i.id === ingredientId)?.name || '',
                station: station.name, seconds: 0, quantity: 0, secPerUnit: 0
            });
            const pLevel = station.status[ingredientId].priority || 'none';
            checkBlockCompletion(pLevel);
            refreshSummaryPanel();
        }
    } else {
        // Unchecking — just toggle directly
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
            station.ingredients.forEach(ing => {
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

    // Start new timer
    taskTimers[timerKey] = {
        stationId, ingredientId, ingName,
        running: true,
        startedAt: Date.now(),
        pausedElapsed: 0,
        interval: setInterval(() => {
            const clock = document.getElementById(`clock_${timerKey}`);
            if (clock) clock.textContent = formatTime(getTimerSeconds(taskTimers[timerKey]));
            updateTimerNotification();
        }, 1000)
    };

    forceUpdateTimerNotification();

    checkAndManageWakeLock();
    showToast(`⏱ Timing: ${ingName}`);
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

// ── Block Timers (countdown from estimated total) ──
function getBlockEstimateSeconds(level) {
    // Calculate total estimated seconds for incomplete tasks in this block
    const levelMap = { high: 'Before Service', medium: 'Necessary', low: 'Backup', none: 'No Priority' };
    let totalEst = 0;
    stations.forEach(station => {
        station.ingredients.forEach(ing => {
            const st = station.status[ing.id];
            if (!st || st.completed) return;
            if ((st.priority || 'none') !== level) return;
            const est = getIngredientEstimate(ing.name, st.parQty, st.parUnit, st.parDepth);
            if (est) totalEst += est.totalSeconds;
        });
    });
    return totalEst;
}

function blockHasTimingData(level) {
    // Check if ANY incomplete ingredient in this block has prepTimes data
    let has = false;
    stations.forEach(station => {
        station.ingredients.forEach(ing => {
            const st = station.status[ing.id];
            if (!st || st.completed) return;
            if ((st.priority || 'none') !== level) return;
            const key = ing.name.toLowerCase();
            if (prepTimes[key] && prepTimes[key].bestSecPerUnit) has = true;
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
    const estSeconds = getBlockEstimateSeconds(level);
    blockTimers[level] = {
        goalSeconds: estSeconds,
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
        station.ingredients.forEach(ing => {
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
    const ing = station ? station.ingredients.find(i => i.id === ingredientId) : null;
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

    const modal = document.createElement('div');
    modal.id = 'modalTaskComplete';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">✅ Task Done!</div>
            <p style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px;">${ingName}</p>
            <p style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">You took</p>
            <p style="font-size:28px;font-weight:800;color:var(--accent);margin-bottom:12px;">${timeStr}</p>
            <div class="form-group" style="margin-bottom:16px;">
                <label style="font-size:11px;font-weight:600;color:var(--text-secondary);">Quantity prepped</label>
                <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
                    <input type="number" id="completeQty" class="form-control" value="${defaultQty}" min="0.1" step="0.5" style="text-align:center;font-size:18px;width:100px;">
                    ${unitLabel}
                </div>
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="handleClick(); cancelTaskComplete(${stationId}, ${ingredientId})">Continue</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); confirmTaskComplete(${stationId}, ${ingredientId})">Done ✅</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
}

function confirmTaskComplete(stationId, ingredientId) {
    const timerKey = `${stationId}_${ingredientId}`;
    const t = taskTimers[timerKey];
    const station = stations.find(s => s.id === stationId);
    const ing = station ? station.ingredients.find(i => i.id === ingredientId) : null;

    // Log time to prepTimes database if timer was running
    const tSec = getTimerSeconds(t);
    if (t && tSec > 0 && ing) {
        const qtyEl = document.getElementById('completeQty');
        const qty = parseFloat(qtyEl ? qtyEl.value : 1) || 1;
        const key = ing.name.toLowerCase();
        const st = station.status[ingredientId];
        const unit = st.parUnit || 'unit';
        const baseQty = convertToBase(qty, unit, st.parDepth);
        const secPerBaseUnit = baseQty > 0 ? tSec / baseQty : tSec;
        const baseUnit = getBaseUnit(unit);

        if (!prepTimes[key]) {
            prepTimes[key] = { avgSecPerUnit: secPerBaseUnit, bestSecPerUnit: secPerBaseUnit, count: 1, baseUnit };
        } else {
            const pt = prepTimes[key];
            pt.avgSecPerUnit = ((pt.avgSecPerUnit * pt.count) + secPerBaseUnit) / (pt.count + 1);
            pt.bestSecPerUnit = Math.min(pt.bestSecPerUnit, secPerBaseUnit);
            pt.count++;
            if (pt.baseUnit === 'unit') pt.baseUnit = baseUnit;
        }
        savePrepTimes();

        logActivity('task_complete', {
            ingredient: ing.name,
            station: station.name,
            seconds: tSec,
            quantity: qty,
            unit,
            depth: st.parDepth || null,
            baseUnit,
            secPerUnit: Math.round(secPerBaseUnit)
        });
    } else if (ing) {
        logActivity('task_complete', {
            ingredient: ing.name,
            station: station.name,
            seconds: 0,
            quantity: 0,
            unit: '',
            secPerUnit: 0
        });
    }

    // Clean up timer
    if (t) {
        if (t.interval) clearInterval(t.interval);
        delete taskTimers[timerKey];
    }
    forceUpdateTimerNotification();

    // Mark completed
    if (station) station.status[ingredientId].completed = true;
    saveData(true);

    const modal = document.getElementById('modalTaskComplete');
    if (modal) modal.remove();

    animateMascot();
    if (station && station.status[ingredientId]) {
        const pLevel = station.status[ingredientId].priority || 'none';
        checkBlockCompletion(pLevel);
    }
    refreshSummaryPanel();
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
    if (station.ingredients.length === 0) return null;

    const lowItems = station.ingredients.filter(ing =>
        station.status[ing.id] && station.status[ing.id].low
    );
    const okItems = station.ingredients.filter(ing =>
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
        if (station.ingredients.length === 0) return;

        const lowItems = station.ingredients.filter(i =>
            station.status[i.id] && station.status[i.id].low
        );
        const okItems = station.ingredients.filter(i =>
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
    // Minify station data: include ALL ingredients, shorten keys
    const mini = data.map(s => {
        const items = s.ingredients.map(i => {
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
            const station = {
                id: Date.now() + Math.random() * 1000 | 0,
                name: s.s,
                ingredients: [],
                status: {},
                expanded: true
            };
            (s.i || []).forEach((item, idx) => {
                const ingId = Date.now() + idx + Math.random() * 1000 | 0;
                station.ingredients.push({ id: ingId, name: item.n });
                const pMap = { h: 'high', m: 'medium', l: 'low' };
                station.status[ingId] = {
                    low: !!item.l,
                    priority: item.p ? pMap[item.p] : null,
                    parLevel: item.v || '',
                    completed: !!item.c
                };
            });
            return station;
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

function renderLogs(container) {
    if (activityLog.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📝</div>
                <p>No prep logs yet</p>
                <p class="empty-sub">Complete tasks with timers to build your history</p>
            </div>`;
        return;
    }

    // Build unique ingredient map
    const ingredientMap = {};
    activityLog.forEach(entry => {
        if (entry.type !== 'task_complete' || !entry.data || !entry.data.seconds || entry.data.seconds === 0) return;
        const d = entry.data;
        const key = d.ingredient;
        if (!ingredientMap[key]) {
            ingredientMap[key] = { name: key, station: d.station || '', count: 0, bestSecPerUnit: Infinity, lastTimestamp: entry.timestamp };
        }
        const m = ingredientMap[key];
        m.count++;
        if (d.secPerUnit > 0 && d.secPerUnit < m.bestSecPerUnit) m.bestSecPerUnit = d.secPerUnit;
        if (entry.timestamp > m.lastTimestamp) { m.lastTimestamp = entry.timestamp; m.station = d.station || m.station; }
    });

    const ingredients = Object.values(ingredientMap).sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

    if (ingredients.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📝</div>
                <p>No prep logs yet</p>
                <p class="empty-sub">Complete tasks with timers to build your history</p>
            </div>`;
        return;
    }

    let html = `
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;padding:0 4px 10px;letter-spacing:0.3px;">${ingredients.length} ingredient${ingredients.length !== 1 ? 's' : ''} tracked</div>`;

    ingredients.forEach(ing => {
        const escapedName = ing.name.replace(/'/g, "\\'");
        html += `
        <button class="log-ingredient-card" onclick="handleClick(); openLogDetail('${escapedName}')">
            <div class="log-ing-top">
                <span class="log-ing-name">${ing.name}</span>
                <span class="log-ing-count">${ing.count} log${ing.count !== 1 ? 's' : ''}</span>
            </div>
            <div class="log-ing-bottom">
                <span class="log-ing-station">${ing.station}</span>
            </div>
            <svg class="log-ing-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>`;
    });

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

    // Find best (shortest) total time
    let bestSeconds = Infinity;
    entries.forEach(e => {
        if (e.data.seconds > 0 && e.data.seconds < bestSeconds) bestSeconds = e.data.seconds;
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
                    <span class="log-stat-label">Best</span>
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
            const isBest = bestSeconds < Infinity && d.seconds > 0 && d.seconds <= bestSeconds;
            const time = new Date(entry.timestamp);
            const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

            html += `
            <div class="log-entry ${isBest ? 'log-best' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="font-size:18px;font-weight:800;color:var(--accent);">${formatTime(d.seconds)}</span>
                        ${isBest ? '<span style="font-size:10px;color:var(--accent);display:flex;align-items:center;gap:2px;"><img src="./badge-96.png" style="width:12px;height:12px;">Best</span>' : ''}
                    </div>
                    <span style="font-size:10px;color:var(--text-muted);">${timeStr}</span>
                </div>
                <div style="display:flex;gap:14px;margin-top:4px;font-size:11px;color:var(--text-secondary);">
                    <span>${PAN_UNITS.includes(d.unit) ? formatParDisplay(d.quantity, d.unit, d.depth) : `${d.quantity} ${d.unit || 'units'}`}</span>
                    <span>${d.station || ''}</span>
                </div>
                ${entry.cook ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${entry.cook}</div>` : ''}
            </div>`;
        });

        html += '</div>';
    });

    container.innerHTML = html;
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
        station.ingredients.forEach(ing => {
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
            <div class="history-day-icon">📋</div>
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
    let dayIcon, dayLabel, daySub;
    if (dayDiff < -15) { dayIcon = '\u23F0'; dayLabel = 'Behind'; }
    else if (dayDiff > 15) { dayIcon = '\uD83C\uDFC6'; dayLabel = 'Ahead!'; }
    else { dayIcon = '\u2705'; dayLabel = 'On Time'; }
    const totalGoalStr = formatTime(Math.abs(totalGoal));
    const totalActualStr = formatTime(Math.abs(totalActual));
    daySub = `${entries.length} block${entries.length !== 1 ? 's' : ''} \u2022 Goal: ${totalGoalStr} \u2022 Actual: ${totalActualStr}`;

    html += `<div class="history-day-status">
        <div class="history-day-icon">${dayIcon}</div>
        <div class="history-day-label">${dayLabel}</div>
        <div class="history-day-sub">${daySub}</div>
    </div>`;

    entries.forEach(e => {
        const d = e.data || {};
        const statusLabels = { behind: 'Behind', ontime: 'On Time', ahead: 'Ahead' };
        const statusClass = d.status || 'ontime';
        const goalSec = d.goal || 0;
        const actualSec = goalSec - (d.seconds || 0);
        const goalStr = formatTime(Math.abs(goalSec));
        const actualStr = formatTime(Math.abs(actualSec));

        html += `<div class="history-block-card">
            <div class="history-block-info">
                <div class="history-block-name">${d.label || d.level || 'Block'}</div>
                <div class="history-block-time">Goal: ${goalStr} &nbsp; Actual: ${actualStr}</div>
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
        ingredients: [],
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
    if (station.ingredients.length === 0) {
        container.innerHTML = '<p class="empty-sub" style="padding:20px;text-align:center">No ingredients</p>';
        return;
    }

    container.innerHTML = '';
    station.ingredients.forEach(ing => {
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
    station.ingredients.push(newIng);
    station.status[newIng.id] = { low: false, priority: null, parLevel: '', parQty: null, parUnit: '', parNotes: '', completed: false };

    input.value = '';
    renderEditIngredients(station);
    saveData(true);
    showToast('Ingredient added');
}

function deleteIngredient(ingredientId) {
    if (!confirm('Delete this ingredient?')) return;

    const station = stations.find(s => s.id === editingStationId);
    if (!station) return;

    station.ingredients = station.ingredients.filter(i => i.id !== ingredientId);
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

    station.ingredients.forEach(ing => {
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
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        Check for Updates
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
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CHECK_UPDATE' });
    }
    // Also try to update SW registration
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then(reg => {
            if (reg) {
                reg.update().then(() => {
                    if (reg.waiting) {
                        showToast('🆕 New version available! Restart app to update.');
                    } else {
                        showToast(`✓ You're on the latest version (${APP_VERSION} Build ${APP_BUILD})`);
                    }
                }).catch(() => {
                    showToast(`✓ You're on the latest version (${APP_VERSION} Build ${APP_BUILD})`);
                });
            }
        });
    } else {
        showToast(`✓ Version ${APP_VERSION} Build ${APP_BUILD}`);
    }
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
