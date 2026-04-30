const { IBApi, EventName } = require('@stoqey/ib');
const WebSocket = require('ws');

const TWS_PORT    = 7497;
const TWS_HOST    = '127.0.0.1';
const BRIDGE_PORT = 8765;
const CLIENT_ID   = 12;

const BTC_CONTRACT = { symbol: 'BTC', secType: 'CRYPTO', currency: 'USD', exchange: 'PAXOS' };
const MARKET_DATA_REQ_ID  = 1;
const ACCT_SUMMARY_REQ_ID = 2;

let nextOrderId  = 1;
let currentPrice = null;
let ibConnected  = false;
let flattenPending = false;

const ibApi = new IBApi({ host: TWS_HOST, port: TWS_PORT, clientId: CLIENT_ID });

function broadcast(obj) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

ibApi.on(EventName.connected, () => {
    ibConnected = true;
    console.log(`✅ Connected to TWS on port ${TWS_PORT}`);
    ibApi.reqIds(1);
    ibApi.reqMarketData(MARKET_DATA_REQ_ID, BTC_CONTRACT, '', false, false);
    ibApi.reqAccountSummary(ACCT_SUMMARY_REQ_ID, 'All', 'NetLiquidation,TotalCashValue');
    broadcast({ type: 'ibStatus', connected: true });
});

ibApi.on(EventName.disconnected, () => {
    ibConnected = false;
    console.log('❌ Disconnected from TWS');
    broadcast({ type: 'ibStatus', connected: false });
});

ibApi.on(EventName.nextValidId, (orderId) => {
    nextOrderId = orderId;
    console.log(`Next order ID: ${orderId}`);
});

// field 4 = LAST price
ibApi.on(EventName.tickPrice, (reqId, field, price) => {
    if (reqId === MARKET_DATA_REQ_ID && field === 4 && price > 0) {
        currentPrice = price;
        broadcast({ type: 'price', price });
    }
});

// Account summary
ibApi.on(EventName.accountSummary, (reqId, account, tag, value) => {
    if (tag === 'NetLiquidation') {
        const netLiq = parseFloat(value);
        console.log(`💰 Account NetLiquidation: $${netLiq.toFixed(2)}`);
        broadcast({ type: 'accountValue', netLiquidation: netLiq });
    }
});

ibApi.on(EventName.accountSummaryEnd, () => {
    ibApi.cancelAccountSummary(ACCT_SUMMARY_REQ_ID);
});

// Positions — used for flatten
ibApi.on(EventName.position, (account, contract, pos) => {
    const size = Number(pos);
    console.log(`📋 Position: ${contract.symbol} ${size}`);
    broadcast({ type: 'position', symbol: contract.symbol, size });

    if (flattenPending && size !== 0) {
        const action = size > 0 ? 'SELL' : 'BUY';
        const qty    = Math.abs(size);
        const id     = nextOrderId++;
        console.log(`🧹 Flatten: ${action} ${qty} ${contract.symbol}  orderId=${id}`);
        ibApi.placeOrder(id, contract, {
            action,
            orderType:     'MKT',
            totalQuantity: qty,
            tif:           'DAY',   // queues for market open if after-hours (stocks)
            outsideRth:    false,
        });
        broadcast({ type: 'flattenOrder', symbol: contract.symbol, action, qty });
    }
});

ibApi.on(EventName.positionEnd, () => {
    if (flattenPending) {
        flattenPending = false;
        broadcast({ type: 'flattenDone' });
        console.log('🧹 Flatten complete');
        // Refresh account value after flattening
        setTimeout(() => ibApi.reqAccountSummary(ACCT_SUMMARY_REQ_ID, 'All', 'NetLiquidation'), 2000);
    }
});

ibApi.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
    console.log(`Order ${orderId}: ${status}  filled=${filled} @ ${avgFillPrice}`);
    broadcast({ type: 'orderStatus', orderId, status, filled: Number(filled), avgFillPrice: Number(avgFillPrice) });
});

ibApi.on(EventName.error, (err, code) => {
    if ([2104, 2106, 2158, 2119].includes(code)) return;
    const msg = err?.message ?? String(err);
    console.error(`TWS [${code}]: ${msg}`);
    broadcast({ type: 'ibError', code, message: msg });
});

// ---- Browser WebSocket server ----
const wss = new WebSocket.Server({ port: BRIDGE_PORT, host: 'localhost' });
console.log(`Bridge listening on ws://localhost:${BRIDGE_PORT}`);

wss.on('connection', (ws) => {
    console.log('🎮 Game connected');
    ws.send(JSON.stringify({ type: 'ibStatus', connected: ibConnected }));
    if (currentPrice) ws.send(JSON.stringify({ type: 'price', price: currentPrice }));
    // Re-request account summary for newly connected client
    if (ibConnected) ibApi.reqAccountSummary(ACCT_SUMMARY_REQ_ID, 'All', 'NetLiquidation');

    ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'order' && ibConnected) {
            const id = nextOrderId++;
            const cashQty = parseFloat(msg.cashQty.toFixed(2));
            console.log(`📤 ${msg.action} $${cashQty}  orderId=${id}`);
            ibApi.placeOrder(id, BTC_CONTRACT, {
                action: msg.action, orderType: 'MKT', cashQty, tif: 'GTC',
            });
            ws.send(JSON.stringify({ type: 'orderPlaced', orderId: id, action: msg.action, cashQty }));
        }

        if (msg.type === 'flatten' && ibConnected) {
            console.log('🧹 Flatten requested');
            flattenPending = true;
            ibApi.reqPositions();
        }

        if (msg.type === 'reqAccountValue' && ibConnected) {
            ibApi.reqAccountSummary(ACCT_SUMMARY_REQ_ID, 'All', 'NetLiquidation');
        }
    });

    ws.on('close', () => console.log('🎮 Game disconnected'));
});

ibApi.connect();

setInterval(() => {
    if (!ibConnected) { try { ibApi.connect(); } catch {} }
}, 10000);
