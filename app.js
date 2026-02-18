// ==================== AQUEOUS - Kitchen Station Manager ====================

let stations = [];
let editingStationId = null;
let currentView = 'home';
let history = [];
let settings = { vibration: true, sound: true, cookName: '', mascot: 'mascot' };
let prepTimes = {}; // { "ingredientName": { avgSecPerUnit: N, count: N } }

// Timer state
let timerMode = 'countdown'; // countdown, stopwatch
let timerSeconds = 0;
let timerTarget = 0;
let timerRunning = false;
let timerInterval = null;
let timerAlarm = false;
let timerLabel = '';
let alarmRepeater = null;

// Mascot animation tracking
let checkCount = 0;
const mascotAnimations = ['mascot-wiggle', 'mascot-bounce', 'mascot-nod'];

// Individual task timer state
let taskTimer = { active: false, stationId: null, ingredientId: null, ingName: '', seconds: 0, interval: null };

// Mascot definitions — type: 'video' for mp4, 'image' for png/gif
const MASCOTS = {
    mascot:    { file: 'mascot.png',            name: 'Chef Buddy',   personality: 'The Original',  emoji: '👨‍🍳', type: 'image' },
    explosive: { file: 'mascot-explosive.mp4',  name: 'Fuego',        personality: 'The Explosive', emoji: '🔥', type: 'video' },
    chill:     { file: 'mascot-chill.png',      name: 'Rasta',        personality: 'The Chill One', emoji: '🌿', type: 'image' },
    sad:       { file: 'mascot-sad.png',        name: 'Onion',        personality: 'The Sad One',   emoji: '😢', type: 'image' },
    excited:   { file: 'mascot-excited.png',    name: 'Sparky',       personality: 'The Hyper One', emoji: '🎉', type: 'image' },
    sexy:      { file: 'mascot-sexy.png',       name: 'Smooth',       personality: 'The Flirty One', emoji: '😏', type: 'image' },
    asian:     { file: 'mascot-asian.png',      name: 'Umami',        personality: 'The Wise One',  emoji: '🍜', type: 'image' }
};

