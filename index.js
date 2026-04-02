const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('fs');
const express = require('express');
const { config } = require('./config');

const app = express();
const port = 3001;

// =============================================
// GLOBAL STATE
// =============================================
const clients = new Map(); // sessionName -> WPPClient
const sessionStatus = {};   // sessionName -> { status: 'initializing', qr: '', sent: 0, type: 'MONITOR'|'SENDER' }
const recentGroups = [];
let allMonitorGroups = [];  // List of all groups the monitor is in
let numbers = [];
const messageQueue = [];

// Load numbers history
const numbersFile = './numbers.json';
if (fs.existsSync(numbersFile)) {
    try {
        numbers = JSON.parse(fs.readFileSync(numbersFile, 'utf8'));
        // Add all numbers to the message queue
        messageQueue.push(...numbers);
        console.log(`[INIT] Loaded ${numbers.length} numbers from ${numbersFile}, added to queue`);
    } catch (err) {
        console.error('Error reading numbers file:', err);
        numbers = [];
    }
}

function saveNumbers() {
    try {
        fs.writeFileSync(numbersFile, JSON.stringify(numbers, null, 2));
    } catch (err) {
        console.error('Error saving numbers file:', err);
    }
}

// BROWSER ARGS FOR AWS EC2
const AWS_BROWSER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-zygote',
    '--single-process' // Helps with memory on tiny instances
];

// =============================================
// HELPER: START SESSION
// =============================================
async function startSession(sessionName, type = 'SENDER', phoneNumber = null) {
    console.log(`[${type}:${sessionName}] Starting initialization... (mode: ${phoneNumber ? 'phone-pairing' : 'qr'})`);

    // Initialize status
    sessionStatus[sessionName] = {
        status: 'initializing',
        qr: '',
        linkCode: '',
        phone: phoneNumber || '',
        sent: 0,
        type: type,
        name: sessionName
    };

    try {
        const createOptions = {
            session: sessionName,
            logQR: false,
            disableWelcome: true,
            autoClose: type === 'MONITOR' ? 0 : 600000,
            browserArgs: AWS_BROWSER_ARGS,
            puppeteerOptions: {
                args: AWS_BROWSER_ARGS,
                headless: 'new',
                executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser'
            }
        };

        if (phoneNumber) {
            // Phone number pairing mode — no QR code
            createOptions.linkCode = true;
            createOptions.phone = phoneNumber;
            createOptions.catchLinkCode = (code) => {
                sessionStatus[sessionName].linkCode = code;
                sessionStatus[sessionName].status = 'link-code-pending';
                console.log(`[${type}:${sessionName}] 📱 Pairing code: ${code} (enter in WhatsApp > Linked Devices > Link with Phone Number)`);
            };
            // avoid QR in phone pairing flow
            createOptions.catchQR = () => {
                /* ignore QR code when using phone + code pairing */
            };
        } else {
            // QR mode
            createOptions.catchQR = (base64Qr, asciiQR) => {
                sessionStatus[sessionName].qr = base64Qr;
                sessionStatus[sessionName].status = 'qr-pending';
                console.log(`[${type}:${sessionName}] QR Code waiting... scan at http://localhost:${port}`);
            };
        }

        const client = await wppconnect.create(createOptions);

        // SUCCESS
        clients.set(sessionName, client);
        sessionStatus[sessionName].status = 'connected';
        sessionStatus[sessionName].qr = '';
        sessionStatus[sessionName].linkCode = '';
        console.log(`[${type}:${sessionName}] ✅ Connected!`);

        // Setup Event Listeners
        if (type === 'MONITOR') {
            setupMonitorEvents(client);
        }

        return client;

    } catch (error) {
        console.error(`[${type}:${sessionName}] ❌ Failed to start:`, error.message || error);
        sessionStatus[sessionName].status = 'error';
        clients.delete(sessionName);
    }
}

