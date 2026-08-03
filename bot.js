const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

// Serve Static Mini App Frontend
app.use(express.static(path.join(__dirname, 'public')));

// --- CORE CONFIGURATION & CREDENTIALS ---
const ADMIN_BOT_TOKEN = '8787715855:AAF9PLZkk_tOb28TYcyTcAs_NszwURnzhkw';
const SUB_ADMIN_BOT_TOKEN = '8437403049:AAGpJJ4dZZ5it5duK-hcvJE5Xu8rxu8J2XY';
const SUPPORT_BOT_TOKEN = '8736759061:AAGaSKOCQ9gUylCsqdAufHenEPeDQhQtSDU';

const DEFAULT_ADMIN_CHAT_ID = '7659178694';
const PORT = process.env.PORT || 3000;
const SERVER_URL = 'https://jpw-auto-rech-bot-production.up.railway.app';
const MONGO_URI = 'mongodb+srv://sibadityapal47_db_user:G95Dds7IGyBQNmGh@cluster0.yjvazin.mongodb.net/jpw_bot?retryWrites=true&w=majority';

let CUSTOMER_BOT_TOKENS = [
    '8874503246:AAEmdPcVJMQ3q6pmINsP_Tcwium3ANV4T6I',
    '8972064227:AAG3LadKR0mLXJgU3xL6BwMy7TxjYz8N3Rw'
];

const INITIAL_WORKER_TOKENS = [
    '8945258673:AAG_-nLAQLbv5-LGxfk2wPW5mMfbKD-PN0w',
    '8818741734:AAE--qJKnkdvybUdMHYcgaqUGr3ozeWopis'
];

// --- DATABASE CONNECTION ---
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log("🟢 Persistent Cloud Database Connected Successfully!");
        await autoRegisterDefaultWorkers();
    })
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- SCHEMAS ---
const settingsSchema = new mongoose.Schema({
    key: { type: String, unique: true, default: 'global' },
    upiId: { type: String, default: 'paytm.s2ujlw0@pty' },
    workerReachRateInRs: { type: Number, default: 1 },
    customerPricePerReach: { type: Number, default: 20 },
    resellerWholesalePrice: { type: Number, default: 15 }
});

const userSchema = new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    firstName: { type: String, default: 'User' },
    language: { type: String, default: 'HI' },
    reaches: { type: Number, default: 0 },
    role: { type: String, default: 'customer' }, // 'customer', 'reseller', 'worker', 'admin'
    myBotToken: { type: String, default: null },
    customUpiId: { type: String, default: null },
    customPricePerReach: { type: Number, default: 20 },
    referredBy: { type: String, default: null },
    lastMsgId: { type: Number, default: null }
});

const workerBotSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true },
    serverName: { type: String, required: true },
    assignedChatId: { type: String, default: DEFAULT_ADMIN_CHAT_ID },
    activeLoads: { type: Number, default: 0 },
    completedToday: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
});

const orderSchema = new mongoose.Schema({
    custChatId: String,
    targetId: String,
    targetPass: String,
    status: { type: String, default: 'Pending' },
    assignedServer: String,
    cancelReason: { type: String, default: null },
    acceptedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});

const SettingsModel = mongoose.model('Setting', settingsSchema);
const UserModel = mongoose.model('User', userSchema);
const WorkerModel = mongoose.model('WorkerBot', workerBotSchema);
const OrderModel = mongoose.model('Order', orderSchema);

const adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
const supportBot = new TelegramBot(SUPPORT_BOT_TOKEN, { polling: true });

let activeWorkerBots = {};
let customerBots = [];
let adminState = {};
let activeOrderTimers = {};
let chatRefreshIntervals = {};

async function autoRegisterDefaultWorkers() {
    for (let i = 0; i < INITIAL_WORKER_TOKENS.length; i++) {
        const token = INITIAL_WORKER_TOKENS[i];
        const existing = await WorkerModel.findOne({ token });
        if (!existing) {
            await WorkerModel.create({
                token,
                serverName: `Worker Server #${i + 1}`,
                assignedChatId: DEFAULT_ADMIN_CHAT_ID
            });
        }
    }
    await initDynamicWorkerBots();
}

