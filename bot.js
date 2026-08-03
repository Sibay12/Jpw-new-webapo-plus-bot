const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const app = express();
app.use(express.json());
app.use(cors());

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
    role: { type: String, default: 'customer' },
    isSuperAdmin: { type: Boolean, default: false },
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
let workerState = {};
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
            isSuperAdmin: isMaster,
            referredBy: (refId && refId !== String(chatId)) ? refId : null
        });
        await user.save();
    }
    return user;
}

// -------------------------------------------------------------
// 📄 PDF INVOICE / RECEIPT GENERATOR ENGINE
// -------------------------------------------------------------
async function generatePaymentReceiptPDF(custName, chatId, amount, reaches, utr, callback) {
    const doc = new PDFDocument({ margin: 50 });
    const filePath = path.join(__dirname, `receipt_${Date.now()}.pdf`);
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // Header Design
    doc.fillColor('#4f46e5').fontSize(22).text('JPW ENTERPRISE', { align: 'center' });
    doc.fillColor('#64748b').fontSize(10).text('Official Payment & Recharge Invoice', { align: 'center' });
    doc.moveDown(1.5);

    // Invoice Meta
    doc.fillColor('#0f172a').fontSize(12).text(`Receipt Date: ${new Date().toLocaleString()}`);
    doc.text(`Customer Name: ${custName}`);
    doc.text(`Telegram Chat ID: ${chatId}`);
    doc.text(`Transaction UTR: ${utr || 'VERIFIED-UPI'}`);
    doc.moveDown(1);

    // Table / Details Box
    doc.rect(50, doc.y, 500, 80).fillAndStroke('#f1f5f9', '#cbd5e1');
    doc.fillColor('#0f172a').fontSize(14).text('Purchase Summary', 65, doc.y - 65);
    doc.fontSize(11).text(`Package Reaches Credited: ${reaches} Reaches`, 65, doc.y - 35);
    doc.text(`Total Amount Paid: INR ${amount}.00`, 65, doc.y - 15);
    doc.moveDown(3);

    // Footer
    doc.fillColor('#64748b').fontSize(9).text('Thank you for choosing JPW Enterprise Auto Services!', { align: 'center' });
    doc.text('This is a system-generated electronic receipt.', { align: 'center' });

    doc.end();

    stream.on('finish', () => {
        callback(filePath);
    });
}

// -------------------------------------------------------------
// 🔍 AI DIAGNOSTICS & SELF-HEALTH ENGINE
// -------------------------------------------------------------
async function runSelfHealthDiagnostics() {
    const uptime = (process.uptime() / 60).toFixed(2);
    const dbState = mongoose.connection.readyState === 1 ? "🟢 Connected & Healthy" : "🔴 Disconnected";
    const totalUsers = await UserModel.countDocuments({ role: 'customer' });
    const totalAdmins = await UserModel.countDocuments({ isSuperAdmin: true });
    const activeWorkers = await WorkerModel.countDocuments({ isActive: true });
    const pendingOrders = await OrderModel.countDocuments({ status: 'Pending' });

    return `
🔍 **AI SELF-HEALTH DIAGNOSTICS REPORT**

🌐 **Cloud Database:** ${dbState}
⚡ **Server Uptime:** \`${uptime} Mins\`
👥 **Total Customers:** \`${totalUsers}\`
👑 **Super Admins Active:** \`${totalAdmins}\`
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
                    caption: `💾 **MIDNIGHT AUTOMATED DAILY BACKUP**\n📅 Date: \`${now.toLocaleDateString()}\``,
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

    supportBot.sendMessage(chatId, `🎧 **JPW OFFICIAL SUPPORT CENTER**\n\nनमस्ते **${firstName}**! अपनी समस्या या सवाल यहाँ लिखकर भेजें।`, { parse_mode: 'Markdown' });
});

