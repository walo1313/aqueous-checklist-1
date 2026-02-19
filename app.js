// ==================== AQUEOUS - Kitchen Station Manager ====================

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
const VOLUME_UNITS = ['quart', 'pint', 'cup', 'oz'];
const WEIGHT_UNITS = ['lb'];
const COUNT_UNITS = ['each', 'batch'];

function getBaseUnit(unit) {
    if (VOLUME_UNITS.includes(unit)) return 'oz';
    if (WEIGHT_UNITS.includes(unit)) return 'lb';
    if (COUNT_UNITS.includes(unit)) return unit;
    return 'unit';
}

function convertToBase(qty, unit) {
    if (VOLUME_UNITS.includes(unit)) return qty * (UNIT_TO_OZ[unit] || 1);
    return qty;
}

function formatEstimate(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function getIngredientEstimate(ingName, parQty, parUnit) {
    const key = ingName.toLowerCase();
    const pt = prepTimes[key];
    if (!pt || !pt.bestSecPerUnit || !parQty || !parUnit) return null;
    const baseUnit = getBaseUnit(parUnit);
    if (pt.baseUnit && pt.baseUnit !== 'unit' && pt.baseUnit !== baseUnit) return null;
    const baseQty = convertToBase(parQty, parUnit);
    const estSeconds = Math.round(pt.bestSecPerUnit * baseQty);
    const bestPerDisplayUnit = Math.round(pt.bestSecPerUnit * (UNIT_TO_OZ[parUnit] || 1));
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

    // Restore saved view and nav highlight
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => item.classList.remove('active'));
    if (currentView === 'timer') currentView = 'logs'; // legacy redirect
    if (currentView === 'home') navItems[0].classList.add('active');
    else if (currentView === 'summary') navItems[1].classList.add('active');
    else if (currentView === 'logs') navItems[2].classList.add('active');
    else if (currentView === 'share') navItems[3].classList.add('active');
    else if (currentView === 'history') navItems[1].classList.add('active');
    else if (currentView === 'settings') { currentView = 'home'; navItems[0].classList.add('active'); }

    renderCurrentView();

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

function switchView(view) {
    // Toggle: if tapping mascot while already in settings, go back
    if (view === 'settings' && currentView === 'settings') {
        // Go back to previous view and pop the settings history entry
        skipPopstate = true;
        window.history.back();
        view = previousView || 'home';
    }

    // Save previous view (but not settings itself)
    if (currentView !== 'settings') {
        previousView = currentView;
    }

    if (view === 'timer') view = 'logs'; // legacy redirect
    currentView = view;
    sessionStorage.setItem('aqueous_currentView', view);
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const navItems = document.querySelectorAll('.nav-item');
    if (view === 'home') navItems[0].classList.add('active');
    else if (view === 'summary') navItems[1].classList.add('active');
    else if (view === 'logs') navItems[2].classList.add('active');
    else if (view === 'share') navItems[3].classList.add('active');
    else if (view === 'settings') { window.history.pushState({ view: 'settings' }, ''); }
    else if (view === 'history') navItems[1].classList.add('active');

    renderCurrentView();
}

function renderCurrentView() {
    const container = document.getElementById('mainContent');
    const fab = document.getElementById('fab');

    if (currentView === 'home') {
        fab.style.display = 'block';
        renderHome(container);
    } else if (currentView === 'summary') {
        fab.style.display = 'none';
        renderSummary(container);
    } else if (currentView === 'logs') {
        fab.style.display = 'none';
        renderLogs(container);
    } else if (currentView === 'share') {
        fab.style.display = 'none';
        renderShare(container);
    } else if (currentView === 'settings') {
        fab.style.display = 'none';
        renderSettings(container);
    } else if (currentView === 'history') {
        fab.style.display = 'none';
        renderHistory(container);
    }
}

// ==================== HOME VIEW ====================

function renderHome(container) {
    if (stations.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <p>No stations created</p>
                <p class="empty-sub">Tap the + button to add a station</p>
            </div>`;
        return;
    }

    let html = '';
    stations.forEach(station => {
        const lowCount = Object.values(station.status).filter(s => s.low).length;
        const isExpanded = station.expanded !== false;

        html += `
        <div class="neu-card">
            <div class="station-header" onclick="toggleStation(${station.id})">
                <div class="station-header-left">
                    <span class="station-name">${station.name}</span>
                    ${lowCount > 0 ? `<span class="count-badge">${lowCount}</span>` : ''}
                </div>
                <div class="station-header-right">
                    <button class="btn-icon" onclick="event.stopPropagation(); shareStation(${station.id})">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                    </button>
                    <button class="btn-icon" onclick="event.stopPropagation(); showEditStationModal(${station.id})">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                    </button>
                    <span class="chevron ${isExpanded ? 'expanded' : ''}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </span>
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
            parDisplay = `<span class="par-display">${st.parQty} ${st.parUnit}</span>`;
        } else if (st.low && st.parLevel) {
            parDisplay = `<span class="par-display">${st.parLevel}</span>`;
        }
        if (st.low && st.parNotes) {
            parDisplay += `<span class="par-display" style="font-style:italic;margin-left:4px;font-size:9px;">${st.parNotes}</span>`;
        }

        const unitOptions = ['quart','pint','cup','oz','lb','each','batch'];

        html += `
        <div class="ingredient ${st.low ? 'low' : ''}">
            <div class="ingredient-header">
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
                        <button class="stepper-btn" onclick="event.stopPropagation(); handleClick(); adjustParQty(${station.id}, ${ing.id}, -0.5)">−</button>
                        <input type="number" class="par-qty-input"
                            value="${st.parQty || ''}"
                            placeholder="0"
                            min="0" step="0.5" inputmode="decimal"
                            oninput="debounce('parq_${station.id}_${ing.id}', () => setParQty(${station.id}, ${ing.id}, this.value), 400)"
                            onclick="event.stopPropagation()">
                        <button class="stepper-btn" onclick="event.stopPropagation(); handleClick(); adjustParQty(${station.id}, ${ing.id}, 0.5)">+</button>
                    </div>
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

function toggleStation(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;
    station.expanded = station.expanded === false ? true : false;
    renderCurrentView();
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
    station.status[ingredientId].parUnit = value;
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

function updateParLevel(station, ingredientId) {
    const st = station.status[ingredientId];
    if (st.parQty && st.parUnit) {
        st.parLevel = `${st.parQty} ${st.parUnit}`;
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
        ingredientDefaults[key] = { qty: st.parQty, unit: st.parUnit };
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
        const scrollY = window.scrollY;
        body.innerHTML = renderIngredients(station) + stationFooter(stationId);
        window.scrollTo(0, scrollY);
    }
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

    // Global "All Blocks" timer
    const allBt = blockTimers['_all'];
    const allBtRunning = allBt && allBt.running;
    const allBtPaused = allBt && !allBt.running && allBt.seconds > 0;
    const allBtActive = allBtRunning || allBtPaused;
    const allBtTime = allBt ? formatTime(allBt.seconds) : '00:00';
    const incompletTotal = allTasks.filter(t => !t.status.completed).length;

    let globalTimerHTML = '';
    if (incompletTotal > 0) {
        if (allBtActive) {
            globalTimerHTML = `
                <div class="global-timer-card">
                    <div class="global-timer-label">All Blocks</div>
                    <div class="global-timer-display">
                        <span class="global-timer-clock" id="blockClock__all">${allBtTime}</span>
                        <div class="global-timer-controls">
                            ${allBtRunning ? `
                                <button class="block-timer-ctrl pause" onclick="pauseBlockTimer('_all')">⏸</button>
                            ` : `
                                <button class="block-timer-ctrl resume" onclick="resumeBlockTimer('_all')">▶</button>
                            `}
                            <button class="block-timer-ctrl reset" onclick="resetBlockTimer('_all')">✕</button>
                        </div>
                    </div>
                </div>`;
        } else {
            globalTimerHTML = `
                <div class="global-timer-card">
                    <button class="global-timer-start" onclick="toggleBlockTimer('_all')">
                        ⏱ Start All Blocks
                    </button>
                </div>`;
        }
    }

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
            ${globalTimerHTML}
        </div>
        <button class="btn btn-link" onclick="switchView('history')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            View 7-Day History
        </button>`;

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

    // Check if all completed
    if (completedCount === totalCount && totalCount > 0) {
        launchCelebration();
    }
}

function renderSummaryGroup(title, level, tasks) {
    const colorClass = level === 'none' ? '' : `summary-${level}`;

    // Calculate block time estimate
    let totalEstSeconds = 0;
    let hasEstimates = false;
    const incompleteTasks = tasks.filter(t => !t.status.completed);
    incompleteTasks.forEach(task => {
        const est = getIngredientEstimate(task.ingredient.name, task.status.parQty, task.status.parUnit);
        if (est) { totalEstSeconds += est.totalSeconds; hasEstimates = true; }
    });
    const estLabel = hasEstimates ? `⏱ ~${formatEstimate(totalEstSeconds)}` : '';

    // Block timer state
    const bt = blockTimers[level];
    const btRunning = bt && bt.running;
    const btPaused = bt && !bt.running && bt.seconds > 0;
    const btActive = btRunning || btPaused;
    const btTime = bt ? formatTime(bt.seconds) : '00:00';

    // Block timer controls for header
    let blockTimerHTML = '';
    if (incompleteTasks.length > 0) {
        if (btActive) {
            blockTimerHTML = `
                <div class="block-timer-row">
                    <span class="block-timer-clock" id="blockClock_${level}">${btTime}</span>
                    ${btRunning ? `
                        <button class="block-timer-ctrl pause" onclick="event.stopPropagation(); pauseBlockTimer('${level}')">⏸</button>
                    ` : `
                        <button class="block-timer-ctrl resume" onclick="event.stopPropagation(); resumeBlockTimer('${level}')">▶</button>
                    `}
                    <button class="block-timer-ctrl reset" onclick="event.stopPropagation(); resetBlockTimer('${level}')">✕</button>
                </div>`;
        } else {
            blockTimerHTML = `
                <button class="block-timer-start ${btRunning ? 'active' : ''}" onclick="event.stopPropagation(); toggleBlockTimer('${level}')">
                    ⏱ ${estLabel || 'Start'}
                </button>`;
        }
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
        const isPaused = timer && !timer.running && timer.seconds > 0;
        const hasTimer = isRunning || isPaused;
        const escapedName = task.ingredient.name.replace(/'/g, "\\'");

        // Per-ingredient time goal
        const est = getIngredientEstimate(task.ingredient.name, task.status.parQty, task.status.parUnit);
        const goalInfo = est
            ? `<span style="font-size:9px;color:var(--accent);">🏆 Best: ${formatEstimate(est.bestPerDisplayUnit)} per ${task.status.parUnit}</span>`
            : '';

        // Par display
        const parTag = task.status.parQty && task.status.parUnit
            ? `<span class="par-tag">${task.status.parQty} ${task.status.parUnit}</span>`
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
                    <span class="inline-timer-clock" id="clock_${timerKey}">${formatTime(timer.seconds)}</span>
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
        if (t && t.seconds > 0) {
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
            const scrollY = window.scrollY;
            renderSummary(document.getElementById('mainContent'));
            window.scrollTo(0, scrollY);
        }
    } else {
        // Unchecking — just toggle directly
        station.status[ingredientId].completed = false;
        saveData(true);
        const scrollY = window.scrollY;
        renderSummary(document.getElementById('mainContent'));
        window.scrollTo(0, scrollY);
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

// Re-acquire wake lock when page becomes visible again (phone unlocked)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Object.values(taskTimers).some(t => t.running)) {
        requestWakeLock();
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

function updateTimerNotification() {
    if (!settings.timerNotifications) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!navigator.serviceWorker) return;

    const running = Object.values(taskTimers).filter(t => t.running);
    const blockLabels = { high: 'Before Service', medium: 'Necessary', low: 'Backup', none: 'No Priority', _all: 'All Blocks' };
    const runningBlocks = Object.entries(blockTimers).filter(([k, v]) => v.running && !v.synced);

    if (running.length === 0 && runningBlocks.length === 0) {
        sendSWMessage({ type: 'TIMER_CLEAR' });
        return;
    }

    let lines = running.map(t => `⏱ ${t.ingName}: ${formatTime(t.seconds)}`);
    runningBlocks.forEach(([k, v]) => {
        lines.push(`🔲 ${blockLabels[k] || k}: ${formatTime(v.seconds)}`);
    });
    const totalActive = running.length + runningBlocks.length;
    const m = MASCOTS[settings.mascot] || MASCOTS.mascot;

    sendSWMessage({
        type: 'TIMER_UPDATE',
        body: lines.join('\n'),
        title: `${m.emoji} Aqueous — ${totalActive} timer${totalActive > 1 ? 's' : ''} active`
    });
}

// Listen for messages from Service Worker (notification action buttons)
if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'PAUSE_ALL_TIMERS') {
            Object.keys(taskTimers).forEach(key => {
                if (taskTimers[key].running) pauseTaskTimer(key);
            });
            Object.keys(blockTimers).forEach(key => {
                if (blockTimers[key].running) pauseBlockTimer(key);
            });
            showToast('⏸ All timers paused');
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
        seconds: 0,
        running: true,
        startedAt: Date.now(),
        interval: setInterval(() => {
            taskTimers[timerKey].seconds++;
            const clock = document.getElementById(`clock_${timerKey}`);
            if (clock) clock.textContent = formatTime(taskTimers[timerKey].seconds);
            // Update notification every 3 seconds
            if (taskTimers[timerKey].seconds % 3 === 0) updateTimerNotification();
        }, 1000)
    };

    updateTimerNotification();

    checkAndManageWakeLock();
    showToast(`⏱ Timing: ${ingName}`);
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function pauseTaskTimer(timerKey) {
    const t = taskTimers[timerKey];
    if (!t) return;
    if (t.interval) clearInterval(t.interval);
    t.interval = null;
    t.running = false;
    updateTimerNotification();

    checkAndManageWakeLock();
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function resumeTaskTimer(timerKey) {
    const t = taskTimers[timerKey];
    if (!t || t.running) return;
    t.running = true;
    t.interval = setInterval(() => {
        t.seconds++;
        const clock = document.getElementById(`clock_${timerKey}`);
        if (clock) clock.textContent = formatTime(t.seconds);
        if (t.seconds % 3 === 0) updateTimerNotification();
    }, 1000);

    checkAndManageWakeLock();
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function resetTaskTimer(timerKey) {
    const t = taskTimers[timerKey];
    if (!t) return;
    if (t.interval) clearInterval(t.interval);
    delete taskTimers[timerKey];
    updateTimerNotification();

    checkAndManageWakeLock();
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

// ── Block Timers ──
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
    blockTimers[level] = {
        seconds: 0,
        running: true,
        interval: setInterval(() => {
            blockTimers[level].seconds++;
            const clock = document.getElementById(`blockClock_${level}`);
            if (clock) clock.textContent = formatTime(blockTimers[level].seconds);
            if (level === '_all') {
                Object.keys(blockTimers).forEach(k => {
                    if (k !== '_all') {
                        const c = document.getElementById(`blockClock_${k}`);
                        if (c && blockTimers[k]) c.textContent = formatTime(blockTimers[k].seconds);
                    }
                });
            }
            if (blockTimers[level].seconds % 3 === 0) updateTimerNotification();
        }, 1000)
    };
    // If starting ALL, also start any block that doesn't have a timer
    if (level === '_all') {
        ['high', 'medium', 'low', 'none'].forEach(lv => {
            if (!blockTimers[lv] && document.getElementById(`blockClock_${lv}`)) {
                blockTimers[lv] = { seconds: 0, running: true, interval: null, synced: true };
            }
        });
    }
    updateTimerNotification();
    checkAndManageWakeLock();
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function pauseBlockTimer(level) {
    const bt = blockTimers[level];
    if (!bt) return;
    if (bt.interval) clearInterval(bt.interval);
    bt.interval = null;
    bt.running = false;
    if (level === '_all') {
        ['high', 'medium', 'low', 'none'].forEach(lv => {
            if (blockTimers[lv] && blockTimers[lv].synced) {
                blockTimers[lv].running = false;
            }
        });
    }
    updateTimerNotification();
    checkAndManageWakeLock();
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function resumeBlockTimer(level) {
    const bt = blockTimers[level];
    if (!bt || bt.running) return;
    bt.running = true;
    bt.interval = setInterval(() => {
        bt.seconds++;
        const clock = document.getElementById(`blockClock_${level}`);
        if (clock) clock.textContent = formatTime(bt.seconds);
        if (level === '_all') {
            Object.keys(blockTimers).forEach(k => {
                if (k !== '_all' && blockTimers[k] && blockTimers[k].synced) {
                    blockTimers[k].seconds++;
                    const c = document.getElementById(`blockClock_${k}`);
                    if (c) c.textContent = formatTime(blockTimers[k].seconds);
                }
            });
        }
        if (bt.seconds % 3 === 0) updateTimerNotification();
    }, 1000);
    if (level === '_all') {
        ['high', 'medium', 'low', 'none'].forEach(lv => {
            if (blockTimers[lv] && blockTimers[lv].synced) {
                blockTimers[lv].running = true;
            }
        });
    }
    checkAndManageWakeLock();
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function resetBlockTimer(level) {
    const bt = blockTimers[level];
    if (!bt) return;
    if (bt.interval) clearInterval(bt.interval);
    delete blockTimers[level];
    if (level === '_all') {
        ['high', 'medium', 'low', 'none'].forEach(lv => {
            if (blockTimers[lv] && blockTimers[lv].synced) {
                delete blockTimers[lv];
            }
        });
    }
    updateTimerNotification();
    checkAndManageWakeLock();
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function showTaskCompleteConfirm(stationId, ingredientId) {
    const timerKey = `${stationId}_${ingredientId}`;
    const t = taskTimers[timerKey];
    const station = stations.find(s => s.id === stationId);
    const ing = station ? station.ingredients.find(i => i.id === ingredientId) : null;
    if (!ing) return;

    const ingName = ing.name;
    const st = station.status[ingredientId];
    const timeStr = t ? formatTime(t.seconds) : '0:00';
    const defaultQty = st.parQty || 1;
    const defaultUnit = st.parUnit || '';

    // Pause timer if running
    if (t && t.running) {
        clearInterval(t.interval);
        t.interval = null;
        t.running = false;
    }

    const existing = document.getElementById('modalTaskComplete');
    if (existing) existing.remove();

    const unitLabel = defaultUnit ? `<span style="font-size:14px;font-weight:600;color:var(--text-secondary);margin-left:6px;">${defaultUnit}</span>` : '';

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
    if (t && t.seconds > 0 && ing) {
        const qtyEl = document.getElementById('completeQty');
        const qty = parseFloat(qtyEl ? qtyEl.value : 1) || 1;
        const key = ing.name.toLowerCase();
        const st = station.status[ingredientId];
        const unit = st.parUnit || 'unit';
        const baseQty = convertToBase(qty, unit);
        const secPerBaseUnit = baseQty > 0 ? t.seconds / baseQty : t.seconds;
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
            seconds: t.seconds,
            quantity: qty,
            unit,
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
    updateTimerNotification();


    // Mark completed
    if (station) station.status[ingredientId].completed = true;
    saveData(true);

    const modal = document.getElementById('modalTaskComplete');
    if (modal) modal.remove();

    animateMascot();
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
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

    // Collect filter options
    const allIngredients = new Set();
    const allStations = new Set();
    activityLog.forEach(entry => {
        if (entry.data && entry.data.ingredient) allIngredients.add(entry.data.ingredient);
        if (entry.data && entry.data.station) allStations.add(entry.data.station);
    });

    let html = `
        <div class="neu-card" style="padding:14px;">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <select id="logFilterIngredient" class="par-select" style="flex:1;" onchange="filterLogs()">
                    <option value="">All Ingredients</option>
                    ${[...allIngredients].sort().map(i => `<option value="${i}">${i}</option>`).join('')}
                </select>
                <select id="logFilterStation" class="par-select" style="flex:1;" onchange="filterLogs()">
                    <option value="">All Stations</option>
                    ${[...allStations].sort().map(s => `<option value="${s}">${s}</option>`).join('')}
                </select>
            </div>
        </div>`;

    // Find best times per ingredient
    const bestTimes = {};
    activityLog.forEach(entry => {
        if (entry.type !== 'task_complete' || !entry.data || !entry.data.seconds || entry.data.seconds === 0) return;
        const key = entry.data.ingredient;
        const spu = entry.data.secPerUnit || 0;
        if (spu > 0 && (!bestTimes[key] || spu < bestTimes[key])) bestTimes[key] = spu;
    });

    // Group by day
    const grouped = {};
    activityLog.forEach(entry => {
        if (entry.type !== 'task_complete' || !entry.data || !entry.data.seconds || entry.data.seconds === 0) return;
        const date = new Date(entry.timestamp);
        const key = date.toISOString().split('T')[0];
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(entry);
    });

    Object.keys(grouped).sort().reverse().forEach(dateKey => {
        const entries = grouped[dateKey];
        const dateObj = new Date(dateKey + 'T12:00:00');
        const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

        html += `
        <div class="log-day-card" data-day="${dateKey}">
            <div class="log-day-header">
                <span style="font-size:13px;font-weight:700;color:var(--text);">${dateStr}</span>
                <span style="font-size:11px;color:var(--text-muted);">${entries.length} task${entries.length !== 1 ? 's' : ''}</span>
            </div>`;

        entries.forEach(entry => {
            const d = entry.data;
            const isBest = bestTimes[d.ingredient] && d.secPerUnit <= bestTimes[d.ingredient];
            const time = new Date(entry.timestamp);
            const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

            html += `
            <div class="log-entry ${isBest ? 'log-best' : ''}" data-ingredient="${d.ingredient}" data-station="${d.station || ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <span style="font-size:13px;font-weight:700;">${d.ingredient}</span>
                        ${isBest ? '<span style="font-size:10px;color:var(--accent);margin-left:6px;">🏆 Best</span>' : ''}
                    </div>
                    <span style="font-size:10px;color:var(--text-muted);">${timeStr}</span>
                </div>
                <div style="display:flex;gap:14px;margin-top:4px;font-size:11px;color:var(--text-secondary);">
                    <span>⏱ ${formatTime(d.seconds)}</span>
                    <span>📦 ${d.quantity} ${d.unit || 'units'}</span>
                    <span>⚡ ${formatEstimate(d.secPerUnit)}/unit</span>
                </div>
                <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${d.station || ''} · ${entry.cook || ''}</div>
            </div>`;
        });

        html += '</div>';
    });

    container.innerHTML = html;
}

function filterLogs() {
    const ingFilter = document.getElementById('logFilterIngredient')?.value || '';
    const stFilter = document.getElementById('logFilterStation')?.value || '';

    document.querySelectorAll('.log-entry').forEach(el => {
        const matchIng = !ingFilter || el.dataset.ingredient === ingFilter;
        const matchSt = !stFilter || el.dataset.station === stFilter;
        el.style.display = (matchIng && matchSt) ? '' : 'none';
    });

    document.querySelectorAll('.log-day-card').forEach(card => {
        const visible = card.querySelectorAll('.log-entry:not([style*="display: none"])');
        card.style.display = visible.length > 0 ? '' : 'none';
    });
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
            const est = getIngredientEstimate(ing.name, st.parQty || 1, st.parUnit || 'unit');
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


// ==================== HISTORY VIEW ====================

function renderHistory(container) {
    if (history.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📅</div>
                <p>No history yet</p>
                <p class="empty-sub">Daily reports will appear here after each day</p>
            </div>
            <button class="btn btn-link" onclick="switchView('summary')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
                Back to Summary
            </button>`;
        return;
    }

    let html = `
        <button class="btn btn-link" onclick="switchView('summary')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Back to Summary
        </button>
        <h3 class="history-title">7-Day History</h3>`;

    history.forEach(entry => {
        const date = new Date(entry.date);
        const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

        let totalLow = 0;
        let totalCompleted = 0;

        entry.stations.forEach(station => {
            station.ingredients.forEach(ing => {
                const st = station.status[ing.id];
                if (st && st.low) {
                    totalLow++;
                    if (st.completed) totalCompleted++;
                }
            });
        });

        html += `
        <div class="history-card">
            <div class="history-card-header">
                <span class="history-date">${dateStr}</span>
                <span class="history-stats">${totalCompleted}/${totalLow} done</span>
            </div>`;

        entry.stations.forEach(station => {
            const lowItems = station.ingredients.filter(i => station.status[i.id] && station.status[i.id].low);
            if (lowItems.length > 0) {
                html += `<div class="history-station">
                    <span class="history-station-name">${station.name}</span>`;
                lowItems.forEach(i => {
                    const st = station.status[i.id];
                    html += `<div class="history-item ${st.completed ? 'done' : ''}">
                        ${st.completed ? '✅' : '⬜'} ${i.name}
                        ${st.parLevel ? `<span class="par-tag">${st.parLevel}</span>` : ''}
                    </div>`;
                });
                html += '</div>';
            }
        });

        html += '</div>';
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
            <div class="settings-group-title">About</div>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Aqueous</span>
                    <span class="setting-desc">Kitchen Station Manager v2.0</span>
                </div>
            </div>
        </div>`;

    container.innerHTML = html;
}

function renderPrepTimesTable() {
    let html = '<div style="margin-top:8px;">';
    Object.entries(prepTimes).forEach(([key, pt]) => {
        const mins = Math.floor(pt.avgSecPerUnit / 60);
        const secs = Math.round(pt.avgSecPerUnit % 60);
        html += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.04);font-size:11px;">
            <span style="font-weight:600;text-transform:capitalize;">${key}</span>
            <span style="color:var(--text-muted);">${mins}m ${secs}s/unit (${pt.count} logs)</span>
        </div>`;
    });
    html += '</div>';
    return html;
}

function selectMascot(key) {
    settings.mascot = key;
    saveSettings();
    updateHeader();
    renderSettings(document.getElementById('mainContent'));
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
    renderSettings(document.getElementById('mainContent'));
    showToast('Name updated!');
}

function clearPrepTimes() {
    if (!confirm('Clear all logged prep times?')) return;
    prepTimes = {};
    savePrepTimes();
    renderSettings(document.getElementById('mainContent'));
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

    // Swipe left/right gestures — swipe right goes to home, on home exits
    let touchStartX = 0;
    let touchStartY = 0;
    document.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        // Only trigger on horizontal swipe (dx > 80px, more horizontal than vertical)
        if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            if (dx > 0) {
                // Swipe right — go back
                if (currentView === 'settings') {
                    switchView(previousView || 'home');
                } else if (currentView !== 'home') {
                    switchView('home');
                }
            }
        }
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