// =============================================
// MONITOR LOGIC
// =============================================
function setupMonitorEvents(client) {
    console.log('[MONITOR] Setting up message listener...');

    client.onMessage(async (message) => {
        try {
            // Basic logging
            if (message.body === '!ping') {
                await client.sendText(message.from, 'Pong from Monitor!');
            }

            // Group tracking with cleanup (keep only last 24 hours)
            if (message.isGroupMsg) {
                const groupId = message.from;
                const groupName = message.sender?.name || message.chat?.contact?.name || 'Unknown Group';

                const existing = recentGroups.find(g => g.id === groupId);
                if (existing) {
                    existing.timestamp = Date.now();
                    if (existing.name === 'Unknown Group' && groupName !== 'Unknown Group') existing.name = groupName;
                } else {
                    recentGroups.push({ id: groupId, name: groupName, timestamp: Date.now() });
                }

                // Cleanup old entries (older than 24 hours)
                const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
                recentGroups = recentGroups.filter(g => g.timestamp > oneDayAgo);
            }

            // SCRAPING LOGIC
            // Check if group is in target list
            const isTargetGroup = (config.targetGroups || []).includes(message.from);

            if (isTargetGroup && (message.body.includes('x.com') || message.body.includes('twitter.com'))) {
                console.log(`[MONITOR] Found link in ${message.from}. Scraping...`);

                try {
                    // Get group members
                    const participants = await client.getGroupMembers(message.from);
                    let count = 0;

                    participants.forEach(p => {
                        const number = p.id._serialized.replace('@c.us', '');
                        // Enhanced filter logic with validation
                        if (number && number.length >= 10 && number.length <= 15 && /^\d+$/.test(number) && !numbers.includes(number)) {
                            numbers.push(number);
                            messageQueue.push(number);
                            count++;
                        }
                    });

                    if (count > 0) {
                        console.log(`[MONITOR] Added ${count} new numbers to queue.`);
                        saveNumbers();
                        processQueue();
                    }
                } catch (err) {
                    console.error('[MONITOR] Error scraping group:', err);
                }
            }
        } catch (err) {
            console.error('[MONITOR] Error in message handler:', err);
        }
    });
}

// =============================================
// QUEUE PROCESSOR
// =============================================
let isProcessing = false;
let senderIndex = 0;
let sendingEnabled = false;

async function processQueue() {
    if (isProcessing || messageQueue.length === 0 || !sendingEnabled) return;

    isProcessing = true;

    try {
        // Get healthy senders
        const activeSenders = [];
        for (const [name, client] of clients) {
            // Allow both SENDER and MONITOR sessions to send messages if connected
            if ((sessionStatus[name]?.type === 'SENDER' || sessionStatus[name]?.type === 'MONITOR') && sessionStatus[name]?.status === 'connected') {
                activeSenders.push({ name, client });
            }
        }

        if (activeSenders.length === 0) {
            console.log('[QUEUE] No active senders available. Pausing.');
            return;
        }

        // Process batch (limit to prevent infinite loops)
        let processedCount = 0;
        const maxBatchSize = 50; // Process max 50 messages per batch

        while (messageQueue.length > 0 && sendingEnabled && processedCount < maxBatchSize) {
            const number = messageQueue.shift();
            const sender = activeSenders[senderIndex % activeSenders.length];
            senderIndex++;

            console.log(`[QUEUE] Sending to ${number} via ${sender.name}...`);

            try {
                let target = number;
                // Only add suffix if missing
                if (!number.includes('@c.us') && !number.includes('@lid') && !number.includes('@g.us')) {
                    target = `${number}@c.us`;
                }

                await sender.client.sendText(target, config.messageToSend);
                sessionStatus[sender.name].sent++;
                processedCount++;

                // Random delay
                const delay = Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) + config.minDelay;
                await new Promise(r => setTimeout(r, delay));

            } catch (err) {
                console.error(`[QUEUE] Failed to send to ${number}:`, err.message);
                // Put failed number back at the end of queue for retry
                messageQueue.push(number);
                break; // Stop processing on first error to avoid spam
            }
        }
    } catch (err) {
        console.error('[QUEUE] Unexpected error in processQueue:', err);
    } finally {
        isProcessing = false;
    }
}