supportBot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    if (chatId !== DEFAULT_ADMIN_CHAT_ID) {
        const userObj = msg.from || {};
        const alertText = `📩 **NEW SUPPORT TICKET FROM CUSTOMER**\n👤 User: ${userObj.first_name} (\`${chatId}\`)\n💬 Message: "${text}"`;

        await adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, alertText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '💬 Reply to User', callback_data: `reply_sup_${chatId}` }]] }
        });

        return supportBot.sendMessage(chatId, `✅ **आपका संदेश सुपर एडमिन तक पहुँचा दिया गया है!**`, { parse_mode: 'Markdown' });
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
    else if (data.startsWith('appr_utr_')) {
        // Format: appr_utr_chatId_reaches_price
        const parts = data.split('_');
        const targetChatId = parts[2];
        const reaches = parseInt(parts[3]);
        const price = parseInt(parts[4]);

        let user = await UserModel.findOne({ chatId: targetChatId });
        if (user) {
            user.reaches += reaches;
            await user.save();

            adminBot.editMessageCaption(`✅ **UTR APPROVED!** Credited +${reaches} Reaches to \`${targetChatId}\``, {
                chat_id: DEFAULT_ADMIN_CHAT_ID, message_id: query.message.message_id, parse_mode: 'Markdown'
            });

            // Generate PDF Receipt and send to Customer
            generatePaymentReceiptPDF(user.firstName, targetChatId, price, reaches, 'VERIFIED-UPI', async (pdfPath) => {
                const primaryBot = customerBots[0] || adminBot;
                try {
                    await primaryBot.sendDocument(targetChatId, pdfPath, {
                        caption: `🎉 **RECHARGE SUCCESSFUL!**\n\n📦 Credited: **${reaches} Reaches**\n💰 Amount Paid: **₹${price}**\n\nYour official payment receipt PDF is attached above. ✨`,
                        parse_mode: 'Markdown'
                    });
                } catch (e) {}
                fs.unlinkSync(pdfPath);
            });
        }
        adminBot.answerCallbackQuery(query.id, { text: "Recharge Approved & PDF Sent!" });
    }
    else if (data.startsWith('appr_admin_')) {
        const targetChatId = data.replace('appr_admin_', '');
        await UserModel.updateOne({ chatId: targetChatId }, { isSuperAdmin: true, role: 'admin' });
        adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `✅ **User \`${targetChatId}\` successfully granted Super Admin access!**`, { parse_mode: 'Markdown' });
        try {
            await adminBot.sendMessage(targetChatId, `🎉 **CONGRATULATIONS!** Your Super Admin access is now UNLOCKED! Send /admin to start.`, { parse_mode: 'Markdown' });
        } catch (e) {}
        adminBot.answerCallbackQuery(query.id, { text: "Approved!" });
    }
});

adminBot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    if (chatId === DEFAULT_ADMIN_CHAT_ID && adminState[DEFAULT_ADMIN_CHAT_ID]?.step === 'WAIT_SUPPORT_REPLY') {
        const targetUserId = adminState[DEFAULT_ADMIN_CHAT_ID].targetUserId;
        adminState[DEFAULT_ADMIN_CHAT_ID] = null;
        const replyText = msg.text;

        try {
            await supportBot.sendMessage(targetUserId, `👨‍💻 **SUPPORT TEAM REPLY:**\n\n${replyText}`, { parse_mode: 'Markdown' });
            return adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `✅ **जवाब सफलतापूर्वक भेज दिया गया है!**`, { parse_mode: 'Markdown' });
        } catch (e) {}
    }
});