async function getSettings() {
    let doc = await SettingsModel.findOne({ key: 'global' });
    if (!doc) {
        doc = new SettingsModel();
        await doc.save();
    }
    return doc;
}

async function initUser(chatId, firstName = 'User', refId = null) {
    let user = await UserModel.findOne({ chatId: String(chatId) });
    if (!user) {
        const isMaster = String(chatId) === DEFAULT_ADMIN_CHAT_ID;
        user = new UserModel({
            chatId: String(chatId),
            firstName: firstName || 'User',
            role: isMaster ? 'admin' : 'customer',
            referredBy: (refId && refId !== String(chatId)) ? refId : null
        });
        await user.save();
    }
    return user;
}

async function autoDeleteOldMessage(bot, chatId, messageId) {
    if (messageId) {
        try {
            await bot.deleteMessage(chatId, messageId);
        } catch (e) {}
    }
}

// -------------------------------------------------------------
// 🔍 AI DIAGNOSTICS & SELF-HEALTH ENGINE
// -------------------------------------------------------------
async function runSelfHealthDiagnostics() {
    const uptime = (process.uptime() / 60).toFixed(2);
    const dbState = mongoose.connection.readyState === 1 ? "🟢 Connected & Healthy" : "🔴 Disconnected";
    const totalUsers = await UserModel.countDocuments({ role: 'customer' });
    const totalResellers = await UserModel.countDocuments({ role: 'reseller' });
    const activeWorkers = await WorkerModel.countDocuments({ isActive: true });
    const pendingOrders = await OrderModel.countDocuments({ status: 'Pending' });

    return `
🔍 **AI SELF-HEALTH DIAGNOSTICS REPORT**

🌐 **Cloud Database:** ${dbState}
⚡ **Server Uptime:** \`${uptime} Mins\`
👥 **Total Customers:** \`${totalUsers}\`
👑 **Total Resellers:** \`${totalResellers}\`
🤖 **Active Workers:** \`${activeWorkers}\`
📦 **Queue Pending Orders:** \`${pendingOrders}\`
🟢 **Status:** 100% Operational & Optimized.
    `.trim();
}

// -------------------------------------------------------------
// 🕛 MIDNIGHT AUTOMATIC BACKUP SCHEDULER (12:00 AM IST)
// -------------------------------------------------------------
function startMidnightBackupScheduler() {
    setInterval(async () => {
        const now = new Date();
        const currentHour = now.getUTCHours() + 5.5;
        const hour = Math.floor(currentHour) % 24;
        const mins = now.getUTCMinutes();

        if (hour === 0 && mins === 0) {
            try {
                const usersBackup = await UserModel.find();
                const ordersBackup = await OrderModel.find().limit(2000);
                const workersBackup = await WorkerModel.find();

                const backupObject = { timestamp: now.toISOString(), users: usersBackup, orders: ordersBackup, workers: workersBackup };
                const backupPath = path.join(__dirname, `backup_${Date.now()}.json`);
                fs.writeFileSync(backupPath, JSON.stringify(backupObject, null, 2));

                await adminBot.sendDocument(DEFAULT_ADMIN_CHAT_ID, backupPath, {
                    caption: `💾 **MIDNIGHT COMPLETE DATABASE BACKUP**\n📅 Date: \`${now.toLocaleDateString()}\``,
                    parse_mode: 'Markdown'
                });

                fs.unlinkSync(backupPath);
            } catch (e) {}
        }
    }, 60 * 1000);
}

startMidnightBackupScheduler();

// -------------------------------------------------------------
// 🎧 SUPPORT BOT LOGIC (@JPW_SUPPORT_ADMIN_BOT)
// -------------------------------------------------------------
supportBot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    const firstName = msg.from ? msg.from.first_name : 'User';
    await initUser(chatId, firstName);

    supportBot.sendMessage(chatId, `🎧 **JPW OFFICIAL SUPPORT CENTER**\n\nनमस्ते **${firstName}**! अपनी समस्या यहाँ लिखें।`, { parse_mode: 'Markdown' });
});

