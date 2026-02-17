// ==================== AQUEOUS - Kitchen Station Manager ====================

let stations = [];
let editingStationId = null;
let currentView = 'home';
let history = [];

// ==================== INITIALIZATION ====================

function initApp() {
    loadData();
    processCarryOver();
    showDate();
    renderCurrentView();
}

function showDate() {
    const today = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    document.getElementById('dateDisplay').textContent = today.toLocaleDateString('en-US', options);
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
    else if (view === 'share') navItems[2].classList.add('active');
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
    } else if (currentView === 'share') {
        fab.style.display = 'none';
        renderShare(container);
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
        <div class="station-card">
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

        const priorityBadge = st.low && st.priority
            ? `<span class="badge badge-${st.priority}">${st.priority}</span>`
            : '';

        const parDisplay = st.low && st.parLevel
            ? `<span class="par-display">${st.parLevel}</span>`
            : '';

        html += `
        <div class="ingredient ${st.low ? 'low' : ''}">
            <div class="ingredient-header">
                <label class="ingredient-label">
                    <input type="checkbox" class="checkbox"
                        ${st.low ? 'checked' : ''}
                        onchange="toggleLow(${station.id}, ${ing.id})">
                    <span class="ingredient-name">${ing.name}</span>
                </label>
                <div class="ingredient-badges">
                    ${parDisplay}
                    ${priorityBadge}
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
                        onchange="setParLevel(${station.id}, ${ing.id}, this.value)"
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

    let html = `
        <div class="summary-header-card">
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
        html += `
            <div class="summary-item ${task.status.completed ? 'done' : ''}">
                <label class="summary-check-label">
                    <input type="checkbox" class="checkbox"
                        ${task.status.completed ? 'checked' : ''}
                        onchange="toggleCompleted(${task.stationId}, ${task.ingredient.id})">
                    <div class="summary-item-info">
                        <span class="summary-item-name">${task.ingredient.name}</span>
                        <span class="summary-item-station">${task.stationName}</span>
                    </div>
                </label>
                ${task.status.parLevel ? `<span class="par-tag">${task.status.parLevel}</span>` : ''}
            </div>`;
    });

    html += '</div>';
    return html;
}

function toggleCompleted(stationId, ingredientId) {
    const station = stations.find(s => s.id === stationId);
    if (!station || !station.status[ingredientId]) return;

    station.status[ingredientId].completed = !station.status[ingredientId].completed;
    saveData(true);

    const scrollY = window.scrollY;
    renderSummary(document.getElementById('mainContent'));
    window.scrollTo(0, scrollY);
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
    function animate() {
        if (frames > 180 || !document.getElementById('confettiCanvas')) return;
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
        requestAnimationFrame(animate);
    }
    animate();
}

// ==================== SHARE VIEW ====================

function renderShare(container) {
    let html = `
        <div class="share-section">
            <h3 class="share-title">Share Options</h3>
            <div class="share-cards">
                <button class="share-card" onclick="shareAllWhatsApp()">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                    <span>WhatsApp Report</span>
                </button>
                <button class="share-card" onclick="shareAppLink()">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                    <span>Copy App Link</span>
                </button>
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

function shareStation(stationId) {
    const station = stations.find(s => s.id === stationId);
    if (!station) return;

    const lowItems = station.ingredients.filter(ing =>
        station.status[ing.id] && station.status[ing.id].low
    );

    if (lowItems.length === 0) {
        showToast('No items marked in this station');
        return;
    }

    let msg = `📋 *CHECKLIST - ${station.name.toUpperCase()}*\n`;
    msg += `📅 ${new Date().toLocaleDateString('en-US')}\n\n`;

    const high = lowItems.filter(i => station.status[i.id].priority === 'high');
    const medium = lowItems.filter(i => station.status[i.id].priority === 'medium');
    const low = lowItems.filter(i => station.status[i.id].priority === 'low');
    const none = lowItems.filter(i => !station.status[i.id].priority);

    if (high.length) {
        msg += `🔴 *HIGH PRIORITY:*\n`;
        high.forEach(i => {
            const par = station.status[i.id].parLevel;
            msg += `  • ${i.name}${par ? ' — ' + par : ''}\n`;
        });
        msg += '\n';
    }
    if (medium.length) {
        msg += `🟡 *MEDIUM:*\n`;
        medium.forEach(i => {
            const par = station.status[i.id].parLevel;
            msg += `  • ${i.name}${par ? ' — ' + par : ''}\n`;
        });
        msg += '\n';
    }
    if (low.length) {
        msg += `🔵 *LOW:*\n`;
        low.forEach(i => {
            const par = station.status[i.id].parLevel;
            msg += `  • ${i.name}${par ? ' — ' + par : ''}\n`;
        });
        msg += '\n';
    }
    if (none.length) {
        msg += `⚪ *NO PRIORITY:*\n`;
        none.forEach(i => {
            const par = station.status[i.id].parLevel;
            msg += `  • ${i.name}${par ? ' — ' + par : ''}\n`;
        });
    }

    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

function shareAllWhatsApp() {
    let msg = `📋 *AQUEOUS — FULL STATION REPORT*\n`;
    msg += `📅 ${new Date().toLocaleDateString('en-US')}\n\n`;

    let hasData = false;
    stations.forEach(station => {
        const lowItems = station.ingredients.filter(i =>
            station.status[i.id] && station.status[i.id].low
        );
        if (lowItems.length > 0) {
            hasData = true;
            msg += `━━━━━━━━━━━━━━━━\n`;
            msg += `🏪 *${station.name.toUpperCase()}*\n━━━━━━━━━━━━━━━━\n\n`;

            const high = lowItems.filter(i => station.status[i.id].priority === 'high');
            const medium = lowItems.filter(i => station.status[i.id].priority === 'medium');
            const low = lowItems.filter(i => station.status[i.id].priority === 'low');

            if (high.length) msg += `🔴 High: ${high.map(i => i.name + (station.status[i.id].parLevel ? ' (' + station.status[i.id].parLevel + ')' : '')).join(', ')}\n`;
            if (medium.length) msg += `🟡 Medium: ${medium.map(i => i.name + (station.status[i.id].parLevel ? ' (' + station.status[i.id].parLevel + ')' : '')).join(', ')}\n`;
            if (low.length) msg += `🔵 Low: ${low.map(i => i.name + (station.status[i.id].parLevel ? ' (' + station.status[i.id].parLevel + ')' : '')).join(', ')}\n`;
            msg += '\n';
        }
    });

    if (!hasData) {
        showToast('No items marked in any station');
        return;
    }

    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

function shareAppLink() {
    const data = btoa(encodeURIComponent(JSON.stringify(stations)));
    const link = window.location.origin + window.location.pathname + '?data=' + data;

    if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(() => {
            showToast('Link copied to clipboard!');
        });
    } else {
        prompt('Copy this link:', link);
    }
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
    const data = params.get('data');
    if (data) {
        try {
            const imported = JSON.parse(decodeURIComponent(atob(data)));
            if (confirm('Import shared station data?')) {
                stations = imported;
                saveData(true);
                window.history.replaceState({}, '', window.location.pathname);
                renderCurrentView();
                showToast('Data imported!');
            }
        } catch (e) {
            console.error('Invalid shared data');
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
});