// -------------------------------------------------------------
// 👷 DYNAMIC WORKER BOTS ENGINE
// -------------------------------------------------------------
async function initDynamicWorkerBots() {
    const dbWorkers = await WorkerModel.find({ isActive: true });
    Object.keys(activeWorkerBots).forEach(id => {
        try { activeWorkerBots[id].stopPolling(); } catch (e) {}
    });
    activeWorkerBots = {};

    dbWorkers.forEach(worker => {
        try {
            const wBot = new TelegramBot(worker.token, { polling: true });

            wBot.onText(/\/start/, async (msg) => {
                const operatorChatId = String(msg.chat.id);
                const workerDoc = await WorkerModel.findOne({ token: worker.token });
                const settings = await getSettings();

                const rate = settings.workerReachRateInRs || 1;
                const totalEarnedRs = (workerDoc.totalEarnings || 0) * rate;

                const statsMsg = `
👷 **WORKER OPERATOR WORKSTATION**

🤖 **Server Name:** ${workerDoc.serverName}
📊 **Completed Today:** \`${workerDoc.completedToday || 0} Reaches\`
💰 **Earned Balance:** \`${workerDoc.totalEarnings || 0} Reaches\`
💱 **Conversion Rate:** \`1 Reach = ₹${rate}\`
💵 **Redeemable Amount:** \`₹${totalEarnedRs}\`
⚡ **Active Load:** \`${workerDoc.activeLoads} Orders\`
                `.trim();

                wBot.sendMessage(operatorChatId, statsMsg, {
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: [[{ text: '💸 Request Payout' }]], resize_keyboard: true }
                });
            });

            wBot.on('message', async (msg) => {
                const operatorChatId = String(msg.chat.id);
                const text = msg.text;
                if (!text || text.startsWith('/')) return;

                if (text === '💸 Request Payout') {
                    workerState[operatorChatId] = { step: 'WAIT_WORKER_UPI', workerId: worker._id };
                    return wBot.sendMessage(operatorChatId, `💸 **पैसे विथड्रॉ करने के लिए अपनी UPI ID दर्ज करें:**`, { parse_mode: 'Markdown' });
                }

                if (workerState[operatorChatId]?.step === 'WAIT_WORKER_UPI') {
                    const upiId = text.trim();
                    const workerId = workerState[operatorChatId].workerId;
                    workerState[operatorChatId] = null;

                    const workerDoc = await WorkerModel.findById(workerId);
                    const settings = await getSettings();
                    const amountRs = (workerDoc.totalEarnings || 0) * (settings.workerReachRateInRs || 1);

                    if (amountRs <= 0) {
                        return wBot.sendMessage(operatorChatId, `❌ **पर्याप्त बैलेंस नहीं है!**`, { parse_mode: 'Markdown' });
                    }

                    await adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `💸 **NEW WORKER PAYOUT REQUEST**\n\n👷 Server: ${workerDoc.serverName}\n🆔 Operator Chat ID: \`${operatorChatId}\`\n💰 Reaches: \`${workerDoc.totalEarnings}\`\n💵 Amount: \`₹${amountRs}\`\n💳 UPI ID: \`${upiId}\``, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: `✅ Accept & Pay ₹${amountRs}`, callback_data: `pay_acc_${workerId}_${operatorChatId}` },
                                { text: `❌ Decline`, callback_data: `pay_dec_${workerId}_${operatorChatId}` }
                            ]]
                        }
                    });

                    return wBot.sendMessage(operatorChatId, `✅ **Payout Request Sent!**`, { parse_mode: 'Markdown' });
                }
            });

            wBot.on('callback_query', async (query) => {
                const operatorChatId = String(query.message.chat.id);
                const parts = query.data.split('_');
                const action = parts[0];
                const custChatId = parts[1];
                const targetId = parts[2];
                const orderDbId = parts[3];
                const orderKey = `${custChatId}_${targetId}_${orderDbId}`;

                const targetOrder = await OrderModel.findById(orderDbId);
                if (!targetOrder || targetOrder.status === 'Completed' || targetOrder.status === 'Cancelled') {
                    return wBot.answerCallbackQuery(query.id, { text: "⚠️ Order already processed!" });
                }

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

                    try {
                        wBot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: operatorChatId, message_id: query.message.message_id });
                    } catch (e) {}

                    const primaryBot = customerBots[0] || adminBot;
                    try {
                        await primaryBot.sendMessage(custChatId, `🎉 **ORDER COMPLETED SUCCESSFULLY!**\n🎯 Target ID: \`${targetId}\``, { parse_mode: 'Markdown' });
                    } catch (e) {}
                    wBot.sendMessage(operatorChatId, `🎉 **Order Completed! +1 Reach Earned.**`, { parse_mode: 'Markdown' });
                    wBot.answerCallbackQuery(query.id, { text: "Completed Successfully!" });
                }
            });

            activeWorkerBots[worker._id] = wBot;
        } catch (e) {}
    });
}

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

    const workerMsg = `⚡ **NEW WORK ORDER ASSIGNED**\n\n👤 Customer: \`${chatId}\`\n🔑 Target ID: \`${targetId}\`\n🔒 Pass: \`${targetPass}\``;
    const targetWBot = activeWorkerBots[assignedWorker._id];
    if (targetWBot) {
        await targetWBot.sendMessage(assignedWorker.assignedChatId, workerMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '⏳ Accept & Start', callback_data: `wrkproc_${chatId}_${targetId}_${newOrder._id}` },
                    { text: '❌ Cancel & Refund', callback_data: `wrkcanc_${chatId}_${targetId}_${newOrder._id}` }
                ]}
            }
        });
    }
}