supportBot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    if (chatId !== DEFAULT_ADMIN_CHAT_ID) {
        const userObj = msg.from || {};
        const alertText = `📩 **NEW SUPPORT TICKET**\n👤 User: ${userObj.first_name} (\`${chatId}\`)\n💬 Message: "${text}"`;

        await adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, alertText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '💬 Reply to User', callback_data: `reply_sup_${chatId}` }]]
            }
        });

        return supportBot.sendMessage(chatId, `✅ **आपका संदेश सुपर एडमिन को भेज दिया गया है!**`, { parse_mode: 'Markdown' });
    }
});

adminBot.on('callback_query', async (query) => {
    const data = query.data;
    if (data.startsWith('reply_sup_')) {
        const targetUserId = data.replace('reply_sup_', '');
        adminState[DEFAULT_ADMIN_CHAT_ID] = { step: 'WAIT_SUPPORT_REPLY', targetUserId };
        adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `✍️ **User \`${targetUserId}\` के लिए अपना जवाब भेजें:**`, { parse_mode: 'Markdown' });
        adminBot.answerCallbackQuery(query.id);
    }
});

// -------------------------------------------------------------
// ⚡ ORDER SUBMISSION ENGINE
// -------------------------------------------------------------
async function processOrderSubmission(bot, chatId, targetId, targetPass) {
    let user = await initUser(chatId);

    if (user.reaches < 1) {
        return bot.sendMessage(chatId, `❌ **Insufficient Reach Balance!** Current Balance: ${user.reaches} Reaches.`, { parse_mode: 'Markdown' });
    }

    user.reaches -= 1;
    await user.save();

    const activeWorkers = await WorkerModel.find({ isActive: true }).sort({ activeLoads: 1 });
    if (activeWorkers.length === 0) {
        user.reaches += 1;
        await user.save();
        return bot.sendMessage(chatId, `⚠️ **No Active Workers. 1 Reach Auto-Refunded!**`, { parse_mode: 'Markdown' });
    }

    const assignedWorker = activeWorkers[0];
    await WorkerModel.updateOne({ _id: assignedWorker._id }, { $inc: { activeLoads: 1 } });
    const newOrder = await OrderModel.create({ custChatId: chatId, targetId, targetPass, assignedServer: assignedWorker.serverName });

    const orderKey = `${chatId}_${targetId}_${newOrder._id}`;
    const statusMsg = await bot.sendMessage(chatId, `⏳ **ORDER SUBMITTED**\n\n🎯 Target ID: \`${targetId}\`\n🤖 Server: ${assignedWorker.serverName}\n⏱️ Elapsed: \`00 Mins 00 Secs\` 🔄`, { parse_mode: 'Markdown' });

    let elapsedSecs = 0;
    chatRefreshIntervals[orderKey] = setInterval(async () => {
        elapsedSecs += 15;
        const mins = Math.floor(elapsedSecs / 60);
        const secs = elapsedSecs % 60;
        try {
            await bot.editMessageText(`⚙️ **ORDER IN PROCESS**\n\n🎯 Target ID: \`${targetId}\`\n⏱️ Elapsed: \`${String(mins).padStart(2,'0')} Mins ${String(secs).padStart(2,'0')} Secs\` 🔄`, {
                chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown'
            });
        } catch (e) {}
    }, 15000);

    activeOrderTimers[orderKey] = setTimeout(async () => {
        if (chatRefreshIntervals[orderKey]) {
            clearInterval(chatRefreshIntervals[orderKey]);
            delete chatRefreshIntervals[orderKey];
        }

        const currentOrder = await OrderModel.findById(newOrder._id);
        if (currentOrder && currentOrder.status === 'Pending') {
            await WorkerModel.updateOne({ _id: assignedWorker._id }, { $inc: { activeLoads: -1 } });
            await OrderModel.updateOne({ _id: newOrder._id }, { status: 'Timeout Refunded' });

            let custUser = await UserModel.findOne({ chatId: chatId });
            if (custUser) {
                custUser.reaches += 1;
                await custUser.save();
            }
            try {
                await bot.sendMessage(chatId, `⏰ **10 Mins Timeout! 1 Reach Auto-Refunded.**`, { parse_mode: 'Markdown' });
            } catch (e) {}
        }
    }, 10 * 60 * 1000);

    const workerMsg = `⚡ **NEW WORK ORDER**\n\n👤 Customer: \`${chatId}\`\n🔑 Target ID: \`${targetId}\`\n🔒 Pass: \`${targetPass}\``;
    const targetWBot = activeWorkerBots[assignedWorker._id];
    if (targetWBot) {
        await targetWBot.sendMessage(assignedWorker.assignedChatId, workerMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '⏳ Accept & Start', callback_data: `wrkproc_${chatId}_${targetId}_${newOrder._id}` },
                    { text: '❌ Cancel & Refund', callback_data: `wrkcanc_${chatId}_${targetId}_${newOrder._id}` }
                ]]
            }
        });
    }
}

