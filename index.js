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
    fs.writeFileSync(numbersFile, JSON.stringify(numbers, null, 2));
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
                headless: 'new'
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
        // Basic logging
        if (message.body === '!ping') {
            await client.sendText(message.from, 'Pong from Monitor!');
        }

        // Group tracking
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
                    // Filter logic
                    if (number.length > 9 && !numbers.includes(number)) {
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
        isProcessing = false;
        return;
    }

    // Process batch
    while (messageQueue.length > 0 && sendingEnabled) {
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

            // Random delay
            const delay = Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) + config.minDelay;
            await new Promise(r => setTimeout(r, delay));

        } catch (err) {
            console.error(`[QUEUE] Failed to send to ${number}:`, err.message);
            // Re-queue if critical error? Or just skip. keeping simple for now.
        }
    }

    isProcessing = false;
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
            <style>
                body { font-family: sans-serif; padding: 20px; color: #333; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; background: #fff; }
                th, td { padding: 12px; border: 1px solid #eee; text-align: center; vertical-align: middle; }
                th { background: #fcfcfc; color: #666; font-weight: 600; }
                .btn { padding: 10px 20px; background: #25d366; color: white; text-decoration: none; border-radius: 5px; cursor: pointer; border: none; font-size: 16px; display: inline-block; }
                .btn.stop { background: #dc3545; }
                .error-box { background: #fee; color: #c00; border: 1px solid #fcc; padding: 10px; margin: 10px 0; border-radius: 5px; display: none; }
            </style>
        </head>
        <body>
            <h1>🤖 Bot Dashboard v2.0 (Stable)</h1>
            
            <div id="error-message" class="error-box"></div>

            <div style="background: #f8f9fa; padding: 15px; border-radius: 5px;">
                <h3>Controls</h3>
                <p>Sending Status: <b id="sending-status">Loading...</b></p>
                <a href="/toggle" id="toggle-btn" class="btn">Loading...</a>
                <div style="margin-top:12px; border-top:1px solid #ddd; padding-top:12px;">
                    <label for="monitor-phone" style="font-weight:600;">Connect Monitor Phone</label><br>
                    <input type="tel" id="monitor-phone" placeholder="Phone e.g. 2348012345678" style="padding:8px;border:1px solid #ccc;border-radius:4px;width:220px; margin-right:8px;" oninput="localStorage.setItem('monitorPhoneDraft', this.value)">
                    <button onclick="connectMonitor(event)" class="btn" style="background:#007bff;border:none;">Connect Monitor</button>
                    <div id="monitor-hint" style="font-size:12px;color:#666;margin-top:6px;">Type the number and click connect; this input is not refreshed and is auto-saved locally.</div>
                </div>
            </div>

            <div style="margin-top: 20px;">
                <h3>📊 Stats</h3>
                <p>Queue: <b id="queue-count">0</b> | Scraped: <b id="scraped-count">0</b> | Senders Active: <b id="active-count">0</b> | <span style="color: green">Total Sent: <b id="total-sent">0</b></span></p>
            </div>

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
                    <tr><td colspan="4">Loading data...</td></tr>
                </tbody>
            </table>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 30px;">
                <h3 style="margin: 0;">Active Target Groups (Monitor)</h3>
                <a href="/groups" class="btn" style="padding: 6px 15px; font-size: 14px; background: #007bff;">Manage Monitored Groups</a>
            </div>
            <p><small style="color: #666;">This only shows target groups that have recently received messages.</small></p>
            <ul id="groups-list">
                <li>Waiting for data...</li>
            </ul>

            <script>
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
                            statusEl.innerHTML = '<span style="color:green">RUNNING</span>';
                            btnEl.innerText = 'STOP SENDING';
                            btnEl.classList.add('stop');
                        } else {
                            statusEl.innerHTML = '<span style="color:red">PAUSED</span>';
                            btnEl.innerText = 'START SENDING';
                            btnEl.classList.remove('stop');
                        }

                        // Update Table
                        const tbody = document.getElementById('session-table-body');
                        let rowsHtml = '';
                        
                        data.sessions.forEach(s => {
                            const statusColor = s.status === 'connected' ? 'green' : (s.status === 'error' ? 'red' : 'orange');
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
                            }

                            const phoneLabel = s.phone ? '<br><small style="color:#888">📱 ' + s.phone + '</small>' : '';
                            
                            rowsHtml += '<tr>' +
                                '<td><b>' + s.name + '</b> <br> <small>' + s.type + '</small>' + phoneLabel + '</td>' +
                                '<td style="color:' + statusColor + '"><b>' + s.status.toUpperCase() + '</b></td>' +
                                '<td>' + s.sent + '</td>' +
                                '<td>' + actionDisplay + '</td>' +
                                '</tr>';
                        });
                        tbody.innerHTML = rowsHtml;

                        // Update Groups
                        const groupsList = document.getElementById('groups-list');
                        groupsList.innerHTML = (data.groups || []).map(g => '<li>' + g.name + ' <small>(' + g.id + ')</small></li>').join('');
                    } catch (err) {
                        console.error('Update error:', err);
                        errorEl.innerText = 'Error updating dashboard: ' + err.message;
                        errorEl.style.display = 'block';
                    }
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
    if (Array.isArray(selectedGroups)) {
        config.targetGroups = selectedGroups; // update in memory
        
        // update config.js file on disk
        const configPath = './config.js';
        if (fs.existsSync(configPath)) {
            let configStr = fs.readFileSync(configPath, 'utf8');
            configStr = configStr.replace(/targetGroups:\s*\[[\s\S]*?\],/, `targetGroups: ${JSON.stringify(selectedGroups, null, 2)},`);
            fs.writeFileSync(configPath, configStr);
        }
        
        console.log(`[MONITOR] Updated target groups. Now monitoring ${selectedGroups.length} groups.`);
        res.json({ success: true, message: "Groups updated successfully!" });
    } else {
        res.status(400).json({ success: false, message: "Invalid data" });
    }
});

app.get('/groups', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Manage Groups - WhatsPromoBot</title>
            <style>
                body { font-family: sans-serif; padding: 20px; max-width: 800px; margin: auto; }
                ul { list-style: none; padding: 0; background: #f8f9fa; border-radius: 5px; padding: 10px; }
                li { padding: 10px; border-bottom: 1px solid #ddd; display: flex; align-items: center; }
                li:last-child { border-bottom: none; }
                li label { margin-left: 10px; cursor: pointer; flex-grow: 1; }
                .btn { padding: 10px 20px; background: #25d366; color: white; text-decoration: none; border-radius: 5px; cursor: pointer; border: none; font-size: 16px; margin-top: 20px; }
            </style>
        </head>
        <body>
            <h1>📁 Manage Monitored Groups</h1>
            <a href="/" style="display:inline-block; margin-bottom: 20px; color: #007bff; text-decoration: none;">&larr; Back to Dashboard</a>
            
            <div id="loading" style="padding: 20px; background: #e9ecef; border-radius: 5px;">
                Loading groups... <br><br>
                <small>(The monitor session must be connected and synced to fetch chats)</small>
            </div>
            
            <form id="groups-form" style="display: none;" onsubmit="saveGroups(event)">
                <ul id="groups-list"></ul>
                <button type="submit" class="btn" id="save-btn">Save Selected Groups</button>
            </form>

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
    if (config.senderSessions && config.senderSessions.length > 0) {
        console.log('--- SENDERS: waiting for manual phone-number connect on dashboard ---');
        for (const senderName of config.senderSessions) {
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
    } else {
        console.log('No senders configured.');
    }

    console.log('--- INITIALIZATION COMPLETE ---');

    // Start automatic queue processor
    setInterval(() => {
        processQueue().catch(err => console.error('[QUEUE] Error processing:', err));
    }, 30000); // Check every 30 seconds
    console.log('[QUEUE] Auto-processor started (30s interval)');
})();