// --- CUSTOMER BOTS ENGINE ---
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
                    [{ text: '👑 Register as Super Admin (₹499)' }, { text: '💼 Become a Reseller' }],
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

        if (text === '💬 Support') {
            return cBot.sendMessage(chatId, `🎧 **JPW OFFICIAL SUPPORT CENTER**\n🔗 t.me/JPW_SUPPORT_ADMIN_BOT`, { parse_mode: 'Markdown' });
        }

        if (text === '👑 Register as Super Admin (₹499)') {
            let settings = await getSettings();
            const upiLink = `upi://pay?pa=${settings.upiId}&pn=JPWPay&am=499&cu=INR`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiLink)}`;

            return cBot.sendPhoto(chatId, qrUrl, {
                caption: `👑 **SUPER ADMIN REGISTRATION (₹499)**\n\nसुपर एडमिन बनने के लिए ₹499 का भुगतान करें और UTR नंबर चैट में भेजें।`,
                parse_mode: 'Markdown'
            });
        }

        const orderMatch = text.trim().match(/^(\d{10})\s+(.+)$/);
        if (orderMatch) {
            return processOrderSubmission(cBot, chatId, orderMatch[1], orderMatch[2]);
        }

        if (/^\d{12}$/.test(text.trim())) {
            const utr = text.trim();
            // Check if user has active package amount intent or default
            await adminBot.sendMessage(DEFAULT_ADMIN_CHAT_ID, `💳 **NEW UTR SUBMITTED FOR APPROVAL**\n👤 Customer: ${user.firstName} (\`${chatId}\`)\n🔢 UTR: \`${utr}\``, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Approve +6 Reaches (₹100)', callback_data: `appr_utr_${chatId}_6_100` }],
                        [{ text: '✅ Approve +35 Reaches (₹500)', callback_data: `appr_utr_${chatId}_35_500` }],
                        [{ text: '✅ Approve +75 Reaches (₹1000)', callback_data: `appr_utr_${chatId}_75_1000` }]
                    ]
                }
            });
            return cBot.sendMessage(chatId, `✅ **UTR Submitted!** Admin will approve shortly and send your PDF Invoice.`, { parse_mode: 'Markdown' });
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

// --- SUPER ADMIN PANEL (WITH INSTANT BACKUP & REPORT BUTTON) ---
adminBot.onText(/\/start|\/admin/, async (msg) => {
    const chatId = String(msg.chat.id);
    let user = await UserModel.findOne({ chatId });

    if (chatId !== DEFAULT_ADMIN_CHAT_ID && (!user || !user.isSuperAdmin)) {
        return adminBot.sendMessage(chatId, `❌ **Access Denied!**`, { parse_mode: 'Markdown' });
    }

    adminBot.sendMessage(chatId, `👑 **SUPER ADMIN MASTER PORTAL** ⚡`, {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [
                [{ text: '1️⃣ Set Consumer Price' }, { text: '2️⃣ Set Worker Conversion Rate' }],
                [{ text: '📥 Download Instant DB Backup' }, { text: '📢 Broadcast Notice to All' }],
                [{ text: '🔍 AI Health Diagnostics' }, { text: '📱 Open Web Portal App 🌐' }]
            ],
            resize_keyboard: true
        }
    });
});