// --- CUSTOMER BOTS ENGINE (DYNAMIC PACKAGES & RESELLER PRICING) ---
CUSTOMER_BOT_TOKENS.forEach(token => {
    const cBot = new TelegramBot(token, { polling: true });

    cBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
        const chatId = String(msg.chat.id);
        const firstName = msg.from ? msg.from.first_name : 'Customer';
        let user = await initUser(chatId, firstName);

        cBot.sendMessage(chatId, `✨ **JPW ENTERPRISE AUTO SERVICES** ✨\n\n👤 Account: **${user.firstName}**\n💰 Balance: **${user.reaches} Reaches**`, {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: '💳 Recharge Wallet' }, { text: '🏷️ View Packages' }],
                    [{ text: '💼 Become a Reseller to Start Personal Business' }],
                    [{ text: '💰 View Balance' }, { text: '📱 Open Mini App' }],
                    [{ text: '💬 Support' }]
                ],
                resize_keyboard: true
            }
        });
    });

    cBot.on('message', async (msg) => {
        const chatId = String(msg.chat.id);
        const text = msg.text;
        if (!text || text.startsWith('/')) return;

        let user = await initUser(chatId, msg.from ? msg.from.first_name : 'User');

        if (text === '💼 Become a Reseller to Start Personal Business') {
            user.role = 'reseller';
            await user.save();
            return cBot.sendMessage(chatId, `🎉 **CONGRATULATIONS! UPGRADED TO RESELLER!** 👑\nYou can now set your custom pricing & UPI ID via Mini App.`, { parse_mode: 'Markdown' });
        }

        if (text === '💼 Reseller Dashboard Portal') {
            return cBot.sendMessage(chatId, `👑 **RESELLER MANAGEMENT PORTAL**\n\nOpen Mini App to configure your custom pricing per reach and UPI ID.`, { parse_mode: 'Markdown' });
        }

        const orderMatch = text.trim().match(/^(\d{10})\s+(.+)$/);
        if (orderMatch) {
            return processOrderSubmission(cBot, chatId, orderMatch[1], orderMatch[2]);
        }

        if (/^\d{12}$/.test(text.trim())) {
            const utr = text.trim();
            await adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `💳 **NEW UTR SUBMITTED**\n👤 Customer: \`${chatId}\`\n🔢 UTR: \`${utr}\``, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '✅ Approve UTR', callback_data: `appr_utr_${chatId}_6_100` }]]
                }
            });
            return cBot.sendMessage(chatId, `✅ **UTR Submitted Successfully!**`, { parse_mode: 'Markdown' });
        }

        if (text === '💳 Recharge Wallet' || text === '🏷️ View Packages') {
            const settings = await getSettings();
            const rate = user.role === 'reseller' ? settings.resellerWholesalePrice : (user.customPricePerReach || settings.customerPricePerReach);

            let pkgText = `🏷️ **AVAILABLE PACKAGES & PRICING:**\n\n`;
            let inlineKeyboard = [];

            [1, 6, 35, 75, 200].forEach(reaches => {
                const cost = reaches * (reaches === 1 ? rate : (rate * 0.9));
                pkgText += `⚡ **${reaches} Reaches** ➔ ₹${Math.round(cost)}\n`;
                inlineKeyboard.push([{ text: `💳 Buy ${reaches} Reaches (₹${Math.round(cost)})`, callback_data: `buy_pkg_${Math.round(cost)}_${reaches}` }]);
            });

            const sentMsg = await cBot.sendMessage(chatId, pkgText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            user.lastMsgId = sentMsg.message_id;
            await user.save();
        }

        if (text === '💰 View Balance') {
            return cBot.sendMessage(chatId, `💰 **Wallet Balance:** \`${user.reaches} Reaches\``, { parse_mode: 'Markdown' });
        }
    });

    cBot.on('callback_query', async (query) => {
        const chatId = String(query.message.chat.id);
        const data = query.data;

        if (data.startsWith('buy_pkg_')) {
            const parts = data.split('_');
            const price = parts[2];
            const reaches = parts[3];

            let user = await UserModel.findOne({ chatId });
            let settings = await getSettings();
            let upi = user.customUpiId || settings.upiId;

            const upiLink = `upi://pay?pa=${upi}&pn=JPWPay&am=${price}&cu=INR`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiLink)}`;

            await cBot.deleteMessage(chatId, query.message.message_id);
            await cBot.sendPhoto(chatId, qrUrl, {
                caption: `⚡ **SCAN QR TO PAY ₹${price}**\n📦 Package: ${reaches} Reaches\n🆔 UPI: \`${upi}\`\n\nSend 12-digit UTR number in chat after payment!`,
                parse_mode: 'Markdown'
            });
            cBot.answerCallbackQuery(query.id);
        }
    });

    customerBots.push(cBot);
});

