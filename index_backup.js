import wppconnect from '@wppconnect-team/wppconnect';
import fs from 'fs';
import express from 'express';
import { config } from './config.js';

const numbersFile = 'numbers.json';
let numbers = []; // History of all unique numbers found
let messageQueue = []; // Queue for numbers waiting to be messaged
let messagesSent = 0; // Counter for sent messages
let isSendingEnabled = false; // Start PAUSED by default
let currentQrCode = '';
let recentGroups = [];
let monitorStatus = 'Initializing...';

// --- SENDER POOL ---
const senders = []; // Array of { name, client, status, qrCode, sentCount }
let senderIndex = 0; // Round-robin counter

// Initialize Express
const app = express();
app.use(express.urlencoded({ extended: true }));
const port = 3001;

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Toggle Route
app.post('/toggle', (req, res) => {
    isSendingEnabled = !isSendingEnabled;
    console.log(`Sending status toggled: ${isSendingEnabled ? 'ON' : 'OFF'}`);
    res.redirect('/');
});

// --- DASHBOARD ---
app.get('/', (req, res) => {
    const groupsHtml = recentGroups.map(g => `
    <li>
      <strong>${g.name || 'Unknown Group'}</strong><br>
      ID: <code>${g.id}</code><br>
      <small>Last active: ${new Date(g.timestamp).toLocaleTimeString()}</small>
    </li>
  `).join('');

    // Monitor status section
    let monitorHtml = '';
    if (monitorStatus === 'Initializing...') {
        monitorHtml = '<p>⏳ Monitor initializing... Please wait.</p>';
    } else if (monitorStatus === 'QR Ready') {
        monitorHtml = `<img src="${currentQrCode}" alt="Monitor QR Code"><p>Scan with your <b>MAIN</b> WhatsApp to login the monitor</p>`;
    } else if (monitorStatus === 'Connected') {
        monitorHtml = '<p>✅ Monitor connected (watching groups)</p>';
    }

    // Sender status table
    const senderRows = senders.map(s => {
        const statusEmoji = s.status === 'connected' ? '✅' :
            s.status === 'qr-pending' ? '📱' :
                s.status === 'error' ? '❌' : '⏳';
        const qrHtml = s.status === 'qr-pending' && s.qrCode
            ? `<img src="${s.qrCode}" alt="QR ${s.name}" style="max-width:150px;height:auto;">`
            : '';
        return `
        <tr>
            <td><strong>${s.name}</strong></td>
            <td>${statusEmoji} ${s.status}</td>
            <td>${s.sentCount}</td>
            <td>${qrHtml}</td>
        </tr>`;
    }).join('');

    const toggleBtnClass = isSendingEnabled ? 'btn-stop' : 'btn-start';
    const toggleBtnText = isSendingEnabled ? 'STOP SENDING' : 'START SENDING';
    const statusColor = isSendingEnabled ? 'green' : 'red';
    const statusText = isSendingEnabled ? 'RUNNING' : 'PAUSED';

    const connectedSenders = senders.filter(s => s.status === 'connected').length;

    res.send(`
    <html>
      <head>
        <title>WhatsApp Bot Dashboard</title>
        <meta http-equiv="refresh" content="5">
        <style>
          body { font-family: sans-serif; background-color: #f0f0f0; padding: 20px; }
          .container { max-width: 900px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .qr-section { text-align: center; margin-bottom: 20px; }
          img { max-width: 300px; height: auto; }
          
          .stats-section { display: flex; justify-content: space-around; margin-bottom: 20px; background: #eef; padding: 15px; border-radius: 8px; }
          .stat-box { text-align: center; }
          .stat-value { font-size: 24px; font-weight: bold; color: #333; }
          .stat-label { font-size: 14px; color: #666; }

          .control-section { text-align: center; margin-bottom: 20px; padding: 20px; border: 2px solid ${statusColor}; border-radius: 8px; background: #fff; }
          .status-indicator { font-size: 18px; font-weight: bold; color: ${statusColor}; margin-bottom: 15px; display: block;}
          
          button { padding: 15px 30px; font-size: 18px; border: none; border-radius: 5px; cursor: pointer; color: white; transition: background 0.3s; }
          .btn-start { background-color: #28a745; }
          .btn-start:hover { background-color: #218838; }
          .btn-stop { background-color: #dc3545; }
          .btn-stop:hover { background-color: #c82333; }

          .sender-section { margin: 20px 0; }
          .sender-section h2 { margin-bottom: 10px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #ddd; padding: 10px; text-align: center; }
          th { background: #f5f5f5; }

          .groups-section { border-top: 1px solid #eee; padding-top: 20px; }
          ul { list-style: none; padding: 0; }
          li { background: #f9f9f9; border: 1px solid #ddd; padding: 10px; margin-bottom: 10px; border-radius: 5px; }
          code { background: #eee; padding: 2px 5px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="qr-section">
            <h1>WhatsApp Bot Dashboard</h1>
            ${monitorHtml}
          </div>

          <div class="stats-section">
            <div class="stat-box">
              <div class="stat-value">${numbers.length}</div>
              <div class="stat-label">Total Scraped</div>
            </div>
            <div class="stat-box">
              <div class="stat-value">${messagesSent}</div>
              <div class="stat-label">Messages Sent</div>
            </div>
            <div class="stat-box">
               <div class="stat-value">${messageQueue.length}</div>
               <div class="stat-label">Pending Queue</div>
            </div>
            <div class="stat-box">
               <div class="stat-value">${connectedSenders}/${senders.length}</div>
               <div class="stat-label">Senders Online</div>
            </div>
          </div>

          <div class="control-section">
             <span class="status-indicator">Status: ${statusText}</span>
             <form action="/toggle" method="POST">
                <button type="submit" class="${toggleBtnClass}">${toggleBtnText}</button>
             </form>
          </div>

          <div class="sender-section">
            <h2>📤 Sender Accounts</h2>
            ${senders.length === 0
            ? '<p><i>No sender sessions configured. Add names to <code>senderSessions</code> in config.js</i></p>'
            : `<table>
                  <thead><tr><th>Name</th><th>Status</th><th>Sent</th><th>QR Code</th></tr></thead>
                  <tbody>${senderRows}</tbody>
                </table>`
        }
          </div>
          
          <div class="groups-section">
            <h2>Active Groups</h2>
            <p>1. Send <code>!id</code> in the group you want to monitor.</p>
            <p>2. Or refresh this page to see recent groups below.</p>
            ${monitorStatus === 'Connected' ? `<ul>${groupsHtml || '<p>Fetching groups...</p>'}</ul>` : '<p><i>Waiting for monitor connection...</i></p>'}
          </div>
        </div>
      </body>
    </html>
  `);
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Load existing numbers (History)
if (fs.existsSync(numbersFile)) {
    try {
        const data = fs.readFileSync(numbersFile, 'utf8');
        numbers = JSON.parse(data);
    } catch (err) {
        console.error('Error reading numbers file:', err);
        numbers = [];
    }
}

// Save numbers to file
function saveNumbers() {
    fs.writeFileSync(numbersFile, JSON.stringify(numbers, null, 2));
}

// =============================================
// 1. MONITOR SESSION — watches groups only
// =============================================
wppconnect
    .create({
        session: 'x-com-monitor',
        catchQR: (base64Qr, asciiQR) => {
            currentQrCode = base64Qr;
            monitorStatus = 'QR Ready';
            console.log('[MONITOR] QR Code updated. Check http://localhost:3001');
        },
        logQR: false,
        disableWelcome: true,
        autoClose: 0,
        browserArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-zygote'],
        puppeteerOptions: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--headless=new', '--disable-gpu', '--disable-dev-shm-usage']
        }
    })
    .then((client) => {
        currentQrCode = '';
        monitorStatus = 'Connected';
        startMonitor(client);
    })
    .catch((error) => {
        console.error('[MONITOR] Failed to start:', error);
        monitorStatus = 'Error';
    });

function startMonitor(client) {
    console.log('[MONITOR] Client started — watching groups only (not sending).');

    // Wait for sync
    console.log('[MONITOR] Waiting 15s for sync...');
    setTimeout(() => {
        console.log('[MONITOR] Fetching all groups...');
        client.listChats({ onlyGroups: true })
            .then(chats => {
                console.log(`[MONITOR] Found ${chats.length} chats.`);
                const groups = chats.filter(c => c.isGroup || c.id._serialized.endsWith('@g.us'));

                if (groups.length === 0) {
                    console.log('[MONITOR] No groups found yet. Try sending a message in a group.');
                } else {
                    console.log(`[MONITOR] Loaded ${groups.length} groups.`);
                }

                groups.forEach(group => {
                    recentGroups.push({
                        id: group.id._serialized,
                        name: group.contact?.name || group.name || 'Unknown Group',
                        timestamp: Date.now()
                    });
                });

                console.log(`[MONITOR] Currently monitoring ${config.targetGroups.length} groups from config.`);
            })
            .catch(err => console.error('[MONITOR] Error fetching chats:', err));
    }, 15000);

    console.log('[MONITOR] Watching for messages...');

    // Monitor messages — ONLY scrape numbers, NEVER send
    client.onMessage(async (message) => {
        if (message.isGroupMsg || (message.from && message.from.endsWith('@g.us'))) {
            const groupId = message.chatId || message.from;
            const groupName = message.sender?.name || (message.chat?.contact?.name) || 'Unknown Group';

            // Command to get Group ID
            if (message.body === '!id' || message.body === '!ping') {
                console.log(`[MONITOR] Command !id received from ${groupId}`);
                await client.sendText(message.from, `Group ID: ${groupId}`);
            }

            // Update recent groups list
            const existingGroupIndex = recentGroups.findIndex(g => g.id === groupId);
            if (existingGroupIndex > -1) {
                recentGroups[existingGroupIndex].timestamp = Date.now();
                if (recentGroups[existingGroupIndex].name === 'Unknown Group' && groupName !== 'Unknown Group') {
                    recentGroups[existingGroupIndex].name = groupName;
                }
            } else {
                recentGroups.unshift({ id: groupId, name: groupName, timestamp: Date.now() });
                if (recentGroups.length > 50) recentGroups.pop();
            }

            // Check if the group is in the target list
            if (config.targetGroups.includes(groupId)) {
                const bodyLower = message.body ? message.body.toLowerCase() : '';
                console.log(`[MONITOR] Checking message from ${groupName}: "${message.body ? message.body.substring(0, 50) + '...' : '[NO TEXT]'}"`);

                if (bodyLower.includes('x.com') || bodyLower.includes('twitter.com')) {
                    const senderId = message.sender.id;

                    // DUPLICATE CHECK: Only add if NOT in history
                    if (!numbers.includes(senderId)) {
                        console.log(`[MONITOR] Found NEW number ${senderId}. Queueing for sender pool.`);
                        numbers.push(senderId);
                        saveNumbers();
                        messageQueue.push(senderId);
                    } else {
                        console.log(`[MONITOR] Ignored ${senderId} — already in history.`);
                    }
                }
            }
        }
    });

    // Start sender sessions AFTER monitor is connected
    initSenders();
}

// =============================================
// 2. SENDER POOL — burner accounts that send
// =============================================
async function initSenders() {
    if (!config.senderSessions || config.senderSessions.length === 0) {
        console.log('[SENDERS] No sender sessions configured in config.js. Messages will NOT be sent.');
        return;
    }

    console.log(`[SENDERS] Initializing ${config.senderSessions.length} sender session(s) SEQUENTIALLY...`);

    // Initialize senders ONE AT A TIME to avoid memory issues
    for (const sessionName of config.senderSessions) {
        const senderInfo = {
            name: sessionName,
            client: null,
            status: 'initializing',
            qrCode: '',
            sentCount: 0
        };
        senders.push(senderInfo);

        console.log(`[SENDER:${sessionName}] Starting initialization (waiting for connection before starting next)...`);

        try {
            const client = await wppconnect.create({
                session: sessionName,
                catchQR: (base64Qr, asciiQR) => {
                    senderInfo.qrCode = base64Qr;
                    senderInfo.status = 'qr-pending';
                    console.log(`[SENDER:${sessionName}] QR Code ready. Scan at http://localhost:${port}`);
                },
                logQR: false,
                disableWelcome: true,
                autoClose: 600, // Auto-close after 10 min if QR not scanned
                browserArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-zygote'],
                puppeteerOptions: {
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--headless=new', '--disable-gpu', '--disable-dev-shm-usage']
                }
            });

            senderInfo.client = client;
            senderInfo.status = 'connected';
            senderInfo.qrCode = '';
            console.log(`[SENDER:${sessionName}] ✅ Connected and ready to send.`);
        } catch (error) {
            senderInfo.status = 'error';
            console.error(`[SENDER:${sessionName}] ❌ Failed to start:`, error.message || error);
            console.log(`[SENDER:${sessionName}] Skipping to next sender...`);
        }

        // Small delay between senders to let memory settle
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const connectedCount = senders.filter(s => s.status === 'connected').length;
    console.log(`[SENDERS] Initialization complete. ${connectedCount}/${senders.length} senders connected.`);

    // Start the queue processor
    processQueue();
}


// =============================================
// 3. QUEUE PROCESSOR — round-robin across senders
// =============================================
async function processQueue() {
    // Check if sending is allowed
    if (!isSendingEnabled) {
        setTimeout(processQueue, 5000);
        return;
    }

    // Get healthy senders
    const healthySenders = senders.filter(s => s.status === 'connected' && s.client);

    if (healthySenders.length === 0) {
        console.log('[QUEUE] No healthy senders available. Waiting...');
        setTimeout(processQueue, 10000);
        return;
    }

    if (messageQueue.length > 0) {
        // Random delay
        const min = config.minDelay || 300000;
        const max = config.maxDelay || 600000;
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        const delayMinutes = (delay / 60000).toFixed(2);

        console.log(`[QUEUE] ${messageQueue.length} pending. Next message in ${delayMinutes} minutes via ${healthySenders.length} sender(s).`);

        await new Promise(resolve => setTimeout(resolve, delay));

        const number = messageQueue.shift();

        if (number) {
            // Round-robin: pick next healthy sender
            const sender = healthySenders[senderIndex % healthySenders.length];
            senderIndex++;

            try {
                await sender.client.sendText(number, config.messageToSend);
                sender.sentCount++;
                messagesSent++;
                console.log(`[SENDER:${sender.name}] ✉️  Sent message to ${number}`);
            } catch (error) {
                console.error(`[SENDER:${sender.name}] Failed to send to ${number}:`, error.message || error);
                // If send fails, mark sender as potentially unhealthy
                if (error.message && (error.message.includes('not logged') || error.message.includes('disconnected'))) {
                    sender.status = 'error';
                    console.log(`[SENDER:${sender.name}] Marked as unhealthy.`);
                }
                // Re-queue the number so another sender can try
                messageQueue.unshift(number);
            }
        }

        processQueue();
    } else {
        setTimeout(processQueue, 5000);
    }
}