adminBot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    let user = await UserModel.findOne({ chatId });
    if (chatId !== DEFAULT_ADMIN_CHAT_ID && (!user || !user.isSuperAdmin)) return;
    const text = msg.text;

    if (text === '1️⃣ Set Consumer Price') {
        adminState[chatId] = { step: 'WAIT_CONSUMER_PRICE' };
        return adminBot.sendMessage(chatId, `🏷️ **नया कंज्यूमर प्रति रीच मूल्य (₹) दर्ज करें:**`, { parse_mode: 'Markdown' });
    }

    if (adminState[chatId]?.step === 'WAIT_CONSUMER_PRICE') {
        const price = parseFloat(text.trim());
        adminState[chatId] = null;
        await SettingsModel.updateOne({ key: 'global' }, { customerPricePerReach: price });
        return adminBot.sendMessage(chatId, `✅ **Consumer Price updated to ₹${price}!**`, { parse_mode: 'Markdown' });
    }

    if (text === '2️⃣ Set Worker Conversion Rate') {
        adminState[chatId] = { step: 'WAIT_WORKER_RATE' };
        return adminBot.sendMessage(chatId, `💱 **वर्कर के लिए 1 Reach का रेट (₹) दर्ज करें:**`, { parse_mode: 'Markdown' });
    }

    if (adminState[chatId]?.step === 'WAIT_WORKER_RATE') {
        const rate = parseFloat(text.trim());
        adminState[chatId] = null;
        await SettingsModel.updateOne({ key: 'global' }, { workerReachRateInRs: rate });
        return adminBot.sendMessage(chatId, `✅ **Worker Conversion Rate updated to 1 Reach = ₹${rate}!**`, { parse_mode: 'Markdown' });
    }

    if (text === '📥 Download Instant DB Backup') {
        await adminBot.sendMessage(chatId, `⏳ **Generating Instant Backup & Report...**`, { parse_mode: 'Markdown' });
        const users = await UserModel.find();
        const orders = await OrderModel.find().limit(2000);
        const workers = await WorkerModel.find();

        const backupData = { timestamp: new Date().toISOString(), totalUsers: users.length, users, orders, workers };
        const backupPath = path.join(__dirname, `report_backup_${Date.now()}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

        await adminBot.sendDocument(chatId, backupPath, { caption: `📊 **INSTANT DATABASE REPORT & BACKUP**` });
        fs.unlinkSync(backupPath);
        return;
    }

    if (text === '📢 Broadcast Notice to All') {
        adminState[chatId] = { step: 'WAIT_NOTICE_MSG' };
        return adminBot.sendMessage(chatId, `📢 **नोटिस बोर्ड पर प्रसारित करने के लिए संदेश लिखें:**`, { parse_mode: 'Markdown' });
    }

    if (adminState[chatId]?.step === 'WAIT_NOTICE_MSG') {
        adminState[chatId] = null;
        const noticeText = text.trim();

        const allUsers = await UserModel.find();
        const primaryBot = customerBots[0] || adminBot;
        let count = 0;

        for (let u of allUsers) {
            try {
                await primaryBot.sendMessage(u.chatId, `📢 **NOTICE BOARD / घोषणा** ⚡\n\n${noticeText}`, { parse_mode: 'Markdown' });
                count++;
            } catch (e) {}
        }

        return adminBot.sendMessage(chatId, `✅ **नोटिस ${count} यूज़र्स को ब्रॉडकास्ट कर दिया गया है!**`, { parse_mode: 'Markdown' });
    }

    if (text === '🔍 AI Health Diagnostics') {
        const diagReport = await runSelfHealthDiagnostics();
        return adminBot.sendMessage(chatId, diagReport, { parse_mode: 'Markdown' });
    }
});

// --- EXPRESS APIs ---
app.get('/miniapp', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

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
            isSuperAdmin: user ? user.isSuperAdmin : false,
            reaches: user ? user.reaches : 0,
            firstName: user ? user.firstName : 'User',
            customPrice: user ? user.customPricePerReach : settings.customerPricePerReach,
            customUpi: user ? user.customUpiId : settings.upiId
        });
    } catch (e) {
        res.json({ role: 'customer', reaches: 0, firstName: 'User' });
    }
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Master SaaS Engine Live on Port ${PORT}`);
});