// --- WORKER BOTS ENGINE ---
async function initDynamicWorkerBots() {
    const dbWorkers = await WorkerModel.find({ isActive: true });
    Object.keys(activeWorkerBots).forEach(id => {
        try { activeWorkerBots[id].stopPolling(); } catch (e) {}
    });
    activeWorkerBots = {};

    dbWorkers.forEach(worker => {
        try {
            const wBot = new TelegramBot(worker.token, { polling: true });
            wBot.on('callback_query', async (query) => {
                const operatorChatId = String(query.message.chat.id);
                const parts = query.data.split('_');
                const action = parts[0];
                const custChatId = parts[1];
                const targetId = parts[2];
                const orderDbId = parts[3];
                const orderKey = `${custChatId}_${targetId}_${orderDbId}`;

                if (action === 'wrkproc') {
                    if (activeOrderTimers[orderKey]) {
                        clearTimeout(activeOrderTimers[orderKey]);
                        delete activeOrderTimers[orderKey];
                    }
                    await OrderModel.updateOne({ _id: orderDbId }, { status: 'Processing', acceptedAt: new Date() });
                    wBot.editMessageReplyMarkup({
                        inline_keyboard: [[{ text: '✅ Complete Order', callback_data: `wrkcomp_${custChatId}_${targetId}_${orderDbId}` }]]
                    }, { chat_id: operatorChatId, message_id: query.message.message_id });
                    wBot.answerCallbackQuery(query.id, { text: "Marked In Process!" });
                } 
                else if (action === 'wrkcomp') {
                    if (chatRefreshIntervals[orderKey]) {
                        clearInterval(chatRefreshIntervals[orderKey]);
                        delete chatRefreshIntervals[orderKey];
                    }
                    await WorkerModel.updateOne({ _id: worker._id }, { $inc: { activeLoads: -1, completedToday: 1, totalEarnings: 1 } });
                    await OrderModel.updateOne({ _id: orderDbId }, { status: 'Completed', completedAt: new Date() });

                    const primaryBot = customerBots[0] || adminBot;
                    try {
                        await primaryBot.sendMessage(custChatId, `🎉 **ORDER COMPLETED SUCCESSFULLY!**\n🎯 Target ID: \`${targetId}\``, { parse_mode: 'Markdown' });
                    } catch (e) {}
                    wBot.sendMessage(operatorChatId, `🎉 **Order Completed! +1 Reach Earned.**`, { parse_mode: 'Markdown' });
                    wBot.answerCallbackQuery(query.id, { text: "Completed!" });
                }
            });
            activeWorkerBots[worker._id] = wBot;
        } catch (e) {}
    });
}