// Debounce utility
let _debounceTimers = {};
function debounce(key, fn, delay) {
    if (_debounceTimers[key]) clearTimeout(_debounceTimers[key]);
    _debounceTimers[key] = setTimeout(fn, delay || 400);
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
    // Update mascot (image or video) with fallback
    const container = document.getElementById('mascotContainer');
    if (container) {
        const m = MASCOTS[settings.mascot] || MASCOTS.mascot;
        if (m.type === 'video') {
            container.innerHTML = `<video src="${m.file}" class="header-mascot" autoplay loop muted playsinline onerror="this.outerHTML='<div class=\\'header-mascot mascot-fallback\\'>${m.emoji}</div>'"></video>`;
        } else {
            container.innerHTML = `<img src="${m.file}" alt="${m.name}" class="header-mascot" onerror="this.outerHTML='<div class=\\'header-mascot mascot-fallback\\'>${m.emoji}</div>'">`;
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
}

function savePrepTimes() {
    localStorage.setItem('aqueous_prep_times', JSON.stringify(prepTimes));
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

function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const navItems = document.querySelectorAll('.nav-item');
    if (view === 'home') navItems[0].classList.add('active');
    else if (view === 'summary') navItems[1].classList.add('active');
    else if (view === 'timer') navItems[2].classList.add('active');
    else if (view === 'share') navItems[3].classList.add('active');
    else if (view === 'settings') navItems[4].classList.add('active');
    else if (view === 'history') { /* sub-view of summary, highlight summary */ navItems[1].classList.add('active'); }

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
    } else if (currentView === 'timer') {
        fab.style.display = 'none';
        renderTimer(container);
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
                <button class="btn btn-outline" onclick="resetStation(${station.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
                    Clear Checklist
                </button>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

function renderIngredients(station) {
    let html = '';
    station.ingredients.forEach(ing => {
        const st = station.status[ing.id] || { low: false, priority: null, parLevel: '', completed: false };

        const parDisplay = st.low && st.parLevel
            ? `<span class="par-display">${st.parLevel}</span>`
            : '';

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
                    <label class="par-label">Par:</label>
                    <input type="text" class="par-input" placeholder="e.g. 1 quart"
                        value="${st.parLevel || ''}"
                        oninput="debounce('par_${station.id}_${ing.id}', () => setParLevel(${station.id}, ${ing.id}, this.value), 600)"
                        onclick="event.stopPropagation()">
                    <select class="par-select" onchange="applyUnit(${station.id}, ${ing.id}, this.value); this.selectedIndex=0;">
                        <option value="">Unit</option>
                        <option value="quart">quart</option>
                        <option value="pint">pint</option>
                        <option value="cup">cup</option>
                        <option value="lb">lb</option>
                        <option value="oz">oz</option>
                        <option value="each">each</option>
                        <option value="batch">batch</option>
                    </select>
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
        station.status[ingredientId] = { low: false, priority: null, parLevel: '', completed: false };
    }

    station.status[ingredientId].low = !station.status[ingredientId].low;

    if (!station.status[ingredientId].low) {
        station.status[ingredientId].priority = null;
        station.status[ingredientId].completed = false;
    }

    saveData(true);

    // Re-render only the station body to preserve scroll position
    const body = document.getElementById(`body-${stationId}`);
    if (body) {
        const scrollY = window.scrollY;
        body.innerHTML = renderIngredients(station) + `
            <button class="btn btn-outline" onclick="resetStation(${stationId})">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
                Clear Checklist
            </button>`;
        window.scrollTo(0, scrollY);
    }
}

function setPriority(stationId, ingredientId, priority) {
    handleClick();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;

    station.status[ingredientId].priority =
        station.status[ingredientId].priority === priority ? null : priority;

    saveData(true);

    const body = document.getElementById(`body-${stationId}`);
    if (body) {
        const scrollY = window.scrollY;
        body.innerHTML = renderIngredients(station) + `
            <button class="btn btn-outline" onclick="resetStation(${stationId})">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
                Clear Checklist
            </button>`;
        window.scrollTo(0, scrollY);
    }
}

function setParLevel(stationId, ingredientId, value) {
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;
    station.status[ingredientId].parLevel = value;
    saveData(true);
}

function applyUnit(stationId, ingredientId, unit) {
    if (!unit) return;
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;

    const current = station.status[ingredientId].parLevel || '';
    const numMatch = current.match(/^[\d.]+/);
    const num = numMatch ? numMatch[0] + ' ' : '';
    station.status[ingredientId].parLevel = num + unit;

    saveData(true);
    const body = document.getElementById(`body-${stationId}`);
    if (body) {
        const scrollY = window.scrollY;
        body.innerHTML = renderIngredients(station) + `
            <button class="btn btn-outline" onclick="resetStation(${stationId})">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
                Clear Checklist
            </button>`;
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

    // Floating task timer bar
    if (taskTimer.active) {
        html += `
            <div class="task-timer-floating" id="taskTimerBar">
                <div class="task-timer-info">
                    <span class="task-timer-name">⏱ ${taskTimer.ingName}</span>
                    <span class="task-timer-clock" id="taskTimerClock">${formatTime(taskTimer.seconds)}</span>
                </div>
                <div class="task-timer-controls">
                    <button class="task-timer-action stop" onclick="handleClick(); stopTaskTimer()">⏹ Stop</button>
                    <button class="task-timer-action save" onclick="handleClick(); saveTaskTimer()">💾 Log</button>
                </div>
            </div>`;
    }

    container.innerHTML = html;

    // Check if all completed
    if (completedCount === totalCount && totalCount > 0) {
        launchCelebration();
    }
}

function renderSummaryGroup(title, level, tasks) {
    const colorClass = level === 'none' ? '' : `summary-${level}`;
    let html = `
        <div class="summary-group ${colorClass}">
            <div class="summary-group-title">${title}</div>`;

    tasks.forEach(task => {
        const isTimingThis = taskTimer.active && taskTimer.stationId === task.stationId && taskTimer.ingredientId === task.ingredient.id;
        const key = task.ingredient.name.toLowerCase();
        const pt = prepTimes[key];
        const avgInfo = pt ? `~${Math.floor(pt.avgSecPerUnit / 60)}m${Math.round(pt.avgSecPerUnit % 60)}s/unit` : '';

        html += `
            <div class="summary-item ${task.status.completed ? 'done' : ''}">
                <label class="summary-check-label">
                    <input type="checkbox" class="neu-check"
                        ${task.status.completed ? 'checked' : ''}
                        onchange="toggleCompleted(${task.stationId}, ${task.ingredient.id})">
                    <div class="summary-item-info">
                        <span class="summary-item-name">${task.ingredient.name}</span>
                        <span class="summary-item-station">${task.stationName}${avgInfo ? ' · ' + avgInfo : ''}</span>
                    </div>
                </label>
                <div class="summary-item-actions">
                    ${task.status.parLevel ? `<span class="par-tag">${task.status.parLevel}</span>` : ''}
                    ${!task.status.completed ? `
                        <button class="task-timer-btn ${isTimingThis ? 'active' : ''}" onclick="event.stopPropagation(); handleClick(); toggleTaskTimer(${task.stationId}, ${task.ingredient.id}, '${task.ingredient.name.replace(/'/g, "\\'")}')">
                            ${isTimingThis ? '⏱' : '⏱'}
                        </button>
                    ` : ''}
                </div>
            </div>`;
    });

    html += '</div>';
    return html;
}

function toggleCompleted(stationId, ingredientId) {
    handleClick();
    animateMascot();
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;

    station.status[ingredientId].completed = !station.status[ingredientId].completed;
    saveData(true);

    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

// ==================== INDIVIDUAL TASK TIMER ====================

function toggleTaskTimer(stationId, ingredientId, ingName) {
    // If already timing this task, stop it
    if (taskTimer.active && taskTimer.stationId === stationId && taskTimer.ingredientId === ingredientId) {
        pauseTaskTimer();
        return;
    }

    // If timing a different task, stop old one first
    if (taskTimer.active) {
        clearInterval(taskTimer.interval);
    }

    // Start new task timer
    taskTimer = {
        active: true,
        stationId: stationId,
        ingredientId: ingredientId,
        ingName: ingName,
        seconds: 0,
        interval: setInterval(() => {
            taskTimer.seconds++;
            updateTaskTimerDisplay();
        }, 1000)
    };

    showToast(`Timing: ${ingName}`);
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function pauseTaskTimer() {
    if (taskTimer.interval) clearInterval(taskTimer.interval);
    taskTimer.interval = null;
    // Don't reset — keep seconds so user can log
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function stopTaskTimer() {
    if (taskTimer.interval) clearInterval(taskTimer.interval);
    taskTimer = { active: false, stationId: null, ingredientId: null, ingName: '', seconds: 0, interval: null };
    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
}

function saveTaskTimer() {
    if (taskTimer.seconds <= 0) {
        showToast('No time recorded');
        return;
    }

    // Show modal to confirm quantity and save
    const existing = document.getElementById('modalTaskLog');
    if (existing) existing.remove();

    const key = taskTimer.ingName.toLowerCase();
    const station = stations.find(s => s.id === taskTimer.stationId);
    const ing = station ? station.ingredients.find(i => i.id === taskTimer.ingredientId) : null;
    const st = station && ing ? station.status[ing.id] : null;
    const defaultQty = st && st.parLevel ? (parseFloat(st.parLevel) || 1) : 1;

    const modal = document.createElement('div');
    modal.id = 'modalTaskLog';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">Log Prep Time</div>
            <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">
                <strong>${taskTimer.ingName}</strong>
            </p>
            <p style="font-size:24px;font-weight:800;color:var(--accent);margin-bottom:16px;">${formatTime(taskTimer.seconds)}</p>
            <div class="form-group">
                <label style="font-size:12px;font-weight:600;">Quantity prepped (units)</label>
                <input type="number" id="taskLogQty" class="form-control" value="${defaultQty}" min="0.1" step="0.5" style="text-align:center;font-size:18px;">
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('modalTaskLog').remove()">Cancel</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); confirmTaskLog()">Save</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
}

function confirmTaskLog() {
    const qtyEl = document.getElementById('taskLogQty');
    const qty = parseFloat(qtyEl ? qtyEl.value : 1) || 1;
    const key = taskTimer.ingName.toLowerCase();
    const secPerUnit = taskTimer.seconds / qty;

    if (!prepTimes[key]) {
        prepTimes[key] = { avgSecPerUnit: secPerUnit, count: 1 };
    } else {
        const pt = prepTimes[key];
        pt.avgSecPerUnit = ((pt.avgSecPerUnit * pt.count) + secPerUnit) / (pt.count + 1);
        pt.count++;
    }

    savePrepTimes();

    const modal = document.getElementById('modalTaskLog');
    if (modal) modal.remove();

    const mins = Math.floor(secPerUnit / 60);
    const secs = Math.round(secPerUnit % 60);
    showToast(`Logged: ${mins}m ${secs}s per unit for ${taskTimer.ingName}`);

    stopTaskTimer();
}

function updateTaskTimerDisplay() {
    const clock = document.getElementById('taskTimerClock');
    if (clock) {
        clock.textContent = formatTime(taskTimer.seconds);
    }
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

// ==================== TIMER VIEW ====================

function renderTimer(container) {
    const displayTime = timerMode === 'countdown'
        ? formatTime(Math.max(0, timerTarget - timerSeconds))
        : formatTime(timerSeconds);

    const isAlarm = timerMode === 'countdown' && timerRunning && timerSeconds >= timerTarget;
    const displayClass = isAlarm ? 'alarm' : (timerRunning ? 'running' : '');

    // Calculate smart block suggestions
    const blockSuggestions = calculateBlockGoals();

    container.innerHTML = `
        <div class="timer-card">
            <div class="timer-mode-tabs">
                <button class="timer-mode-tab ${timerMode === 'countdown' ? 'active' : ''}"
                    onclick="handleClick(); setTimerMode('countdown')">⏳ Countdown</button>
                <button class="timer-mode-tab ${timerMode === 'stopwatch' ? 'active' : ''}"
                    onclick="handleClick(); setTimerMode('stopwatch')">⏱ Stopwatch</button>
            </div>

            ${timerMode === 'countdown' && !timerRunning && timerSeconds === 0 ? `
                <div class="timer-label">Set Time</div>
                <div class="timer-input-row">
                    <input type="number" class="timer-input" id="timerMin" value="5" min="0" max="99" placeholder="MM">
                    <span class="timer-sep">:</span>
                    <input type="number" class="timer-input" id="timerSec" value="00" min="0" max="59" placeholder="SS">
                </div>
                <div class="timer-presets">
                    <button class="timer-preset-btn" onclick="handleClick(); setTimerPreset(2)">2 min</button>
                    <button class="timer-preset-btn" onclick="handleClick(); setTimerPreset(5)">5 min</button>
                    <button class="timer-preset-btn" onclick="handleClick(); setTimerPreset(10)">10 min</button>
                    <button class="timer-preset-btn" onclick="handleClick(); setTimerPreset(15)">15 min</button>
                    <button class="timer-preset-btn" onclick="handleClick(); setTimerPreset(30)">30 min</button>
                </div>
            ` : `
                <div class="timer-label">${timerLabel || (timerMode === 'countdown' ? 'Countdown' : 'Stopwatch')}</div>
                <div class="timer-display ${displayClass}" id="timerDisplay">${displayTime}</div>
            `}

            <div class="timer-controls">
                ${!timerRunning ? `
                    <button class="btn btn-primary squishy" onclick="handleClick(); startTimer()">
                        ${timerSeconds > 0 ? '▶ Resume' : '▶ Start'}
                    </button>
                    ${timerSeconds > 0 ? `
                        <button class="btn btn-secondary squishy" onclick="handleClick(); resetTimer()">↺ Reset</button>
                    ` : ''}
                ` : `
                    <button class="btn btn-danger squishy" onclick="handleClick(); pauseTimer()">⏸ Pause</button>
                    <button class="btn btn-secondary squishy" onclick="handleClick(); resetTimer()">↺ Reset</button>
                `}
            </div>
        </div>

        <div class="timer-card">
            <div class="timer-label">Prep Block Timers</div>
            <p style="font-size:10px;color:var(--text-muted);margin-bottom:12px;font-weight:500;">Goals adjust based on your prep history</p>

            ${blockSuggestions.high.items > 0 ? `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <button class="btn btn-outline squishy" style="flex:1;margin:0" onclick="handleClick(); startBlockTimer('Before Service', ${blockSuggestions.high.mins})">
                    🔴 Before Service — ${blockSuggestions.high.mins} min
                </button>
                <button class="timer-preset-btn" onclick="handleClick(); editBlockMinutes('high', ${blockSuggestions.high.mins})" title="Edit">✏️</button>
            </div>
            <p style="font-size:9px;color:var(--text-muted);margin-bottom:12px;">${blockSuggestions.high.detail}</p>
            ` : ''}

            ${blockSuggestions.medium.items > 0 ? `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <button class="btn btn-outline squishy" style="flex:1;margin:0" onclick="handleClick(); startBlockTimer('Prep Block', ${blockSuggestions.medium.mins})">
                    🟡 Prep Block — ${blockSuggestions.medium.mins} min
                </button>
                <button class="timer-preset-btn" onclick="handleClick(); editBlockMinutes('medium', ${blockSuggestions.medium.mins})" title="Edit">✏️</button>
            </div>
            <p style="font-size:9px;color:var(--text-muted);margin-bottom:12px;">${blockSuggestions.medium.detail}</p>
            ` : ''}

            ${blockSuggestions.low.items > 0 ? `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <button class="btn btn-outline squishy" style="flex:1;margin:0" onclick="handleClick(); startBlockTimer('Backup Prep', ${blockSuggestions.low.mins})">
                    🔵 Backup Prep — ${blockSuggestions.low.mins} min
                </button>
                <button class="timer-preset-btn" onclick="handleClick(); editBlockMinutes('low', ${blockSuggestions.low.mins})" title="Edit">✏️</button>
            </div>
            <p style="font-size:9px;color:var(--text-muted);margin-bottom:12px;">${blockSuggestions.low.detail}</p>
            ` : ''}

            ${blockSuggestions.high.items === 0 && blockSuggestions.medium.items === 0 && blockSuggestions.low.items === 0 ? `
                <p style="font-size:12px;color:var(--text-muted);text-align:center;padding:16px;">Mark some ingredients as low in Home to see smart prep block timers here</p>
            ` : ''}
        </div>

        <div class="timer-card">
            <div class="timer-label">Log Prep Time</div>
            <p style="font-size:10px;color:var(--text-muted);margin-bottom:12px;">Use the stopwatch to time a task, then log it to improve future block goals</p>
            ${timerMode === 'stopwatch' && timerSeconds > 0 && !timerRunning ? `
                <button class="btn btn-success squishy" onclick="handleClick(); showLogPrepModal()">
                    📝 Log ${formatTime(timerSeconds)} for an ingredient
                </button>
            ` : `
                <p style="font-size:11px;color:var(--text-muted);text-align:center;">Use stopwatch mode, then pause to log time</p>
            `}
        </div>`;
}

function formatTime(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function setTimerMode(mode) {
    if (timerRunning) pauseTimer();
    timerMode = mode;
    timerSeconds = 0;
    timerTarget = 0;
    timerAlarm = false;
    timerLabel = '';
    renderTimer(document.getElementById('mainContent'));
}

function setTimerPreset(minutes) {
    const minInput = document.getElementById('timerMin');
    const secInput = document.getElementById('timerSec');
    if (minInput) minInput.value = minutes;
    if (secInput) secInput.value = '00';
}

function startTimer() {
    if (timerMode === 'countdown' && timerSeconds === 0) {
        const minInput = document.getElementById('timerMin');
        const secInput = document.getElementById('timerSec');
        const mins = parseInt(minInput ? minInput.value : 5) || 0;
        const secs = parseInt(secInput ? secInput.value : 0) || 0;
        timerTarget = mins * 60 + secs;
        if (timerTarget <= 0) { showToast('Set a time first'); return; }
        timerSeconds = 0;
    }
    timerRunning = true;
    timerAlarm = false;
    timerInterval = setInterval(() => {
        timerSeconds++;
        updateTimerDisplay();
        // Countdown alarm with physical confirmation
        if (timerMode === 'countdown' && timerSeconds >= timerTarget && !timerAlarm) {
            timerAlarm = true;
            startAlarmRepeat();
        }
    }, 1000);
    renderTimer(document.getElementById('mainContent'));
}

function pauseTimer() {
    timerRunning = false;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    renderTimer(document.getElementById('mainContent'));
}

function resetTimer() {
    timerRunning = false;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    if (alarmRepeater) { clearInterval(alarmRepeater); alarmRepeater = null; }
    const overlay = document.getElementById('alarmOverlay');
    if (overlay) overlay.remove();
    timerSeconds = 0;
    timerTarget = 0;
    timerAlarm = false;
    timerLabel = '';
    renderTimer(document.getElementById('mainContent'));
}

function startBlockTimer(label, minutes) {
    if (timerRunning) pauseTimer();
    timerMode = 'countdown';
    timerLabel = label;
    timerSeconds = 0;
    timerTarget = minutes * 60;
    startTimer();
    showToast(`${label}: ${minutes} min started`);
}

function editBlockMinutes(priority, currentMins) {
    const existing = document.getElementById('modalEditBlock');
    if (existing) existing.remove();

    const labels = { high: 'Before Service', medium: 'Prep Block', low: 'Backup Prep' };
    const emojis = { high: '🔴', medium: '🟡', low: '🔵' };

    const modal = document.createElement('div');
    modal.id = 'modalEditBlock';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header">${emojis[priority]} Edit ${labels[priority]}</div>
            <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;">Set your block timer goal (minutes)</p>
            <div class="form-group">
                <input type="number" id="editBlockInput" class="form-control" value="${currentMins}" min="1" max="999" style="text-align:center;font-size:24px;font-weight:700;">
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('modalEditBlock').remove()">Cancel</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); confirmEditBlock('${priority}')">Start Timer</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    setTimeout(() => { const input = document.getElementById('editBlockInput'); if (input) { input.focus(); input.select(); } }, 200);
}

function confirmEditBlock(priority) {
    const input = document.getElementById('editBlockInput');
    const mins = parseInt(input ? input.value : 0);
    if (!mins || mins <= 0) { showToast('Enter a valid number'); return; }
    const modal = document.getElementById('modalEditBlock');
    if (modal) modal.remove();
    const labels = { high: 'Before Service', medium: 'Prep Block', low: 'Backup Prep' };
    startBlockTimer(labels[priority], mins);
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

            // Check if we have prep time data for this ingredient
            const key = ing.name.toLowerCase();
            const pt = prepTimes[key];
            if (pt && pt.avgSecPerUnit > 0) {
                // Parse par level for quantity
                const qty = parseFloat(st.parLevel) || 1;
                const estSec = Math.round(pt.avgSecPerUnit * qty);
                if (!result[p].estSeconds) result[p].estSeconds = 0;
                result[p].estSeconds += estSec;
                if (!result[p].ingredients) result[p].ingredients = [];
                result[p].ingredients.push(`${ing.name}: ~${Math.ceil(estSec / 60)}m`);
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

function showLogPrepModal() {
    const existing = document.getElementById('modalLogPrep');
    if (existing) existing.remove();

    // Build ingredient options — only show low-marked (active prep) ingredients first, then all
    let options = '';
    let hasLowItems = false;
    stations.forEach(station => {
        station.ingredients.forEach(ing => {
            const st = station.status[ing.id];
            if (st && st.low && !st.completed) {
                hasLowItems = true;
                const par = st.parLevel ? ` (${st.parLevel})` : '';
                options += `<option value="${ing.name.toLowerCase()}">${ing.name}${par} — ${station.name}</option>`;
            }
        });
    });
    if (!hasLowItems) {
        // Fallback: show all ingredients if none are marked low
        stations.forEach(station => {
            station.ingredients.forEach(ing => {
                options += `<option value="${ing.name.toLowerCase()}">${ing.name} (${station.name})</option>`;
            });
        });
    }

    const modal = document.createElement('div');
    modal.id = 'modalLogPrep';
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">Log Prep Time</div>
            <p style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;">
                You spent <strong>${formatTime(timerSeconds)}</strong>. Which ingredient?
            </p>
            <div class="form-group">
                <label>Ingredient</label>
                <select id="logPrepIngredient" class="form-control">${options}</select>
            </div>
            <div class="form-group">
                <label>Quantity prepped (e.g. 2 for 2 quarts)</label>
                <input type="number" id="logPrepQty" class="form-control" value="1" min="0.1" step="0.5">
            </div>
            <div class="btn-group">
                <button class="btn btn-secondary squishy" onclick="document.getElementById('modalLogPrep').remove()">Cancel</button>
                <button class="btn btn-primary squishy" onclick="handleClick(); saveLogPrep()">Save</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
}

function saveLogPrep() {
    const ingEl = document.getElementById('logPrepIngredient');
    const qtyEl = document.getElementById('logPrepQty');
    const key = ingEl.value;
    const qty = parseFloat(qtyEl.value) || 1;
    const secPerUnit = timerSeconds / qty;

    if (!prepTimes[key]) {
        prepTimes[key] = { avgSecPerUnit: secPerUnit, count: 1 };
    } else {
        // Running average
        const pt = prepTimes[key];
        pt.avgSecPerUnit = ((pt.avgSecPerUnit * pt.count) + secPerUnit) / (pt.count + 1);
        pt.count++;
    }

    savePrepTimes();
    document.getElementById('modalLogPrep').remove();
    showToast(`Logged: ${Math.round(secPerUnit)}s per unit for ${key}`);
    resetTimer();
}

function updateTimerDisplay() {
    const el = document.getElementById('timerDisplay');
    if (!el) return;
    const displayTime = timerMode === 'countdown'
        ? formatTime(Math.max(0, timerTarget - timerSeconds))
        : formatTime(timerSeconds);
    el.textContent = displayTime;
    if (timerMode === 'countdown' && timerSeconds >= timerTarget) {
        el.className = 'timer-display alarm';
    } else {
        el.className = 'timer-display running';
    }
}

function playAlarm() {
    // Play 3 beeps
    if (settings.sound) {
        try {
            const ctx = getAudioCtx();
            for (let i = 0; i < 3; i++) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'square';
                osc.frequency.value = 880;
                gain.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.3);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.3 + 0.2);
                osc.start(ctx.currentTime + i * 0.3);
                osc.stop(ctx.currentTime + i * 0.3 + 0.2);
            }
        } catch (e) {}
    }
}

function startAlarmRepeat() {
    // Keep alarming every 5 seconds until confirmed
    vibrate(500);
    playAlarm();
    alarmRepeater = setInterval(() => {
        vibrate(500);
        playAlarm();
    }, 5000);
    showAlarmConfirmation();
}

function showAlarmConfirmation() {
    const existing = document.getElementById('alarmOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'alarmOverlay';
    overlay.className = 'celebration-overlay';
    overlay.innerHTML = `
        <div class="celebration-content" style="padding:36px 28px;">
            <div class="celebration-emoji">⏰</div>
            <h2>Time's Up!</h2>
            <p style="margin-bottom:12px;">${timerLabel || 'Your timer'} is done</p>
            <button class="btn btn-danger squishy" style="font-size:18px;padding:18px 36px;" onclick="handleClick(); confirmAlarm()">
                🔔 STOP ALARM
            </button>
        </div>`;
    document.body.appendChild(overlay);
}

function confirmAlarm() {
    if (alarmRepeater) {
        clearInterval(alarmRepeater);
        alarmRepeater = null;
    }
    const overlay = document.getElementById('alarmOverlay');
    if (overlay) overlay.remove();
    pauseTimer();
    showToast('Alarm stopped');
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
    station.status[newIng.id] = { low: false, priority: null, parLevel: '', completed: false };

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
            // Merge: add imported stations that don't exist by name
            imported.forEach(impStation => {
                const existing = stations.find(s => s.name.toLowerCase() === impStation.name.toLowerCase());
                if (existing) {
                    // Merge ingredients into existing station
                    impStation.ingredients.forEach(impIng => {
                        const existsIng = existing.ingredients.find(e => e.name.toLowerCase() === impIng.name.toLowerCase());
                        if (!existsIng) {
                            existing.ingredients.push(impIng);
                            existing.status[impIng.id] = impStation.status[impIng.id];
                        }
                    });
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