// =============================================
// DASHBOARD
// =============================================
app.use(express.json()); // Allow parsing JSON bodies
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>WhatsPromoBot Dashboard</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    padding: 20px;
                    color: #2c3e50;
                }
                .container { max-width: 1200px; margin: 0 auto; }
                h1 { 
                    color: white; 
                    margin-bottom: 30px; 
                    text-align: center;
                    font-size: 2.5em;
                    text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
                }
                
                .card {
                    background: white;
                    border-radius: 12px;
                    padding: 25px;
                    margin-bottom: 20px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                    transition: transform 0.3s ease, box-shadow 0.3s ease;
                }
                .card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(0,0,0,0.15); }
                
                .card h2, .card h3 { 
                    color: #667eea; 
                    margin-bottom: 15px;
                    font-size: 1.5em;
                }
                
                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 15px;
                    margin: 15px 0;
                }
                .stat-box {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 20px;
                    border-radius: 10px;
                    text-align: center;
                    box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
                }
                .stat-label { font-size: 0.85em; opacity: 0.9; margin-bottom: 8px; }
                .stat-value { font-size: 2em; font-weight: bold; }
                
                .control-group {
                    margin: 15px 0;
                    padding: 15px 0;
                    border-bottom: 1px solid #eee;
                }
                .control-group:last-child { border-bottom: none; }
                
                .form-group {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                    flex-wrap: wrap;
                    margin: 12px 0;
                }
                
                label { 
                    font-weight: 600; 
                    color: #2c3e50;
                    min-width: 150px;
                }
                
                input[type="tel"] {
                    padding: 12px 15px;
                    border: 2px solid #e0e0e0;
                    border-radius: 8px;
                    font-size: 1em;
                    transition: border-color 0.3s ease;
                    flex: 1;
                    min-width: 200px;
                }
                input[type="tel"]:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                }
                
                .btn {
                    padding: 12px 24px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    text-decoration: none;
                    border-radius: 8px;
                    cursor: pointer;
                    border: none;
                    font-size: 1em;
                    font-weight: 600;
                    transition: all 0.3s ease;
                    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
                }
                .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4); }
                .btn:active { transform: translateY(0); }
                .btn.stop { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
                
                .btn-secondary {
                    background: #007bff;
                    box-shadow: 0 4px 15px rgba(0, 123, 255, 0.3);
                }
                .btn-secondary:hover { box-shadow: 0 6px 20px rgba(0, 123, 255, 0.4); }
                
                .error-box {
                    background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%);
                    color: white;
                    border-radius: 10px;
                    padding: 15px 20px;
                    margin-bottom: 20px;
                    display: none;
                    box-shadow: 0 4px 15px rgba(245, 87, 108, 0.3);
                    font-weight: 500;
                }
                
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 20px;
                }
                
                th {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 15px 12px;
                    text-align: left;
                    font-weight: 600;
                    border-radius: 8px 8px 0 0;
                }
                
                td {
                    padding: 15px 12px;
                    border-bottom: 1px solid #e0e0e0;
                    text-align: left;
                    vertical-align: middle;
                }
                
                tr:hover { background: #f8f9ff; }
                
                .status-connected { color: #27ae60; font-weight: 600; }
                .status-error { color: #e74c3c; font-weight: 600; }
                .status-other { color: #f39c12; font-weight: 600; }
                
                .hint-text {
                    font-size: 0.85em;
                    color: #7f8c8d;
                    margin-top: 8px;
                    line-height: 1.4;
                }
                
                .section-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    margin-top: 30px;
                }
                
                .groups-list {
                    list-style: none;
                    background: #f8f9fa;
                    border-radius: 10px;
                    padding: 15px;
                    max-height: 300px;
                    overflow-y: auto;
                }
                
                .groups-list li {
                    padding: 10px 12px;
                    border-bottom: 1px solid #e0e0e0;
                    font-size: 0.95em;
                }
                
                .groups-list li:last-child { border-bottom: none; }
                
                .status-badge {
                    display: inline-block;
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-size: 0.85em;
                    font-weight: 600;
                }
                
                .badge-running { background: #d4edda; color: #155724; }
                .badge-paused { background: #f8d7da; color: #721c24; }
                
                @media (max-width: 768px) {
                    h1 { font-size: 1.8em; }
                    .stats-grid { grid-template-columns: repeat(2, 1fr); }
                    .form-group { flex-direction: column; }
                    label { min-width: auto; width: 100%; }
                    input[type="tel"] { min-width: auto; width: 100%; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 WhatsPromoBot Dashboard</h1>
                
                <div id="error-message" class="error-box"></div>

                <div class="card">
                    <h2>🎮 Controls</h2>
                    <div class="control-group">
                        <p>Sending Status: <span id="sending-status" class="status-badge badge-paused">Loading...</span></p>
                        <button id="toggle-btn" class="btn" style="margin-top: 10px;">Loading...</button>
                    </div>
                    
                    <div class="control-group">
                        <div class="form-group">
                            <label for="monitor-phone">Monitor Phone</label>
                            <input type="tel" id="monitor-phone" placeholder="E.g. 2348012345678" oninput="localStorage.setItem('monitorPhoneDraft', this.value)">
                            <button onclick="connectMonitor(event)" class="btn btn-secondary">Connect Monitor</button>
                        </div>
                        <p class="hint-text">📌 Your input is saved locally and never refreshed automatically.</p>
                    </div>
                </div>

                <div class="card">
                    <h2>📊 Statistics</h2>
                    <div class="stats-grid">
                        <div class="stat-box">
                            <div class="stat-label">Queue</div>
                            <div class="stat-value" id="queue-count">0</div>
                        </div>
                        <div class="stat-box">
                            <div class="stat-label">Scraped</div>
                            <div class="stat-value" id="scraped-count">0</div>
                        </div>
                        <div class="stat-box">
                            <div class="stat-label">Active Senders</div>
                            <div class="stat-value" id="active-count">0</div>
                        </div>
                        <div class="stat-box">
                            <div class="stat-label">Total Sent</div>
                            <div class="stat-value" id="total-sent">0</div>
                        </div>
                    </div>
                </div>

                <div class="card">
                    <h2>📱 Sessions</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Session Name</th>
                                <th>Status</th>
                                <th>Messages Sent</th>
                                <th>Action / Pairing Code</th>
                            </tr>
                        </thead>
                        <tbody id="session-table-body">
                            <!-- Rows will be dynamically created -->
                        </tbody>
                    </table>
                </div>

                <div class="card">
                    <div class="section-header">
                        <h2 style="margin: 0;">📁 Monitored Groups</h2>
                        <a href="/groups" class="btn btn-secondary" style="padding: 8px 16px; font-size: 0.9em;">Manage Groups</a>
                    </div>
                    <ul class="groups-list" id="groups-list">
                        <li>Waiting for data...</li>
                    </ul>
                </div>
            </div>

            <script>
                let currentSessions = [];

                async function updateDashboard() {
                    const errorEl = document.getElementById('error-message');
                    try {
                        const response = await fetch('/status');
                        if (!response.ok) throw new Error('Server returned ' + response.status);
                        const data = await response.json();
                        errorEl.style.display = 'none';

                        // Update Stats
                        document.getElementById('queue-count').innerText = data.stats.queue;
                        document.getElementById('scraped-count').innerText = data.stats.scraped;
                        document.getElementById('active-count').innerText = data.stats.active;
                        document.getElementById('total-sent').innerText = data.stats.totalSent || 0;

                        // Update Sending Status
                        const statusEl = document.getElementById('sending-status');
                        const btnEl = document.getElementById('toggle-btn');
                        if (data.sendingEnabled) {
                            statusEl.innerHTML = 'RUNNING';
                            statusEl.className = 'status-badge badge-running';
                            btnEl.innerText = '⏹ STOP SENDING';
                            btnEl.classList.add('stop');
                        } else {
                            statusEl.innerHTML = 'PAUSED';
                            statusEl.className = 'status-badge badge-paused';
                            btnEl.innerText = '▶ START SENDING';
                            btnEl.classList.remove('stop');
                        }

                        // Update or create table rows
                        updateTableRows(data.sessions);

                        // Update Groups
                        const groupsList = document.getElementById('groups-list');
                        groupsList.innerHTML = (data.groups || []).map(g => '<li>' + g.name + ' <small>(' + g.id + ')</small></li>').join('');
                    } catch (err) {
                        console.error('Update error:', err);
                        errorEl.innerText = 'Error updating dashboard: ' + err.message;
                        errorEl.style.display = 'block';
                    }
                }

                function updateTableRows(sessions) {
                    const tbody = document.getElementById('session-table-body');
                    
                    // Remove rows for sessions that no longer exist
                    const existingRows = Array.from(tbody.querySelectorAll('tr')).map(tr => tr.dataset.sessionName);
                    const newSessionNames = sessions.map(s => s.name);
                    
                    existingRows.forEach(name => {
                        if (!newSessionNames.includes(name)) {
                            const row = document.getElementById('row-' + name);
                            if (row) row.remove();
                        }
                    });

                    // Update or add rows
                    sessions.forEach(s => {
                        let row = document.getElementById('row-' + s.name);
                        if (!row) {
                            // Create new row
                            row = document.createElement('tr');
                            row.id = 'row-' + s.name;
                            row.dataset.sessionName = s.name;
                            row.innerHTML = \`
                                <td><b>\${s.name}</b> <br> <small>\${s.type}</small>\${s.phone ? '<br><small style="color:#888">📱 ' + s.phone + '</small>' : ''}</td>
                                <td><span id="status-\${s.name}" class="status-other"><b>UNKNOWN</b></span></td>
                                <td id="sent-\${s.name}">0</td>
                                <td id="action-\${s.name}"></td>
                            \`;
                            tbody.appendChild(row);
                        }

                        // Update status
                        const statusEl = document.getElementById('status-' + s.name);
                        const statusColor = s.status === 'connected' ? 'status-connected' : (s.status === 'error' ? 'status-error' : 'status-other');
                        statusEl.className = statusColor;
                        statusEl.innerHTML = '<b>' + s.status.toUpperCase() + '</b>';

                        // Update sent count
                        document.getElementById('sent-' + s.name).innerText = s.sent;

                        // Update action
                        const actionEl = document.getElementById('action-' + s.name);
                        let actionDisplay = '';

                        if (s.status === 'connected') {
                            actionDisplay = '✅ Connected';
                        } else if (s.status === 'initializing') {
                            actionDisplay = '<i>Initializing...</i>';
                        } else if (s.status === 'link-code-pending' && s.linkCode) {
                            actionDisplay = '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px;text-align:center">' +
                                            '<b style="font-size:22px;letter-spacing:4px">' + s.linkCode + '</b><br>' +
                                            '<small>Enter in WhatsApp &#x2192; Linked Devices &#x2192; Link with Phone Number</small></div>';
                        } else if (s.status === 'qr-pending' && s.qr) {
                            actionDisplay = '<button onclick="showQr(\\'' + s.name + '\\')" id="btn-qr-' + s.name + '" style="padding:6px 12px;cursor:pointer;border:1px solid #ccc;border-radius:4px;background:#fff">Show QR Code</button>' +
                                            '<div id="qr-img-' + s.name + '" style="display:none">' +
                                            '<img src="' + s.qr + '" style="width:200px;height:200px;display:block;margin:0 auto" />' +
                                            '<small>Scan with WhatsApp</small></div>';
                        } else if (s.type === 'MONITOR' && (s.status === 'unknown' || s.status === 'error' || !s.status)) {
                            actionDisplay = '<span style="color:#666">Monitor not connected yet; use the control above to connect.</span>';
                        } else if (s.type === 'SENDER' && (s.status === 'unknown' || s.status === 'error' || !s.status)) {
                            // Only create form if it doesn't exist
                            if (!actionEl.querySelector('form')) {
                                actionDisplay = '<form onsubmit="connectSender(event, \\'' + s.name + '\\')" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">' +
                                                '<input type="tel" placeholder="Phone e.g. 2348012345678" id="phone-' + s.name + '" style="padding:6px;border:1px solid #ccc;border-radius:4px;width:180px" required>' +
                                                '<button type="submit" style="padding:6px 12px;background:#25d366;color:#fff;border:none;border-radius:4px;cursor:pointer">Connect Sender</button></form>';
                            } else {
                                // Form already exists, don't overwrite
                                return;
                            }
                        }

                        if (actionDisplay) {
                            actionEl.innerHTML = actionDisplay;
                        }
                    });
                }

                function showQr(name) {
                    document.getElementById('qr-img-' + name).style.display = 'block';
                    document.getElementById('btn-qr-' + name).style.display = 'none';
                }

                async function connectSender(e, sessionName) {
                    e.preventDefault();
                    const phone = document.getElementById('phone-' + sessionName).value.trim();
                    if (!phone) return;
                    try {
                        const res = await fetch('/connect-sender', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionName, phone })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('Connecting ' + sessionName + ' with phone ' + phone + '...\\n\\nA pairing code will appear shortly.');
                        } else {
                            alert('Error: ' + data.message);
                        }
                    } catch (err) {
                        alert('Error connecting: ' + err.message);
                    }
                }

                async function connectMonitor(e) {
                    e.preventDefault();
                    const phoneEl = document.getElementById('monitor-phone');
                    const phone = phoneEl.value.trim();
                    if (!phone) return;
                    localStorage.setItem('monitorPhoneDraft', phone);
                    try {
                        const res = await fetch('/connect-monitor', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('Connecting monitor with phone ' + phone + '...\\n\\nA pairing code will appear shortly.');
                        } else {
                            alert('Error: ' + data.message);
                        }
                    } catch (err) {
                        alert('Error connecting: ' + err.message);
                    }
                }

                function restoreMonitorPhoneDraft() {
                    const saved = localStorage.getItem('monitorPhoneDraft');
                    if (saved) {
                        const input = document.getElementById('monitor-phone');
                        if (input) input.value = saved;
                    }
                }

                window.onload = () => {
                    restoreMonitorPhoneDraft();
                    updateDashboard();
                    setInterval(updateDashboard, 3000);
                };
            </script>
        </body>
        </html>
    `);
});

app.get('/status', (req, res) => {
    const allSessions = ['x-com-monitor', ...config.senderSessions];
    const sessions = allSessions.map(name => {
        const s = sessionStatus[name] || { status: 'unknown', sent: 0, qr: '', linkCode: '', phone: '', type: 'UNKNOWN' };
        return { name, ...s };
    });

    const activeCount = Object.values(sessionStatus).filter(s => s.type === 'SENDER' && s.status === 'connected').length;
    const totalSent = Object.values(sessionStatus).filter(s => s.type === 'SENDER').reduce((sum, s) => sum + (s.sent || 0), 0);

    res.json({
        stats: {
            queue: messageQueue.length,
            scraped: numbers.length,
            active: activeCount,
            totalSent: totalSent
        },
        sendingEnabled,
        sessions,
        groups: recentGroups
    });
});

app.get('/toggle', (req, res) => {
    sendingEnabled = !sendingEnabled;
    console.log(`[TOGGLE] Sending is now: ${sendingEnabled ? 'ENABLED' : 'DISABLED'}`);
    res.redirect('/');
});

app.post('/connect-sender', async (req, res) => {
    const { sessionName, phone } = req.body;
    if (!sessionName || !phone) {
        return res.status(400).json({ success: false, message: 'sessionName and phone are required' });
    }

    // Validate phone number format
    const phoneRegex = /^\d{10,15}$/;
    if (!phoneRegex.test(phone)) {
        return res.status(400).json({ success: false, message: 'Invalid phone number format. Must be 10-15 digits only.' });
    }

    if (!config.senderSessions.includes(sessionName)) {
        return res.status(400).json({ success: false, message: 'Unknown session name' });
    }
    // Only allow if not already connected/initializing
    const current = sessionStatus[sessionName];
    if (current && (current.status === 'connected' || current.status === 'initializing')) {
        return res.status(400).json({ success: false, message: `Session is already ${current.status}` });
    }
    console.log(`[CONNECT-SENDER] Starting ${sessionName} with phone ${phone}`);
    // Start async, don't await — pairing code will appear in sessionStatus
    startSession(sessionName, 'SENDER', phone).catch(err => console.error('[CONNECT-SENDER] Error:', err));
    res.json({ success: true, message: `Connecting ${sessionName}... Watch for pairing code on dashboard.` });
});

app.post('/connect-monitor', async (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, message: 'phone is required' });
    }

    // Validate phone number format
    const phoneRegex = /^\d{10,15}$/;
    if (!phoneRegex.test(phone)) {
        return res.status(400).json({ success: false, message: 'Invalid phone number format. Must be 10-15 digits only.' });
    }

    // Only allow if not already connected/initializing
    const current = sessionStatus['x-com-monitor'];
    if (current && (current.status === 'connected' || current.status === 'initializing')) {
        return res.status(400).json({ success: false, message: `Monitor is already ${current.status}` });
    }
    console.log(`[CONNECT-MONITOR] Starting monitor with phone ${phone}`);
    // Start async, don't await — pairing code will appear in sessionStatus
    startSession('x-com-monitor', 'MONITOR', phone).catch(err => console.error('[CONNECT-MONITOR] Error:', err));
    res.json({ success: true, message: `Connecting monitor... Watch for pairing code on dashboard.` });
});

app.get('/api/groups', async (req, res) => {
    try {
        const monitorClient = clients.get('x-com-monitor');
        if (monitorClient) {
            let groups = [];
            // Try the dedicated getAllGroups() first
            try {
                groups = await monitorClient.getAllGroups();
                console.log(`[API] getAllGroups returned ${groups.length} items`);
            } catch (e) {
                console.log('[API] getAllGroups failed, trying getAllChats fallback:', e.message);
            }

            // Fallback: use getAllChats and filter
            if (!groups || groups.length === 0) {
                const chats = await monitorClient.getAllChats();
                groups = chats.filter(c => c.isGroup || c.id?._serialized?.endsWith('@g.us'));
                console.log(`[API] getAllChats fallback returned ${groups.length} groups from ${chats.length} chats`);
            }

            allMonitorGroups = groups.map(c => ({
                id: c.id?._serialized || c.id || '',
                name: c.name || c.title || c.contact?.name || 'Unknown Group'
            })).filter(g => g.id);
        } else {
            console.log('[API] Monitor client not connected yet');
        }
    } catch (err) {
        console.error('[API] Error fetching groups:', err.message);
    }

    res.json({
        allGroups: allMonitorGroups,
        targetGroups: config.targetGroups || [],
        monitorConnected: clients.has('x-com-monitor')
    });
});

app.post('/api/groups/update', (req, res) => {
    const { selectedGroups } = req.body;
    if (!Array.isArray(selectedGroups)) {
        return res.status(400).json({ success: false, message: "Invalid data - selectedGroups must be an array" });
    }

    // Validate that all selected groups are strings
    if (!selectedGroups.every(g => typeof g === 'string' && g.length > 0)) {
        return res.status(400).json({ success: false, message: "Invalid group IDs" });
    }

    config.targetGroups = selectedGroups; // update in memory

    // update config.js file on disk
    const configPath = './config.js';
    try {
        if (fs.existsSync(configPath)) {
            let configStr = fs.readFileSync(configPath, 'utf8');

            // More robust replacement using a better regex
            const targetGroupsRegex = /targetGroups:\s*\[[\s\S]*?\],/;
            const newTargetGroups = `targetGroups: ${JSON.stringify(selectedGroups, null, 2)},`;

            if (targetGroupsRegex.test(configStr)) {
                configStr = configStr.replace(targetGroupsRegex, newTargetGroups);
                fs.writeFileSync(configPath, configStr);
                console.log(`[MONITOR] Updated target groups. Now monitoring ${selectedGroups.length} groups.`);
                res.json({ success: true, message: "Groups updated successfully!" });
            } else {
                console.error('[MONITOR] Could not find targetGroups in config file');
                res.status(500).json({ success: false, message: "Failed to update config file" });
            }
        } else {
            console.error('[MONITOR] Config file not found');
            res.status(500).json({ success: false, message: "Config file not found" });
        }
    } catch (err) {
        console.error('[MONITOR] Error updating config file:', err);
        res.status(500).json({ success: false, message: "Error updating config file" });
    }
});

app.get('/groups', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Manage Groups - WhatsPromoBot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    padding: 20px;
                }
                .container { max-width: 900px; margin: 0 auto; }
                h1 {
                    color: white;
                    margin-bottom: 20px;
                    text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
                }
                .card {
                    background: white;
                    border-radius: 12px;
                    padding: 25px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                }
                .back-link {
                    display: inline-block;
                    margin-bottom: 20px;
                    color: white;
                    text-decoration: none;
                    font-weight: 600;
                    transition: all 0.3s ease;
                }
                .back-link:hover { transform: translateX(-4px); }
                
                #loading {
                    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                    color: white;
                    padding: 25px;
                    border-radius: 10px;
                    text-align: center;
                }
                
                ul { list-style: none; padding: 0; }
                li {
                    padding: 12px;
                    border-bottom: 1px solid #e0e0e0;
                    display: flex;
                    align-items: center;
                    transition: background 0.2s ease;
                }
                li:hover { background: #f8f9fa; }
                li:last-child { border-bottom: none; }
                
                input[type="checkbox"] {
                    cursor: pointer;
                    width: 18px;
                    height: 18px;
                }
                
                li label {
                    margin-left: 12px;
                    cursor: pointer;
                    flex-grow: 1;
                    user-select: none;
                }
                
                .btn {
                    padding: 12px 24px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 1em;
                    font-weight: 600;
                    margin-top: 20px;
                    transition: all 0.3s ease;
                    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
                }
                .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4); }
                
                small { color: #7f8c8d; font-size: 0.9em; }
            </style>
        </head>
        <body>
            <div class="container">
                <a href="/" class="back-link">← Back to Dashboard</a>
                <h1>📁 Manage Monitored Groups</h1>
                
                <div class="card">
                    <div id="loading" style="margin-bottom: 20px;">
                        Loading groups... <br><br>
                        <small>(The monitor session must be connected and synced to fetch chats)</small>
                    </div>
                    
                    <form id="groups-form" style="display: none;" onsubmit="saveGroups(event)">
                        <ul id="groups-list"></ul>
                        <button type="submit" class="btn" id="save-btn">💾 Save Selected Groups</button>
                    </form>
                </div>
            </div>

            <script>
                async function loadGroups() {
                    try {
                        const res = await fetch('/api/groups');
                        const data = await res.json();
                        
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('groups-form').style.display = 'block';
                        
                        const list = document.getElementById('groups-list');
                        list.innerHTML = '';
                        
                        if (!data.allGroups || data.allGroups.length === 0) {
                            if (!data.monitorConnected) {
                                list.innerHTML = '<li style="color:red">⚠️ Monitor is not connected yet. Go back to dashboard and wait for x-com-monitor to show CONNECTED, then reload this page.</li>';
                            } else {
                                list.innerHTML = '<li>⏳ Monitor is connected but chats have not yet synced. This usually takes 5–15 seconds after connecting. <a href="/groups">Reload this page</a> to try again.</li>';
                            }
                            return;
                        }

                        // Sort by name
                        data.allGroups.sort((a,b) => a.name.localeCompare(b.name));

                        data.allGroups.forEach(g => {
                            const isChecked = data.targetGroups.includes(g.id) ? 'checked' : '';
                            list.innerHTML += \`
                                <li>
                                    <input type="checkbox" name="group" value="\${g.id}" id="g_\${g.id}" \${isChecked}>
                                    <label for="g_\${g.id}">\${g.name} <br> <small style="color:#666">\${g.id}</small></label>
                                </li>
                            \`;
                        });
                    } catch (err) {
                        document.getElementById('loading').innerHTML = 'Error loading groups. Make sure server is running.';
                    }
                }
                
                async function saveGroups(e) {
                    e.preventDefault();
                    const btn = document.getElementById('save-btn');
                    btn.innerText = 'Saving...';
                    
                    const selected = Array.from(document.querySelectorAll('input[name="group"]:checked')).map(cb => cb.value);
                    
                    try {
                        const res = await fetch('/api/groups/update', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ selectedGroups: selected })
                        });
                        const data = await res.json();
                        if (data.success) {
                            alert('Groups updated successfully! The bot is now monitoring only the selected groups.');
                        } else {
                            alert('Failed to update groups.');
                        }
                    } catch (err) {
                        alert('Error saving groups');
                    }
                    btn.innerText = 'Save Selected Groups';
                }

                loadGroups();
            </script>
        </body>
        </html>
    `);
});


// =============================================
// MAIN ENTRY POINT
// =============================================
(async () => {
    try {
        // 1. Start Server
        app.listen(port, () => console.log(`Dashboard running on port ${port}`));

        // 2. Initialize Monitor status — connect manually from dashboard
        sessionStatus['x-com-monitor'] = {
            status: 'unknown',
            qr: '',
            linkCode: '',
            phone: config.monitorPhone || '',
            sent: 0,
            type: 'MONITOR',
            name: 'x-com-monitor'
        };

        // If monitorPhone is set, auto-connect
        if (config.monitorPhone) {
            console.log('--- STARTING MONITOR v2.0 ---');
            startSession('x-com-monitor', 'MONITOR', config.monitorPhone).catch(err => console.error('[AUTO-CONNECT-MONITOR] Error:', err));
        } else {
            console.log('--- MONITOR: waiting for manual phone-number connect on dashboard ---');
        }

        // 3. Pre-seed sender statuses — they connect on demand from the dashboard
        if (config.senderSessions && Array.isArray(config.senderSessions) && config.senderSessions.length > 0) {
            console.log('--- SENDERS: waiting for manual phone-number connect on dashboard ---');
            for (const senderName of config.senderSessions) {
                if (typeof senderName === 'string' && senderName.length > 0) {
                    // Only pre-seed if not already initialized (e.g. session token exists)
                    sessionStatus[senderName] = sessionStatus[senderName] || {
                        status: 'unknown',
                        qr: '',
                        linkCode: '',
                        phone: '',
                        sent: 0,
                        type: 'SENDER',
                        name: senderName
                    };
                }
            }
        } else {
            console.log('No senders configured.');
        }

        console.log('--- INITIALIZATION COMPLETE ---');

        // Start automatic queue processor
        setInterval(() => {
            processQueue().catch(err => console.error('[QUEUE] Error processing:', err));
        }, 30000); // Check every 30 seconds
        console.log('[QUEUE] Auto-processor started (30s interval)');

    } catch (err) {
        console.error('Fatal error during initialization:', err);
        process.exit(1);
    }
})();