initDynamicWorkerBots();

// --- SUPER ADMIN PANEL ---
adminBot.onText(/\/start|\/admin/, async (msg) => {
    if (String(msg.chat.id) !== DEFAULT_ADMIN_CHAT_ID) return;
    adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `👑 **SUPER ADMIN MASTER PORTAL** ⚡`, {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [
                [{ text: '🏷️ Set Global Pricing / Slabs' }, { text: '🔍 AI Health Diagnostics' }],
                [{ text: '📢 Broadcast Notice to All' }, { text: '📱 Open Web Portal App 🌐' }]
            ],
            resize_keyboard: true
        }
    });
});

adminBot.on('message', async (msg) => {
    if (String(msg.chat.id) !== DEFAULT_ADMIN_CHAT_ID) return;
    const text = msg.text;

    if (text === '🏷️ Set Global Pricing / Slabs') {
        adminState[DEFAULT_ADMIN_CHAT_ID] = { step: 'WAIT_ADMIN_NEW_PRICE' };
        return adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `🏷️ **Enter New Default Price per Reach (e.g. 20):**`, { parse_mode: 'Markdown' });
    }

    if (adminState[DEFAULT_ADMIN_CHAT_ID]?.step === 'WAIT_ADMIN_NEW_PRICE') {
        const newPrice = parseFloat(text.trim());
        adminState[DEFAULT_ADMIN_CHAT_ID] = null;
        await SettingsModel.updateOne({ key: 'global' }, { customerPricePerReach: newPrice });
        return adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `✅ **Global Customer Price updated to ₹${newPrice} per Reach!**`, { parse_mode: 'Markdown' });
    }

    if (text === '🔍 AI Health Diagnostics') {
        const diagReport = await runSelfHealthDiagnostics();
        return adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, diagReport, { parse_mode: 'Markdown' });
    }
});

// --- EXPRESS APIs ---
app.get('/miniapp', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.post('/api/reseller/update-pricing', async (req, res) => {
    const { chatId, customPricePerReach, customUpiId } = req.body;
    await UserModel.updateOne({ chatId }, { customPricePerReach, customUpiId });
    res.json({ success: true, message: "Reseller pricing updated!" });
});

app.post('/api/user/become-reseller', async (req, res) => {
    const { chatId } = req.body;
    await UserModel.updateOne({ chatId }, { role: 'reseller' });
    res.json({ success: true, message: "Upgraded to Reseller Status!" });
});

app.post('/api/submit-target', async (req, res) => {
    try {
        const { chatId, targetId, targetPass } = req.body;
        await processOrderSubmission(customerBots[0] || adminBot, chatId, targetId, targetPass);
        res.json({ success: true, message: "Order Submitted Successfully!" });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/user-role/:chatId', async (req, res) => {
    try {
        let user = await UserModel.findOne({ chatId: req.params.chatId });
        let settings = await getSettings();
        res.json({
            role: user ? user.role : 'customer',
            reaches: user ? user.reaches : 0,
            firstName: user ? user.firstName : 'User',
            customPrice: user ? user.customPricePerReach : settings.customerPricePerReach,
            customUpi: user ? user.customUpiId : settings.upiId
        });
    } catch (e) {
        res.json({ role: 'customer', reaches: 0, firstName: 'User' });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Master SaaS Engine Live on Port ${PORT}`));
