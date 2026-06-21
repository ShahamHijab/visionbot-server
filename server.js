// 💻 LAPTOP SERVER - Receive alerts from robot, serve to phone
// Run: node server.js
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
let firebaseReady = false;
const FCM_TOPIC = process.env.FCM_TOPIC || 'visionbot_alerts';

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    firebaseReady = true;
    console.log('✅ Firebase Admin ready');
  } else {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT_BASE64 missing');
  }
} catch (e) {
  console.log('❌ Firebase setup error:', e.message);
}
// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Files
const ALERTS_FILE = path.join(__dirname, 'alerts.json');
const STATUS_FILE = path.join(__dirname, 'robot_status.json');

// Initialize files
if (!fs.existsSync(ALERTS_FILE)) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify([], null, 2));
}
if (!fs.existsSync(STATUS_FILE)) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({}, null, 2));
}

// ═════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════

function readAlerts() {
  try {
    const data = fs.readFileSync(ALERTS_FILE, 'utf8');
    return JSON.parse(data) || [];
  } catch (e) {
    return [];
  }
}

function writeAlerts(alerts) {
  try {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
  } catch (e) {
    console.log('❌ Write alerts error:', e.message);
  }
}

function getRobotStatus() {
  try {
    const data = fs.readFileSync(STATUS_FILE, 'utf8');
    return JSON.parse(data) || {};
  } catch (e) {
    return {};
  }
}

function writeRobotStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    console.log('❌ Write status error:', e.message);
  }
}

// ═════════════════════════════════════════════════════════════
// ROBOT ENDPOINTS
// ═════════════════════════════════════════════════════════════

/// POST /api/robot/status
app.post('/api/robot/status', (req, res) => {
  try {
    const { ip, pendingAlerts } = req.body;

    console.log('');
    console.log('🚗 [ROBOT] Status update');
    console.log('   IP: ' + ip);
    console.log('   Pending: ' + pendingAlerts);

    const status = {
      lastUpdate: new Date().toISOString(),
      ip,
      pendingAlerts,
      online: true,
    };

    writeRobotStatus(status);

    res.json({
      success: true,
      message: 'Status received',
      timestamp: new Date(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
async function sendNotification(alert) {
  if (!firebaseReady) {
    console.log('⚠️ Firebase not ready, notification skipped');
    return;
  }

  try {
    const title = alert.title || 'VisionBot Alert';
    const body = alert.message || `${alert.type || 'Alert'} detected by VisionBot`;

    const response = await admin.messaging().send({
      topic: FCM_TOPIC,
      notification: {
        title: title,
        body: body,
      },
      data: {
        alert_id: String(alert.alert_id || ''),
        type: String(alert.type || 'alert'),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'visionbot_alerts',
          priority: 'high',
          defaultSound: true,
        },
      },
    });

    console.log('🔔 Notification sent:', response);
  } catch (e) {
    console.log('❌ Notification error:', e.message);
  }
}
/// POST /api/robot/alerts
app.post('/api/robot/alerts', async (req, res) => {
  try {
    const { alerts: newAlerts } = req.body;

    if (!Array.isArray(newAlerts)) {
      return res.status(400).json({ error: 'alerts must be array' });
    }

    console.log('');
    console.log(`📤 [ROBOT] Uploading ${newAlerts.length} alerts`);

    let allAlerts = readAlerts();

    // Add new alerts (no duplicates)
    for (const alert of newAlerts) {
      const exists = allAlerts.find((a) => a.alert_id === alert.alert_id);
      if (!exists) {
        const savedAlert = {
  ...alert,
  receivedAt: new Date().toISOString(),
  deliveredToPhone: false,
};

allAlerts.push(savedAlert);

await sendNotification(savedAlert);

console.log(`   ✅ ${alert.alert_id}`);
      }
    }

    // Keep only last 500
    if (allAlerts.length > 500) {
      allAlerts = allAlerts.slice(-500);
    }

    writeAlerts(allAlerts);

    console.log(`   📊 Total: ${allAlerts.length} alerts`);

    res.json({
      success: true,
      stored: newAlerts.length,
      totalAlerts: allAlerts.length,
    });
  } catch (e) {
    console.log('❌ Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════
// PHONE ENDPOINTS
// ═════════════════════════════════════════════════════════════

/// GET /api/phone/alerts
app.get('/api/phone/alerts', (req, res) => {
  try {
    const alerts = readAlerts();
    const robotStatus = getRobotStatus();

    console.log('');
    console.log(`📥 [PHONE] Requesting alerts: ${alerts.length} available`);

    res.json({
      success: true,
      alerts,
      count: alerts.length,
      robotStatus,
      timestamp: new Date(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/// GET /api/phone/alerts/:id
app.get('/api/phone/alerts/:id', (req, res) => {
  try {
    const { id } = req.params;
    const alerts = readAlerts();
    const alert = alerts.find((a) => a.alert_id === id);

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({
      success: true,
      alert,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/// POST /api/phone/confirm/:id
app.post('/api/phone/confirm/:id', (req, res) => {
  try {
    const { id } = req.params;
    let alerts = readAlerts();

    const alert = alerts.find((a) => a.alert_id === id);
    if (alert) {
      alert.deliveredToPhone = true;
      alert.deliveredAt = new Date().toISOString();
      writeAlerts(alerts);
      console.log(`📥 [PHONE] Confirmed: ${id}`);
    }

    res.json({
      success: true,
      message: 'Confirmed',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/// GET /api/phone/status
app.get('/api/phone/status', (req, res) => {
  try {
    const alerts = readAlerts();
    const robotStatus = getRobotStatus();

    res.json({
      success: true,
      server: 'online',
      alerts: alerts.length,
      robotStatus,
      timestamp: new Date(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════
// UTILITY ENDPOINTS
// ═════════════════════════════════════════════════════════════

/// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    firebaseReady,
    topic: FCM_TOPIC,
    time: new Date(),
  });
});

/// GET /api/stats
app.get('/api/stats', (req, res) => {
  const alerts = readAlerts();
  const robotStatus = getRobotStatus();

  res.json({
    success: true,
    totalAlerts: alerts.length,
    robotStatus,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date(),
  });
});

/// DELETE /api/clear
app.delete('/api/clear', (req, res) => {
  writeAlerts([]);
  res.json({ success: true, message: 'Cleared all alerts' });
});

// ═════════════════════════════════════════════════════════════
// START SERVER
// ═════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

const getLocalIP = () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return 'localhost';
};

const localIP = getLocalIP();
app.post('/api/test-notification', async (req, res) => {
  const testAlert = {
    alert_id: 'test_' + Date.now(),
    type: 'test',
    title: 'VisionBot Test',
    message: 'Notification system is working',
  };

  await sendNotification(testAlert);

  res.json({
    success: true,
    firebaseReady,
    topic: FCM_TOPIC,
  });
});
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════╗');
  console.log('║  💻 VisionBot Laptop Server       ║');
  console.log('╠═══════════════════════════════════╣');
  console.log('║  Status: ✅ RUNNING                ║');
  console.log(`║  IP: ${localIP}`);
  console.log(`║  Port: ${PORT}`);
  console.log(`║  URL: http://${localIP}:${PORT}`);
  console.log('║                                   ║');
  console.log('║  Files:                           ║');
  console.log('║  • alerts.json                    ║');
  console.log('║  • robot_status.json              ║');
  console.log('╚═══════════════════════════════════╝');
  console.log('');
  console.log('Test: http://' + localIP + ':' + PORT + '/health');
  console.log('');
});